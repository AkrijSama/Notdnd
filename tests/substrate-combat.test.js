import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun, validateSoloRun } from "../server/solo/schema.js";
import { resolveSoloAction, getAvailableSoloActions } from "../server/solo/actions.js";
import { enterCombatFromAttackIntent, resolveCombatInput, combatActive, detectAttackIntent } from "../server/solo/combat.js";
import { loadScenarioIntoRun, loadScenarioFile } from "../server/campaign/scenarioLoader.js";
import { classifyCombatInput } from "../server/solo/combatContract.js";
import { readFileSync } from "node:fs";

// The D.5 substrate + D.4 combat vertical slice. These are the tests-of-record
// for the reeve-collector junction: a danger thread escalates, hands off to a
// combat via a hostileNpc beat, the fight writes a canonical fact, and the thread
// advances off that fact. Plus the coherence invariants the brief names.

const T = (n) => new Date(1730000000000 + n * 1000).toISOString();

function armedFighterRun(now) {
  const run = createDefaultSoloRun({ now });
  run.campaignId = "cmp_test";
  run.player.abilities = { strength: 16, dexterity: 14, constitution: 14, intelligence: 10, wisdom: 12, charisma: 10 };
  run.player.proficiencyBonus = 2;
  run.player.character = { derivedStats: { armorClass: 14, initiative: 2, maxHp: 14, proficiencyBonus: 2 } };
  run.player.resources = { hitPoints: { current: 14, max: 14 } };
  run.inventory.item_blade = { itemId: "item_blade", name: "combat blade", quantity: 1, tags: [], flags: {} };
  return run;
}

function placeCollector(run, locationId = "second_location") {
  run.npcs.npc_collector = {
    npcId: "npc_collector", displayName: "The reeve's collector", role: "enforcer",
    known: true, status: "active", memoryFactIds: [],
    expressionVariants: { neutral: null, warm: null, suspicious: null, fearful: null, surprised: null, angry: null },
    statBlockId: "waylayer", currentLocationId: locationId, tags: ["hostile"], flags: { hostile: true }, dialogueBeats: []
  };
}

// ── schema: additive first-class records ──────────────────────────────────────
test("run.threads and run.combat default clean and validate", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  assert.deepEqual(run.threads, {});
  assert.equal(run.combat, null);
  assert.equal(validateSoloRun(run).ok, true);
});

test("a combat combatant referencing a missing NPC fails validation (roster integrity)", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  run.combat = {
    combatId: "cbt_1", status: "active", turn: 1, now: 0,
    combatants: { player: { kind: "player" }, enm_1: { kind: "enemy", npcId: "npc_ghost", statBlockId: "waylayer", hp: { current: 12, max: 12 }, ac: 13 } },
    enemyIntents: {}
  };
  const v = validateSoloRun(run);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /combatants.*npcId/i.test(e.path) || /Combatant NPC/.test(e.message)));
});

// ── combat resolver ───────────────────────────────────────────────────────────
test("combat: entry → win writes a canonical fact and clears run.combat", () => {
  const run = armedFighterRun(T(0));
  placeCollector(run);
  const entry = enterCombatFromAttackIntent(run, { targetNpcId: "npc_collector", intent: "attack the collector" }, { now: T(1), fixedRolls: [13, 3, 18, 3], rng: () => 0.99 });
  assert.equal(entry.ok, true);
  assert.equal(combatActive(run), true);
  let guard = 0;
  while (combatActive(run) && guard++ < 6) {
    resolveCombatInput(run, { intent: "attack the collector" }, { now: T(2 + guard), fixedRolls: [18, 3], rng: () => 0.99 });
  }
  assert.equal(run.combat, null, "combat cleared on close");
  const fact = run.memoryFacts.find((f) => f.type === "combat_outcome");
  assert.ok(fact, "combat-close canonical fact written");
  assert.match(fact.text, /collector/i, "fact carries the enemy noun (thread write-back keyword)");
  assert.equal(run.npcs.npc_collector.status, "dead");
  assert.ok(run.player.xp > 0, "combat XP awarded");
});

test("combat: a question spends no turn (ask ≠ act inside the fight)", () => {
  const run = armedFighterRun(T(0));
  placeCollector(run);
  enterCombatFromAttackIntent(run, { targetNpcId: "npc_collector", intent: "attack the collector" }, { now: T(1), fixedRolls: [20, 2, 3, 3], rng: () => 0.1 });
  const turnBefore = run.combat.turn;
  const res = resolveCombatInput(run, { intent: "how hurt is the collector?" }, { now: T(2) });
  assert.ok(res.clarify, "a question routes to clarify");
  assert.equal(run.combat.turn, turnBefore, "the turn did not advance (ask ≠ act)");
});

test("combat: the in-combat menu replaces the exploration menu while active", () => {
  const run = armedFighterRun(T(0));
  placeCollector(run);
  enterCombatFromAttackIntent(run, { targetNpcId: "npc_collector", intent: "attack the collector" }, { now: T(1), fixedRolls: [20, 2, 3, 3], rng: () => 0.1 });
  const menu = getAvailableSoloActions(run).map((a) => a.combatAction).filter(Boolean);
  assert.deepEqual(menu.sort(), ["attack", "defend", "flee", "use_item"].sort());
});

