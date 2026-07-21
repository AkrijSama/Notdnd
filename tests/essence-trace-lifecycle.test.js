// ESSENCE-TRACE DESTROY FATE (verdance-region-v1 §law-5 lifecycle) — proves the
// INSP-02 fix: a followable TRAIL is a perishable thing. It must not outlive the
// demon that laid it (source dead/removed) nor its own recency (age expiry), and
// STANDING residue/marks are exempt (a portal's guardians never leave). The prune
// is wired onto the world-clock tick (worldClock.advanceClock). Server logic only;
// ZERO OpenRouter / GPU calls.

import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun } from "../server/solo/schema.js";
import { loadScenarioIntoRun, loadScenarioFile } from "../server/campaign/scenarioLoader.js";
import { advanceClock } from "../server/solo/worldClock.js";
import {
  makeTrace,
  upsertTrace,
  getEssenceTraces,
  ensureEssenceTraces,
  buildSightPayload,
  followableTrailsAtCurrent,
  isTraceSourceDead,
  traceReachedExpiry,
  pruneEssenceTraces,
  TRACE_EXPIRY_MINUTES
} from "../server/solo/essence.js";

const T = (n) => new Date(1730000000000 + n * 1000).toISOString();

// A minimal run with a real edge (loc_a -> loc_b) so the trail at loc_a is genuinely
// FOLLOWABLE, plus the wolf that laid it standing at loc_b (linked via meta.encounter,
// the soft link a bestiary placement stamps).
function runWithHostileTrail() {
  const run = {
    currentLocationId: "loc_a",
    world: { time: { minutes: 100 } },
    locations: {
      loc_a: { locationId: "loc_a", name: "A", connectedLocationIds: ["loc_b"], state: { visited: true, discovered: true } },
      loc_b: { locationId: "loc_b", name: "B", connectedLocationIds: ["loc_a"], state: { discovered: true } }
    },
    npcs: {
      npc_wolf: { npcId: "npc_wolf", currentLocationId: "loc_b", status: "alive", flags: {} }
    },
    essenceTraces: []
  };
  upsertTrace(run, makeTrace({
    id: "trace_wolf",
    kind: "trail",
    source: "limping_grey",
    locationId: "loc_a",
    path: ["loc_b"],
    bornMinutes: 100,
    meta: { encounter: "npc_wolf" }
  }));
  return run;
}

// ── THE PRIMARY BUG: a followed trail must die with its owner ──────────────────
test("lifecycle: a trail whose source hostile is KILLED is destroyed — no longer followable/served", () => {
  const run = runWithHostileTrail();
  // Before the kill: the trail is live, served, and followable.
  assert.equal(getEssenceTraces(run).length, 1);
  assert.equal(followableTrailsAtCurrent(run).length, 1, "followable before the kill");
  assert.equal(buildSightPayload(run).followable, true);
  assert.equal(isTraceSourceDead(run, getEssenceTraces(run)[0]), false, "alive source → not dead");

  // Kill the wolf (the combat resolver marks the roster entity dead).
  run.npcs.npc_wolf.status = "dead";

  const removed = pruneEssenceTraces(run);
  assert.deepEqual(removed, ["trace_wolf"], "the dead-source trail is pruned");
  assert.equal(getEssenceTraces(run).length, 0, "trace destroyed, served to nothing");
  assert.equal(followableTrailsAtCurrent(run).length, 0, "no longer followable");
  assert.equal(buildSightPayload(run).followable, false, "sight surface no longer offers the follow");
});

test("lifecycle: a defeated-but-not-status-dead source (flags.defeated) also destroys its trail", () => {
  const run = runWithHostileTrail();
  run.npcs.npc_wolf.flags.defeated = true; // the combat close path stamps this too
  assert.equal(isTraceSourceDead(run, getEssenceTraces(run)[0]), true);
  assert.deepEqual(pruneEssenceTraces(run), ["trace_wolf"]);
});

test("lifecycle: an explicit sourceNpcId that no longer exists on the roster = source removed → destroyed", () => {
  const run = runWithHostileTrail();
  // Re-mint the same trail with a STRONG link to an entity that is gone from the run.
  run.essenceTraces = [];
  upsertTrace(run, makeTrace({
    id: "trace_ghost", kind: "trail", source: "drifted-demon",
    locationId: "loc_a", path: ["loc_b"], bornMinutes: 100, sourceNpcId: "npc_gone"
  }));
  assert.equal(isTraceSourceDead(run, getEssenceTraces(run)[0]), true, "absent strong ref = removed");
  assert.deepEqual(pruneEssenceTraces(run), ["trace_ghost"]);
});

// ── STANDING residue/marks are EXEMPT (regional law 2 replenishment) ───────────
test("lifecycle: a STANDING residue survives the prune even with a dead-named source", () => {
  const run = runWithHostileTrail();
  run.npcs.npc_wolf.status = "dead"; // its trail should die...
  upsertTrace(run, makeTrace({
    id: "residue_portal", kind: "residue", source: "npc_wolf", // names the dead npc
    locationId: "loc_b", standing: true, standingBand: "bright"
  }));
  const removed = pruneEssenceTraces(run);
  assert.deepEqual(removed, ["trace_wolf"], "only the trail dies");
  const ids = getEssenceTraces(run).map((t) => t.id);
  assert.deepEqual(ids, ["residue_portal"], "the standing residue is exempt and survives");
});

