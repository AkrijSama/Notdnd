// JOB 1 (F2/F3) — rank + rankedSkillCount are BABEL canon, not engine law. The scene payload
// emitted them UNGATED for every world while babelStats/babelSkills two lines down were
// variant-gated. GATE: (a) Babel byte-identical — it still emits a rank; (b) a non-Babel world
// emits neither (no Solo-Leveling ladder leaks into cyberpunk).
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { loadScenarioIntoRun, loadScenarioFile } from "../server/campaign/scenarioLoader.js";
import { buildSoloScenePayload } from "../server/solo/scene.js";

test("GATE(babel byte-identical): a Babel run still emits rank + a numeric rankedSkillCount", () => {
  const run = createDefaultSoloRun({ runId: "rank_babel" });
  loadScenarioIntoRun(run, loadScenarioFile("babel"), {});
  const p = buildSoloScenePayload(run);
  assert.equal(run.world.variant, "babel", "the babel loader stamps variant=babel");
  assert.notEqual(p.player.rank, null, "babel still emits a rank readout (UNASSESSED until a skill is ranked)");
  assert.equal(typeof p.player.rankedSkillCount, "number", "babel emits a numeric ranked-skill count");
});

test("GATE(non-babel: NO leak): a non-Babel run emits NO rank and NO rankedSkillCount", () => {
  const run = createDefaultSoloRun({ runId: "rank_neon" });
  // A default run is not the Babel family (no variant stamp) — the cyberpunk case.
  assert.notEqual(run.world.variant, "babel", "a default (non-Babel) run must not be variant=babel");
  const p = buildSoloScenePayload(run);
  assert.equal(p.player.rank, null, "no Babel rank leaks to a non-Babel world");
  assert.equal(p.player.rankedSkillCount, null, "no Babel rankedSkillCount leaks to a non-Babel world");
});
