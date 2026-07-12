import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultSoloRun } from "../server/solo/schema.js";
import { fireMomentumEvent, ensureMomentumState } from "../server/solo/momentum.js";
import { MOMENTUM_TEMPLATES } from "../server/campaign/momentumEvents.js";
import { hasCommittedDeadlineReferent } from "../server/gm/deadlineAudit.js";
import { enforceThreadDeadlines } from "../server/solo/threads.js";

// item 4b — momentum PROMOTION closes the fake-urgency class: an event that commits
// time-pressured stakes ("the storm is minutes away") also commits a THREAD CLOCK,
// so the urgency the GM narrates is backed by a committed deadline referent.

const T = (n) => new Date(1730000000000 + n * 1000).toISOString();

test("deadline-bearing momentum templates declare a deadline with a consequence", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  for (const id of ["hazard_storm", "hazard_fire"]) {
    const tpl = MOMENTUM_TEMPLATES.find((t) => t.templateId === id);
    const built = tpl.build(run);
    assert.ok(built.deadline, `${id} declares a deadline`);
    assert.ok(Number.isFinite(built.deadline.minutes) && built.deadline.minutes > 0, `${id} deadline has minutes`);
    assert.ok(typeof built.deadline.consequenceBrief === "string" && built.deadline.consequenceBrief.trim(), `${id} deadline has a consequence`);
  }
});

test("firing a deadline-bearing event commits a thread clock and makes urgency lawful", () => {
  // Sweep seeds deterministically until a deadline-bearing event fires.
  let hit = null;
  for (let i = 0; i < 60 && !hit; i += 1) {
    const run = createDefaultSoloRun({ now: T(0) });
    run.campaignId = "cmp"; run.worldSeed = `s_${i}`;
    ensureMomentumState(run); run.flags.momentum.turnCount = i + 1;
    const ev = fireMomentumEvent(run, { now: T(1), idFactory: () => `m_${i}` });
    if (ev && ev.deadlineThread) hit = { run, ev };
  }
  assert.ok(hit, "a deadline-bearing event fired within the seed sweep");
  const { run, ev } = hit;

  const thread = run.threads[ev.deadlineThread.threadId];
  assert.ok(thread, "the deadline thread was committed");
  assert.equal(thread.origin, "momentum");
  assert.equal(thread.status, "active");
  assert.ok(
    Number.isFinite(thread.clock.expiresAtMinutes) && thread.clock.expiresAtMinutes > run.world.time.minutes,
    "the thread carries a FUTURE world-clock deadline"
  );
  // The load-bearing point: the GM's urgency is now backed by a committed referent.
  assert.equal(hasCommittedDeadlineReferent(run), true);

  // And the deadline actually bites: on expiry the ladder resolves as expired.
  run.world.time.minutes = thread.clock.expiresAtMinutes + 1;
  const out = enforceThreadDeadlines(run, { now: T(2) });
  assert.ok(out.expired.some((e) => e.threadId === ev.deadlineThread.threadId), "the deadline lapses");
  assert.equal(run.threads[ev.deadlineThread.threadId].status, "expired");
});

test("a non-deadline event does NOT commit a thread (backward compatible)", () => {
  // arrival_watcher / arrival_scavenger etc. carry no deadline — no thread promoted.
  const run = createDefaultSoloRun({ now: T(0) });
  run.campaignId = "cmp"; run.worldSeed = "no_deadline";
  const watcher = MOMENTUM_TEMPLATES.find((t) => t.templateId === "arrival_watcher");
  assert.equal(watcher.build(run).deadline, undefined, "arrival_watcher implies no deadline");
});
