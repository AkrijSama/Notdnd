// COMBAT DEATH & FLEE (D.4 item 10). Enemy morale-flee (injured + outmatched → the
// world remembers), player flee (fortune's verb), and the player-drop → dying path.
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { loadScenarioIntoRun, loadScenarioFile } from "../server/campaign/scenarioLoader.js";
import { enterCombatFromAttackIntent, resolveCombatInput, combatActive } from "../server/solo/combat.js";
import { isDying, isDead } from "../server/solo/death.js";

const T = (n) => new Date(1730000000000 + n * 1000).toISOString();
function fighter(now, { ac = 16, hp = 20 } = {}) {
  // Fixed seed so the morale-flee roll (seeded on worldSeed/runId + combatId + turn) is
  // DETERMINISTIC — otherwise a random runId makes "breaks within N turns" a coin flip.
  const run = createDefaultSoloRun({ now, runId: "flee_fixed" });
  run.worldSeed = "flee_fixed";
  run.player.abilities = { strength: 16, dexterity: 16, constitution: 14, intelligence: 10, wisdom: 12, charisma: 10 };
  run.player.proficiencyBonus = 2;
  run.player.character = { derivedStats: { armorClass: ac, initiative: 3, maxHp: hp, proficiencyBonus: 2 } };
  run.player.resources = { hitPoints: { current: hp, max: hp } };
  run.inventory.item_blade = { itemId: "item_blade", name: "combat blade", quantity: 1, tags: [], flags: {} };
  loadScenarioIntoRun(run, loadScenarioFile("babel"), {});
  run.currentLocationId = "loc_waking_mile";
  return run;
}

test("enemy morale-flee: a wounded, outmatched Grey breaks and COMMITS as fled (alive, world remembers, no XP)", () => {
  const run = fighter(T(0), { ac: 16, hp: 20 });
  // A light opening hit wounds the Grey to ~2 HP (7 − ~5) while the player stays full.
  enterCombatFromAttackIntent(run, { targetNpcId: "npc_limping_grey", intent: "strike the grey" }, { now: T(1), fixedRolls: [15, 2], rng: () => 0.15 });
  // If the fight is still live, keep defending until the wounded Grey breaks.
  let guard = 0;
  while (combatActive(run) && guard++ < 10) {
    resolveCombatInput(run, { intent: "defend" }, { now: T(2 + guard), fixedRolls: [10, 2], rng: () => 0.15 });
  }
  assert.equal(run.combat, null, "combat closed");
  const grey = run.npcs.npc_limping_grey;
  assert.equal(grey.flags?.fled, true, "the Grey committed as fled");
  assert.notEqual(grey.status, "dead", "a fled creature is ALIVE, not a corpse");
  assert.equal(run.player.xp, 0, "no XP for an enemy that escaped (XP flows only from committed defeats)");
  const fact = run.memoryFacts.find((f) => f.type === "combat_outcome");
  assert.match(fact.text, /fled|broke/i, "the fled outcome is a canonical fact (thread-seed hook)");
});

test("player flee: a successful flee check ends combat as fled and relocates", () => {
  const run = fighter(T(0), { ac: 18, hp: 20 }); // high AC so the Grey can't drop the player mid-escape
  // A clean WHIFF opener (nat-1 → failure, no damage) so the Grey stays healthy and
  // does NOT break-and-flee first — the player is the one who breaks off here.
  enterCombatFromAttackIntent(run, { targetNpcId: "npc_limping_grey", intent: "strike the grey" }, { now: T(1), fixedRolls: [1, 2], rng: () => 0.1 });
  const startLoc = run.currentLocationId;
  // Flee: a contested DEX check vs the fastest enemy's dexMod. Nat-20 clears it.
  const r = resolveCombatInput(run, { intent: "I flee, break away and run" }, { now: T(2), fixedRolls: [20], rng: () => 0.9 });
  const fled = r.combatRound?.actions?.find((a) => a.actor === "player" && a.kind === "flee");
  assert.ok(fled?.roll?.hit, "the flee check succeeded");
  assert.equal(run.combat, null, "combat closed on a successful flee");
  assert.notEqual(run.currentLocationId, startLoc, "a successful flee relocates to a connected location");
});

test("player-drop → dying: a lethal enemy blow ends combat 'lost' and hands off to the dying loop", () => {
  const run = fighter(T(0), { ac: 2, hp: 3 }); // fragile + low AC so any Grey hit drops the player
  enterCombatFromAttackIntent(run, { targetNpcId: "npc_limping_grey", intent: "strike the grey" }, { now: T(1), fixedRolls: [1, 20], rng: () => 0.99 });
  // Keep whiffing until the Grey chooses to bite (its intent is seeded/weighted); the
  // moment it lands, the player-drop rule ends combat and hands off to the dying loop.
  let guard = 0;
  while (combatActive(run) && guard++ < 12) {
    resolveCombatInput(run, { intent: "I swing wildly" }, { now: T(2 + guard), fixedRolls: [1, 20], rng: () => 0.99 });
  }
  assert.equal(run.combat, null, "combat cleared on the player drop");
  assert.ok(isDying(run) || isDead(run), "the player is dying/dead — the death machinery owns the aftermath out of combat");
});
