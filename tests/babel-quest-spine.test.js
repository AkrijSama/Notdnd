// A3.2 + A3.3 — the Babel quest spine + Elkwater notices. Two completable, stage-based
// quests; the Warm House's LIVE chaosling spawn (mint-on-demand into the scene, carrying
// a high-tier skill); St. Brigid's committed medicine loot; the desperate-register board.
import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { loadScenarioIntoRun, loadScenarioFile } from "../server/campaign/scenarioLoader.js";
import { resolveSoloAction } from "../server/solo/actions.js";
import { spawnChaoslingOnEnter } from "../server/solo/chaoslingSpawn.js";
import { resolveStatBlock } from "../server/campaign/bestiary.js";
import { enterCombatFromAttackIntent, combatActive } from "../server/solo/combat.js";

function babelRun() {
  const run = createDefaultSoloRun({ runId: "spine_run" });
  run.worldSeed = "spine_run";
  run.world = run.world || {}; run.world.variant = "babel";
  loadScenarioIntoRun(run, loadScenarioFile("babel"), {});
  return run;
}

test("both quests load as active, stage-based, completable arcs", () => {
  const run = babelRun();
  const wh = run.quests.quest_warm_house;
  const med = run.quests.quest_medicine_run;
  assert.equal(wh?.status, "active");
  assert.equal(wh.stages.length, 2);
  assert.deepEqual(wh.completion, { kind: "reach_location", targetId: "loc_warm_house" });
  assert.equal(med.stages.length, 2);
  assert.deepEqual(med.completion, { kind: "reach_location", targetId: "loc_st_brigids" });
});

test("LIVE CHAOSLING SPAWN: entering the Warm House mints a hostile foe that resolves + carries a high-tier skill", () => {
  const run = babelRun();
  const spawned = spawnChaoslingOnEnter(run, "loc_warm_house");
  assert.ok(spawned, "a chaosling was minted into the scene");
  const npc = run.npcs[spawned.npcId];
  assert.equal(npc.flags.hostile, true, "placed as a hostile");
  assert.equal(npc.currentLocationId, "loc_warm_house");
  const block = resolveStatBlock(npc.statBlockId);
  assert.ok(block, "the minted block RESOLVES (runtime overlay)");
  assert.ok(block.carriedSkills.some((s) => s.skillId === "charm-person"), "the rapture-born nastier mint carries a high-tier skill");
  assert.ok(run.mintedStatBlocks[npc.statBlockId], "persisted on the run (restart-safe)");
  // fires ONCE
  assert.equal(spawnChaoslingOnEnter(run, "loc_warm_house"), null, "does not re-spawn on a second entry");
});

test("the spawned Warm House foe is attackable → real combat", () => {
  const run = babelRun();
  run.currentLocationId = "loc_warm_house";
  const spawned = spawnChaoslingOnEnter(run, "loc_warm_house");
  const r = enterCombatFromAttackIntent(run, { targetNpcId: spawned.npcId, intent: "attack the thing" }, { now: new Date(1730000000000).toISOString(), fixedRolls: [10], rng: () => 0.5 });
  assert.equal(r.ok, true, "combat entered against the spawned foe");
  const acts = r.combatRound?.actions || [];
  assert.ok(acts.some((a) => a.actor === "player" && a.kind === "attack"), "the player struck the minted foe");
  assert.ok(acts.some((a) => a.actor !== "player"), "the minted foe resolved into a real fight (its statBlock loaded + it acted)");
});

test("moving into the Warm House (the real turn path) spawns the foe AND advances the quest", () => {
  const run = babelRun();
  run.currentLocationId = "loc_elkwater_crossing";
  run.locations.loc_warm_house.state = { ...(run.locations.loc_warm_house.state || {}), discovered: true, visited: false };
  const res = resolveSoloAction(run, { type: "move", toLocationId: "loc_warm_house" }, {});
  const after = res.run || run;
  assert.equal(after.currentLocationId, "loc_warm_house", "arrived");
  assert.ok(after.npcs.npc_warmhouse_born, "the spawn hook fired on arrival");
  assert.ok(after.quests.quest_warm_house.stage >= 1, "reach_location advanced the Warm House quest");
});

test("St. Brigid's carries the committed medicine loot + the Congregation breadcrumb", () => {
  const run = babelRun();
  const details = run.locations.loc_st_brigids.searchDetails || [];
  const supplies = details.find((d) => d.detailId === "st_brigids_supplies");
  assert.ok(supplies && supplies.takeable, "the medicine is takeable committed loot");
  assert.equal(supplies.grantItem.itemId, "item_medicine_cache");
  const trail = details.find((d) => d.detailId === "st_brigids_outbound_trail");
  assert.match(trail.description, /Congregation/, "the outbound trail reads the Congregation breadcrumb");
});

test("A3.3 — Elkwater's board carries 4-5 desperate notices; 2 are wired to the quests", () => {
  const run = babelRun();
  const notices = run.locations.loc_elkwater_crossing.notices || [];
  assert.ok(notices.length >= 4 && notices.length <= 5, `4-5 postings (got ${notices.length})`);
  const wired = notices.filter((n) => n.questId);
  assert.equal(wired.length, 2, "exactly two notices route to real quests");
  assert.ok(wired.some((n) => n.questId === "quest_medicine_run") && wired.some((n) => n.questId === "quest_warm_house"));
  assert.ok(notices.every((n) => typeof n.text === "string" && n.text.length > 0), "every notice has copy");
});
