import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { resolveSoloAction } from "../server/solo/actions.js";
import { attemptNeedsCheck } from "../server/solo/attempt.js";
import { extractQuotedSpeech, resolveConversationSpeaker, hasActionRemainder } from "../server/solo/dialogueRouting.js";

// dialogue-always-vn (owner law, 2026-07-11): ALL dialogue goes to the VN screen.
// Typed quoted speech is CONVERSATION (never a roll); mixed speech+action splits;
// plain questions are automatic; contested social still checks.

const NOW = "2026-01-01T00:00:00.000Z";
function idFactory() {
  const counts = {};
  return (prefix) => { counts[prefix] = (counts[prefix] || 0) + 1; return `${prefix}_${counts[prefix]}`; };
}
function addNpc(run, id, name) {
  run.npcs[id] = {
    npcId: id, displayName: name, role: "a bystander", currentLocationId: "start_location",
    known: true, status: "alive", memoryFactIds: [], tags: [], flags: {},
    edition: run.edition, policyProfileId: run.policyProfileId, contentTags: [], dialogueBeats: []
  };
  return run;
}

// (a) quoted speech → conversation classification, no checkResult, VN opens.
test("(a) typed quoted speech at a present NPC routes to CONVERSATION — VN opens, NO roll", () => {
  const run = addNpc(createDefaultSoloRun({ runId: "vn_a", now: NOW }), "npc_by", "Bystander");
  const result = resolveSoloAction(
    run,
    { type: "attempt", actorId: "player", mode: "speech", intent: '"What is licensed cleansing?"' },
    { now: NOW, idFactory: idFactory() }
  );
  assert.equal(result.ok, true);
  assert.equal(result.action.type, "talk", "quoted speech resolves as conversation, not an attempt");
  assert.equal(result.talkResult.npcId, "npc_by");
  assert.equal(result.talkResult.checkResult ?? null, null, "safe conversation never rolls");
  assert.deepEqual(result.run.vn, { active: true, speakerId: "npc_by" }, "the VN opens with the addressed NPC");
  assert.equal(result.run.timeline.at(-1).type, "talk");
  assert.equal(result.run.timeline.at(-1).payload.band ?? null, null, "no band stamped for conversation");
});

// (f/#2) plain question → automatic (the owner's verbatim live-failure line).
test("(#2) a plain question is automatic-tier — no roll (owner's verbatim line)", () => {
  assert.equal(attemptNeedsCheck("licensed cleansing, what is that?"), false);
  const run = addNpc(createDefaultSoloRun({ runId: "vn_q", now: NOW }), "npc_by", "Bystander");
  const result = resolveSoloAction(
    run,
    { type: "attempt", actorId: "player", intent: "licensed cleansing, what is that?" },
    { now: NOW, idFactory: idFactory() }
  );
  assert.equal(result.ok, true);
  assert.equal(result.attemptResult.band, "automatic");
  assert.equal(result.attemptResult.checkResult, null, "a question is never Rolled X vs DC Y");
});

// (b) the Talk button (an explicit talk action) is unchanged.
test("(b) an explicit talk action still resolves as a talk — unchanged", () => {
  const run = addNpc(createDefaultSoloRun({ runId: "vn_b", now: NOW }), "npc_by", "Bystander");
  const result = resolveSoloAction(
    run,
    { type: "talk", actorId: "player", targetEntityId: "npc:npc_by" },
    { now: NOW, idFactory: idFactory() }
  );
  assert.equal(result.ok, true);
  assert.equal(result.talkResult.npcId, "npc_by");
  assert.deepEqual(result.run.vn, { active: true, speakerId: "npc_by" });
});

