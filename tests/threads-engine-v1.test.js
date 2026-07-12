import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun, validateSoloRun, validateThreadState } from "../server/solo/schema.js";
import {
  loadThreadsFromJson,
  instantiateThreadFromFront,
  seedSandboxThreads,
  enforceThreadDeadlines,
  advanceThreads,
  fireDueThreadBeatOnClock,
  resolveThreadLifecycle
} from "../server/solo/threads.js";
import { hasCommittedDeadlineReferent, detectDeadlineViolations } from "../server/gm/deadlineAudit.js";
import { buildSoloScenePayload } from "../server/solo/scene.js";
import { buildOocGroundingContext } from "../server/gm/oocGrounding.js";

// threads-engine-v1 — the tests-of-record for the D.5 reconciliation: authored/seeded
// plain-data load, deterministic tick triggers, server-decided visibility transitions,
// world-clock deadlines (auditor referent + expiry auto-advance), and resume-safety.

const T = (n) => new Date(1730000000000 + n * 1000).toISOString();

// An authored front (plain data an author could write by hand). Uses the "start"
// alias to prove load-time ref resolution; carries a world-clock deadline.
function dangerFront(overrides = {}) {
  return {
    frontId: "thread_test_danger",
    kind: "danger",
    origin: "worldgen",
    title: "Test danger",
    agenda: "A test agenda.",
    revealState: "hidden",
    groundedIn: { locationRefs: ["start"] },
    clock: { minTurnsBetweenBeats: 1, expiresAtMinutes: 600 },
    beats: [
      {
        beatId: "t0",
        label: "sign",
        reveal: "rumored",
        brief: "A sign.",
        decision: "Look?",
        trigger: { descriptive: { onPlayerAt: "start" } },
        payload: { fact: { text: "A sign at {place}." } }
      },
      {
        beatId: "t1",
        label: "break",
        reveal: "revealed",
        brief: "It breaks.",
        decision: "Run?",
        trigger: { prescriptive: { minTurn: 1, requiresBeat: "t0" } },
        payload: { objectState: { key: "test_break", locationId: "{player_location}", state: "hazard", reason: "broke" } }
      }
    ],
    resolution: [{ kind: "beat_final", outcome: "resolved" }],
    ...overrides
  };
}

function withTurn(run, n) {
  run.flags = run.flags || {};
  run.flags.momentum = { tension: 0, turnCount: n, lastFiredTurn: null, firedTemplateIds: [], lastEvent: null };
  return run;
}

// ── schema: v1 fields validate; a malformed deadline fails ────────────────────
test("a thread carrying clock.expiresAtMinutes validates; a non-number deadline fails", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  loadThreadsFromJson(run, [dangerFront()], {});
  const th = run.threads.thread_test_danger;
  assert.equal(validateThreadState(th).ok, true);
  assert.equal(th.clock.expiresAtMinutes, 600);
  assert.equal(validateSoloRun(run).ok, true);

  const bad = JSON.parse(JSON.stringify(th));
  bad.clock.expiresAtMinutes = "soon";
  assert.equal(validateThreadState(bad).ok, false);

  const nulled = JSON.parse(JSON.stringify(th));
  nulled.clock.expiresAtMinutes = null; // null = no deadline, still valid
  assert.equal(validateThreadState(nulled).ok, true);
});

// ── loadThreadsFromJson: the authored plain-data door ─────────────────────────
test("loadThreadsFromJson instantiates authored fronts, resolves refs, keeps the run valid", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  const res = loadThreadsFromJson(run, [dangerFront()], { failLoud: true });
  assert.deepEqual(res.loaded, ["thread_test_danger"]);
  const th = run.threads.thread_test_danger;
  // "start" alias → real id; the dynamic {player_location} stays a token.
  assert.deepEqual(th.groundedIn.locationIds, ["start_location"]);
  assert.equal(th.beats[0].trigger.descriptive.onPlayerAt, "start_location");
  assert.equal(th.beats[1].payload.objectState.locationId, "{player_location}");
  assert.equal(validateSoloRun(run).ok, true);
});

