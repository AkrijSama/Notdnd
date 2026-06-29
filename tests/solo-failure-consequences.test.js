import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun } from "../server/solo/schema.js";
import {
  resolveAttemptAction,
  resolveRetryForeclosure,
  enforceFailureConsequence,
  validateAttemptProviderOutput
} from "../server/solo/attempt.js";

// A scripted GM provider returning a fixed proposal incl. a structured
// failureConsequence. fixedRoll forces the d20, so success/failure is deterministic.
function scriptedAttempt(run, { intent, dc = 12, fixedRoll = 7, ability = "investigation", failureConsequence } = {}) {
  const providerOutput = {
    summary: `You attempt: ${intent}`,
    recommendedAbility: ability,
    dc,
    needsCheck: true,
    advantage: false,
    disadvantage: false,
    successNarration: "It goes well.",
    failureNarration: failureConsequence?.reason ? `You fail — ${failureConsequence.reason}.` : "You fail.",
    proposedEffects: []
  };
  if (failureConsequence !== undefined) {
    providerOutput.failureConsequence = failureConsequence;
  }
  return resolveAttemptAction(run, { type: "attempt", actorId: "player", intent }, {
    fixedRoll,
    now: "2026-01-01T00:00:00.000Z",
    attemptProviderFn: () => providerOutput
  });
}

const hp = (run) => run.player.resources.hitPoints.current;
const objectStatesOf = (run) => run.locations[run.currentLocationId].flags.objectStates || {};

// ── type "damage": HP actually drops by the GM-proposed amount ───────────────
test("failure consequence 'damage' reduces real HP by the proposed amount", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const before = hp(run);
  const result = scriptedAttempt(run, {
    intent: "wrestle the iron grate loose",
    failureConsequence: { type: "damage", amount: 4, reason: "the grate gashes your hands" }
  });
  assert.equal(result.attemptResult.success, false);
  assert.equal(result.attemptResult.consequence.type, "damage");
  assert.equal(result.attemptResult.consequence.amount, 4);
  assert.equal(hp(result.run), before - 4, "HP visibly dropped by 4");
});

// ── type "none": a consequence-free failure mutates NOTHING ──────────────────
test("failure consequence 'none' costs no HP and adds no state (a beat, not a punishment)", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const before = hp(run);
  const result = scriptedAttempt(run, {
    intent: "search the empty alcove for anything hidden",
    failureConsequence: { type: "none", reason: "there is simply nothing here" }
  });
  assert.equal(result.attemptResult.success, false);
  assert.equal(result.attemptResult.consequence.type, "none");
  assert.equal(hp(result.run), before, "no HP lost on a consequence-free failure");
  assert.equal(result.attemptResult.damage, null);
  assert.deepEqual(objectStatesOf(result.run), {}, "no object degraded");
});

// ── legacy default: omitting failureConsequence keeps the small fixed cost ────
test("omitting a consequence falls back to the legacy fixed HP cost (degraded mode keeps teeth)", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const before = hp(run);
  const result = scriptedAttempt(run, { intent: "force the door open" }); // no failureConsequence
  assert.equal(result.attemptResult.success, false);
  assert.equal(result.attemptResult.damage.amount, 2, "legacy fixed 2 HP cost still applies");
  assert.equal(hp(result.run), before - 2);
});

// ── type "condition": added to player.conditions (shows on the sheet) ─────────
test("failure consequence 'condition' adds a tracked condition (idempotent by id)", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const result = scriptedAttempt(run, {
    intent: "stare into the warding sigil to read it",
    failureConsequence: { type: "condition", condition: "Dazed", reason: "the sigil's glare blinds you" }
  });
  assert.equal(result.attemptResult.consequence.type, "condition");
  const conditions = result.run.player.conditions;
  assert.ok(conditions.some((c) => c.id === "dazed" && c.name === "Dazed"), "Dazed condition tracked");
});

