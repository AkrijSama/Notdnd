import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun } from "../server/solo/schema.js";
import {
  resolveAttemptAction,
  resolveRetryForeclosure,
  enforceFailureConsequence,
  validateAttemptProviderOutput,
  composeAttemptNarration
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

// ─────────────────────────────────────────────────────────────────────────────
// FORECLOSURE matches by a STABLE, PLAYER-DERIVED key (intent/target), NOT by the
// model's free-text targetObject label — so a retry phrased differently from the
// label still links to the degraded object (the bug the model swap exposed).
// ─────────────────────────────────────────────────────────────────────────────

function failProvider(failureConsequence) {
  return { summary: "You attempt it.", recommendedAbility: "strength", dc: 13, needsCheck: true, advantage: false, disadvantage: false, successNarration: "It opens.", failureNarration: "It resists.", proposedEffects: [], failureConsequence };
}
function attempt2(run, intent, fc, fixedRoll) {
  return resolveAttemptAction(run, { type: "attempt", actorId: "player", intent }, { fixedRoll, now: "2026-01-01T00:00:00.000Z", attemptProviderFn: () => failProvider(fc) });
}

test("foreclosure links a retry to the degraded object even when the MODEL LABELS IT DIFFERENTLY", () => {
  let run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  // The player attempts a LOCK, but the model labels the degraded object as "the
  // warped shutters" (lexically disjoint from the intent).
  const deg = attempt2(run, "force the rusted iron lock until it gives", { type: "objectState", targetObject: "the warped shutters", objectState: "jammed", retryEffect: "harder", reason: "a pin shears off inside" }, 1);
  run = deg.run;
  const entry = Object.values(objectStatesOf(run))[0];
  assert.ok(entry, "an object was degraded");
  // The match key is derived from the PLAYER's words, not the model label.
  assert.ok(entry.matchTokens.includes("lock"), "matchTokens come from the player intent (lock), not the label (shutters)");
  assert.ok(!entry.matchTokens.includes("shutters"), "the model label is NOT the match key");
  // A retry phrased differently from the label still forecloses.
  const retry = attempt2(run, "try to force the lock again", { type: "objectState", targetObject: "x", objectState: "jammed", retryEffect: "harder" }, 14);
  assert.equal(retry.attemptResult.foreclosed, true, "the rephrased retry links to the degraded lock");
});

test("foreclosure matches a retry on the same TARGET id regardless of wording", () => {
  let run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  // No targetId here (freeform), but the token path covers it; assert a same-object
  // rephrase links, and an unrelated object does NOT.
  const deg = attempt2(run, "pry the swollen oak door apart", { type: "objectState", targetObject: "the door", objectState: "splintered", retryEffect: "blocked", reason: "the wood splinters" }, 1);
  run = deg.run;
  const same = resolveRetryForeclosure(run, { intent: "shoulder the splintered door open" });
  assert.equal(same.effect, "blocked", "a rephrased retry on the same door is blocked");
  const other = resolveRetryForeclosure(run, { intent: "climb the crumbling wall to the ledge" });
  assert.equal(other.effect, "none", "an unrelated object still rolls (no over-foreclosure)");
});

test("foreclosure does NOT fire when the model label happens to share a word with an unrelated retry", () => {
  let run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  // Model labels a degraded MAP as "the ancient chart"; a later retry of a CHART of
  // stars (unrelated) must not falsely foreclose — because matching is on the
  // player's degrade-intent words (map), not the label (chart).
  const deg = attempt2(run, "examine the brittle wall map", { type: "objectState", targetObject: "the ancient chart", objectState: "torn", retryEffect: "blocked", reason: "the map tears" }, 1);
  run = deg.run;
  const unrelated = resolveRetryForeclosure(run, { intent: "study the star chart on the ceiling" });
  assert.equal(unrelated.effect, "none", "the label word 'chart' does not foreclose an unrelated chart");
  const sameObj = resolveRetryForeclosure(run, { intent: "look at the torn map again" });
  assert.equal(sameObj.effect, "blocked", "the same map (player word) still forecloses");
});

// ── ITEM-3: fallback-path narration is grounded in the enforced consequence reason
test("composeAttemptNarration: empty provider prose on a failure binds to the consequence reason", () => {
  // The offline/legacy fallback path (no provider prose) — bound to enforced state.
  assert.equal(
    composeAttemptNarration({ baseNarration: "", success: false, phrase: "wrench the grate loose", consequence: { type: "damage", reason: "the grate gashes your palms" } }),
    "You try to wrench the grate loose, but the grate gashes your palms."
  );
  // No reason (legacy fixed cost) → neutral line, not a fabricated cause.
  assert.equal(
    composeAttemptNarration({ baseNarration: "", success: false, phrase: "force the door", consequence: { type: "damage", reason: "" } }),
    "You try to force the door, but it doesn't come together this time."
  );
  // A foreclosure block line wins; a present provider line is preserved.
  assert.equal(composeAttemptNarration({ blockNarration: "It is too torn to read again.", baseNarration: "", success: false, phrase: "x", consequence: {} }), "It is too torn to read again.");
  assert.equal(composeAttemptNarration({ baseNarration: "The lock holds firm.", success: false, phrase: "x", consequence: { reason: "y" } }), "The lock holds firm.");
});