test("loadThreadsFromJson drops grounding in absent ids (referential closure holds)", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  loadThreadsFromJson(
    run,
    [dangerFront({ frontId: "t2", groundedIn: { entityRefs: ["npc_ghost"], locationRefs: ["start"] } })],
    {}
  );
  assert.deepEqual(run.threads.t2.groundedIn.entityIds, []); // ghost filtered
  assert.equal(validateSoloRun(run).ok, true);
});

test("loadThreadsFromJson never overwrites a committed thread", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  loadThreadsFromJson(run, [dangerFront()], {});
  run.threads.thread_test_danger.beatIndex = 1; // pretend it advanced
  loadThreadsFromJson(run, [dangerFront()], {}); // same id again
  assert.equal(run.threads.thread_test_danger.beatIndex, 1); // untouched
});

// ── seeding: 1-3 threads from worldgen context, deterministic ─────────────────
test("seedSandboxThreads seeds 1-3 valid threads deterministically, danger-with-deadline first", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  run.worldSeed = "seed_abc";
  const r = seedSandboxThreads(run, {});
  assert.ok(r.loaded.length >= 1 && r.loaded.length <= 3);
  assert.ok(run.threads.thread_seed_danger, "danger thread always seeded");
  assert.equal(typeof run.threads.thread_seed_danger.clock.expiresAtMinutes, "number");
  assert.equal(run.threads.thread_seed_danger.origin, "worldgen");
  assert.equal(validateSoloRun(run).ok, true);

  // deterministic: same seed → same set
  const runB = createDefaultSoloRun({ now: T(0) });
  runB.worldSeed = "seed_abc";
  seedSandboxThreads(runB, {});
  assert.deepEqual(Object.keys(run.threads).sort(), Object.keys(runB.threads).sort());

  // idempotent: a run that already has threads is not re-seeded
  const again = seedSandboxThreads(run, {});
  assert.deepEqual(again.loaded, []);
});

// ── deterministic tick: descriptive trigger fires on the player's own action ──
test("a descriptive onPlayerAt trigger advances the ladder when the player is there — and not otherwise", () => {
  const at = createDefaultSoloRun({ now: T(0) });
  loadThreadsFromJson(at, [dangerFront()], {});
  assert.equal(at.currentLocationId, "start_location");
  const fired = advanceThreads(at, {}, { now: T(1) });
  assert.equal(fired.fired, true);
  assert.equal(at.threads.thread_test_danger.beatIndex, 1);
  assert.equal(at.threads.thread_test_danger.beats[0].status, "committed");
  assert.ok((at.memoryFacts || []).some((f) => /a sign at/i.test(f.text || "")));

  // deterministic: identical run → identical outcome
  const at2 = createDefaultSoloRun({ now: T(0) });
  loadThreadsFromJson(at2, [dangerFront()], {});
  const fired2 = advanceThreads(at2, {}, { now: T(1) });
  assert.equal(fired2.fired, true);
  assert.equal(at2.threads.thread_test_danger.beatIndex, 1);

  // elsewhere: the same trigger does NOT fire
  const away = createDefaultSoloRun({ now: T(0) });
  loadThreadsFromJson(away, [dangerFront()], {});
  away.currentLocationId = "third_location";
  assert.equal(advanceThreads(away, {}, { now: T(1) }).fired, false);
});

