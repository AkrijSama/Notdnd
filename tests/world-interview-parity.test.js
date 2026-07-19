// DRIFT GUARD: the client mirror of the interview questions (worldCreator.CREATOR_QUESTIONS)
// must stay identical to the server authority (worldInterview.INTERVIEW_QUESTIONS). The
// questions ARE the UX; this test fails loudly if the two copies ever diverge.
import assert from "node:assert/strict";
import test from "node:test";
import { INTERVIEW_QUESTIONS } from "../server/campaign/worldInterview.js";
import { CREATOR_QUESTIONS } from "../src/components/worldCreator.js";

test("client CREATOR_QUESTIONS === server INTERVIEW_QUESTIONS (id + prompt + skipLabel)", () => {
  assert.equal(CREATOR_QUESTIONS.length, INTERVIEW_QUESTIONS.length, "same number of questions");
  for (let i = 0; i < INTERVIEW_QUESTIONS.length; i += 1) {
    const s = INTERVIEW_QUESTIONS[i];
    const c = CREATOR_QUESTIONS[i];
    assert.equal(c.id, s.id, `question ${i} id parity`);
    assert.equal(c.prompt, s.prompt, `question ${i} (${s.id}) prompt parity`);
    assert.equal(c.skipLabel, s.skipLabel, `question ${i} (${s.id}) skipLabel parity`);
  }
});
