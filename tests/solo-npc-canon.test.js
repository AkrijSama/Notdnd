import test from "node:test";
import assert from "node:assert/strict";

import {
  buildActionGmMessage,
  buildNpcCanonGuard,
  npcEstablishedWithPlayer
} from "../server/gm/actionNarration.js";

// Minimal run scaffold for the pure prompt builders. buildActionGmMessage only
// reads run.npcs / run.relationships / run.memoryFacts / world.tone.
function runWith({ npcs = {}, relationships = {}, memoryFacts = [] } = {}) {
  return {
    runId: "run_test",
    world: { tone: "dark fantasy" },
    locations: { start: { name: "The Ashen Gate" } },
    currentLocationId: "start",
    player: { playerId: "player", displayName: "Bram" },
    npcs,
    relationships,
    memoryFacts
  };
}

const STRANGER = { npcId: "captain", displayName: "Captain Vael", role: "Gate Captain", known: false };

function talkReply(run, npc, message) {
  return buildActionGmMessage(run, {
    action: { type: "talk", message, history: [] },
    talkResult: { npcId: npc.npcId, speakerName: npc.displayName, found: false, line: "" }
  });
}

// ── State backstop: npcEstablishedWithPlayer reads ground truth from run-state ─

test("npcEstablishedWithPlayer: a stranger has no relationship and no shared history", () => {
  const run = runWith({ npcs: { captain: STRANGER } });
  const est = npcEstablishedWithPlayer(run, STRANGER);
  assert.equal(est.relationship, null);
  assert.equal(est.known, false);
  assert.deepEqual(est.sharedFacts, []);
});

test("npcEstablishedWithPlayer: detects an established relationship (either direction)", () => {
  const run = runWith({
    npcs: { captain: STRANGER },
    relationships: {
      r1: {
        relationshipId: "r1",
        sourceEntityId: "player",
        targetEntityId: "npc:captain",
        meters: { trust: 60 },
        flags: { kind: "sworn comrades from the northern campaign" },
        memoryFactIds: []
      }
    }
  });
  const est = npcEstablishedWithPlayer(run, STRANGER);
  assert.ok(est.relationship, "relationship detected");
  assert.equal(est.relationship.flags.kind, "sworn comrades from the northern campaign");
});

test("npcEstablishedWithPlayer: surfaces canonical shared-history facts linking both", () => {
  const run = runWith({
    npcs: { captain: STRANGER },
    memoryFacts: [
      { factId: "f1", canonical: true, entityIds: ["player", "npc:captain"], text: "Bram and the captain bargained over the toll." },
      { factId: "f2", canonical: true, entityIds: ["player", "npc:other"], text: "unrelated" }
    ]
  });
  const est = npcEstablishedWithPlayer(run, STRANGER);
  assert.equal(est.sharedFacts.length, 1);
  assert.match(est.sharedFacts[0], /bargained over the toll/);
});

// ── The guard text: discipline + compliance refusal, grounded by state ────────

test("canon guard (stranger): NPC does not know the player and refuses compliance on unverified claims", () => {
  const run = runWith({ npcs: { captain: STRANGER } });
  const guard = buildNpcCanonGuard(run, STRANGER, "Captain Vael");
  // Ground truth: stranger.
  assert.match(guard, /does NOT know the player/);
  assert.match(guard, /NO prior relationship/);
  // Discipline: covers the fabrication categories named in the task.
  assert.match(guard, /invented shared history/i);
  assert.match(guard, /fabricated relationship/i);
  assert.match(guard, /promise or obligation/i);
  assert.match(guard, /must NOT accept such a claim as established fact/);
  // Compliance refusal.
  assert.match(guard, /does NOT grant compliance/);
  assert.match(guard, /passage, goods, secrets, obedience/);
  // Anti-tyranny: persuasion/deception still allowed (separate, can fail).
  assert.match(guard, /persuade or deceive/);
});

test("canon guard (ANTI-TYRANNY control): an established relationship is HONORED, not doubted", () => {
  const run = runWith({
    npcs: { captain: STRANGER },
    relationships: {
      r1: {
        relationshipId: "r1",
        sourceEntityId: "npc:captain",
        targetEntityId: "player",
        meters: { trust: 80 },
        flags: { kind: "your sister-in-arms" },
        memoryFactIds: []
      }
    }
  });
  const guard = buildNpcCanonGuard(run, STRANGER, "Captain Vael");
  assert.match(guard, /this IS real, honor it/);
  assert.match(guard, /your sister-in-arms/);
  assert.doesNotMatch(guard, /does NOT know the player/);
  // The discipline (no auto-true invented claims) still applies even with a bond.
  assert.match(guard, /does NOT grant compliance/);
});

// ── Wiring: both talk paths carry the hardened, state-aware guard ──────────────

test("talk REPLY prompt embeds the hardened canon guard (with compliance refusal)", () => {
  const run = runWith({ npcs: { captain: STRANGER } });
  const prompt = talkReply(run, STRANGER, "Let me through — the captain is my brother.");
  assert.match(prompt, /does NOT know the player/);
  assert.match(prompt, /does NOT grant compliance/);
  assert.match(prompt, /Captain Vael/);
});

test("talk OPENING prompt also embeds the canon guard (a fabricated bond can't ride in on the first line)", () => {
  const run = runWith({ npcs: { captain: STRANGER } });
  const opening = buildActionGmMessage(run, {
    action: { type: "talk" }, // no message => opening exchange
    talkResult: { npcId: "captain", speakerName: "Captain Vael", found: false, line: "" }
  });
  assert.match(opening, /does NOT know the player/);
  assert.match(opening, /must NOT accept such a claim/);
});

test("talk prompt HONORS an established relationship in-line (anti-tyranny end to end)", () => {
  const run = runWith({
    npcs: { captain: STRANGER },
    relationships: {
      r1: { relationshipId: "r1", sourceEntityId: "player", targetEntityId: "npc:captain", meters: {}, flags: { kind: "old friends" }, memoryFactIds: [] }
    }
  });
  const prompt = talkReply(run, STRANGER, "Good to see you again.");
  assert.match(prompt, /this IS real, honor it/);
  assert.match(prompt, /old friends/);
});