// ── visibility transitions: server-decided, up the ladder only ────────────────
test("a committed beat raises revealState hidden→rumored→revealed and never lowers it", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  loadThreadsFromJson(run, [dangerFront()], {});
  assert.equal(run.threads.thread_test_danger.revealState, "hidden");

  advanceThreads(run, {}, { now: T(1) }); // t0.reveal = rumored
  assert.equal(run.threads.thread_test_danger.revealState, "rumored");

  withTurn(run, 5);
  fireDueThreadBeatOnClock(run, { now: T(2) }); // t1.reveal = revealed
  assert.equal(run.threads.thread_test_danger.revealState, "revealed");

  // never down: firing a rumored-reveal beat on an already-revealed thread is a no-op
  const down = createDefaultSoloRun({ now: T(0) });
  loadThreadsFromJson(down, [dangerFront()], {});
  down.threads.thread_test_danger.revealState = "revealed";
  advanceThreads(down, {}, { now: T(1) }); // t0.reveal = rumored (lower)
  assert.equal(down.threads.thread_test_danger.revealState, "revealed");
});

// ── deadline auditor: a thread clock is a lawful referent for time-boxed prose ─
test("hasCommittedDeadlineReferent recognizes an active thread clock; urgency then passes the auditor", () => {
  const run = createDefaultSoloRun({ now: T(0) }); // minutes 420
  loadThreadsFromJson(run, [dangerFront()], {}); // expiresAtMinutes 600 > 420
  assert.equal(hasCommittedDeadlineReferent(run), true);
  // Time-boxed narration is LAWFUL because a committed thread deadline backs it.
  assert.deepEqual(detectDeadlineViolations("You have maybe five minutes before the danger breaks.", run), []);

  // no thread → the same prose is FLAGGED
  const bare = createDefaultSoloRun({ now: T(0) });
  assert.equal(hasCommittedDeadlineReferent(bare), false);
  assert.ok(detectDeadlineViolations("You have maybe five minutes to decide.", bare).length >= 1);

  // an expired (resolved) thread no longer backs urgency
  const spent = createDefaultSoloRun({ now: T(0) });
  loadThreadsFromJson(spent, [dangerFront()], {});
  spent.threads.thread_test_danger.status = "resolved";
  assert.equal(hasCommittedDeadlineReferent(spent), false);
});

// ── deadline expiry: the clock auto-advances the ladder to its consequence ────
test("enforceThreadDeadlines lands the ladder consequence and resolves the thread as expired", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  loadThreadsFromJson(run, [dangerFront()], {});
  // player sees the telegraph first (beatIndex → 1, current beat is the break)
  advanceThreads(run, {}, { now: T(1) });
  assert.equal(run.threads.thread_test_danger.beatIndex, 1);

  run.world.time.minutes = 620; // past the deadline (600)
  const out = enforceThreadDeadlines(run, { now: T(2) });
  assert.equal(out.expired.length, 1);
  assert.equal(out.expired[0].outcome, "expired");
  assert.equal(out.expired[0].atMinutes, 600);
  assert.ok(out.driver, "an expiry drives one narration");

  const th = run.threads.thread_test_danger;
  // the consequence beat (t1) committed its objectState into the world:
  assert.ok(run.locations.start_location.flags?.objectStates?.test_break);
  assert.equal(th.status, "expired");
  assert.equal(th.resolved.outcome, "expired");
  assert.equal(th.resolved.atMinutes, 600);
  assert.equal(th.clock.expiresAtMinutes, null); // spent — never re-fires
  assert.equal(th.revealState, "revealed"); // t1.reveal
  assert.equal(validateSoloRun(run).ok, true);
});

test("a deadline not yet reached does nothing", () => {
  const run = createDefaultSoloRun({ now: T(0) }); // minutes 420, deadline 600
  loadThreadsFromJson(run, [dangerFront()], {});
  const out = enforceThreadDeadlines(run, { now: T(1) });
  assert.deepEqual(out.expired, []);
  assert.equal(run.threads.thread_test_danger.status, "active");
});

