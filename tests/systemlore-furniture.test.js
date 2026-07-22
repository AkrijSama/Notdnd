// SYSTEM-LORE FURNITURE MIGRATION — regression gate (2026-07-21, CLI-2).
// The WINDOW/VOICE lore content moved from an engine constant to world.systemLore.
// GATE: (a) Babel byte-identical — the clause + auditor are unchanged for babel;
// (b) the non-Babel world (cyberpunk-alley) loads and NO LONGER inherits the leak.
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { loadScenarioIntoRun, loadScenarioFile } from "../server/campaign/scenarioLoader.js";
import { buildSystemLoreClause, detectSystemLoreViolations } from "../server/gm/systemLore.js";

// The clause the engine emits post-migration. ONE justified diff vs the pre-migration
// golden: the em-dash in window.what ("VOICE — a pane") → a comma ("VOICE, a pane").
// That em-dash violated the authored-content em-dash law (em-dash-server-strings) but
// hid in an UNSCANNED engine file; surfacing the string into scanned babel.json forced
// the correction. Semantics unchanged; every other byte is identical to pre-migration.
const GOLDEN_CLAUSE =
  " SYSTEM LORE (committed world-law — never contradict): The WINDOW is a diegetic status display granted by the VOICE, a pane of light only the champion perceives. It ONLY displays the character's six measures (status); displays level and growth; displays the tracked objective; updates to reflect committed state when read. It does NOT remember, advise, predict, watch, speak, warn, guide, decide, judge, listen — never attribute any of those to the window. The VOICE is the power that brought the champion here. It spoke once at the arrival and speaks rarely, if ever, again. It does NOT lie, advise, predict, watch, answer, intervene, command. If the player asks what the window or voice can do, answer strictly from these facts.";

function babelRun() {
  const run = createDefaultSoloRun({ runId: "syslore_fixed" });
  run.worldSeed = "syslore_fixed";
  loadScenarioIntoRun(run, loadScenarioFile("babel"), {});
  return run;
}

test("GATE(babel byte-identical): the carried world.systemLore rebuilds the EXACT pre-migration clause", () => {
  const run = babelRun();
  assert.ok(run.world.systemLore, "the loader must carry world.systemLore into run.world (Stage-3 whitelist)");
  assert.equal(buildSystemLoreClause(run.world), GOLDEN_CLAUSE, "babel's clause must be byte-identical to the old engine constant");
});

test("GATE(babel byte-identical): the auditor flags the exact same violations from the carried lore", () => {
  const run = babelRun();
  const bad = detectSystemLoreViolations("The window will remember what direction you go.", run.world);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].subject, "window");
  assert.equal(bad[0].verb, "remember");
  assert.equal(detectSystemLoreViolations("The voice watches you from the treeline.", run.world).length, 1);
  assert.deepEqual(detectSystemLoreViolations("The window does not remember anything.", run.world), []);
});

test("GATE(non-babel loads + no leak): a cyberpunk-alley world inherits NO WINDOW/VOICE lore", () => {
  const run = createDefaultSoloRun({ runId: "neon" });
  run.world = { name: "Neon City", tone: "cyberpunk" }; // the sceneRegister test's leak-world
  assert.equal(buildSystemLoreClause(run.world), "", "the clause must be empty — no Babel cosmology injected");
  assert.deepEqual(detectSystemLoreViolations("The window will remember your route.", run.world), [], "no committed system → no false auditing");
});

test("ROUTE-INVENTORY: the migrated knob has a LIVE consumer — the narrator prompt clause", () => {
  // The player-facing door is the GM prompt: buildSystemLoreClause is concatenated into
  // the turn message (index.js), the opening (onboarding.js), and OOC grounding
  // (oocGrounding.js). Babel serves the clause; a non-systemLore world serves nothing.
  const run = babelRun();
  assert.ok(buildSystemLoreClause(run.world).length > 100, "babel's live turn prompt carries the grounding clause");
});