test("lifecycle: a standing trace never expires by age (guardians never leave)", () => {
  const run = { world: { time: { minutes: 0 } }, npcs: {}, essenceTraces: [] };
  upsertTrace(run, makeTrace({
    id: "residue_old", kind: "residue", source: "cold_door_portal",
    locationId: "loc_cold", standing: true, standingBand: "bright", bornMinutes: 0
  }));
  const ancient = TRACE_EXPIRY_MINUTES * 10;
  assert.equal(traceReachedExpiry(getEssenceTraces(run)[0], ancient), false, "standing never expires");
  run.world.time.minutes = ancient;
  assert.deepEqual(pruneEssenceTraces(run), [], "standing residue survives an ancient clock");
  assert.equal(getEssenceTraces(run).length, 1);
});

// ── EXPIRY: an aged non-standing trail is destroyed ────────────────────────────
test("lifecycle: an aged non-standing trail expires past the horizon; a fresh one survives", () => {
  const run = { world: { time: { minutes: 0 } }, npcs: {}, essenceTraces: [] };
  upsertTrace(run, makeTrace({ id: "trace_fresh", kind: "trail", source: "drift", locationId: "loc_a", bornMinutes: 0 }));
  upsertTrace(run, makeTrace({ id: "trace_old", kind: "trail", source: "drift", locationId: "loc_a", bornMinutes: 0 }));

  const now = TRACE_EXPIRY_MINUTES + 1;
  assert.equal(traceReachedExpiry(getEssenceTraces(run).find((t) => t.id === "trace_old"), now), true);
  // Bump the fresh one's birth so it stays within the horizon at `now`.
  getEssenceTraces(run).find((t) => t.id === "trace_fresh").bornMinutes = now - 60;

  run.world.time.minutes = now;
  const removed = pruneEssenceTraces(run);
  assert.deepEqual(removed, ["trace_old"], "only the aged trail is destroyed");
  assert.deepEqual(getEssenceTraces(run).map((t) => t.id), ["trace_fresh"], "the fresh trail survives");
});

// ── REGRESSION GUARD: a not-yet-spawned soft ref must NOT read as dead ─────────
test("lifecycle: a soft encounter ref that has not spawned yet is KEPT (not mistaken for removed)", () => {
  const run = { world: { time: { minutes: 100 } }, npcs: {}, essenceTraces: [] };
  // meta.encounter points at a creature spawnOnEnter has not minted yet — absent, not dead.
  upsertTrace(run, makeTrace({
    id: "trace_pending", kind: "trail", source: "rapture_drifter",
    locationId: "loc_a", path: ["loc_b"], bornMinutes: 100, meta: { encounter: "npc_not_yet" }
  }));
  assert.equal(isTraceSourceDead(run, getEssenceTraces(run)[0]), false, "absent SOFT ref = not-yet-spawned, not removed");
  assert.deepEqual(pruneEssenceTraces(run), [], "the pending trail survives");
});

// ── WIRING: the world-clock tick applies the destroy fate + reports it ─────────
test("lifecycle: advanceClock (the world-clock tick) prunes a dead-source trail and reports it", () => {
  const run = runWithHostileTrail();
  run.npcs.npc_wolf.status = "dead";
  const adv = advanceClock(run, 5, { now: T(1) });
  assert.deepEqual(adv.prunedTraceIds, ["trace_wolf"], "the tick record reports the destroyed trail");
  assert.equal(getEssenceTraces(run).length, 0, "the tick destroyed it");
});

test("lifecycle: advanceClock leaves a live-source trail and standing traces untouched", () => {
  const run = runWithHostileTrail(); // wolf alive
  upsertTrace(run, makeTrace({ id: "residue_x", kind: "residue", source: "portal", locationId: "loc_b", standing: true }));
  const adv = advanceClock(run, 5, { now: T(1) });
  assert.deepEqual(adv.prunedTraceIds, [], "nothing pruned while the source lives");
  assert.deepEqual(getEssenceTraces(run).map((t) => t.id).sort(), ["residue_x", "trace_wolf"]);
});

// ── RESUME-SAFE: a legacy run with no field / no traces is a no-op ─────────────
test("lifecycle: prune is a safe no-op on a legacy run with no essenceTraces field", () => {
  assert.deepEqual(pruneEssenceTraces({}), []);
  assert.deepEqual(pruneEssenceTraces({ essenceTraces: [] }), []);
  assert.deepEqual(pruneEssenceTraces(null), []);
});

// ── LOADER INTEGRITY: the four founding Verdance traces survive a normal tick ──
test("lifecycle: the seeded Verdance founding traces are NOT falsely pruned on a normal clock tick", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  run.campaignId = "cmp_test";
  loadScenarioIntoRun(run, loadScenarioFile("babel"), {});
  const before = getEssenceTraces(run).length;
  assert.ok(before >= 4, "the four founding traces (Warm House, St. Brigid's, Tithing Mill, Cold Door) seeded");
  const adv = advanceClock(run, 60, { now: T(1) });
  assert.deepEqual(adv.prunedTraceIds, [], "no founding trace is destroyed by a routine tick");
  assert.equal(getEssenceTraces(run).length, before, "seeded content preserved");
  // ensureEssenceTraces stays idempotent after the tick.
  assert.equal(ensureEssenceTraces(run).length, before);
});
