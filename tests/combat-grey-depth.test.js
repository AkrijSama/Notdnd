// A2 COMBAT DEPTH — the Limping Grey is a fight worth having. KILL-path acceptance
// (the audit's coverage gap: only flee/death were Grey-tested), the chill-bite OPENER
// signature (tactic policy → chilled bends the player's CTB tick), the essence-sight
// FOCUS active, and a real DEFEND. Deterministic (fixedRolls + seeded rng); no model.
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { loadScenarioIntoRun, loadScenarioFile } from "../server/campaign/scenarioLoader.js";
import { enterCombatFromAttackIntent, resolveCombatInput, combatActive } from "../server/solo/combat.js";

const T = (n) => new Date(1730000000000 + n * 1000).toISOString();
function fighter(now, { ac = 16, hp = 20 } = {}) {
  const run = createDefaultSoloRun({ now });
  run.player.abilities = { strength: 16, dexterity: 16, constitution: 14, intelligence: 10, wisdom: 12, charisma: 10 };
  run.player.proficiencyBonus = 2;
  run.player.character = { derivedStats: { armorClass: ac, initiative: 3, maxHp: hp, proficiencyBonus: 2 } };
  run.player.resources = { hitPoints: { current: hp, max: hp } };
  run.inventory.item_blade = { itemId: "item_blade", name: "combat blade", quantity: 1, tags: [], flags: {} };
  loadScenarioIntoRun(run, loadScenarioFile("babel"), {});
  run.currentLocationId = "loc_waking_mile";
  return run;
}
function greyCombatant(run) { return run.combat && Object.values(run.combat.combatants).find((c) => c.statBlockId === "limping_grey"); }
function playerConditions(run) { return run.combat?.combatants?.player?.conditions || []; }

test("KILL-path vs the Limping Grey: crits drop it → dead, combat won, XP awarded", () => {
  const run = fighter(T(0), { ac: 18, hp: 24 });
  // Crit on entry (nat-20, max damage) one-shots the 7-HP Grey before any flee window.
  enterCombatFromAttackIntent(run, { targetNpcId: "npc_limping_grey", intent: "cut the grey down" }, { now: T(1), fixedRolls: [20], rng: () => 0.99 });
  let guard = 0;
  while (combatActive(run) && guard++ < 8) {
    resolveCombatInput(run, { intent: "strike the grey" }, { now: T(2 + guard), fixedRolls: [20], rng: () => 0.99 });
  }
  assert.equal(run.combat, null, "combat closed on the kill");
  assert.equal(run.npcs.npc_limping_grey.status, "dead", "the Grey is a corpse (committed defeat)");
  assert.ok(run.player.xp > 0, "XP flows from a committed kill (the Grey's 45)");
  const fact = run.memoryFacts.find((f) => f.type === "combat_outcome");
  assert.ok(fact, "a canonical combat outcome fact is written");
});

test("OPENER signature: the Grey leads with the chill-bite → the player is Slowed (chilled bends the CTB tick)", () => {
  const run = fighter(T(0), { ac: 12, hp: 24 });
  // Player whiffs the opening (nat-1); the Grey's opener bite then lands (nat-18).
  enterCombatFromAttackIntent(run, { targetNpcId: "npc_limping_grey", intent: "swing at the grey" }, { now: T(1), fixedRolls: [1, 18], rng: () => 0.6 });
  const slowed = playerConditions(run).some((c) => c.engineStatus === "slow");
  assert.equal(slowed, true, "the chill-bite compiled to Slow on the player — its signature is felt on turn one");
  // Slow actually bends tempo: the slowed player's CTB flag is set.
  assert.equal(Boolean(run.combat?.combatants?.player?.ctb?.slow), true, "the slow flag is live on the CTB queue");
});

test("FOCUS (essence-sight active): the Beckoned MC reads the foe → advantage + revealed intent, no damage", () => {
  const run = fighter(T(0), { ac: 16, hp: 24 });
  assert.match(String(run.player.origin || ""), /beckoned/i, "the babel MC loads as The Beckoned (origin-gated FOCUS)");
  enterCombatFromAttackIntent(run, { targetNpcId: "npc_limping_grey", intent: "size up the grey" }, { now: T(1), fixedRolls: [1], rng: () => 0.1 });
  assert.equal(combatActive(run), true, "the fight is live");
  const r = resolveCombatInput(run, { intent: "focus on the grey and read it" }, { now: T(3), fixedRolls: [10], rng: () => 0.3 });
  const focus = r.combatRound?.actions?.find((a) => a.actor === "player" && a.kind === "focus");
  assert.ok(focus, "the read resolved as a FOCUS action");
  assert.ok(focus.read && focus.read.intentId, "it reveals the target's next intent (the read)");
  assert.equal(focus.damage, null, "FOCUS deals no damage — it spends the turn on the read");
  assert.equal(run.player.flags?.advantageNextAttack, true, "the read grants advantage on the next attack");
});

test("DEFEND is real: the guard is set and a landed blow is halved", () => {
  const run = fighter(T(0), { ac: 8, hp: 40 }); // low AC so the Grey reliably lands
  enterCombatFromAttackIntent(run, { targetNpcId: "npc_limping_grey", intent: "swing at the grey" }, { now: T(1), fixedRolls: [1], rng: () => 0.99 });
  const r = resolveCombatInput(run, { intent: "raise a guard and defend" }, { now: T(3), fixedRolls: [20, 20], rng: () => 0.99 });
  assert.equal(run.player.flags?.defendingUntilRound >= 0, true, "the guard flag is set");
  const enemyHit = r.combatRound?.actions?.find((a) => a.actor !== "player" && a.kind === "attack" && a.damage);
  if (enemyHit) {
    // chaos_bite is 1d6+1 → max 7; halved-and-ceiled while defending is ≤ 4.
    assert.ok(enemyHit.damage.amount <= 4, `a defended blow is halved (got ${enemyHit.damage.amount} vs up to 7)`);
  }
});
