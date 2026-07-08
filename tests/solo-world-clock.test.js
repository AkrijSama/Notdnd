import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveClock,
  advanceClock,
  advanceCombatRounds,
  sanitizeDurationMinutes,
  phaseForMinuteOfDay,
  ensureClock,
  DAY_MINUTES,
  MAX_ACTION_MINUTES,
  COMBAT_ROUND_SECONDS
} from "../server/solo/worldClock.js";
import { resolveAttemptAction } from "../server/solo/attempt.js";
import { createDefaultSoloRun } from "../server/solo/schema.js";

// ---------------------------------------------------------------------------
// #14 WORLD CLOCK — pure derivations
// ---------------------------------------------------------------------------

test("phaseForMinuteOfDay maps the four phases at their exact boundaries", () => {
  assert.equal(phaseForMinuteOfDay(5 * 60 - 1), "night"); // 04:59
  assert.equal(phaseForMinuteOfDay(5 * 60), "dawn"); // 05:00
  assert.equal(phaseForMinuteOfDay(7 * 60), "day"); // 07:00
  assert.equal(phaseForMinuteOfDay(18 * 60 - 1), "day"); // 17:59
  assert.equal(phaseForMinuteOfDay(18 * 60), "dusk"); // 18:00
  assert.equal(phaseForMinuteOfDay(21 * 60 - 1), "dusk"); // 20:59
  assert.equal(phaseForMinuteOfDay(21 * 60), "night"); // 21:00
  assert.equal(phaseForMinuteOfDay(0), "night"); // 00:00
});

test("deriveClock derives day (1-based), HH:MM, and night flag", () => {
  const morning = deriveClock(7 * 60);
  assert.equal(morning.day, 1);
  assert.equal(morning.hhmm, "07:00");
  assert.equal(morning.phase, "day");
  assert.equal(morning.isNight, false);

  const nextDay = deriveClock(DAY_MINUTES + 30);
  assert.equal(nextDay.day, 2);
  assert.equal(nextDay.hhmm, "00:30");
  assert.equal(nextDay.isNight, true);
});

test("sanitizeDurationMinutes clamps to the sane band and rounds", () => {
  assert.equal(sanitizeDurationMinutes(-5), 0);
  assert.equal(sanitizeDurationMinutes(9999), MAX_ACTION_MINUTES);
  assert.equal(sanitizeDurationMinutes(12.6), 13);
  assert.equal(sanitizeDurationMinutes("nope", 4), 4); // non-number -> fallback
  assert.equal(sanitizeDurationMinutes(null, 30), 30);
});

test("advanceClock rolls the day and re-derives phase", () => {
  const run = { world: { time: { day: 1, tick: 0, minutes: 23 * 60 } } };
  const adv = advanceClock(run, 120, { now: "2026-07-08T00:00:00.000Z" });
  assert.equal(adv.minutes, 120);
  assert.equal(adv.after.clock, "01:00");
  assert.equal(adv.after.day, 2);
  assert.equal(adv.dayRolled, true);
  assert.equal(run.world.time.minutes, 24 * 60 + 60);
  assert.equal(run.world.time.day, 2);
  assert.equal(run.world.time.lastAdvancedAt, "2026-07-08T00:00:00.000Z");
});

test("ensureClock migrates a legacy { day, tick } run to a seeded minutes clock", () => {
  const run = { world: { time: { day: 3, tick: 12 } } };
  const time = ensureClock(run);
  // legacy day 3 seeds at 07:00 on day 3 => (3-1)*1440 + 420
  assert.equal(time.minutes, 2 * DAY_MINUTES + 7 * 60);
  assert.equal(time.day, 3);
  assert.equal(time.clock, "07:00");
  assert.equal(time.tick, 12); // legacy tick preserved
});

test("advanceCombatRounds keeps sub-minute skirmishes from burning game-hours", () => {
  const run = { world: { time: { day: 1, tick: 0, minutes: 7 * 60 } } };
  const r5 = advanceCombatRounds(run, 5); // 5 * 6s = 30s -> 0 whole minutes
  assert.equal(r5.minutes, 0);
  assert.equal(run.world.time.minutes, 7 * 60);
  const r15 = advanceCombatRounds(run, 15); // 15 * 6s = 90s -> 1 whole minute
  assert.equal(r15.minutes, 1);
  assert.equal(COMBAT_ROUND_SECONDS, 6);
});

// ---------------------------------------------------------------------------
// #14 WORLD CLOCK — committed through the live resolvers
// ---------------------------------------------------------------------------

test("resolveAttemptAction commits the GM-proposed durationMinutes", () => {
  const run = createDefaultSoloRun();
  const provider = () => ({
    summary: "search the wing",
    recommendedAbility: "investigation",
    dc: 12,
    needsCheck: true,
    successNarration: "You comb the wing.",
    failureNarration: "You find nothing and the time slips away.",
    proposedEffects: [],
    durationMinutes: 45
  });
  const res = resolveAttemptAction(
    run,
    { type: "attempt", intent: "search the east wing carefully", createdAt: "2026-07-08T00:10:00.000Z" },
    { attemptProviderFn: provider, fixedRoll: 20 }
  );
  assert.equal(res.ok, true);
  assert.equal(res.attemptResult.timeAdvance.minutes, 45);
  assert.equal(res.run.world.time.clock, "07:45");
  assert.equal(res.run.world.time.minutes, 7 * 60 + 45);
});

test("resolveAttemptAction clamps an over-cap duration instead of dropping the proposal", () => {
  const run = createDefaultSoloRun();
  const provider = () => ({
    summary: "wait",
    recommendedAbility: null,
    dc: null,
    needsCheck: false,
    successNarration: "You wait by the fire.",
    failureNarration: "nothing happens",
    proposedEffects: [],
    durationMinutes: 5000
  });
  const res = resolveAttemptAction(
    run,
    { type: "attempt", intent: "wait by the fire", createdAt: "2026-07-08T00:10:00.000Z" },
    { attemptProviderFn: provider }
  );
  assert.equal(res.ok, true);
  assert.equal(res.attemptResult.timeAdvance.minutes, MAX_ACTION_MINUTES);
});

test("resolveAttemptAction falls back to a band default when the GM omits a duration", () => {
  const run = createDefaultSoloRun();
  const provider = () => ({
    summary: "pick the lock",
    recommendedAbility: "dexterity",
    dc: 12,
    needsCheck: true,
    successNarration: "click",
    failureNarration: "the lock holds and the minutes pass",
    proposedEffects: []
  });
  const res = resolveAttemptAction(
    run,
    { type: "attempt", intent: "pick the lock", createdAt: "2026-07-08T00:10:00.000Z" },
    { attemptProviderFn: provider, fixedRoll: 20 }
  );
  assert.equal(res.ok, true);
  assert.equal(res.attemptResult.timeAdvance.minutes, 6); // DEFAULT_CHECK_MINUTES
});

test("the STATUS WINDOW payload surfaces the derived world clock", async () => {
  const { buildPlayerPayload } = await import("../server/solo/scene.js");
  const run = createDefaultSoloRun();
  run.world.time.minutes = 21 * 60; // 21:00 -> night
  const payload = buildPlayerPayload(run);
  assert.ok(payload.worldTime);
  assert.equal(payload.worldTime.clock, "21:00");
  assert.equal(payload.worldTime.phase, "night");
  assert.equal(payload.worldTime.isNight, true);
  assert.equal(payload.worldTime.day, 1);
});
