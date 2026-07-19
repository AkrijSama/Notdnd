// A2.2 (the five formerly-inert statuses + haste applier) and A3.4 (high-tier chaos
// skills: charm-person, vision-share, telepathy). All the sealed ten now DO something,
// and the mind skills use them. Deterministic; no model.
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCombatStatus, statusAttackDisadvantage, statusSkillsLocked, statusAsleep,
  statusMisdirects, wakeOnDamage, absorbWithShield, combatantHasStatus
} from "../server/solo/combatStatus.js";
import { spawnChaosling } from "../server/campaign/bestiary.js";
import { resolveStatBlock } from "../server/campaign/bestiary.js";
import { selectEnemyIntent, applyPackVisionShare } from "../server/solo/combat.js";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { loadScenarioIntoRun, loadScenarioFile } from "../server/campaign/scenarioLoader.js";
import { enterCombatFromAttackIntent, resolveCombatInput } from "../server/solo/combat.js";

const combat = () => ({ combatId: "c", now: 0, combatants: {} });
const enemy = () => ({ kind: "enemy", conditions: [], nextTick: 10, ctb: { haste: false, slow: false } });

// ── A2.2: the five inert statuses, now real ──────────────────────────────────

test("BLIND → attack disadvantage; SILENCE → skills locked", () => {
  const c = enemy();
  applyCombatStatus(combat(), c, "blind");
  assert.equal(statusAttackDisadvantage(c), true);
  applyCombatStatus(combat(), c, "silence");
  assert.equal(statusSkillsLocked(c), true);
});

test("SLEEP → asleep, and ANY damage wakes it", () => {
  const c = enemy();
  applyCombatStatus(combat(), c, "sleep");
  assert.equal(statusAsleep(c), true);
  assert.equal(wakeOnDamage(c), true, "damage woke it");
  assert.equal(statusAsleep(c), false, "no longer asleep");
});

test("CONFUSE → seeded misdirect (both outcomes reachable; absent = never)", () => {
  const c = enemy();
  assert.equal(statusMisdirects(c, "any"), false, "no confuse → never misdirects");
  applyCombatStatus(combat(), c, "confuse");
  const results = Array.from({ length: 24 }, (_, i) => statusMisdirects(c, `seed${i}`));
  assert.ok(results.includes(true) && results.includes(false), "misdirect fires sometimes, not always");
  assert.equal(statusMisdirects(c, "seed3"), statusMisdirects(c, "seed3"), "deterministic per seed");
});

test("SHIELD → a damage-absorb pool that depletes then expires", () => {
  const c = enemy();
  applyCombatStatus(combat(), c, "shield", { absorb: 5 });
  const a = absorbWithShield(c, 3);
  assert.deepEqual(a, { amount: 0, absorbed: 3 }, "3 fully soaked");
  const b = absorbWithShield(c, 5);
  assert.equal(b.absorbed, 2, "2 left in the pool");
  assert.equal(b.amount, 3, "the rest lands");
  assert.equal(combatantHasStatus(c, "shield"), false, "the pool is spent → shield gone");
});

test("HASTE applier wired (queue op flips the ctb flag)", () => {
  const c = enemy();
  applyCombatStatus(combat(), c, "haste");
  assert.equal(c.ctb.haste, true, "haste bends the CTB queue");
});

// ── A3.4: high-tier chaos skills ─────────────────────────────────────────────

test("SPAWN WIRING: spawnChaosling mints, registers, and forces a skill (resolvable)", () => {
  const block = spawnChaosling({ baseAnimalId: "grey_wolf", tier: 3, seed: "spawn1", forceSkill: "charm-person" });
  assert.ok(block && block.statBlockId, "a block was minted");
  assert.equal(resolveStatBlock(block.statBlockId), block, "it is now resolvable (runtime overlay)");
  assert.ok(block.carriedSkills.some((s) => s.skillId === "charm-person"), "the forced skill is carried");
  assert.ok(block.intents.some((i) => i.kind === "skill" && i.skillId === "charm-person"), "charm is a usable combat intent");
});

