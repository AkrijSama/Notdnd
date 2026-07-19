// COMBAT STATUS ENGINE tests-of-record. The sealed TEN on the CTB clock (ch8), the
// rename law (world-book riders compile down), and the chaos-rider wiring (the Limping
// Grey's chill-bite → Slow, which bends the player's tempo).
import test from "node:test";
import assert from "node:assert/strict";
import { applyCombatStatus, tickStatusesOnTurnStart, combatConditionsPayload, statusForRider, ENGINE_STATUSES } from "../server/solo/combatStatus.js";
import { seedCombatantQueue, combatantSpeed } from "../server/solo/ctb.js";

function mkCombat() {
  const player = { combatantId: "player", kind: "player", name: "You", dexMod: 2, conditions: [] };
  const grey = { combatantId: "enm_grey", kind: "enemy", name: "The Limping Grey", dexMod: 1, hp: { current: 7, max: 7 }, conditions: [] };
  const combat = { queueSeed: 1, now: 0, combatants: { player, enm_grey: grey } };
  seedCombatantQueue(player, { now: 0 });
  seedCombatantQueue(grey, { now: 0 });
  return { combat, player, grey };
}

test("rename law: world-book riders compile down to the sealed ten (chill→slow, bleed→poison)", () => {
  assert.equal(statusForRider("chill"), "slow");
  assert.equal(statusForRider("bleed"), "poison");
  assert.equal(statusForRider("burns"), "poison");
  assert.equal(statusForRider("mends"), "regen");
  assert.equal(statusForRider("nonsense"), null);
  // exactly ten engine statuses, never an eleventh mechanic
  assert.equal(Object.keys(ENGINE_STATUSES).length, 10);
});

test("chill → Slow bends the player's CTB tempo (the queue op fires on apply)", () => {
  const { combat, player } = mkCombat();
  const before = combatantSpeed(player); // 12
  const applied = applyCombatStatus(combat, player, "chill", { worldName: "Chill" });
  assert.equal(applied.engineStatus, "slow", "chill compiles to Slow");
  assert.equal(applied.worldName, "Chill", "flavor label preserved for narration/chips");
  assert.ok(combatantSpeed(player) < before, "slowed → effective speed dropped (tempo bent)");
  assert.ok(player.conditions.some((c) => c.engineStatus === "slow"), "condition recorded");
});

test("poison ticks HP at turn start and expires after its duration (own-turns)", () => {
  const { combat, grey } = mkCombat();
  applyCombatStatus(combat, grey, "poison", { turns: 2 });
  const start = grey.hp.current;
  const ev1 = tickStatusesOnTurnStart({}, combat, grey, {});
  assert.ok(grey.hp.current < start, "poison drained HP on the tick");
  assert.ok(ev1.some((e) => e.status === "poison" && e.hp < 0));
  // turnsLeft 2 → after tick 1 it is 1 (still on); after tick 2 it expires
  tickStatusesOnTurnStart({}, combat, grey, {});
  assert.ok(!grey.conditions.some((c) => c.engineStatus === "poison"), "poison expired after 2 own-turns");
});

test("slow expiry restores tempo (the queue op is undone)", () => {
  const { combat, player } = mkCombat();
  const base = combatantSpeed(player);
  applyCombatStatus(combat, player, "slow", { turns: 1 });
  assert.ok(combatantSpeed(player) < base);
  tickStatusesOnTurnStart({}, combat, player, {}); // 1 turn → expires
  assert.equal(combatantSpeed(player), base, "speed restored when Slow ends");
});

test("stun uses the CTB one-shot push (no lasting speed change), display condition present", () => {
  const { combat, grey } = mkCombat();
  const before = grey.nextTick;
  const speedBefore = combatantSpeed(grey);
  applyCombatStatus(combat, grey, "stun");
  assert.ok(grey.nextTick > before, "stun pushed next_tick forward");
  assert.equal(combatantSpeed(grey), speedBefore, "stun leaves speed untouched");
});

test("combatConditionsPayload emits the chip shape (id/name/effect/kind), turns in effect text", () => {
  const { combat, player } = mkCombat();
  applyCombatStatus(combat, player, "chill", { turns: 2, worldName: "Chill" });
  const chips = combatConditionsPayload(player);
  assert.equal(chips.length, 1);
  const chip = chips[0];
  assert.deepEqual(Object.keys(chip).sort(), ["effect", "id", "kind", "name", "permanent", "remainingMinutes"]);
  assert.equal(chip.kind, "debuff", "Slow is a debuff chip");
  assert.match(chip.effect, /2 turns left/);
  assert.equal(chip.remainingMinutes, null, "combat durations are turns, not minutes");
});
