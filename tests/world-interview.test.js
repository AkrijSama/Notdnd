// THE INTERVIEW STATE MACHINE (server/campaign/worldInterview.js). Answer / skip /
// just-build / resume — pure + serializable. The question set is the UX; a parity test
// (world-interview-parity) guards the client mirror.
import assert from "node:assert/strict";
import test from "node:test";
import {
  INTERVIEW_QUESTIONS, createInterview, currentQuestion, answerQuestion, skipQuestion,
  justBuild, isComplete, interviewProgress, interviewAnswers, resumeInterview
} from "../server/campaign/worldInterview.js";

test("the question set is the generalized Babel set (7, each with a skip affordance)", () => {
  assert.equal(INTERVIEW_QUESTIONS.length, 7);
  const ids = INTERVIEW_QUESTIONS.map((q) => q.id);
  assert.deepEqual(ids, ["landmark", "remnant", "temptation", "threats", "signature", "powers", "region"]);
  for (const q of INTERVIEW_QUESTIONS) {
    assert.ok(q.prompt && q.skipLabel && q.feeds, `${q.id} has prompt/skip/feeds`);
  }
});

test("answering advances one at a time; the current question is what the user sees", () => {
  let iv = createInterview("neon city");
  assert.equal(currentQuestion(iv).id, "landmark");
  iv = answerQuestion(iv, "a tower that prints weather");
  assert.equal(currentQuestion(iv).id, "remnant");
  assert.equal(iv.answers.landmark.value, "a tower that prints weather");
});

test("answering by explicit id, and an empty answer becomes a skip", () => {
  let iv = createInterview("x");
  iv = answerQuestion(iv, { id: "powers", answer: "the Zaibatsu" });
  assert.equal(iv.answers.powers.value, "the Zaibatsu");
  iv = answerQuestion(iv, "   "); // empty → skip of the current question (landmark)
  assert.equal(iv.answers.landmark.skipped, true);
});

test("skip marks 'let the world decide'; it resolves the question", () => {
  let iv = createInterview("x");
  iv = skipQuestion(iv);
  assert.equal(iv.answers.landmark.skipped, true);
  assert.equal(currentQuestion(iv).id, "remnant");
});

test("just-build defers every remaining question and marks the interview ready", () => {
  let iv = createInterview("neon city, corporate gods");
  iv = answerQuestion(iv, "a tower");
  iv = justBuild(iv);
  assert.equal(iv.status, "ready");
  assert.equal(isComplete(iv), true);
  assert.equal(currentQuestion(iv), null);
  // deferred questions are skipped (the draft mints them from the spark).
  assert.equal(iv.answers.remnant.skipped, true);
  assert.equal(iv.answers.remnant.deferred, true);
  assert.equal(iv.answers.landmark.value, "a tower", "an already-given answer survives just-build");
});

test("progress counts answered vs resolved", () => {
  let iv = createInterview("x");
  iv = answerQuestion(iv, "a");
  iv = skipQuestion(iv);
  const p = interviewProgress(iv);
  assert.equal(p.total, 7);
  assert.equal(p.answered, 1);
  assert.equal(p.resolved, 2);
});

test("interviewAnswers exposes byId + byFeed (skips surface as null)", () => {
  let iv = createInterview("the spark");
  iv = answerQuestion(iv, { id: "landmark", answer: "a tower" });
  iv = skipQuestion(iv, { id: "region" });
  const a = interviewAnswers(iv);
  assert.equal(a.spark, "the spark");
  assert.equal(a.byId.landmark, "a tower");
  assert.equal(a.byId.region, null, "a skip is null (draft invents it)");
  assert.equal(a.byFeed.pois, "a tower", "landmark feeds the pois section");
});

test("resume rehydrates a persisted interview (partial + ready), tolerating junk", () => {
  let iv = createInterview("resume me");
  iv = answerQuestion(iv, "a tower");
  iv = skipQuestion(iv); // remnant
  const roundTripped = JSON.parse(JSON.stringify(iv));
  roundTripped.answers.bogus_id = { value: "ignore me" }; // foreign id
  const resumed = resumeInterview(roundTripped);
  assert.equal(resumed.answers.landmark.value, "a tower");
  assert.equal(resumed.answers.remnant.skipped, true);
  assert.equal(resumed.answers.bogus_id, undefined, "unknown ids dropped");
  assert.equal(currentQuestion(resumed).id, "temptation", "cursor lands on the first unresolved question");

  const ready = resumeInterview({ spark: "s", status: "ready", answers: {} });
  assert.equal(ready.status, "ready");
  assert.equal(isComplete(ready), true);
});
