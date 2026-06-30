import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun } from "../server/solo/schema.js";
import { resolveSoloAction } from "../server/solo/actions.js";
import { playerKnowsEntity, runHasCanonicalEvent, claimSupportedByCanon } from "../server/solo/canon.js";

// Part B: canonical event / relationship claims are checked against server-owned
// run-state (run.relationships + canonical run.memoryFacts + run.timeline) — the
// player cannot establish a past event or a bond by declaration.

test("a fabricated past event is UNSUPPORTED by run-state", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  assert.equal(runHasCanonicalEvent(run, ["slew", "warlord"]), false);
  assert.equal(runHasCanonicalEvent(run, ["siege", "blackmoor"]), false);
  assert.equal(runHasCanonicalEvent(run, ["promised", "throne"]), false);
});

test("a real event that actually happened IS supported (queryable from canon)", () => {
  let run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  // A move writes a canonical movement memory fact + timeline event.
  const moved = resolveSoloAction(run, { type: "move", toLocationId: "second_location" }, { now: "2026-01-01T00:00:01.000Z" });
  run = moved.run;
  assert.equal(runHasCanonicalEvent(run, ["moved"]), true, "the move is on the canonical record");
  assert.equal(runHasCanonicalEvent(run, ["second_location"]), true);
});

test("a fabricated relationship is UNSUPPORTED (no bond → not established)", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  assert.equal(playerKnowsEntity(run, "npc_phantom"), false);
  assert.equal(playerKnowsEntity(run, "npc:npc_made_up_brother"), false);
  assert.deepEqual(claimSupportedByCanon(run, { entityRef: "npc_phantom" }), { supported: false, reason: "no established bond in run-state" });
});

test("an established relationship in run-state IS honored (anti-tyranny — real bonds are real)", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  // Seed a canonical relationship between the player and an NPC directly in state.
  run.relationships = {
    rel_1: { relationshipId: "rel_1", sourceEntityId: "player", targetEntityId: "npc:npc_ally", flags: { kind: "old comrade" } }
  };
  assert.equal(playerKnowsEntity(run, "npc_ally"), true, "a recorded bond is honored");
  assert.equal(playerKnowsEntity(run, "npc:npc_ally"), true, "matches the npc:-prefixed form too");
  assert.equal(claimSupportedByCanon(run, { entityRef: "npc_ally" }).supported, true);
});

test("a canonical shared memory fact establishes a bond", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  run.memoryFacts = [
    ...(run.memoryFacts || []),
    { factId: "f_shared", entityIds: ["player", "npc:npc_hale"], type: "shared_history", text: "The player saved Hale from the collapse.", source: "system", createdAt: "2026-01-01T00:00:00.000Z", tags: [], canonical: true }
  ];
  assert.equal(playerKnowsEntity(run, "npc_hale"), true);
  // A non-canonical (retracted/unverified) fact does NOT establish a bond.
  run.memoryFacts.push({ factId: "f_doubt", entityIds: ["player", "npc:npc_stranger"], type: "claim", text: "x", source: "system", createdAt: "2026-01-01T00:00:00.000Z", tags: [], canonical: false });
  assert.equal(playerKnowsEntity(run, "npc_stranger"), false, "a non-canonical fact is not ground truth");
});

test("claimSupportedByCanon handles event keywords and empty claims", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  assert.equal(claimSupportedByCanon(run, { eventKeywords: ["slew", "warlord"] }).supported, false);
  assert.equal(claimSupportedByCanon(run, {}).supported, false);
});
