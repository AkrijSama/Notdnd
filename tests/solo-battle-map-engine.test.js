import assert from "node:assert/strict";
import test from "node:test";
import {
  FEET_PER_TILE,
  tilesForSpeed,
  chebyshev,
  bfsDistances,
  computeReachable,
  moveCost,
  isLegalMove
} from "../src/components/battleMapEngine.js";

test("speed -> tile budget (1 tile = 5ft)", () => {
  assert.equal(FEET_PER_TILE, 5);
  assert.equal(tilesForSpeed(30), 6);
  assert.equal(tilesForSpeed(25), 5);
  assert.equal(tilesForSpeed(0), 0);
  assert.equal(tilesForSpeed(undefined), 6); // default 30
});

test("chebyshev distance", () => {
  assert.equal(chebyshev(0, 0, 3, 1), 3);
  assert.equal(chebyshev(2, 2, 2, 2), 0);
});

const grid = {
  width: 10,
  height: 10,
  tokenId: "player",
  positions: { player: { x: 5, y: 5 }, npc: { x: 6, y: 5 } }
};

test("computeReachable respects the budget and excludes start + occupied", () => {
  const r1 = computeReachable(grid, 1);
  // 8 neighbors minus the npc at (6,5)
  assert.equal(r1.size, 7);
  assert.ok(!r1.has("5,5"), "start excluded");
  assert.ok(!r1.has("6,5"), "occupied excluded");
  assert.ok(r1.has("4,5") && r1.has("5,6") && r1.has("4,4"));

  const r0 = computeReachable(grid, 0);
  assert.equal(r0.size, 0);
});

test("budget grows the reachable area (Chebyshev ring)", () => {
  const r2 = computeReachable(grid, 2);
  assert.ok(r2.has("3,5"), "2 tiles west reachable");
  assert.ok(r2.has("7,7"), "2 tiles diagonal reachable");
  assert.ok(!r2.has("2,5"), "3 tiles west NOT reachable at budget 2");
});

test("moveCost is BFS shortest path; blocked cells route around", () => {
  assert.equal(moveCost(grid, 4, 5), 1);
  assert.equal(moveCost(grid, 7, 5), 2); // around/past the npc, diagonal step
  assert.equal(moveCost(grid, 6, 5), Infinity); // occupied -> unreachable
});

test("isLegalMove gates on budget", () => {
  assert.equal(isLegalMove(grid, 6, 0, 0), true); // within 30ft
  assert.equal(isLegalMove(grid, 2, 8, 8), false); // too far
  assert.equal(isLegalMove(grid, 6, 6, 5), false); // occupied
});

test("out-of-bounds and edge starts are handled", () => {
  const edge = { width: 3, height: 3, tokenId: "p", positions: { p: { x: 0, y: 0 } } };
  const r = computeReachable(edge, 1);
  assert.deepEqual([...r].sort(), ["0,1", "1,0", "1,1"].sort());
});

test("missing token yields no movement", () => {
  assert.equal(computeReachable({ width: 5, height: 5, tokenId: "ghost", positions: {} }, 6).size, 0);
  assert.equal(moveCost({ width: 5, height: 5, tokenId: "ghost", positions: {} }, 1, 1), Infinity);
});
