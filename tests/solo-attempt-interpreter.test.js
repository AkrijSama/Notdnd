import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun } from "../server/solo/schema.js";
import { resolveAttemptAction } from "../server/solo/attempt.js";
import { buildAttemptInterpreterMessages, coerceInterpreterOutput, extractJsonObject } from "../server/gm/attemptInterpreter.js";
import { validateAttemptProviderOutput } from "../server/solo/attempt.js";

// ── extractJsonObject: tolerant parse of the model's structured reply ─────────

test("extractJsonObject parses a bare JSON object", () => {
  const out = extractJsonObject('{"type":"none","reason":"nothing here"}');
  assert.deepEqual(out, { type: "none", reason: "nothing here" });
});

test("extractJsonObject parses a ```json fenced object", () => {
  const out = extractJsonObject('```json\n{"dc": 14, "needsCheck": true}\n```');
  assert.deepEqual(out, { dc: 14, needsCheck: true });
});

test("extractJsonObject digs the object out of surrounding prose", () => {
  const out = extractJsonObject('Sure! Here is the adjudication: {"summary":"x"} — hope that helps.');
  assert.deepEqual(out, { summary: "x" });
});

test("extractJsonObject returns null on junk / non-object / empty", () => {
  assert.equal(extractJsonObject("the lock rattles but holds"), null);
  assert.equal(extractJsonObject("[1,2,3]"), null); // array is not an attempt object
  assert.equal(extractJsonObject(""), null);
  assert.equal(extractJsonObject("{ not json"), null);
});

// ── buildAttemptInterpreterMessages: pins the contract + per-case discipline ──

function providerInputFixture(overrides = {}) {
  return {
    ok: true,
    mode: "attempt_interpretation",
    context: {
      intent: "pry open the rusted iron grate",
      targetId: null,
      location: { name: "The Ashen Ruins", description: "Toppled stone half-swallowed by forest." },
      player: { resources: { hitPoints: { current: 9, max: 12 } } },
      ...overrides
    }
  };
}

test("buildAttemptInterpreterMessages returns system+user messages grounded in the attempt", () => {
  const messages = buildAttemptInterpreterMessages(providerInputFixture());
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].role, "user");
  // System pins the JSON-only contract and the per-case "none" discipline.
  assert.match(messages[0].content, /JSON object/i);
  assert.match(messages[0].content, /failureConsequence/);
  assert.match(messages[0].content, /"none" is valid and COMMON/);
  assert.match(messages[0].content, /objectState/);
  assert.match(messages[0].content, /retryEffect/);
  // The enum values are surfaced so the model stays in-contract.
  assert.match(messages[0].content, /blocked/);
  assert.match(messages[0].content, /harder/);
  // User message carries the live scene context.
  assert.match(messages[1].content, /pry open the rusted iron grate/);
  assert.match(messages[1].content, /The Ashen Ruins/);
  assert.match(messages[1].content, /9\/12/);
});

test("buildAttemptInterpreterMessages degrades gracefully on a thin context", () => {
  const messages = buildAttemptInterpreterMessages({ ok: true, context: {} });
  assert.equal(messages.length, 2);
  assert.match(messages[1].content, /Player HP: unknown/);
});

// ── coerceInterpreterOutput: keep a weak model's usable proposal in-contract ──

test("coerceInterpreterOutput drops unknown fields and fills required strings so a weak model passes validation", () => {
  // A dolphin-style reply: a real failureConsequence, but a stray field and no
  // narration strings — which the strict engine validator would otherwise reject.
  const coerced = coerceInterpreterOutput(
    {
      dc: 15,
      recommendedAbility: "strength",
      failureConsequence: { type: "objectState", targetObject: "the rusted lock", objectState: "jammed", retryEffect: "harder", reason: "a pin snaps off inside" },
      chitchat: "Sure, here is my ruling!" // unknown field
    },
    { intent: "force the rusted lock" }
  );
  assert.equal(coerced.chitchat, undefined, "unknown field dropped");
  assert.equal(coerced.failureConsequence.type, "objectState", "consequence preserved");
  // The engine validator now accepts it (required strings were filled).
  assert.equal(validateAttemptProviderOutput(coerced).ok, true);
});

test("coerceInterpreterOutput preserves an explicit type:none (no fabricated cost)", () => {
  const coerced = coerceInterpreterOutput(
    { failureConsequence: { type: "none", reason: "the room is empty" } },
    { intent: "search the empty room" }
  );
  assert.equal(coerced.failureConsequence.type, "none");
  assert.equal(validateAttemptProviderOutput(coerced).ok, true);
});

test("coerceInterpreterOutput returns null when the model gave no actionable signal", () => {
  assert.equal(coerceInterpreterOutput({}, { intent: "x" }), null);
  assert.equal(coerceInterpreterOutput({ onlyJunk: true }, { intent: "x" }), null);
  assert.equal(coerceInterpreterOutput(null, { intent: "x" }), null);
  assert.equal(coerceInterpreterOutput([1, 2], { intent: "x" }), null);
});

// ── GRACEFUL FALLBACK: a junk provider proposal must not crash or block the turn.
// This is the live-path safety net (the model is sometimes a weak local dolphin):
// the engine validates the proposal and, on junk, falls back to its sane default
// (legacy fixed HP cost), still resolving the turn and flagging the fallback.

const hp = (run) => run.player.resources.hitPoints.current;

test("a junk attempt proposal falls back to the legacy default (turn still resolves, with warning)", () => {
  const run = createDefaultSoloRun();
  const before = hp(run);
  const result = resolveAttemptAction(
    run,
    { type: "attempt", actorId: "player", intent: "force the ancient door" },
    {
      fixedRoll: 3, // force a failure
      now: "2026-01-01T00:00:00.000Z",
      // Invalid output: unknown fields + missing required narration strings.
      attemptProviderFn: () => ({ garbage: true, failureConsequence: { type: "explode" } })
    }
  );
  assert.equal(result.ok, true, "turn resolves despite junk proposal");
  assert.equal(result.attemptResult.success, false);
  assert.ok(result.attemptResult.warnings.includes("ATTEMPT_PROVIDER_FALLBACK"), "fallback flagged");
  // Legacy fixed cost applied (degraded mode keeps teeth) — not a crash, not a no-op.
  assert.ok(hp(result.run) < before, "legacy HP cost applied on fallback");
});

test("a non-JSON string proposal also resolves sanely (parsed as narration, then validated/fallback)", () => {
  const run = createDefaultSoloRun();
  const result = resolveAttemptAction(
    run,
    { type: "attempt", actorId: "player", intent: "decipher the worn inscription" },
    {
      fixedRoll: 2,
      now: "2026-01-01T00:00:00.000Z",
      attemptProviderFn: () => "the runes blur together; you can't make sense of them"
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.attemptResult.success, false);
});