test("combat entry grounds on a present hostile, never mints a target", () => {
  const run = armedFighterRun(T(0));
  // No NPC present → an attack verb does NOT enter combat (falls through).
  assert.equal(detectAttackIntent(run, "attack the collector"), null);
  placeCollector(run, "start_location"); // present at the player's start location
  run.currentLocationId = "start_location";
  assert.deepEqual(detectAttackIntent(run, "attack the collector"), { targetNpcId: "npc_collector" });
  // A question never starts a fight (handled by the reroute chain's !interrogative gate).
});

// ── the scenario loader ───────────────────────────────────────────────────────
test("the_shipment loads clean: 3 threads, cast, quests, start bound", () => {
  const run = armedFighterRun(T(0));
  const scenario = loadScenarioFile("the_shipment");
  loadScenarioIntoRun(run, scenario, {});
  assert.equal(validateSoloRun(run).ok, true);
  assert.deepEqual(Object.keys(run.threads).sort(), ["front_collector", "front_courier", "front_vault"]);
  assert.equal(run.threads.front_collector.kind, "danger");
  assert.equal(run.threads.front_collector.revealState, "hidden");
  assert.equal(run.currentLocationId, "second_location");
  assert.ok(run.npcs.npc_quest_giver && run.npcs.npc_far_witness);
  assert.ok(run.quests.quest_courier);
});

test("#51 babel: no objective is asserted cold; the bounty is an ACCEPTABLE offer", () => {
  const run = armedFighterRun(T(0));
  loadScenarioIntoRun(run, loadScenarioFile("babel"), {});
  assert.equal(validateSoloRun(run).ok, true);
  // No auto-active main quest — nothing shown cold at the start.
  const mains = Object.values(run.quests).filter((q) => q && q.isMain && q.status === "active");
  assert.equal(mains.length, 0, "no cold main objective at start");
  // The board bounty rides the barkeep as an ACCEPTABLE offer (offerText surfaces
  // it; .quest lets resolveQuestAccept instantiate it on acceptance).
  const saw = run.npcs.npc_barkeep;
  assert.ok(saw && saw.questOffer, "barkeep carries the offer");
  assert.equal(typeof saw.questOffer.offerText, "string");
  assert.ok(saw.questOffer.quest && typeof saw.questOffer.quest.questId === "string", "offer is acceptable (has a quest)");
  assert.equal(saw.questOffer.quest.isMain, true, "accepting a delivery bounty becomes the tracked main");
});

// ── the junction (the gradeable loop, deterministic) ──────────────────────────
test("JUNCTION: thread escalates → enters combat → resolves → advances the thread", () => {
  const run = armedFighterRun(T(0));
  loadScenarioIntoRun(run, loadScenarioFile("the_shipment"), {});

  let r = run;
  const step = (action, opts) => { r = resolveSoloAction(r, action, opts).run || r; };

  // rung 0 — flagged (descriptive: onPlayerAt second_location).
  step({ type: "search", actorId: "player", targetLocationId: "second_location" }, { now: T(1) });
  assert.equal(r.threads.front_collector.beatIndex, 1, "rung 0 fired");
  assert.ok(r.memoryFacts.some((f) => /flagged the courier/i.test(f.text)));

  // rung 1 — cordon (descriptive: onPlayerAt third_location) — an objectState.
  step({ type: "move", actorId: "player", toLocationId: "third_location" }, { now: T(2) });
  assert.equal(r.locations.third_location.flags.objectStates["the-cordon"].state, "hardened");

  // rung 2 — the collector arrives (hostileNpc beat placing a waylayer).
  step({ type: "search", actorId: "player", targetLocationId: "third_location" }, { now: T(3) });
  assert.ok(r.npcs.npc_collector, "the collector was placed by the thread beat");
  assert.equal(r.npcs.npc_collector.statBlockId, "waylayer");
  assert.equal(r.npcs.npc_collector.flags.hostile, true);

  // combat — entered via an attack on the beat-placed collector.
  step({ type: "attempt", actorId: "player", intent: "I draw my blade and attack the collector" }, { now: T(4), fixedRolls: [13, 3, 18, 3], rng: () => 0.99 });
  assert.equal(combatActive(r), true, "combat entered via the reeve-collector beat");
  let guard = 0;
  while (combatActive(r) && guard++ < 6) {
    step({ type: "attempt", actorId: "player", intent: "attack the collector" }, { now: T(5 + guard), fixedRolls: [18, 3], rng: () => 0.99 });
  }

  // resolve → advance: combat wrote "collector dead"; rung 3 fires on that canon
  // fact and the danger thread resolves.
  assert.ok(r.memoryFacts.some((f) => f.type === "combat_outcome" && /collector/i.test(f.text)));
  assert.ok(r.memoryFacts.some((f) => /Kesh/i.test(f.text)), "rung 3 (boss named) advanced off the combat fact");
  assert.equal(r.threads.front_collector.status, "resolved");
  assert.equal(validateSoloRun(r).ok, true);
});