// ── resume-safety: serialize mid-ladder, reload, keep advancing ───────────────
test("a run round-tripped through JSON mid-ladder stays valid and continues advancing", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  loadThreadsFromJson(run, [dangerFront()], {});
  advanceThreads(run, {}, { now: T(1) }); // fire t0
  assert.equal(run.threads.thread_test_danger.beatIndex, 1);

  const reloaded = JSON.parse(JSON.stringify(run)); // == repository save/load
  const th = reloaded.threads.thread_test_danger;
  assert.equal(th.beatIndex, 1);
  assert.equal(th.beats[0].status, "committed");
  assert.equal(th.revealState, "rumored");
  assert.equal(validateSoloRun(reloaded).ok, true);

  // the tick continues on the reloaded run: the next rung fires on the clock
  withTurn(reloaded, 5);
  const beat = fireDueThreadBeatOnClock(reloaded, { now: T(2) });
  assert.ok(beat, "the next beat fires after reload");
  assert.equal(reloaded.threads.thread_test_danger.beatIndex, 2);
});

// ── lifecycle: a resolution rule closes a thread with a committed record ───────
test("resolveThreadLifecycle records { outcome, atMinutes } when a rule holds", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  loadThreadsFromJson(run, [dangerFront()], {});
  const th = run.threads.thread_test_danger;
  th.beatIndex = th.beats.length; // ladder spent → beat_final holds
  run.world.time.minutes = 500;
  const resolved = resolveThreadLifecycle(run, {}, { now: T(1) });
  assert.equal(resolved.length, 1);
  assert.equal(th.status, "resolved");
  assert.equal(th.resolved.outcome, "resolved");
  assert.equal(th.resolved.atMinutes, 500);
});

// ── player surface + OOC grounding: known threads (with deadline) surface ─────
test("the scene payload surfaces a known thread with its agenda and deadline; hidden stays hidden", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  loadThreadsFromJson(run, [dangerFront()], {}); // expiresAtMinutes 600, minutes 420
  const hiddenScene = buildSoloScenePayload(run, {});
  const hiddenEntry = (hiddenScene.threads || []).find((x) => x.threadId === "thread_test_danger");
  assert.ok(hiddenEntry, "the thread is present in the payload");
  assert.equal(hiddenEntry.title, undefined); // hidden: no title/agenda/deadline leaves the server
  assert.equal(hiddenEntry.deadline, undefined);

  run.threads.thread_test_danger.revealState = "revealed";
  const scene = buildSoloScenePayload(run, {});
  const t = (scene.threads || []).find((x) => x.threadId === "thread_test_danger");
  assert.equal(t.agenda, "A test agenda.");
  assert.ok(t.deadline && t.deadline.atMinutes === 600);
  assert.equal(t.deadline.inMinutes, 180); // 600 - 420
});

test("OOC grounding answers 'what should I be worried about' from committed threads", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  loadThreadsFromJson(run, [dangerFront()], {});
  run.threads.thread_test_danger.revealState = "revealed";
  const ctx = buildOocGroundingContext(run);
  assert.match(ctx, /ONGOING THREADS/);
  assert.match(ctx, /A test agenda\./);
  assert.match(ctx, /comes due in ~180 min/);

  // a purely hidden thread must NOT appear in the OOC answer
  const hidden = createDefaultSoloRun({ now: T(0) });
  loadThreadsFromJson(hidden, [dangerFront()], {});
  const hiddenCtx = buildOocGroundingContext(hidden);
  assert.doesNotMatch(hiddenCtx, /Test danger/);
});

// instantiateThreadFromFront is the shared bridge — a direct smoke on defaults.
test("instantiateThreadFromFront fills v1 defaults (clock, revealState, resolved:null)", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  const th = instantiateThreadFromFront({ frontId: "bare", kind: "secret", beats: [] }, run);
  assert.equal(th.threadId, "bare");
  assert.equal(th.revealState, "hidden");
  assert.equal(th.status, "active");
  assert.equal(th.clock.expiresAtMinutes, null);
  assert.equal(th.resolved, null);
});
