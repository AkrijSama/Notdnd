import test from "node:test";
import assert from "node:assert/strict";
import {
  MILESTONE_MAX,
  applyHpDelta,
  awardXp,
  ensureMilestone,
  meetsTier,
  milestoneForXp,
  xpForMilestone
} from "../server/solo/progression.js";
import { createDefaultSoloRun, validatePlayerState } from "../server/solo/schema.js";

// Tests-of-record for the milestone-track engine delta
// (docs/specs/milestone-engine-delta.md).
//
// FIRST, per the spec's riskiest-seam finding: the four-mirror HP bump is
// extracted into ONE applyHpDelta() and regression-locked to keep every mirror
// in agreement — the UI's max HP and the death math's max HP must never
// diverge. These mirror tests assert EQUALITY of movement, not magnitudes, so
// they hold across the curve change.

function fullMirrorPlayer() {
  return {
    playerId: "p1",
    level: 1,
    xp: 0,
    status: "alive",
    maxHealth: 10,
    health: 10,
    resources: {
      hitPoints: { max: 10, current: 10 },
      hp: { max: 10, current: 10 }
    }
  };
}

function mirrorSnapshot(player) {
  return {
    maxHealth: player.maxHealth,
    health: player.health,
    hitPointsMax: player.resources?.hitPoints?.max,
    hitPointsCurrent: player.resources?.hitPoints?.current,
    hpMax: player.resources?.hp?.max,
    hpCurrent: player.resources?.hp?.current
  };
}

function assertMirrorsMovedEqually(before, after, context) {
  const deltas = Object.entries(before)
    .filter(([, v]) => typeof v === "number")
    .map(([k, v]) => ({ key: k, delta: after[k] - v }));
  assert.ok(deltas.length > 0, `${context}: no mirrors present`);
  const first = deltas[0].delta;
  for (const { key, delta } of deltas) {
    assert.equal(delta, first, `${context}: mirror ${key} moved ${delta}, expected ${first} — mirrors drifted`);
  }
  return first;
}

// ── applyHpDelta: the single HP write path ────────────────────────────────────

test("applyHpDelta moves all four mirrors by the same amount (max AND current)", () => {
  const player = fullMirrorPlayer();
  const before = mirrorSnapshot(player);
  const applied = applyHpDelta(player, 7);
  assert.equal(applied, 7);
  const moved = assertMirrorsMovedEqually(before, mirrorSnapshot(player), "applyHpDelta(7)");
  assert.equal(moved, 7);
});

test("applyHpDelta on a partial-mirror player touches what exists, invents nothing", () => {
  const player = { playerId: "p2", status: "alive", maxHealth: 12, health: 12 };
  applyHpDelta(player, 5);
  assert.equal(player.maxHealth, 17);
  assert.equal(player.health, 17);
  assert.equal(player.resources, undefined, "missing mirrors must not be invented");
});

test("applyHpDelta no-ops on zero, non-finite, and absent players", () => {
  const player = fullMirrorPlayer();
  const before = mirrorSnapshot(player);
  assert.equal(applyHpDelta(player, 0), 0);
  assert.equal(applyHpDelta(player, NaN), 0);
  assert.equal(applyHpDelta(player, "9"), 0);
  assert.equal(applyHpDelta(null, 5), 0);
  assert.deepEqual(mirrorSnapshot(player), before);
});

test("awardXp's progression bump keeps every HP mirror in agreement (riskiest-seam regression)", () => {
  const run = { status: "active", player: fullMirrorPlayer() };
  const before = mirrorSnapshot(run.player);
  const rec = awardXp(run, 300); // crosses at least one progression boundary on any curve
  assert.equal(rec.leveledUp, true, "300 xp must cross a boundary");
  const moved = assertMirrorsMovedEqually(before, mirrorSnapshot(run.player), "awardXp(300)");
  assert.ok(moved > 0, "progression must toughen the character across all mirrors");
});

test("multi-milestone gains keep the mirrors in agreement (spec test #7)", () => {
  const run = { status: "active", player: fullMirrorPlayer() };
  const before = mirrorSnapshot(run.player);
  awardXp(run, 1000); // milestone 1 → 5 in one award
  assert.equal(run.player.milestone, 5);
  const moved = assertMirrorsMovedEqually(before, mirrorSnapshot(run.player), "awardXp(1000)");
  assert.equal(moved, 20, "four milestones × 5 HP, on every mirror");
});

// ── Spec test #1 — the Ch7 curve, exact boundaries of record ─────────────────

test("milestoneForXp matches Ch7's table exactly", () => {
  assert.equal(xpForMilestone(2), 100);
  assert.equal(xpForMilestone(5), 1000);
  assert.equal(xpForMilestone(10), 4500);
  assert.equal(xpForMilestone(15), 10500);
  assert.equal(xpForMilestone(20), 19000);

  assert.equal(milestoneForXp(0), 1);
  assert.equal(milestoneForXp(99), 1);
  assert.equal(milestoneForXp(100), 2);
  assert.equal(milestoneForXp(999), 4);
  assert.equal(milestoneForXp(1000), 5);
  assert.equal(milestoneForXp(4499), 9);
  assert.equal(milestoneForXp(4500), 10);
  assert.equal(milestoneForXp(10500), 15);
  assert.equal(milestoneForXp(18999), 19);
  assert.equal(milestoneForXp(19000), 20);
  assert.equal(milestoneForXp(10_000_000), MILESTONE_MAX, "the curve hard-caps at the chassis budget");
});

