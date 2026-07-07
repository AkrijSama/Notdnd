import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun } from "../server/solo/schema.js";
import { detectMoveIntent, getAvailableMoves } from "../server/solo/movement.js";
import { resolveSoloAction } from "../server/solo/actions.js";

// M.1 — a directed move sent as a free-text "attempt" must COMMIT the location
// change (success on a move = you actually moved), not just narrate arrival.

function discoveredRun() {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  // Simulate the campaign "told-of" reveal so the destination is a NAMED exit.
  run.locations.second_location.state.discovered = true;
  return run;
}

// ── detectMoveIntent ─────────────────────────────────────────────────────────
test("detects a move-intent toward a reachable, named (discovered) location", () => {
  const run = discoveredRun();
  const d = detectMoveIntent(run, "Head toward Ashenmoor Market Square");
  assert.ok(d?.reachable, "reachable move intent");
  assert.equal(d.toLocationId, "second_location");
});

test("detects a move-intent toward an UNDISCOVERED exit (matches the gated 'unexplored path' name)", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  assert.equal(getAvailableMoves(run)[0].name, "An unexplored path", "undiscovered exit is unnamed");
  const d = detectMoveIntent(run, "Head toward the unexplored path");
  assert.ok(d?.reachable, "the player can still travel an unnamed path");
  assert.equal(d.toLocationId, "second_location");
});

test("NON-move intents are not treated as moves (no false reroute)", () => {
  const run = discoveredRun();
  for (const intent of ["Search the ruins for anything useful", "Climb the broken wall", "Examine the rubble", "Listen at the door", "Rest by the fire"]) {
    assert.equal(detectMoveIntent(run, intent), null, `"${intent}" is not a move`);
  }
});

test("a move-intent naming a KNOWN but NOT-reachable place is flagged unreachable (no false arrival)", () => {
  const run = discoveredRun(); // at start_location; third_location is NOT connected to start
  const d = detectMoveIntent(run, "Travel to The Ashen Watch Gatehouse");
  assert.equal(d?.reachable, false);
  assert.equal(d?.knownUnreachable, true);
});

// ── end-to-end reroute-COMMIT through resolveSoloAction ──────────────────────
test("PIPELINE: a move-intent attempt COMMITS the location change (the M.1 repro)", () => {
  const run = discoveredRun();
  const before = run.currentLocationId;
  const res = resolveSoloAction(run, { type: "attempt", actorId: "player", intent: "Head toward Ashenmoor Market Square" }, { now: "2026-01-01T00:00:01.000Z" });
  assert.equal(res.ok, true);
  assert.equal(res.run.currentLocationId, "second_location", "currentLocation actually changed");
  assert.notEqual(res.run.currentLocationId, before);
  assert.equal(res.action.type, "move", "the attempt was rerouted to a committed move");
  assert.ok(res.moved && res.moved.toLocationId === "second_location", "move metadata surfaced");
  // Arrival reveals the destination (M.2 reveal-on-visit).
  assert.equal(res.run.locations.second_location.state.discovered, true);
  assert.equal(res.run.locations.second_location.state.visited, true);
});

test("PIPELINE: an undiscovered move-intent commits AND reveals the destination name", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const res = resolveSoloAction(run, { type: "attempt", actorId: "player", intent: "Head toward the unexplored path" }, { now: "2026-01-01T00:00:01.000Z" });
  assert.equal(res.run.currentLocationId, "second_location");
  assert.equal(res.run.locations.second_location.state.discovered, true, "arrival reveals it");
  // Now it is a NAMED exit going back.
  assert.ok(getAvailableMoves(res.run).some((m) => m.discovered && m.name === "Start Location"));
});

test("PIPELINE: an unreachable move-intent is REFUSED — location unchanged, no false arrival", () => {
  const run = discoveredRun();
  const before = run.currentLocationId;
  const res = resolveSoloAction(run, { type: "attempt", actorId: "player", intent: "Travel to The Ashen Watch Gatehouse" }, { now: "2026-01-01T00:00:01.000Z" });
  assert.equal(res.ok, true);
  assert.equal((res.run ?? run).currentLocationId, before, "did NOT move");
  assert.equal(res.attemptResult.success, false);
  assert.equal(res.attemptResult.gated, true, "refused (no LLM false-arrival narration)");
  assert.match(res.attemptResult.narration, /no path|can't|cannot|reach/i);
});

// ── Route-taking ("take the north road to X") — caught live in the guest walk:
// the Babel VOICE teaches this exact phrasing, and "take" (the item-take verb)
// wasn't a move trigger, so the walk narrated into the void instead of moving.
test('ROUTE-TAKING: "take the north road to <place>" is a MOVE and resolves the named exit', () => {
  const run = discoveredRun();
  const d = detectMoveIntent(run, "Take the north road to Ashenmoor Market Square");
  assert.ok(d?.reachable, "route-taking is a move intent");
  assert.equal(d.toLocationId, "second_location");
});

test('ROUTE-TAKING commits through the full pipeline (free-text attempt actually moves)', () => {
  const run = discoveredRun();
  const resolved = resolveSoloAction(run, {
    type: "attempt",
    actorId: "player",
    intent: "take the road north to Ashenmoor Market Square"
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.run.currentLocationId, "second_location", "the move COMMITTED");
});

test('ROUTE-TAKING does not hijack item takes: "take the crate" is NOT a move', () => {
  const run = discoveredRun();
  assert.equal(detectMoveIntent(run, "take the crate"), null);
  assert.equal(detectMoveIntent(run, "take the sword from the pedestal"), null);
});
