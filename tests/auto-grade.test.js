import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  letterFor,
  isRealGmModel,
  detectRecycledLoop,
  detectBandDesync,
  detectClockDivergence,
  detectConditionsWithoutShed,
  gradeSession,
  renderGradeReport
} from "../scripts/selfplayAudit.mjs";
import { discoverGradeReports } from "../scripts/autoGrade.mjs";

test("discoverGradeReports matches auto-grade-*.md (corrected pattern), not autograde* / globstar", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grades-"));
  fs.writeFileSync(path.join(dir, "auto-grade-2026-07-09T00-00-00.md"), "x");
  fs.writeFileSync(path.join(dir, "auto-grade-AGGREGATE-2026-07-08.md"), "x");
  fs.writeFileSync(path.join(dir, "autograde-nohyphen.md"), "x"); // the OLD broken shape — must NOT match
  fs.writeFileSync(path.join(dir, "notes.md"), "x"); // unrelated md — must NOT match
  const found = discoverGradeReports(dir).map((p) => path.basename(p));
  assert.deepEqual(found.sort(), ["auto-grade-2026-07-09T00-00-00.md", "auto-grade-AGGREGATE-2026-07-08.md"]);
  assert.ok(!found.includes("autograde-nohyphen.md"), "hyphen-less name is not matched");
  assert.deepEqual(discoverGradeReports(path.join(dir, "does-not-exist")), [], "absent dir -> [] (never throws)");
});

// ---- letter scale + model matcher ----
test("letterFor maps numerics to the standard scale", () => {
  assert.equal(letterFor(95), "A");
  assert.equal(letterFor(83), "B");
  assert.equal(letterFor(77), "C+");
  assert.equal(letterFor(65), "D");
  assert.equal(letterFor(40), "F");
  assert.equal(letterFor(null), "N/A");
});

test("isRealGmModel accepts deepseek, rejects local/gemini", () => {
  assert.equal(isRealGmModel("deepseek/deepseek-v4-pro"), true);
  assert.equal(isRealGmModel("dolphin-llama3:8b"), false);
  assert.equal(isRealGmModel("google/gemini-2.0-flash"), false);
  assert.equal(isRealGmModel(""), false);
});

// ---- gap-class detectors ----
test("detectRecycledLoop clusters near-verbatim recycled narrations by turn (dead-loop), not shared setting nouns", () => {
  const loops = detectRecycledLoop([
    { n: 3, narration: "The disorientation worsens, the floor tilting sharply beneath your boots." },
    { n: 5, narration: "You steady yourself and study the far exit across the hall." },
    { n: 7, narration: "The disorientation worsens, the floor tilting sharply beneath your boots again." },
    { n: 9, narration: "The disorientation worsens once more, the floor tilting sharply beneath your boots." }
  ]);
  assert.equal(loops.length, 1, "one loop cluster, not one finding per shared word");
  assert.deepEqual(loops[0].turns, [3, 7, 9]);
});

test("detectRecycledLoop does NOT flag consistent setting description (a stone tavern every turn)", () => {
  const loops = detectRecycledLoop([
    { n: 1, narration: "Cold stone walls rise around a hearth of banked embers and old ash." },
    { n: 2, narration: "The stone chimney breathes smoke; a barkeep wipes down chipped mugs." },
    { n: 3, narration: "Loose mortar crumbles where a stone lintel meets the sagging doorframe." }
  ]);
  assert.equal(loops.length, 0, "shared 'stone' is setting consistency, not a recycled loop");
});

test("detectBandDesync flags a sub-DC roll that reads as a clean success (#28)", () => {
  assert.ok(detectBandDesync({ checkResult: { total: 8, dc: 16 }, band: "success", outcomeLabel: "Success" }));
  assert.equal(detectBandDesync({ checkResult: { total: 8, dc: 16 }, band: "failure", outcomeLabel: "Failure" }), null);
  assert.equal(detectBandDesync({ checkResult: { total: 18, dc: 16 }, band: "success" }), null);
  // at-a-cost on a sub-DC roll is legitimate, not a desync
  assert.equal(detectBandDesync({ checkResult: { total: 13, dc: 16 }, band: "success_at_cost", outcomeLabel: "Success at a cost" }), null);
});

