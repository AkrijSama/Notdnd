import test from "node:test";
import assert from "node:assert/strict";

import {
  applyCondition,
  tickConditions,
  clearCondition,
  conditionStatusPayload,
  describeCondition,
  normalizeConditionId,
  CONDITION_VOCAB
} from "../server/solo/conditions.js";
import { resolveAttemptAction } from "../server/solo/attempt.js";
import { resolveRestAction } from "../server/solo/rest.js";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { buildPlayerPayload } from "../server/solo/scene.js";

function runWithClock(minutes = 7 * 60) {
  const run = createDefaultSoloRun();
  run.world.time.minutes = minutes;
  run.player.conditions = [];
  return run;
}

test("normalizeConditionId matches the Ch8 vocabulary from free text", () => {
  assert.equal(normalizeConditionId("Poisoned").id, "poisoned");
  assert.equal(normalizeConditionId("you are poisoned by the fumes").id, "poisoned");
  assert.equal(normalizeConditionId("Frightened").canon, CONDITION_VOCAB.frightened);
  assert.equal(normalizeConditionId("some homebrew curse").canon, null);
});

test("describeCondition fills vocab defaults and honors GM overrides", () => {
  const canon = describeCondition({ name: "poisoned" });
  assert.equal(canon.name, "Poisoned");
  assert.equal(canon.defaultMinutes, 60);
  assert.ok(canon.effect.includes("Burden"));

  const override = describeCondition({ name: "poisoned", durationMinutes: 15, effect: "custom" });
  assert.equal(override.defaultMinutes, 15);
  assert.equal(override.effect, "custom");
});

test("applyCondition commits a timed entry with a clock-based expiry", () => {
  const run = runWithClock(7 * 60);
  const entry = applyCondition(run, { name: "poisoned" }, run.world.time.minutes);
  assert.equal(entry.id, "poisoned");
  assert.equal(entry.durationMinutes, 60);
  assert.equal(entry.appliedAtMinutes, 7 * 60);
  assert.equal(entry.expiresAtMinutes, 7 * 60 + 60);
  assert.equal(run.player.conditions.length, 1);
});

test("re-applying a condition refreshes to the LATER expiry, never shortens", () => {
  const run = runWithClock(7 * 60);
  applyCondition(run, { name: "poisoned", durationMinutes: 60 }, 7 * 60); // expires 08:00 (480)
  applyCondition(run, { name: "poisoned", durationMinutes: 10 }, 7 * 60 + 30); // 07:30+10 = 07:40 (460) < 480
  assert.equal(run.player.conditions.length, 1); // no duplicate stack
  // Refresh keeps the LATER expiry — a shorter re-dose never cuts an active timer short.
  assert.equal(run.player.conditions[0].expiresAtMinutes, 8 * 60);
});

test("tickConditions sheds only conditions whose timer has elapsed", () => {
  const run = runWithClock(7 * 60);
  applyCondition(run, { name: "stunned", durationMinutes: 1 }, 7 * 60); // expires 7:01
  applyCondition(run, { name: "poisoned", durationMinutes: 60 }, 7 * 60); // expires 8:00
  const tick = tickConditions(run, 7 * 60 + 5); // 07:05 — stunned gone, poisoned stays
  assert.deepEqual(tick.shed.map((s) => s.id), ["stunned"]);
  assert.equal(run.player.conditions.length, 1);
  assert.equal(run.player.conditions[0].id, "poisoned");
});

test("a permanent condition (null expiry) is never auto-shed but can be cleared", () => {
  const run = runWithClock(7 * 60);
  // curse: not in vocab -> unknown gets a default timer; force permanent via null.
  run.player.conditions.push({ id: "cursed", name: "Cursed", effect: "x", durationMinutes: null, appliedAtMinutes: 0, expiresAtMinutes: null });
  const tick = tickConditions(run, 99999);
  assert.equal(tick.shed.length, 0);
  const removed = clearCondition(run, "cursed");
  assert.equal(removed.id, "cursed");
  assert.equal(run.player.conditions.length, 0);
});

test("conditionStatusPayload reports remaining minutes for the STATUS WINDOW", () => {
  const run = runWithClock(7 * 60);
  applyCondition(run, { name: "poisoned" }, 7 * 60);
  const payload = conditionStatusPayload(run, 7 * 60 + 20);
  assert.equal(payload[0].name, "Poisoned");
  assert.equal(payload[0].remainingMinutes, 40);
  assert.equal(payload[0].permanent, false);
  assert.ok(payload[0].effect.length > 0);
});

// ---- Live through the resolver ----

test("a failed check applies a timed condition, and later time sheds it", () => {
  const run = runWithClock(7 * 60);
  const provider = () => ({
    summary: "brave the gas",
    recommendedAbility: "constitution",
    dc: 18,
    needsCheck: true,
    successNarration: "You hold your breath.",
    failureNarration: "The fumes take you.",
    proposedEffects: [],
    failureConsequence: { type: "condition", condition: "poisoned", durationMinutes: 30, reason: "the fumes" }
  });
  // Force a failure (roll 1 vs DC 18) so the condition applies.
  const res1 = resolveAttemptAction(
    run,
    { type: "attempt", intent: "push through the poison gas", createdAt: "2026-07-08T00:00:00.000Z" },
    { attemptProviderFn: provider, fixedRoll: 1 }
  );
  assert.equal(res1.ok, true);
  assert.equal(res1.attemptResult.band, "failure");
  const poisoned = res1.run.player.conditions.find((c) => c.id === "poisoned");
  assert.ok(poisoned, "condition committed");
  assert.equal(poisoned.durationMinutes, 30);

  // A short rest passes 1h (the default location allows short) and must shed the
  // 30-min poison, which the intervening hour outlasts.
  const rest = resolveRestAction(res1.run, { type: "rest", restType: "short", createdAt: "2026-07-08T01:00:00.000Z" });
  assert.equal(rest.ok, true);
  assert.ok(rest.run, "short rest is allowed at the default location");
  assert.equal(rest.run.player.conditions.find((c) => c.id === "poisoned"), undefined);
});

test("the STATUS WINDOW conditions carry effect + remaining after a live application", () => {
  const run = runWithClock(7 * 60);
  applyCondition(run, { name: "frightened" }, run.world.time.minutes);
  const payload = buildPlayerPayload(run);
  const cond = payload.conditions.find((c) => c.id === "frightened");
  assert.ok(cond);
  assert.equal(cond.name, "Frightened");
  assert.ok(cond.effect.length > 0);
  assert.equal(typeof cond.remainingMinutes, "number");
});
