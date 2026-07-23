// JOB 3 — THE MIRROR BUG + the anti-recurrence net for the whitelist-drop class.
// `world.plausibleFauna` was authored (babel.json, 18 animals) with a LIVE reader
// (absentTarget.js:124 via actions.js) but silently dropped by the loader — the SAME class as
// the prior whitelist drops. This carries it AND locks the class: every Babel world key that is
// both authored AND read from run.world must survive the loader, or this test names it.
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { loadScenarioIntoRun, loadScenarioFile } from "../server/campaign/scenarioLoader.js";
import { detectAbsentTargetRefusal } from "../server/solo/absentTarget.js";

// Keys authored on a world AND read from run.world.<key> by a live consumer (derived from a
// grep of `run.world.*` reads across server/, intersected with babel's authored world block).
// If a NEW run.world reader is added, add its key here — the enumeration is the guard.
// NOTE (JOB 2.4): `nameBanks` was REMOVED from this list — it has no run.world reader. Its live
// reader is the COMPILE-time cast/POI name mint reading `book.nameBanks`; the run.world carry was
// redundant dead weight and is no longer carried. This guard is only for run.world readers.
const AUTHORED_AND_READ = [
  "name", "tone", "variant", "flavor", "artStyle", "era", "sceneRegister",
  "deathLaw", "systemLore", "artStyleOptions", "plausibleFauna",
  "startingLocationName", "startingLocationType"
];

function babelRun() {
  const run = createDefaultSoloRun({ runId: "carry_parity" });
  loadScenarioIntoRun(run, loadScenarioFile("babel"), {});
  return run;
}

test("JOB 3.2 (anti-recurrence): every authored Babel world key with a live reader survives the loader", () => {
  const scen = loadScenarioFile("babel");
  const run = babelRun();
  const dropped = [];
  for (const k of AUTHORED_AND_READ) {
    if (scen.world[k] !== undefined && run.world[k] === undefined) dropped.push(k);
  }
  assert.deepEqual(dropped, [], `authored world keys with live readers were DROPPED at load (the whitelist-drop class recurred): ${dropped.join(", ")} — carry them in scenarioLoader`);
});

test("JOB 3.1: plausibleFauna reaches its live reader — the absent-fauna grounder", () => {
  const run = babelRun();
  assert.ok(Array.isArray(run.world.plausibleFauna) && run.world.plausibleFauna.length >= 10, "the authored animals reach run.world.plausibleFauna");
  // ROUTE-INVENTORY: the player-facing door is the free-text turn. Typing "attack the elk" with
  // NO elk committed here is refused diegetically (never a phantom fight) BECAUSE the world's
  // fauna list recognizes "elk" as an absent agent. Dropped fauna → the world's own animals go
  // unrecognized and a phantom can be manufactured.
  const refusal = detectAbsentTargetRefusal(run, "attack the elk");
  assert.ok(refusal, "an authored fauna ('elk') is recognized as an absent agent → refused, not manufactured");
});

test("a world that authors NO plausibleFauna simply has none (neutral default, no crash)", () => {
  const run = createDefaultSoloRun({ runId: "neon_fauna" });
  run.world = { name: "Neon City", tone: "cyberpunk" };
  assert.equal(run.world.plausibleFauna, undefined, "no fauna authored → none carried");
  // the reader tolerates absence (empty list) — no crash, just no fauna-based recognition.
  assert.doesNotThrow(() => detectAbsentTargetRefusal(run, "attack the drone"));
});