test("detectClockDivergence flags narrated night against a committed day clock (#14)", () => {
  assert.ok(detectClockDivergence("Nightfall has come and the tavern empties.", { minuteOfDay: 480, isNight: false, clock: "08:00" }));
  assert.equal(detectClockDivergence("The morning light spills in.", { minuteOfDay: 480, isNight: false }), null);
});

test("detectConditionsWithoutShed flags a monotonically growing debuff stack (#26)", () => {
  assert.ok(detectConditionsWithoutShed([0, 1, 2, 3, 4]));
  assert.equal(detectConditionsWithoutShed([0, 1, 2, 1, 0]), null, "a stack that sheds is fine");
  assert.equal(detectConditionsWithoutShed([1, 1]), null, "small non-growing is fine");
});

// ---- the full grader shape + machine-actionable findings ----
function scene(names = []) {
  return { location: { name: "The Ember Tavern" }, player: { displayName: "Bram" }, cast: names.map((n) => ({ displayName: n, npcId: n.toLowerCase() })) };
}

test("gradeSession emits per-axis letter+numeric, structured findings, and model integrity", () => {
  const turns = [
    { n: 1, intent: "look", narration: "The tavern is quiet.", model: "deepseek/deepseek-v4-pro", fallback: false, latencyMs: 12000, attemptResult: {}, scene: scene(["Mara"]), sceneBefore: { a: 1 }, sceneAfter: { a: 1 } },
    { n: 2, intent: "force door", narration: "You throw your weight at the door. Garrick steps out of the shadows to stop you.", model: "deepseek/deepseek-v4-pro", fallback: false, latencyMs: 31000,
      attemptResult: { needsCheck: true, checkResult: { total: 8, dc: 16 }, band: "success", outcomeLabel: "Success", success: true },
      scene: scene(["Mara"]), sceneBefore: { a: 1 }, sceneAfter: { a: 1 } }
  ];
  const g = gradeSession(turns, { meta: { runId: "run_x" } });

  // axes shape
  for (const axis of ["narration", "coherence", "depth", "mechanical", "pacing"]) {
    assert.ok(g.axes[axis], `axis ${axis} present`);
    assert.ok(typeof g.axes[axis].letter === "string");
    assert.ok(g.axes[axis].numeric == null || typeof g.axes[axis].numeric === "number");
  }
  // integrity
  assert.equal(g.integrity.total, 2);
  assert.equal(g.integrity.real, 2);
  assert.equal(g.integrity.fallback, 0);
  assert.equal(g.integrity.valid, true);

  // findings are machine-actionable: exact shape
  assert.ok(g.findings.length > 0);
  for (const f of g.findings) {
    assert.ok(["narration", "coherence", "depth", "mechanical", "pacing"].includes(f.axis));
    assert.ok(["critical", "high", "medium", "low"].includes(f.severity));
    assert.ok(Array.isArray(f.turns));
    assert.ok(typeof f.failure === "string" && f.failure.length > 0);
    assert.ok(typeof f.rootCause === "string" && f.rootCause.length > 0);
    assert.ok(typeof f.fixTarget === "string" && f.fixTarget.length > 0);
  }
  // the specific known classes fired
  assert.ok(g.findings.some((f) => f.axis === "coherence" && /Garrick/.test(f.failure)), "phantom NPC finding");
  assert.ok(g.findings.some((f) => f.axis === "coherence" && /band\/label desync/.test(f.failure)), "band-desync finding");
  assert.ok(g.findings.some((f) => f.axis === "depth" && /NO state delta/.test(f.failure)), "narrate-into-void finding");
  assert.ok(g.findings.some((f) => f.axis === "pacing" && /latency/.test(f.failure)), "latency finding");
  // findings ranked: critical before low
  const sevRank = { critical: 0, high: 1, medium: 2, low: 3 };
  for (let i = 1; i < g.findings.length; i += 1) {
    assert.ok(sevRank[g.findings[i - 1].severity] <= sevRank[g.findings[i].severity], "ranked by severity");
  }
});

