// A3.1 ROMANCE REACHABILITY (audit 5d548ac). The romance two-track was unreachable in
// authored/user worlds because loadScenarioIntoRun never applied the law-R2 romanceable
// default to authored cast (it ran only in the sandbox branch). Now authored cast is
// romance-eligible — behind the same fail-closed age wall. No model calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { loadScenarioIntoRun } from "../server/campaign/scenarioLoader.js";
import { isRomanceEligible, isAdult } from "../server/solo/reputation.js";

const babel = JSON.parse(fs.readFileSync(path.resolve("server/campaign/scenarios/babel.json"), "utf8"));

function loadedBabelRun() {
  const run = createDefaultSoloRun({ runId: "romance_reach" });
  run.world = run.world || {};
  run.world.variant = "babel";
  loadScenarioIntoRun(run, babel, {});
  return run;
}

test("a Babel authored NPC is romance-eligible after loading (the wiring)", () => {
  const run = loadedBabelRun();
  const castIds = (babel.cast || []).map((c) => c.npcId);
  const eligible = castIds.filter((id) => run.npcs[id] && isRomanceEligible(run.npcs[id]));
  assert.ok(eligible.length >= 1, `at least one Babel cast NPC is romance-eligible (got ${eligible.length} of ${castIds.length})`);
});

test("the age wall stays fail-closed: only affirmed adults are eligible", () => {
  const run = loadedBabelRun();
  for (const npc of Object.values(run.npcs)) {
    if (isRomanceEligible(npc)) {
      assert.equal(isAdult(npc), true, `${npc.npcId} is eligible only because it is an affirmed adult`);
    }
  }
  // A synthetic child cast never becomes eligible even though it loads through the same path.
  const run2 = createDefaultSoloRun({ runId: "romance_child" });
  run2.world.variant = "babel";
  const scenarioWithChild = { ...babel, cast: [...babel.cast, { npcId: "npc_child_test", displayName: "Wren", role: "child", at: "start_location", ageClass: "child" }] };
  loadScenarioIntoRun(run2, scenarioWithChild, {});
  assert.equal(isRomanceEligible(run2.npcs.npc_child_test), false, "a child NPC is never romance-eligible (fail-closed)");
});

test("an explicit authored romanceable:false is honored", () => {
  const run = createDefaultSoloRun({ runId: "romance_optout" });
  run.world.variant = "babel";
  const scenarioOptOut = { ...babel, cast: [...babel.cast, { npcId: "npc_optout_test", displayName: "Ledgerkeeper", role: "clerk", at: "start_location", romanceable: false }] };
  loadScenarioIntoRun(run, scenarioOptOut, {});
  assert.equal(run.npcs.npc_optout_test.romanceable, false, "authored opt-out wins over the default");
  assert.equal(isRomanceEligible(run.npcs.npc_optout_test), false);
});