// (c) mixed input splits — the action rolls, the quote opens the VN, both commit.
test("(c) mixed speech+action splits: action resolves through the resolver, quote to the VN", () => {
  const run = addNpc(createDefaultSoloRun({ runId: "vn_c", now: NOW }), "npc_man", "Garrick");
  const result = resolveSoloAction(
    run,
    { type: "attempt", actorId: "player", mode: "speech", intent: '"Wait!" I grab his arm' },
    { now: NOW, idFactory: idFactory(), fixedRoll: 12, attemptProviderFn: () => ({ summary: "grab", recommendedAbility: "strength", dc: 12, proposedEffects: [] }) }
  );
  assert.equal(result.ok, true);
  // the ACTION resolved (and rolled — "grab" is contested)
  assert.ok(result.attemptResult, "the action remainder resolved");
  assert.ok(result.attemptResult.checkResult, "the action rolled its stakes");
  // the SPEECH opened the VN with the addressed NPC
  assert.equal(result.talkResult.npcId, "npc_man");
  assert.deepEqual(result.spokenLine, { speakerId: "npc_man", text: "Wait!" });
  assert.deepEqual(result.run.vn, { active: true, speakerId: "npc_man" });
  // conservation: BOTH events committed this turn
  const tail = result.run.timeline.slice(-2).map((e) => e.type);
  assert.deepEqual(tail, ["attempt", "talk"]);
});

// (d) contested social (non-quoted intent) still checks — per the Ch3 tiers.
test("(d) contested social still rolls; plain speech does not", () => {
  assert.equal(attemptNeedsCheck("persuade the merchant to lower his price"), true);
  assert.equal(attemptNeedsCheck("intimidate the guard into leaving"), true);
  assert.equal(attemptNeedsCheck("deceive him about the missing key"), true);
  // a plain greeting/statement is automatic
  assert.equal(attemptNeedsCheck("greet the guard and say hello"), false);
});

// (e) nearby-NPC PROSE (non-quoted, no address) does NOT open a conversation — the
//     VN is player-initiated only. (Prose auto-VN stays dead; see solo-vn-agency.)
test("(e) a non-quoted, non-address action near an NPC does NOT route to conversation/VN", () => {
  const run = addNpc(createDefaultSoloRun({ runId: "vn_e", now: NOW }), "npc_by", "Bystander");
  const result = resolveSoloAction(
    run,
    { type: "attempt", actorId: "player", intent: "examine the muddy footprints on the ground" },
    { now: NOW, idFactory: idFactory(), fixedRoll: 15, attemptProviderFn: () => ({ summary: "look", recommendedAbility: "wisdom", dc: 12, proposedEffects: [] }) }
  );
  assert.equal(result.ok, true);
  assert.notEqual(result.action.type, "talk", "a non-speech action never becomes a conversation");
  assert.equal(result.run.vn.active, false, "the VN stays closed — nearby presence is not an address");
});

// speaker resolution priority (pure helper).
test("resolveConversationSpeaker honors address > active-VN > sole > last-interacted", () => {
  const base = addNpc(addNpc(createDefaultSoloRun({ runId: "vn_spk", now: NOW }), "npc_a", "Marta"), "npc_b", "Ilse");
  // explicit name
  assert.equal(resolveConversationSpeaker(base, '"Marta, is it safe?"'), "npc_a");
  // active VN session continues with the current speaker
  base.vn = { active: true, speakerId: "npc_b" };
  assert.equal(resolveConversationSpeaker(base, '"and what about the road?"'), "npc_b");
  // exactly one present NPC
  const solo = addNpc(createDefaultSoloRun({ runId: "vn_solo", now: NOW }), "npc_only", "Renn");
  assert.equal(resolveConversationSpeaker(solo, '"hello there"'), "npc_only");
});

// extraction conservation.
test("extractQuotedSpeech separates the spoken words from an action remainder", () => {
  assert.deepEqual(extractQuotedSpeech('"Wait!" I grab his arm'), { hasQuote: true, spokenText: "Wait!", remainder: "I grab his arm" });
  assert.deepEqual(extractQuotedSpeech('"Just a question about the sign."'), { hasQuote: true, spokenText: "Just a question about the sign.", remainder: "" });
  assert.equal(hasActionRemainder("I grab his arm"), true);
  assert.equal(hasActionRemainder("I say quietly"), false);
});