test("depth void-check ignores a stale attemptResult on a reroute turn (freshAttempt=false)", () => {
  // A reroute turn (search/observe/move/take) returns no attemptResult; the scene's
  // latestAttemptResult still holds the PRIOR attempt's success. The grader must not
  // flag that reroute turn as narrate-into-void off the stale success.
  const staleSuccess = { success: true, band: "success", outcomeLabel: "Success" };
  const turns = [
    { n: 1, intent: "force the door", narration: "You force it.", model: "deepseek/deepseek-v4-pro", fallback: false, latencyMs: 9000,
      attemptResult: staleSuccess, freshAttempt: true, scene: scene([]), sceneBefore: { a: 1 }, sceneAfter: { a: 2 } },
    // T2 is an observation reroute: no fresh attempt, snapshot unchanged, but the
    // stale success from T1 rides on attemptResult. Must NOT be flagged.
    { n: 2, intent: "wait and watch the room", narration: "You watch; nothing new stirs.", model: "deepseek/deepseek-v4-pro", fallback: false, latencyMs: 8000,
      attemptResult: staleSuccess, freshAttempt: false, scene: scene([]), sceneBefore: { a: 2 }, sceneAfter: { a: 2 } }
  ];
  const g = gradeSession(turns);
  assert.ok(!g.findings.some((f) => f.axis === "depth" && f.turns.includes(2)), "reroute turn (freshAttempt=false) not flagged void");
});

test("depth void-check exempts a social success that committed a disposition delta (B2)", () => {
  const turns = [
    { n: 1, intent: "persuade the barkeep to trust me", narration: "She softens, a little.", model: "deepseek/deepseek-v4-pro", fallback: false, latencyMs: 9000,
      attemptResult: { success: true, band: "success", dispositionChange: { targetNpcId: "npc_x", meter: "trust", delta: 3, before: 0, after: 3 } },
      freshAttempt: true, scene: scene([]), sceneBefore: { a: 1 }, sceneAfter: { a: 1 } }
  ];
  const g = gradeSession(turns);
  assert.ok(!g.findings.some((f) => f.axis === "depth" && f.turns.includes(1)), "committed disposition is a real delta, not void");
});

test("depth void-check STILL flags a fresh attempt success with no delta", () => {
  const turns = [
    { n: 1, intent: "force the door", narration: "The door gives way.", model: "deepseek/deepseek-v4-pro", fallback: false, latencyMs: 9000,
      attemptResult: { success: true, band: "success" }, freshAttempt: true, scene: scene([]), sceneBefore: { a: 1 }, sceneAfter: { a: 1 } }
  ];
  const g = gradeSession(turns);
  assert.ok(g.findings.some((f) => f.axis === "depth" && /NO state delta/.test(f.failure)), "fresh void still caught");
});

test("gradeSession EXCLUDES fallback turns from narration/coherence and marks them invalid", () => {
  const turns = [
    { n: 1, intent: "x", narration: "Garrick the phantom sneers.", model: "dolphin-llama3:8b", fallback: true, latencyMs: 3000, attemptResult: {}, scene: scene([]), sceneBefore: {}, sceneAfter: {} },
    { n: 2, intent: "y", narration: "Doc Han appears from nowhere.", model: "google/gemini-2.0-flash", fallback: true, latencyMs: 4000, attemptResult: {}, scene: scene([]), sceneBefore: {}, sceneAfter: {} }
  ];
  const g = gradeSession(turns);
  assert.equal(g.integrity.real, 0);
  assert.equal(g.integrity.fallback, 2);
  assert.equal(g.integrity.valid, false);
  assert.deepEqual(g.integrity.excludedTurns, [1, 2]);
  // no phantom (coherence) finding should be raised on the excluded fallback prose
  assert.ok(!g.findings.some((f) => f.axis === "coherence" && /Garrick|Doc Han/.test(f.failure)), "fallback phantoms excluded");
  // narration/coherence axes are marked invalid
  assert.equal(g.axes.narration.invalid, true);
  assert.equal(g.axes.coherence.invalid, true);
  // pacing still flags the fallback frequency
  assert.ok(g.findings.some((f) => f.axis === "pacing" && /fell to a fallback model/.test(f.failure)));
});

test("renderGradeReport emits the report sections", () => {
  const turns = [{ n: 1, intent: "x", narration: "Quiet.", model: "deepseek/deepseek-v4-pro", fallback: false, latencyMs: 10000, attemptResult: {}, scene: scene(["Mara"]), sceneBefore: {}, sceneAfter: {} }];
  const md = renderGradeReport(gradeSession(turns), { timestamp: "2026-07-08", runId: "run_x", sha: "abc1234" });
  assert.match(md, /# Auto-Grade/);
  assert.match(md, /## Model integrity/);
  assert.match(md, /## Grades/);
  assert.match(md, /\| Narration \|/);
  assert.match(md, /Machine-actionable findings/);
});
