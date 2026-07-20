// T5 (world card copy + genre tags) + T6 (landing taxonomy: Custom World card dies,
// sandbox = a module within a world). Client render + schema + loader binding.
import assert from "node:assert/strict";
import test from "node:test";
import { renderOnboardingFlow, WORLD_SELECT_CARDS } from "../src/components/onboardingFlow.js";
import { validateScenario } from "../server/campaign/scenarioSchema.js";
import { resolveRequestedScenario, loadScenarioIntoRun, loadScenarioFile } from "../server/campaign/scenarioLoader.js";
import { createDefaultSoloRun } from "../server/solo/schema.js";

function babelScenario() {
  const s = loadScenarioFile("babel");
  assert.ok(s, "babel scenario loads");
  return s;
}

// ── T5: copy + genre tags ─────────────────────────────────────────────────
test("T5: the Babel card reads 'The Tower of Babel' and carries the isekai genre tag", () => {
  const babel = WORLD_SELECT_CARDS.find((c) => c.scenarioId === "babel");
  assert.equal(babel.title, "The Tower of Babel");
  assert.deepEqual(babel.genreTags, ["isekai"]);
  const html = renderOnboardingFlow({ step: "world", worldDef: {}, userWorlds: [] });
  assert.match(html, /The Tower of Babel/, "new title renders");
  assert.match(html, /class="onb-genre-tag">isekai</, "the isekai genre tag renders on the card");
});

test("T5: genreTags is a validated world-book field (1-2 non-empty strings, optional)", () => {
  const base = babelScenario();
  assert.equal(validateScenario({ ...base, genreTags: ["isekai"] }).ok, true, "1 tag ok");
  assert.equal(validateScenario({ ...base, genreTags: ["isekai", "dark-fantasy"] }).ok, true, "2 tags ok");
  assert.equal(validateScenario({ ...base, genreTags: undefined }).ok, true, "field is optional");
  assert.equal(validateScenario({ ...base, genreTags: ["a", "b", "c"] }).ok, false, "3 tags rejected");
  assert.equal(validateScenario({ ...base, genreTags: [] }).ok, false, "empty rejected");
  assert.equal(validateScenario({ ...base, genreTags: ["", "  "] }).ok, false, "blank strings rejected");
  // babel.json itself carries the tag and stays valid
  assert.deepEqual(base.genreTags, ["isekai"]);
  assert.equal(validateScenario(base).ok, true);
});

// ── T6: landing taxonomy ──────────────────────────────────────────────────
test("T6: the fake 'Custom World' card is GONE; a distinct create tile routes to the wizard", () => {
  const html = renderOnboardingFlow({ step: "world", worldDef: {}, userWorlds: [] });
  assert.doesNotMatch(html, /Custom World/, "no Custom World world-card");
  assert.doesNotMatch(html, /data-world-scenario=""/, "no empty-scenario fake card");
  assert.match(html, /data-world-create="1"/, "a distinct create tile is present");
  assert.match(html, /Create a world/, "create tile copy");
  // the create tile is NOT a world card selection (no scenarioId hook on it)
  assert.match(html, /onb-world-card-create/, "create tile has its own class");
});

// ── T6: sandbox = a MODULE WITHIN A WORLD ─────────────────────────────────
test("T6: a WORLDLESS sandbox stays worldgen; a NAMED sandbox binds to that world's canon", () => {
  // no id → worldless → worldgen (null), unchanged
  assert.equal(resolveRequestedScenario({ scenarioId: null, sandbox: true }), null);
  assert.equal(resolveRequestedScenario({ scenarioId: "", sandbox: true }), null);
  // named world + sandbox → binds to the world (loads the scenario)
  const bound = resolveRequestedScenario({ scenarioId: "babel", sandbox: true });
  assert.ok(bound && bound.scenarioId === "babel", "a named sandbox binds to the world canon");
});

test("T6: a world-bound sandbox loads the world (locations/cast) but NOT the authored opening", () => {
  const scenario = babelScenario();
  const sandboxRun = createDefaultSoloRun({ runId: "sbx" });
  loadScenarioIntoRun(sandboxRun, scenario, { sandbox: true });
  // world canon loaded: the authored locations are present
  assert.ok(Object.keys(sandboxRun.locations).length > 1, "world locations loaded");
  // but the authored opening is stripped: no authored quests, no directed fronts/threads
  assert.equal(Object.keys(sandboxRun.quests).length, 0, "sandbox: no authored quests (open world)");
  assert.equal(Object.keys(sandboxRun.threads).length, 0, "sandbox: no authored fronts/threads");

  // the SAME scenario as a CAMPAIGN (not sandbox) DOES instantiate the authored opening
  const campaignRun = createDefaultSoloRun({ runId: "cmp" });
  loadScenarioIntoRun(campaignRun, scenario, { sandbox: false });
  assert.ok(Object.keys(campaignRun.quests).length > 0, "campaign: authored quests instantiated");
});
