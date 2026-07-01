import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun } from "../server/solo/schema.js";
import { resolveSoloAction } from "../server/solo/actions.js";
import { detectSearchIntent } from "../server/solo/search.js";
import { detectMoveIntent } from "../server/solo/movement.js";

// HOLLOW-CORE fix: free-text intents must reach the mechanics that CHANGE state.
// A natural session ("search the ruins", "go deeper") must reveal placed features
// and commit moves — not narrate over a static world.

function ruinsRun() {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  run.locations[run.currentLocationId].searchDetails = [
    { detailId: "d_hall", label: "The Collapsed Hall", description: "a fire-scarred great hall, defensible", revealed: false },
    { detailId: "d_well", label: "The Old Well", description: "a deep well with cold water below", revealed: false }
  ];
  return run;
}
const revealedCount = (run) => (run.locations[run.currentLocationId].searchDetails || []).filter((d) => d.revealed).length;

// ── detectSearchIntent ───────────────────────────────────────────────────────
test("detectSearchIntent fires on natural area-search phrasing, not on other actions", () => {
  const run = ruinsRun();
  for (const i of ["Search the ruins for anything useful", "look for anything useful", "scour the area", "rummage through the debris", "search the walls for clues"]) {
    assert.ok(detectSearchIntent(run, i), `"${i}" should route to search`);
  }
  for (const i of ["climb the wall", "head toward the market", "attack the beast", "examine the strange markings"]) {
    assert.equal(detectSearchIntent(run, i), null, `"${i}" is not an area search`);
  }
});

test("detectSearchIntent does NOT fire when searching a present NPC (a person, not the area)", () => {
  const run = ruinsRun();
  run.npcs = { g: { npcId: "g", displayName: "The Warden", currentLocationId: run.currentLocationId, status: "present" } };
  assert.equal(detectSearchIntent(run, "search the warden for keys"), null);
  assert.ok(detectSearchIntent(run, "search the ruins for keys"), "the area is still searchable");
});

// ── broadened move detection (natural directional free-text) ─────────────────
test("directional free-text commits an ONWARD move even with no named exit", () => {
  const run = ruinsRun();
  for (const i of ["go deeper into the ruins", "Follow the unexplored path deeper", "press forward", "continue deeper", "venture inward", "delve deeper"]) {
    const d = detectMoveIntent(run, i);
    assert.ok(d?.reachable, `"${i}" should commit onward`);
    assert.equal(d.toLocationId, "second_location");
  }
});

test("directional detection does NOT fire on in-place actions", () => {
  const run = ruinsRun();
  for (const i of ["climb the wall", "examine the markings", "continue examining the wall", "press the lever", "force the door open", "what do i see?"]) {
    assert.equal(detectMoveIntent(run, i), null, `"${i}" is not a move`);
  }
});

// ── end-to-end: free-text advances world state ───────────────────────────────
test("PIPELINE: free-text 'search the ruins' REVEALS a placed feature (discoveredDetails increases)", () => {
  const run = ruinsRun();
  assert.equal(revealedCount(run), 0);
  const res = resolveSoloAction(run, { type: "attempt", actorId: "player", intent: "Search the ruins for anything useful" }, { now: "2026-01-01T00:00:01.000Z" });
  assert.equal(res.ok, true);
  assert.equal(res.action.type, "search", "attempt was rerouted to the real search mechanic");
  assert.equal(res.searchResult.found, true);
  assert.match(res.searchResult.summary, /hall|well/i, "a real placed feature was revealed");
  assert.equal(revealedCount(res.run), 1, "state changed: a feature is now discovered");
});

test("PIPELINE: repeated free-text searches reveal DISTINCT features (progress, not repetition)", () => {
  let run = ruinsRun();
  const r1 = resolveSoloAction(run, { type: "attempt", actorId: "player", intent: "search the area for anything useful" }, { now: "2026-01-01T00:00:01.000Z" });
  const r2 = resolveSoloAction(r1.run, { type: "attempt", actorId: "player", intent: "search the ruins for anything hidden" }, { now: "2026-01-01T00:00:02.000Z" });
  assert.equal(revealedCount(r2.run), 2, "two searches -> two distinct features revealed");
  assert.notEqual(r1.searchResult.summary, r2.searchResult.summary, "different feature each time");
});

test("PIPELINE: free-text 'go deeper' COMMITS a location change (and reveals the destination)", () => {
  const run = ruinsRun();
  const before = run.currentLocationId;
  const res = resolveSoloAction(run, { type: "attempt", actorId: "player", intent: "go deeper into the ruins" }, { now: "2026-01-01T00:00:01.000Z" });
  assert.equal(res.action.type, "move", "attempt was rerouted to the move mechanic");
  assert.equal(res.run.currentLocationId, "second_location");
  assert.notEqual(res.run.currentLocationId, before);
  assert.equal(res.run.locations.second_location.state.discovered, true, "arrival reveals the onward location");
});

test("PIPELINE: a NON-search, NON-move attempt still resolves normally (no over-routing)", () => {
  const run = ruinsRun();
  const res = resolveSoloAction(run, { type: "attempt", actorId: "player", intent: "climb the crumbling wall to the ledge" }, {
    fixedRoll: 15, now: "2026-01-01T00:00:01.000Z",
    attemptProviderFn: () => ({ summary: "x", recommendedAbility: "strength", dc: 12, needsCheck: true, advantage: false, disadvantage: false, successNarration: "up", failureNarration: "slip", proposedEffects: [] })
  });
  assert.equal(res.action.type, "attempt", "a real attempt is not rerouted");
  assert.ok(res.attemptResult.checkResult, "it rolled a normal check");
});
