import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderSoloGoals } from "../src/components/soloSceneShell.js";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { buildSoloScenePayload } from "../server/solo/scene.js";
import { captureDeclaredGoal, honorGoalsOnAttempt } from "../server/solo/goals.js";

const CSS = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("scene payload emits committed goals; legacy run emits an empty array", () => {
  const run = createDefaultSoloRun({ runId: "run_ui_goals" });
  const empty = buildSoloScenePayload(run);
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.goals, []);
  captureDeclaredGoal(run, "I'm going to build a shelter before the storm hits", {});
  const withGoal = buildSoloScenePayload(run);
  assert.equal(withGoal.goals.length, 1);
  assert.equal(withGoal.goals[0].scale, "task");
  assert.equal(withGoal.goals[0].state, "active");
});

test("goals rail renders active + achieved rows; empty scene renders nothing", () => {
  assert.equal(renderSoloGoals({}), "");
  assert.equal(renderSoloGoals({ goals: [] }), "");
  const html = renderSoloGoals({
    goals: [
      { goalId: "g1", summary: "build a shelter before the storm hits", scale: "task", state: "active" },
      { goalId: "g2", summary: "become guildmaster", scale: "ambition", state: "achieved" }
    ]
  });
  assert.match(html, /data-solo-goals/);
  assert.match(html, /Goals<\/div>/);
  assert.match(html, /build a shelter before the storm hits/);
  assert.match(html, /solo-goal is-achieved/);
  assert.match(html, /become guildmaster/);
  // The achieved-row strike + goal styles are committed in CSS.
  assert.match(CSS, /\.solo-goal\.is-achieved .solo-goal-summary\s*\{[^}]*line-through/s);
});

test("Project goals render pips reflecting committed progress", () => {
  const html = renderSoloGoals({
    goals: [{ goalId: "g3", summary: "build a keep on the ridge", scale: "project", state: "active", progress: { current: 2, target: 5 } }]
  });
  assert.match(html, /solo-goal-pips/);
  const filled = (html.match(/is-filled/g) || []).length;
  assert.equal(filled, 2, "2 of 5 pips filled");
});

test("an achieved shelter goal surfaces in the payload for the next turn's status window", () => {
  const run = createDefaultSoloRun({ runId: "run_ui_achieved" });
  run.locations[run.currentLocationId].flags.objectStates = {
    "the-sky": { objectId: "the-sky", label: "the sky", state: "storm-breaking", retryEffect: "harder", reason: "", matchTokens: [], targetId: null, sourceIntent: "", since: new Date().toISOString() }
  };
  captureDeclaredGoal(run, "I'm going to build a shelter before the storm hits", { nowMinutes: run.world.time.minutes });
  honorGoalsOnAttempt(run, { intent: "I build a shelter", attemptResult: { band: "success" }, nowMinutes: run.world.time.minutes });
  const payload = buildSoloScenePayload(run);
  const shelter = payload.goals.find((g) => /shelter/.test(g.summary));
  assert.ok(shelter);
  assert.equal(shelter.state, "achieved");
});
