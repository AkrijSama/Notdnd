// FACT SELECTION v1 (product-thesis wiring, 2026-07-20).
// The committed-fact librarian was memoryFacts.slice(-10) — pure recency, which
// silently evicts an old high-stakes fact the moment ten newer ones land. Selection
// is now scored by importance × recency, so a durable promise/death/betrayal floats
// over ten recent low-stakes facts. These lock the ranker and the scene wiring.
import test from "node:test";
import assert from "node:assert/strict";
import { importanceOf, rankFactsByImportance } from "../server/solo/factSelection.js";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { getRelevantMemoryFacts } from "../server/solo/scene.js";

const T = (n) => new Date(1730000000000 + n * 1000).toISOString();

function weather(i) {
  return { factId: `w${i}`, type: "observation", text: `A cool breeze drifts through. (${i})`, tags: ["system"], createdAt: T(100 + i) };
}
const PROMISE = {
  factId: "p1", type: "attempt_memory", tags: ["system", "attempt"],
  text: "You promised Vesa you would come back for her brother.", createdAt: T(1)
};

// ── importanceOf: the drama heuristic ─────────────────────────────────────────
test("importanceOf: high-drama classes score 1, ambient scores low, mid-arc between", () => {
  assert.equal(importanceOf({ text: "You promised to return." }), 1, "a promise is max drama");
  assert.equal(importanceOf({ type: "combat_outcome", text: "The Grey is dead." }), 1, "a death is max drama");
  assert.equal(importanceOf({ text: "He betrayed you to the watch." }), 1);
  assert.equal(importanceOf({ type: "thread_beat", tags: ["thread"], text: "A rival rises." }), 0.7, "arc-bearing state");
  assert.equal(importanceOf({ type: "observation", text: "A cool breeze drifts by." }), 0.15, "ambient is low");
  // a stamped importance WINS over derivation (v2 poignancy overwrite path).
  assert.equal(importanceOf({ type: "observation", text: "just weather", importance: 0.9 }), 0.9);
});

// ── the named conviction: an old promise beats ten recent weather facts ────────
test("rankFactsByImportance: an OLD high-importance promise survives over ten recent weather facts", () => {
  const pool = [PROMISE, ...Array.from({ length: 10 }, (_, i) => weather(i))]; // promise is the OLDEST
  const picked = rankFactsByImportance(pool, 10);
  assert.equal(picked.length, 10, "capped to the limit");
  assert.ok(picked.some((f) => f.factId === "p1"), "the old promise is retained despite being oldest + outnumbered");
  // the dropped fact is a weather fact (the lowest-scoring), never the promise.
  const droppedWeather = Array.from({ length: 10 }, (_, i) => `w${i}`).filter((id) => !picked.some((f) => f.factId === id));
  assert.equal(droppedWeather.length, 1, "exactly one weather fact was evicted, not the promise");
});

test("rankFactsByImportance: a pool at/under the limit is returned unchanged (chronological), deduped by text", () => {
  const pool = [weather(0), weather(1), PROMISE];
  const out = rankFactsByImportance(pool, 10);
  assert.deepEqual(out.map((f) => f.factId), ["w0", "w1", "p1"], "small pool kept in order");
  // exact-text dupes collapse to one.
  const dup = [{ factId: "a", text: "same" }, { factId: "b", text: "same" }, { factId: "c", text: "other" }];
  assert.deepEqual(rankFactsByImportance(dup, 10).map((f) => f.factId), ["a", "c"]);
});

// ── the scene wiring: getRelevantMemoryFacts floats the promise end-to-end ─────
test("getRelevantMemoryFacts: the old promise reaches the scene payload over recent weather", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  run.memoryFacts = [
    { ...PROMISE, entityIds: [run.runId], contentTags: [], policyProfileId: run.policyProfileId, canonical: true },
    ...Array.from({ length: 14 }, (_, i) => ({ ...weather(i), entityIds: [run.runId], contentTags: [], policyProfileId: run.policyProfileId, canonical: true }))
  ];
  const picked = getRelevantMemoryFacts(run, { limit: 10 });
  assert.ok(picked.length <= 10, "capped");
  assert.ok(picked.some((f) => f.factId === "p1"), "the promise survived the slice-10 that would have evicted it");
});
