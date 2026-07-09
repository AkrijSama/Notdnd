import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Isolate the run-log dir so timing writes never touch real logs.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-readability-"));
process.env.NOTDND_DB_PATH = path.join(tmpDir, "r.db.json");

const { renderNarrationLog, renderSoloActionOutcome } = await import("../src/components/soloSceneShell.js");
const { startTurnTiming, getLastTurnTiming, getRecentTurnTimings } = await import("../server/logging/turnTiming.js");

// ---- Item 3: wall-of-text chunker ----

test("a long single-block narration renders as MULTIPLE visual paragraphs", () => {
  const wall =
    "The tavern breathes smoke and old ash around you. Every face at the long tables turns as the door groans shut behind your back. " +
    "A barkeep with a chipped jaw studies you from behind the counter while wiping a mug that has not been clean in years. " +
    "Somewhere above, floorboards creak under a weight that pauses when you look up at the ceiling beams. " +
    "The fire in the hearth has burned low, throwing more shadow than light across the stone floor of the common room.";
  const html = renderNarrationLog([{ id: "n1", intent: "look around", text: wall }]);
  const pCount = (html.match(/<p>/g) || []).length;
  assert.ok(wall.length > 360, "fixture is a genuine wall (>360 chars)");
  assert.ok(pCount >= 2, `wall of text splits into visual paragraphs (got ${pCount})`);
});

test("a short paragraph is NOT chunked", () => {
  const html = renderNarrationLog([{ id: "n1", intent: "", text: "The door holds. Dust falls." }]);
  assert.equal((html.match(/<p>/g) || []).length, 1);
});

test("chunking never splits inside quoted dialogue (coloring survives)", () => {
  const withQuote =
    "The barkeep leans across the counter and lowers his voice so only you can hear what he says next over the noise. " +
    "“You should not be here after dark. The roads north are watched. Nobody who takes them comes back the same.” " +
    "He straightens up and goes back to his mug as if nothing at all had passed between the two of you just then. " +
    "The fire pops in the hearth and the room swallows the moment whole again.";
  const html = renderNarrationLog([{ id: "n1", intent: "", text: withQuote }]);
  // The full quote must land inside ONE dialogue span — an intra-quote split
  // would break the “…” pairing and drop the wrapper.
  assert.match(html, /<span class="solo-dialogue">“You should not be here after dark\..*same\.”<\/span>/s);
});

test("explicit blank-line paragraphs are preserved as before", () => {
  const html = renderNarrationLog([{ id: "n1", intent: "", text: "First beat.\n\nSecond beat." }]);
  assert.equal((html.match(/<p>/g) || []).length, 2);
});

// ---- Item 5: labeled roll badges ----

test("log roll badge reads 'Rolled X · DC Y' (not bare X / Y)", () => {
  const html = renderNarrationLog([
    { id: "n1", intent: "force the door", checkResult: { total: 2, dc: 12 }, band: "failure", text: "It holds." }
  ]);
  assert.match(html, /Rolled 2 · DC 12/);
  assert.doesNotMatch(html, /2 \/ 12/);
});

test("log roll badge without a DC reads 'Rolled X'", () => {
  const html = renderNarrationLog([
    { id: "n1", intent: "leap", checkResult: { total: 17 }, band: "success", text: "You clear it." }
  ]);
  assert.match(html, /Rolled 17/);
  assert.doesNotMatch(html, /DC/);
});

test("stage outcome strip reads 'Rolled X · DC Y'", () => {
  const html = renderSoloActionOutcome({
    scene: {
      recentTimeline: [{ type: "attempt" }],
      latestAttemptResult: { intent: "pick the lock", success: true, band: "success", checkResult: { total: 17, dc: 14 } }
    }
  });
  assert.match(html, /Rolled 17/);
  assert.match(html, /· DC 14/);
});

// ---- Item 7: per-turn timing collector ----

test("startTurnTiming records sequential stage segments + total", async () => {
  const t = startTurnTiming("run_timing_test", "attempt");
  await new Promise((r) => setTimeout(r, 12));
  t.mark("interpreter");
  t.mark("commit");
  await new Promise((r) => setTimeout(r, 8));
  t.mark("gm");
  t.mark("auditor");
  t.mark("renderReady");
  const rec = t.finish();
  assert.equal(rec.runId, "run_timing_test");
  assert.equal(rec.actionType, "attempt");
  for (const stage of ["interpreter", "commit", "gm", "auditor", "renderReady"]) {
    assert.ok(typeof rec.stages[stage] === "number" && rec.stages[stage] >= 0, `${stage} recorded`);
  }
  assert.ok(rec.stages.interpreter >= 10, "interpreter segment captured its wait");
  assert.ok(rec.stages.gm >= 6, "gm segment captured its wait");
  assert.ok(rec.totalMs >= rec.stages.interpreter + rec.stages.gm, "total covers the segments");
  assert.ok(rec.at, "timestamped");
});

test("last + recent timings are retained for debug status", () => {
  const before = getRecentTurnTimings().length;
  const t = startTurnTiming("run_timing_ring", "talk");
  t.mark("interpreter");
  t.finish();
  assert.equal(getLastTurnTiming().runId, "run_timing_ring");
  assert.equal(getRecentTurnTimings().length, Math.min(before + 1, 10));
  // finish() is idempotent — a double call must not double-log or re-push.
  t.finish();
  assert.equal(getRecentTurnTimings().length, Math.min(before + 1, 10));
});