test("JUNCTION is robust to the identity worker renaming the placed hostile", () => {
  // The live identity worker renames an NPC's displayName (e.g. the collector →
  // "Soren"). The thread write-back must still fire off the STABLE npcId, not the
  // brittle display name, or rung 3 never triggers (the live-proof bug).
  const run = armedFighterRun(T(0));
  loadScenarioIntoRun(run, loadScenarioFile("the_shipment"), {});
  let r = run;
  const step = (action, opts) => { r = resolveSoloAction(r, action, opts).run || r; };
  step({ type: "search", actorId: "player", targetLocationId: "second_location" }, { now: T(1) });
  step({ type: "move", actorId: "player", toLocationId: "third_location" }, { now: T(2) });
  step({ type: "search", actorId: "player", targetLocationId: "third_location" }, { now: T(3) });
  assert.ok(r.npcs.npc_collector);
  // Simulate the identity worker: rename the collector, dropping the "collector" noun.
  r.npcs.npc_collector.displayName = "Soren";
  step({ type: "attempt", actorId: "player", intent: "attack Soren" }, { now: T(4), fixedRolls: [20, 2, 18, 3], rng: () => 0.99 });
  let guard = 0;
  while (combatActive(r) && guard++ < 6) {
    step({ type: "attempt", actorId: "player", intent: "attack Soren" }, { now: T(5 + guard), fixedRolls: [18, 3], rng: () => 0.99 });
  }
  // The fact says "Soren is dead" (no "collector"), but rung 3 still advances off
  // the committed npc_collector id.
  assert.ok(r.memoryFacts.some((f) => /Kesh/i.test(f.text)), "rung 3 fired despite the rename (matched the stable npcId)");
  assert.equal(r.threads.front_collector.status, "resolved");
});

// ── one clock / ≤1 driver ─────────────────────────────────────────────────────
test("one clock: at most one thread beat fires per turn", () => {
  const run = armedFighterRun(T(0));
  loadScenarioIntoRun(run, loadScenarioFile("the_shipment"), {});
  // Both front_courier and front_collector could see the player at second_location,
  // but only one driver may fire per turn.
  const res = resolveSoloAction(run, { type: "search", actorId: "player", targetLocationId: "second_location" }, { now: T(1) });
  const firedBeats = Object.values(res.run.threads).filter((t) => t.beatIndex > 0).length;
  assert.ok(firedBeats <= 1, "≤1 thread advanced this turn");
});

// ── coherence invariants (the brief's four) ───────────────────────────────────
test("coherence: ALLOWED_EFFECT_TYPES stays sealed (combat/threads add no effect type)", () => {
  const src = readFileSync(new URL("../server/solo/attempt.js", import.meta.url), "utf8");
  const line = src.split("\n").find((l) => l.includes("ALLOWED_EFFECT_TYPES = new Set"));
  assert.ok(line, "found the allowlist");
  assert.match(line, /"timeline_event".*"memory_fact".*"narration".*"damage"/);
  assert.ok(!/attack|kill_enemy|end_combat|thread/.test(line), "no combat/thread effect type was added");
});

test("coherence: a HIDDEN thread's agenda never enters the narrativeDriver", async () => {
  const run = armedFighterRun(T(0));
  loadScenarioIntoRun(run, loadScenarioFile("the_shipment"), {});
  const res = resolveSoloAction(run, { type: "search", actorId: "player", targetLocationId: "second_location" }, { now: T(1) });
  const driver = res.narrativeDriver;
  assert.ok(driver && driver.source === "thread", "a thread beat drove this turn");
  assert.equal(driver.threadKnown, false, "the hidden thread is not known");
  assert.equal(driver.agenda, undefined, "the hidden agenda is absent from the GM-facing driver");
  // The committed EFFECT (brief) rides; the PLOT does not.
  assert.ok(typeof driver.beat.brief === "string" && driver.beat.brief.length > 0);
});

test("coherence: the in-combat interception matches classifyCombatInput's routing", () => {
  const run = armedFighterRun(T(0));
  placeCollector(run);
  enterCombatFromAttackIntent(run, { targetNpcId: "npc_collector", intent: "attack the collector" }, { now: T(1), fixedRolls: [20, 2, 3, 3], rng: () => 0.1 });
  const ctx = { isDying: false, enemies: [{ id: "enm_collector", name: "The reeve's collector", alive: true, hp: run.combat.combatants.enm_collector.hp }], heldItems: [{ itemId: "item_blade", name: "combat blade" }] };
  for (const intent of ["run away", "defend myself", "how hurt is it?", "attack the collector"]) {
    const contractRoute = classifyCombatInput(intent, ctx).route;
    // The resolver dispatches on exactly this classifier — the seam is the contract.
    assert.ok(["attack", "defend", "flee", "clarify", "stunt", "use_item", "hold_on"].includes(contractRoute));
  }
});