// ── Spec test #2 — lazy migration: keep-and-floor, never revoke ──────────────

test("legacy save (level N, 5e-threshold xp) migrates to milestone N and never de-levels", () => {
  // A real legacy shape: level 7 earned on old cheap-early thresholds, xp far
  // below the Ch7 total for milestone 7 (2,100).
  const run = {
    status: "active",
    player: { playerId: "legacy", status: "alive", level: 7, xp: 120, maxHealth: 40, health: 40 }
  };
  const rec = awardXp(run, 25);
  assert.equal(run.player.milestone, 7, "milestone floors at the legacy level");
  assert.equal(run.player.level, 7, "display level unchanged — zero visible change on migration");
  assert.equal(rec.leveledUp, false, "the computed milestone lags the grandfathered one; nobody de-levels");
  assert.equal(run.player.xp, 145, "the xp ledger is kept as-is");
  assert.equal(run.player.maxHealth, 40, "no HP bump without a milestone gain");
});

test("ensureMilestone migrates lazily and clamps to the chassis cap", () => {
  const p1 = { level: 12 };
  assert.equal(ensureMilestone(p1), 12);
  assert.equal(p1.milestone, 12, "migration writes the milestone");
  const p2 = { level: 99 };
  assert.equal(ensureMilestone(p2), MILESTONE_MAX, "legacy levels clamp to the cap");
  const p3 = {};
  assert.equal(ensureMilestone(p3), 1, "no level at all defaults to 1");
});

test("milestone 20 hard-stops conversion: no further levels, no further HP", () => {
  const run = {
    status: "active",
    player: { playerId: "cap", status: "alive", level: 20, milestone: 20, xp: 19000, maxHealth: 105, health: 105 }
  };
  const rec = awardXp(run, 5000);
  assert.equal(rec.awarded, 5000, "xp still accrues (the ledger never closes)");
  assert.equal(run.player.milestone, 20);
  assert.equal(run.player.level, 20);
  assert.equal(rec.leveledUp, false);
  assert.equal(run.player.maxHealth, 105, "no HP beyond the final milestone");
});

// ── Spec test #3 — identity default: display === milestone, same numbers ─────

test("identity mapping: level always mirrors the milestone on fresh runs", () => {
  const run = createDefaultSoloRun({ displayName: "Mirror" });
  assert.equal(run.player.milestone, 1, "new runs are born with the milestone field");
  assert.equal(run.player.level, run.player.milestone);
  const rec = awardXp(run, 300);
  assert.equal(rec.milestone, 3);
  assert.equal(rec.displayLevel, 3);
  assert.equal(rec.level, rec.displayLevel, "the callers' `level` key carries displayLevel");
  assert.equal(run.player.level, run.player.milestone, "the mirror never diverges under identity");
});

test("awardXp return shape carries the milestone fields alongside the legacy keys", () => {
  const run = createDefaultSoloRun({ displayName: "Shape" });
  const rec = awardXp(run, 10);
  for (const key of ["awarded", "xp", "level", "leveledUp", "levelsGained", "milestone", "displayLevel", "milestoneUp", "minorLevelUps"]) {
    assert.ok(key in rec, `awardXp result must carry ${key}`);
  }
  assert.equal(rec.minorLevelUps, 0, "identity mapping has no minor levels (Phase 2 seam)");
});

// ── Spec test #6 — anti-inflation: gates read milestones, never display ──────

test("an inflated display level cannot fake a tier gate open", () => {
  // A world book showing milestone 3 as level 60 must still fail Tier II.
  const inflated = { milestone: 3, level: 60 };
  assert.equal(meetsTier(inflated, 2), false, "Tier II reads the milestone (floor 6), not the display 60");
  assert.equal(meetsTier(inflated, 1), true);

  assert.equal(meetsTier({ milestone: 6 }, 2), true);
  assert.equal(meetsTier({ milestone: 15 }, 3), true);
  assert.equal(meetsTier({ milestone: 15 }, 4), false);
  assert.equal(meetsTier({ milestone: 16 }, 4), true);
});

test("meetsTier migrates legacy players by the migration rule (level IS the old truth)", () => {
  const legacy = { level: 12 }; // no milestone yet — pre-delta save
  assert.equal(meetsTier(legacy, 3), true, "legacy level 12 → milestone 12 ≥ Tier III floor 11");
  assert.equal(legacy.milestone, 12, "the gate touch migrated the save");
  assert.equal(meetsTier(null, 2), false);
  assert.equal(meetsTier({ milestone: 8 }, 9), false, "unknown tier bands never pass");
});

// ── Schema: field defaulting + tolerant validation ───────────────────────────

test("schema: milestone validates when present, tolerates legacy absence", () => {
  const run = createDefaultSoloRun({ displayName: "Schema" });
  assert.equal(validatePlayerState(run.player).ok, true);

  const legacy = { ...run.player };
  delete legacy.milestone;
  assert.equal(validatePlayerState(legacy).ok, true, "legacy saves without a milestone still validate");

  const broken = { ...run.player, milestone: "eleven" };
  assert.equal(validatePlayerState(broken).ok, false, "a non-numeric milestone is rejected");
});
