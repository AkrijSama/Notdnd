import test from "node:test";
import assert from "node:assert/strict";
import { applyHpDelta, awardXp } from "../server/solo/progression.js";

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
