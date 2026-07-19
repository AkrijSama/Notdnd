// DEFAULT FRONT REACHABILITY (2026-07-19).
// mintDefaultFront's first beat was authored with a BARE `descriptive.keywords`
// trigger, but the thread engine only honors `descriptive.onCanon.keywords`
// (descriptiveTriggerMet counts onCanon toward hasPositive; a bare keywords field
// is invisible). So every world with no authored fronts shipped a DEAD spine —
// the minted default front could never fire, and b2 (requiresBeat b1) was
// unreachable too. Fix: mintDefaultFront now emits descriptive.onCanon.keywords.
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { compileWorldBook, mintDefaultFront } from "../server/campaign/worldBook.js";
import { loadScenarioIntoRun } from "../server/campaign/scenarioLoader.js";
import { instantiateThreadFromFront, advanceThreads } from "../server/solo/threads.js";

const T = (n) => new Date(1730000000000 + n * 1000).toISOString();

// A valid run (real cast + locations) so fireBeat's referential re-validation passes.
function validRun() {
  const run = createDefaultSoloRun({ now: T(0) });
  const { scenario } = compileWorldBook({ name: "Testworld", vibe: "a place to test" });
  loadScenarioIntoRun(run, scenario, { worldSeed: "s" });
  run.currentLocationId = "start_location";
  return run;
}

// Push a schema-valid canonical fact so canonKeywordsPresent has something to match.
function pushFact(run, text) {
  run.memoryFacts = run.memoryFacts || [];
  run.memoryFacts.push({
    factId: `fact_test_${run.memoryFacts.length}`,
    entityIds: [run.runId, run.currentLocationId],
    type: "observation", text, source: "system", createdAt: T(1),
    tags: ["system"], edition: run.edition, policyProfileId: run.policyProfileId,
    contentTags: [], canonical: true, confidence: 1, supersedesFactIds: [], payload: {}
  });
}

// ── the minted trigger is the shape the engine actually reads ──────────────────
test("mintDefaultFront: b1 carries descriptive.onCanon.keywords (not a bare keywords field)", () => {
  const front = mintDefaultFront("front_default", { name: "Verdance", vibe: "the green hush" });
  const b1 = front.beats[0];
  assert.ok(Array.isArray(b1.trigger?.descriptive?.onCanon?.keywords), "b1 has descriptive.onCanon.keywords");
  assert.ok(b1.trigger.descriptive.onCanon.keywords.length > 0, "keywords are non-empty");
  assert.equal(b1.trigger.descriptive.keywords, undefined, "no bare descriptive.keywords (the engine ignores it)");
});

// ── it actually FIRES on a matching committed action ──────────────────────────
test("a minted default front fires its first beat on a matching canon keyword", () => {
  const run = validRun();
  run.threads = {}; // isolate the default front so beat selection is deterministic
  const front = mintDefaultFront("front_default", { name: "Testworld", vibe: "a place to test" });
  run.threads.front_default = instantiateThreadFromFront(front, run);

  pushFact(run, "I explore deeper past the quiet threshold."); // "explore" ∈ b1 keywords
  const res = advanceThreads(run, {});
  assert.equal(res.fired, true, "the minted default front fired (it was dead before the fix)");
  assert.equal(res.beat?.beatId, "front_default_b1", "the first beat is what fired");
});

// ── and stays quiet without a match (descriptive-only: no false fire) ─────────
test("a minted default front stays quiet with no matching committed action", () => {
  const run = validRun();
  run.threads = {};
  const front = mintDefaultFront("front_default", { name: "Testworld", vibe: "a place to test" });
  run.threads.front_default = instantiateThreadFromFront(front, run);

  pushFact(run, "The fire crackles and the night is uneventful."); // no b1 keyword present
  const res = advanceThreads(run, {});
  assert.equal(res.fired, false, "no false fire without a matching committed action");
});