// ── type "objectState" + retryEffect "blocked": object degraded + retry foreclosed
test("failure consequence 'objectState'/'blocked' degrades the object AND forecloses retry", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });

  // First failed attempt: the GM marks the map torn and blocks re-reading it.
  const first = scriptedAttempt(run, {
    intent: "examine the map with Esk",
    dc: 12,
    fixedRoll: 7,
    failureConsequence: { type: "objectState", targetObject: "map", objectState: "torn", retryEffect: "blocked", reason: "the brittle map tears as you unfold it" }
  });
  assert.equal(first.attemptResult.success, false);
  assert.equal(first.attemptResult.consequence.type, "objectState");
  assert.equal(first.attemptResult.consequence.objectState, "torn");
  const states = objectStatesOf(first.run);
  assert.ok(states.map, "the map is now a tracked object");
  assert.equal(states.map.state, "torn", "tracked as torn (persisted on location.flags)");
  assert.equal(states.map.retryEffect, "blocked");

  // Retry on the SAME object — even with a winning roll — is foreclosed, no roll.
  const retry = scriptedAttempt(first.run, {
    intent: "examine the map again",
    dc: 12,
    fixedRoll: 20, // would succeed if it rolled
    failureConsequence: { type: "objectState", targetObject: "map", objectState: "torn", retryEffect: "blocked" }
  });
  assert.equal(retry.attemptResult.success, false, "blocked retry cannot succeed by re-rolling");
  assert.equal(retry.attemptResult.foreclosed, true);
  assert.equal(retry.attemptResult.checkResult, null, "no dice rolled on a foreclosed retry");
  assert.equal(retry.attemptResult.consequence.type, "retry_foreclosed");
  assert.match(retry.attemptResult.narration, /again|tears|torn/i, "narration explains the closed door");
  // No fresh harm from spamming a blocked object.
  assert.equal(retry.attemptResult.damage, null);
});

// ── retryEffect "harder": retry rolls against a higher DC (at disadvantage) ───
test("failure consequence 'harder' raises the retry DC so spamming is penalized, not free", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const first = scriptedAttempt(run, {
    intent: "pick the rusted lock",
    dc: 12,
    fixedRoll: 7,
    failureConsequence: { type: "objectState", targetObject: "lock", objectState: "jammed", retryEffect: "harder", reason: "a pin snaps off inside" }
  });
  assert.equal(objectStatesOf(first.run).lock.retryEffect, "harder");

  // A retry that clears the base DC (13 vs 12) but NOT the bumped DC (12+5=17)
  // now fails — the foreclosure made it harder.
  const retry = scriptedAttempt(first.run, {
    intent: "pick the lock again",
    dc: 12,
    fixedRoll: 13,
    failureConsequence: { type: "objectState", targetObject: "lock", objectState: "jammed", retryEffect: "harder" }
  });
  assert.equal(retry.attemptResult.foreclosed, true, "retry flagged as penalized");
  assert.equal(retry.attemptResult.success, false, "a roll that beat the base DC fails the harder DC");
});

// ── an ordinary failed check with no object stays freely retryable ────────────
test("a failed check with no object/retryEffect does NOT foreclose retry", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const failed = scriptedAttempt(run, {
    intent: "listen at the door for voices",
    failureConsequence: { type: "none", reason: "only silence" }
  });
  const fore = resolveRetryForeclosure(failed.run, { intent: "listen at the door for voices" });
  assert.equal(fore.effect, "none", "nothing foreclosed — empty-room perception stays retryable");
});

// ── type "resource": spends time (advances the world clock) ──────────────────
test("failure consequence 'resource' spends the stated resource", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const enforced = enforceFailureConsequence(run, { type: "resource", resource: "time", amount: 3 }, { intent: "decipher the runes" }, "2026-01-01T00:00:00.000Z");
  assert.equal(enforced.type, "resource");
  assert.equal(run.world.time.tick, 3, "world clock advanced by the spent time");
});

// ── contract validation accepts the new structured field ─────────────────────
test("validateAttemptProviderOutput accepts a well-formed failureConsequence and rejects a bad type", () => {
  const base = {
    summary: "s", successNarration: "ok", failureNarration: "no", proposedEffects: [],
    failureConsequence: { type: "objectState", targetObject: "map", objectState: "torn", retryEffect: "blocked" }
  };
  assert.equal(validateAttemptProviderOutput(base).ok, true);
  const bad = { ...base, failureConsequence: { type: "explode" } };
  assert.equal(validateAttemptProviderOutput(bad).ok, false);
});
