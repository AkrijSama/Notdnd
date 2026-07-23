// JOB 4 — THE TWO-DOORS MISMATCH. A world enters the engine through two doors: scenarioLoader
// (direct JSON, how Babel loads) and compileWorldBook (the creator path, HOW CYBERPUNK IS MADE).
// They carried different world-knob sets, so a field wired for one door was dead through the other
// — a created world silently lost knobs Babel has. Both doors now read ONE registry
// (CARRIED_WORLD_KEYS). This test FAILS when they diverge — the guard that stops the next silent
// drop, and the proof that a CREATOR-authored knob reaches the engine (not just a JSON file).
import test from "node:test";
import assert from "node:assert/strict";
import { compileWorldBook } from "../server/campaign/worldBook.js";
import { CARRIED_WORLD_KEYS, loadScenarioIntoRun } from "../server/campaign/scenarioLoader.js";
import { createDefaultSoloRun } from "../server/solo/schema.js";

const ALL = [...CARRIED_WORLD_KEYS.string, ...CARRIED_WORLD_KEYS.object, ...CARRIED_WORLD_KEYS.array];

// A world-book (creator input) that declares EVERY loader-carried knob under world.*.
function fullWorldBook() {
  const wb = { name: "Neon City", identity: { name: "Neon City", tone: "cyberpunk", genre: "noir" }, vibe: "rain and neon and debt", world: {} };
  for (const k of CARRIED_WORLD_KEYS.string) wb.world[k] = `probe_${k}`;
  for (const k of CARRIED_WORLD_KEYS.object) wb.world[k] = { probe: k };
  for (const k of CARRIED_WORLD_KEYS.array) wb.world[k] = [`probe_${k}`];
  return wb;
}

test("JOB 4.2 (two-doors parity): compileWorldBook emits EVERY loader-carried world knob — no divergence", () => {
  const { scenario } = compileWorldBook(fullWorldBook());
  const missing = ALL.filter((k) => scenario.world[k] === undefined);
  assert.deepEqual(missing, [], `the CREATOR door (compileWorldBook) drops knobs the loader carries: [${missing.join(", ")}] — the two doors diverged; emit them from compileWorldBook (both read CARRIED_WORLD_KEYS)`);
});

test("JOB 4.3: a knob authored through the CREATOR door reaches the ENGINE (run.world), not just a JSON file", () => {
  const { scenario } = compileWorldBook(fullWorldBook());
  const run = createDefaultSoloRun({ runId: "creator_door" });
  loadScenarioIntoRun(run, scenario, {});
  const dropped = ALL.filter((k) => run.world[k] === undefined);
  assert.deepEqual(dropped, [], `creator-authored world knobs did not reach run.world through the loader: [${dropped.join(", ")}]`);
  // spot-check the two JOB 5 targets specifically (the ones cyberpunk needs).
  assert.ok(run.world.sheetSpec, "a creator-authored sheetSpec reaches the engine");
  assert.ok(run.world.rankLadder, "a creator-authored rankLadder reaches the engine");
});

test("JOB 4 (regression): a world-book that declares NO extra knobs still compiles + loads (neutral)", () => {
  const { scenario, validation } = compileWorldBook({ name: "Bare World", identity: { name: "Bare World" }, vibe: "empty" });
  assert.ok(validation.ok !== false, "a minimal world-book still compiles to a valid scenario");
  const run = createDefaultSoloRun({ runId: "bare" });
  assert.doesNotThrow(() => loadScenarioIntoRun(run, scenario, {}));
  assert.equal(run.world.sheetSpec, undefined, "a world that declares no sheetSpec gets none (neutral default)");
});
