// SCENE REGISTER — the steel/furniture migration regression (owner 2026-07-21).
//
// The scene-art tone clause used to be a HARDCODED Verdance line appended to every scene
// prompt of every world ("beautiful yet subtly wrong … over-still water") — a cyberpunk
// alley rendered with over-still water. It is now furniture: babel.json carries its own
// `world.sceneRegister`, and the engine default is EMPTY.
//
// The migration contract, both halves:
//   1. Babel's scene prompt is UNCHANGED (the clause still rides, now from data).
//   2. A world that declares no register gets NO register clause.
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { loadScenarioIntoRun, loadScenarioFile } from "../server/campaign/scenarioLoader.js";
import { buildScenePrompt } from "../server/solo/imageWorker.js";

const VERDANCE_REGISTER =
  "beautiful yet subtly wrong, uneasy stillness, faint shimmer in the air, over-still water, off light";

function babelRun() {
  const run = createDefaultSoloRun({ runId: "reg" });
  run.worldSeed = "reg";
  run.world = run.world || {};
  run.world.variant = "babel";
  loadScenarioIntoRun(run, loadScenarioFile("babel"), {});
  return run;
}

test("babel still carries its scene register — now as authored data, not engine steel", () => {
  const run = babelRun();
  assert.equal(
    run.world.sceneRegister,
    VERDANCE_REGISTER,
    "the loader must carry world.sceneRegister through to the run (whitelist at scenarioLoader.js)"
  );
  const prompt = buildScenePrompt(run, run.locations.loc_waking_mile, "loc_waking_mile");
  assert.ok(prompt.includes(VERDANCE_REGISTER), "babel's scene prompt must be unchanged by the migration");
});

test("a world that declares no register gets NO register clause (the leak is closed)", () => {
  const run = createDefaultSoloRun({ runId: "neon" });
  run.world = { name: "Neon City", tone: "cyberpunk" };
  const prompt = buildScenePrompt(run, { name: "A rain-slick alley", description: "Neon signs buzz." }, "loc_alley");
  assert.ok(!prompt.includes("over-still water"), "a cyberpunk alley must not inherit the Verdance tone law");
  assert.ok(!prompt.includes("subtly wrong"), "no world-specific register may leak into an undeclared world");
  assert.ok(prompt.includes("cyberpunk"), "the world's own tone still rides");
});

test("an authored register is honored verbatim for any world", () => {
  const run = createDefaultSoloRun({ runId: "ash" });
  run.world = { name: "Ashfall", tone: "post-apocalyptic", sceneRegister: "ash-choked air, colorless light" };
  const prompt = buildScenePrompt(run, { name: "The Dust Road", description: "Cracked asphalt." }, "loc_road");
  assert.ok(prompt.includes("ash-choked air, colorless light"), "each world supplies its own register");
});
