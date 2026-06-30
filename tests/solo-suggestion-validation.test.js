import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun } from "../server/solo/schema.js";
import { validateSuggestions, buildFallbackSuggestions } from "../server/solo/suggestions.js";

// Track A / Problem 3 — suggestions must be validated against scene state. A chip
// that points the player at an NPC requires that NPC in the present cast; the
// model cannot invent "the curious locals" in an empty wilderness.

function emptyWilderness() {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  run.npcs = {}; // CAST panel: "No one is here yet"
  return run;
}
function withPresentNpc(name) {
  const run = emptyWilderness();
  run.npcs = { npc_1: { npcId: "npc_1", displayName: name, currentLocationId: run.currentLocationId, status: "present" } };
  return run;
}

test("phantom-people chip is SUPPRESSED when no one is present (the repro)", () => {
  const run = emptyWilderness();
  const out = validateSuggestions(run, [
    "Engage the curious locals for clues",
    "Search the area for tracks",
    "Head north along the ridge"
  ]);
  assert.equal(out.includes("Engage the curious locals for clues"), false, "invented NPCs are dropped");
  assert.ok(out.includes("Search the area for tracks"), "the valid, entity-free chip survives");
  assert.equal(out.length, 3, "always exactly 3 (backfilled from the scene-aware fallback)");
});

test("a chip that NAMES a present NPC is kept", () => {
  const run = withPresentNpc("Kessa");
  const out = validateSuggestions(run, [
    "Approach Kessa and ask about the road",
    "Search the area",
    "Head for the gate"
  ]);
  assert.ok(out.includes("Approach Kessa and ask about the road"), "a real, present NPC reference is valid");
});

test("a chip directing the player at a NON-present person is suppressed", () => {
  const run = withPresentNpc("Kessa"); // only Kessa is here
  const out = validateSuggestions(run, [
    "Approach the warden and bargain for passage",
    "Search the area",
    "Head for the gate"
  ]);
  assert.equal(out.includes("Approach the warden and bargain for passage"), false, "the warden isn't in the cast → dropped");
});

test("an exploratory call into the unknown is NOT a phantom (allowed with nobody present)", () => {
  const run = emptyWilderness();
  const out = validateSuggestions(run, [
    "Call out and see who answers",
    "Search the ruins for anything useful",
    "Climb the ridge for a better view"
  ]);
  assert.ok(out.includes("Call out and see who answers"), "calling into emptiness presupposes no one — kept");
});

test("when every chip is a phantom, all 3 are backfilled from the safe scene-aware fallback", () => {
  const run = emptyWilderness();
  const out = validateSuggestions(run, ["Talk to the merchant", "Ask the guard for directions", "Engage the locals"]);
  assert.equal(out.length, 3, "exactly 3");
  assert.equal(new Set(out.map((s) => s.toLowerCase())).size, out.length, "no duplicates");
  const fallback = new Set(buildFallbackSuggestions(run).map((s) => s.toLowerCase()));
  assert.ok(out.every((s) => fallback.has(s.toLowerCase())), "all came from the deterministic fallback");
});

test("non-person chips (investigate / move) are never falsely suppressed", () => {
  const run = emptyWilderness();
  const out = validateSuggestions(run, [
    "Examine the shattered altar",
    "Search the collapsed hall",
    "Follow the cold draft deeper in"
  ]);
  assert.equal(out.length, 3);
  assert.ok(out.includes("Examine the shattered altar"));
  assert.ok(out.includes("Follow the cold draft deeper in"));
});
