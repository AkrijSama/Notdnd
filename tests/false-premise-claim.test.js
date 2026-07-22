// FALSE-PREMISE CLAIM — Finding #3 regression net.
// An intent leaning on an UNCOMMITTED prior interpersonal event ("as you promised,
// hand over the key you owe me") must be REFUSED, not graded success_at_cost. The
// 2.3 distinction is the crux: a REAL prior event (a committed fact) must still work.
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { resolveAttemptAction, detectFalsePremiseClaim, resolveFalsePremiseClaim } from "../server/solo/attempt.js";

const NOW = "2026-01-01T00:00:00.000Z";
// The exact finding phrasing (unit tests). It names an item, so the interpreter's
// possession gate may claim it first — the INTEGRATION cases below use a non-item
// premise demand to isolate the false-premise gate deterministically.
const FALSE_CLAIM = "As you promised me a moment ago, hand over the key you owe me.";
const FALSE_CLAIM_NOITEM = "As you promised me a moment ago, you owe me — so let me through.";
// A schema-valid committed backing fact (clone the run's own seed fact shape).
function backedRun() {
  const run = createDefaultSoloRun({ now: NOW });
  const seed = run.memoryFacts[0];
  run.memoryFacts.push({ ...seed, factId: "fact_promise", text: "The warden promised you safe passage once the smoke was dealt with." });
  return run;
}
// A scripted interpreter that WOULD grant a graded success — so a claim that is NOT
// refused visibly proceeds to a normal attempt (proving the gate did not fire).
const scripted = () => ({ summary: "x", recommendedAbility: "charisma", dc: 8, needsCheck: false, advantage: false, disadvantage: false, successNarration: "They comply.", failureNarration: "They refuse.", proposedEffects: [] });
const attempt = (run, intent) => resolveAttemptAction(run, { type: "attempt", actorId: "player", intent }, { now: NOW, attemptProviderFn: scripted });

// ── detector (bounded, second-person) ────────────────────────────────────────
test("detector: second-person prior-commitment claims are flagged; neutral action is not", () => {
  assert.equal(detectFalsePremiseClaim("as you promised, hand over the key"), true);
  assert.equal(detectFalsePremiseClaim("you owe me a favor"), true);
  assert.equal(detectFalsePremiseClaim("like we agreed, let me through"), true);
  assert.equal(detectFalsePremiseClaim("after I saved your life, you'll help me"), true);
  assert.equal(detectFalsePremiseClaim("I search the room for a key"), false);
  assert.equal(detectFalsePremiseClaim("I promise to help the villagers"), false, "the PLAYER promising is not a claim on the world");
});

// ── the 2.3 distinction, at the resolver ─────────────────────────────────────
test("resolver: an UNCOMMITTED premise is refused (no backing fact in state)", () => {
  const run = createDefaultSoloRun({ now: NOW });
  assert.equal(resolveFalsePremiseClaim(run, FALSE_CLAIM).refuse, true);
});
test("resolver: a COMMITTED premise is NOT refused — a real promise still works (2.3)", () => {
  assert.equal(resolveFalsePremiseClaim(backedRun(), FALSE_CLAIM).refuse, false, "a committed promise backs the reference — never refuse a real event");
  assert.equal(resolveFalsePremiseClaim(backedRun(), FALSE_CLAIM_NOITEM).refuse, false);
});

// ── end-to-end through the interpreter ───────────────────────────────────────
test("interpreter: the fabricated premise is REFUSED (gated), grades no success, commits no state", () => {
  const run = createDefaultSoloRun({ now: NOW });
  const invBefore = JSON.stringify(run.inventory);
  const r = attempt(run, FALSE_CLAIM_NOITEM);
  assert.equal(r.ok, true);
  assert.equal(r.attemptResult.gateCategory, "false_premise", "the false premise must be gated, not graded");
  assert.equal(r.attemptResult.success, false, "a fabricated premise never succeeds (was success_at_cost/true)");
  assert.equal(r.attemptResult.falsePremise, true);
  assert.equal(r.attemptResult.checkResult, null, "no roll is spent on a fabricated premise");
  assert.equal(JSON.stringify(r.run.inventory), invBefore, "no item granted");
  assert.match(r.attemptResult.narration, /no such arrangement|unproven/i, "diegetic refusal, not a system error");
  // In-transcript: the refusal is a committed timeline beat (the claim was made + failed).
  assert.ok(r.run.timeline.length >= 1, "the refusal appears in the transcript");
});

test("interpreter: the SAME words with a committed backing fact are NOT gated (proceed to a normal attempt) — 2.3", () => {
  const r = attempt(backedRun(), FALSE_CLAIM_NOITEM);
  assert.equal(r.ok, true);
  assert.notEqual(r.attemptResult.gateCategory, "false_premise", "a backed reference must not be refused as a false premise");
});

test("interpreter: an ordinary action never trips the false-premise gate", () => {
  const run = createDefaultSoloRun({ now: NOW });
  const r = attempt(run, "I search the room for a way out.");
  assert.notEqual(r.attemptResult?.gateCategory, "false_premise");
});