test("TELEPATHY intent-mask: telegraph reads '???' until revealed (FOCUS counters it)", () => {
  const block = spawnChaosling({ baseAnimalId: "grey_wolf", tier: 3, seed: "tele1", forceSkill: "telepathy" });
  const run = { runId: "r", worldSeed: "r" };
  const cbt = { combatId: "c", combatants: {} };
  const foe = { combatantId: "e1", kind: "enemy", statBlockId: block.statBlockId, conditions: [], hp: { current: 12, max: 12 }, revealed: false };
  const masked = selectEnemyIntent(run, cbt, foe, 1);
  assert.equal(masked.telegraph, "???", "the tell is masked");
  assert.equal(masked.masked, true);
  foe.revealed = true; // what a player FOCUS sets
  const seen = selectEnemyIntent(run, cbt, foe, 1);
  assert.notEqual(seen.telegraph, "???", "FOCUS unmasks the tell");
});

test("VISION-SHARE (pack): reveals the pack + shares advantage + tempo (haste)", () => {
  const carrier = spawnChaosling({ baseAnimalId: "coyote", tier: 3, seed: "vs1", forceSkill: "vision-share" });
  const cbt = { combatId: "c", now: 0, combatants: {
    e1: { combatantId: "e1", kind: "enemy", statBlockId: carrier.statBlockId, hp: { current: 8, max: 8 }, conditions: [], flags: {}, ctb: { haste: false }, nextTick: 10, revealed: false },
    e2: { combatantId: "e2", kind: "enemy", statBlockId: carrier.statBlockId, hp: { current: 8, max: 8 }, conditions: [], flags: {}, ctb: { haste: false }, nextTick: 10, revealed: false }
  } };
  applyPackVisionShare(cbt);
  assert.equal(cbt.combatants.e1.revealed, true, "pack revealed");
  assert.equal(cbt.combatants.e2.flags.edgeNextTurn, true, "shared advantage");
  assert.equal(cbt.combatants.e1.ctb.haste, true, "shared tempo (haste applier)");
});

test("CHARM-PERSON: a successful charm CONFUSES the player (contested, mid-fight)", () => {
  const block = spawnChaosling({ baseAnimalId: "grey_wolf", tier: 3, seed: "charm1", forceSkill: "charm-person" });
  const run = createDefaultSoloRun({ runId: "charm_run" });
  run.worldSeed = "charm_run";
  run.player.abilities = { strength: 12, dexterity: 12, constitution: 12, intelligence: 10, wisdom: 10, charisma: 10 };
  run.player.resources = { hitPoints: { current: 30, max: 30 } };
  run.player.character = { derivedStats: { armorClass: 14, maxHp: 30, proficiencyBonus: 2 } };
  loadScenarioIntoRun(run, loadScenarioFile("babel"), {});
  run.currentLocationId = "loc_waking_mile";
  run.npcs.npc_charmer = { npcId: "npc_charmer", displayName: "The Whisperer", role: "chaosling", currentLocationId: "loc_waking_mile", status: "present", known: true, flags: { hostile: true }, statBlockId: block.statBlockId, ageClass: "adult", tags: [], memoryFactIds: [] };
  enterCombatFromAttackIntent(run, { targetNpcId: "npc_charmer", intent: "attack the whisperer" }, { now: new Date(1730000000000).toISOString(), fixedRolls: [2], rng: () => 0.5 });
  const eid = Object.keys(run.combat.combatants).find((id) => id !== "player");
  run.combat.enemyIntents[eid] = { intentId: "charm-person", kind: "skill", skillId: "charm-person" };
  resolveCombatInput(run, { intent: "strike the whisperer" }, { now: new Date(1730000005000).toISOString(), fixedRolls: [2, 18], rng: () => 0.5 });
  const player = run.combat?.combatants?.player;
  assert.ok(player, "fight still live");
  assert.equal(combatantHasStatus(player, "confuse"), true, "the charm landed → the player is confused (charmed)");
});
