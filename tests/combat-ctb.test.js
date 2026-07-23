// CTB TURN ENGINE tests-of-record — pins the [LOCKED] formulas in
// docs/handbook/ctb-turn-engine-spec.md so a drift from the sealed law fails here.
import test from "node:test";
import assert from "node:assert/strict";
import {
  speedFromDexMod, effectiveSpeed, delayFor, standardDelay, combatantSpeed,
  seedCombatantQueue, nextActor, commitTurn, applyHaste, applySlow, applyStun,
  buildForecast, ACTION_WEIGHT, CTB_BASE
} from "../server/solo/ctb.js";

test("speed = clamp(10 + dexMod, 8, 16); delay = round(BASE/speed × weight) — spec sample values", () => {
  // §2.1 / §3: DEX 14→dexMod 2→speed 12→delay 100; DEX 8→speed 9→133; DEX 18→speed 14→86.
  assert.equal(speedFromDexMod(2), 12);
  assert.equal(delayFor(12, ACTION_WEIGHT.standard), 100);
  assert.equal(speedFromDexMod(-1), 9);
  assert.equal(delayFor(9, ACTION_WEIGHT.standard), 133);
  assert.equal(speedFromDexMod(4), 14);
  assert.equal(delayFor(14, ACTION_WEIGHT.standard), 86);
  // clamp bounds
  assert.equal(speedFromDexMod(-5), 8);
  assert.equal(speedFromDexMod(10), 16);
  assert.equal(CTB_BASE, 1200);
});

test("action weights bend the FOLLOWING delay: light 0.75 / standard 1.0 / heavy 1.5", () => {
  assert.equal(delayFor(12, ACTION_WEIGHT.light), 75);
  assert.equal(delayFor(12, ACTION_WEIGHT.standard), 100);
  assert.equal(delayFor(12, ACTION_WEIGHT.heavy), 150);
});

test("haste/slow multiply speed THEN clamp (clamp-after-mult is normative)", () => {
  // DEX 20 → base speed 15; haste ×1.5 = 22.5 → clamp 16.
  assert.equal(effectiveSpeed(15, { haste: true }), 16);
  // DEX 6 → base speed 8; slow ×0.5 = 4 → clamp 8.
  assert.equal(effectiveSpeed(8, { slow: true }), 8);
  // haste + slow multiply, not cancel: 12 ×1.5×0.5 = 9 (slow mostly wins).
  assert.equal(effectiveSpeed(12, { haste: true, slow: true }), 9);
});

test("degeneracy bound: hasted-fast vs slowed-slow never triple-turns (ratio ≤ 2.0)", () => {
  const fast = delayFor(effectiveSpeed(speedFromDexMod(5), { haste: true })); // 75
  const slow = delayFor(effectiveSpeed(speedFromDexMod(-2), { slow: true })); // 150
  assert.equal(fast, 75);
  assert.equal(slow, 150);
  assert.ok(slow / fast <= 2.0, "worst delay ratio is 2.0 — no combatant takes 3 turns between another's 2");
});

function mkCombat() {
  const player = { combatantId: "player", kind: "player", name: "You", dexMod: 2 };
  const grey = { combatantId: "enm_grey", kind: "enemy", name: "The Limping Grey", dexMod: 1, hp: { current: 7, max: 7 } };
  const combat = { queueSeed: 42, now: 0, combatants: { player, enm_grey: grey } };
  seedCombatantQueue(player, { now: 0 });
  seedCombatantQueue(grey, { now: 0 });
  return { combat, player, grey };
}

test("start seeds nextTick = standard delay (no initiative); surprised enters at 2×", () => {
  const { player, grey } = mkCombat();
  assert.equal(player.nextTick, 100); // speed 12
  assert.equal(grey.nextTick, delayFor(11)); // speed 11 → 109
  const ambushed = { combatantId: "x", kind: "enemy", dexMod: 1, hp: { current: 5, max: 5 } };
  seedCombatantQueue(ambushed, { now: 0, surprised: true });
  assert.equal(ambushed.nextTick, 2 * delayFor(11));
});

test("nextActor picks lowest nextTick; commitTurn advances the clock + the actor", () => {
  const { combat, player, grey } = mkCombat();
  assert.equal(nextActor(combat).combatantId, "player"); // 100 < 109
  commitTurn(combat, player, { weight: ACTION_WEIGHT.standard });
  assert.equal(combat.now, 100);
  assert.equal(player.nextTick, 200);
  assert.equal(nextActor(combat).combatantId, "enm_grey"); // 109 < 200
});

test("stun pushes one standard delay once; anti-stunlock immune after 2 pushes without acting", () => {
  const { combat, grey } = mkCombat();
  const before = grey.nextTick;
  assert.equal(applyStun(combat, grey), true);
  assert.equal(grey.nextTick, before + standardDelay(grey));
  assert.equal(applyStun(combat, grey), true); // second push
  assert.equal(applyStun(combat, grey), false, "third stun refused — anti-stunlock");
  commitTurn(combat, grey); // acting clears the counter
  assert.equal(applyStun(combat, grey), true, "stun works again after the victim acts");
});

test("slow re-scales the pending wait (§4) — tempo roughly halves", () => {
  const { combat, grey } = mkCombat(); // grey.nextTick 109, speed 11, now 0
  applySlow(combat, grey, true);
  // remaining 109 × (11/ effSpeed). effSpeed = clamp(round(11×0.5),8,16)=8 (min). 109×11/8≈150.
  assert.ok(grey.nextTick >= 140 && grey.nextTick <= 160, `slowed wait ≈ doubled-ish, got ${grey.nextTick}`);
  assert.equal(combatantSpeed(grey), 8);
});

test("forecast is ORDER-ONLY, deterministic, and excludes hidden combatants", () => {
  const { combat } = mkCombat();
  const f1 = buildForecast(combat, { slots: 6 });
  const f2 = buildForecast(combat, { slots: 6 });
  assert.deepEqual(f1, f2, "same state → same order (determinism)");
  assert.equal(f1.length, 6);
  // order-only: no RAW TICK field leaks to the player-facing slot. `speed` is a derived stat
  // (clamp 8-16), surfaced for the forecast hover (name + speed) — it is NOT a tick, so it does
  // not break the order-only rule; the raw combat.now/nextTick still never leave.
  for (const slot of f1) {
    assert.deepEqual(Object.keys(slot).sort(), ["actorId", "displayName", "isPlayer", "slotIndex", "speed"]);
    assert.ok(!("nextTick" in slot) && !("now" in slot) && !("tick" in slot), "no raw CTB tick leaks to the player");
  }
  assert.equal(f1[0].actorId, "player"); // player (100) acts before grey (109)
  assert.equal(f1[0].slotIndex, 0);
  // hidden filter: an unrevealed foe never appears
  const hidden = buildForecast(combat, { slots: 6, isRevealed: (c) => c.kind === "player" });
  assert.ok(hidden.every((s) => s.isPlayer), "only the player is revealed → only the player forecasts");
});
