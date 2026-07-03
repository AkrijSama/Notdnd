import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun } from "../server/solo/schema.js";
import { resolveSoloAction, isInterrogativeIntent } from "../server/solo/actions.js";
import { resolveQuestAccept } from "../server/solo/questFlow.js";
import { buildDeliveryOffer } from "../server/campaign/authoredQuests.js";

// A1 (ask ≠ act), from the real-player corpus: an interrogative utterance must
// NEVER be committed as a state mechanic. "How deep does this ruin go? Is it
// lit?" — a real owner input — was routed through the directional move fallback
// and TELEPORTED the player who only asked a question.

const T = (n) => `2026-04-01T00:00:0${n}.000Z`;

function questionRun() {
  const run = createDefaultSoloRun({ now: T(0) });
  run.locations[run.currentLocationId].searchDetails = [
    { detailId: "d1", label: "The Collapsed Hall", description: "a fire-scarred hall", revealed: false },
    {
      detailId: "d2", label: "A Sealed Crate", description: "a crate", revealed: true,
      takeable: true, taken: false, takeKeywords: ["crate", "box"],
      grantItem: { itemId: "q_crate", name: "A Sealed Crate", qty: 1 }
    }
  ];
  return run;
}

test("isInterrogativeIntent: questions yes, directional declaratives no", () => {
  for (const q of [
    "How deep does this ruin go? Is it lit?",
    "is there anything worth taking here?",
    "can I go deeper into the ruins",
    "what lies down the unexplored path?",
    "Where does this road lead"
  ]) {
    assert.equal(isInterrogativeIntent(q), true, `"${q}" is a question`);
  }
  for (const d of ["go deeper into the ruins", "take the crate", "search the hall for anything useful", "I head toward the crossing"]) {
    assert.equal(isInterrogativeIntent(d), false, `"${d}" is a declarative`);
  }
});

test("A1: the owner's exact question does NOT commit a move (and 3 variants)", () => {
  for (const q of [
    "How deep does this ruin go? Is it lit?",
    "can I go deeper into the ruins?",
    "where does the unexplored path go",
    "is it safe to go further in?"
  ]) {
    const run = questionRun();
    const res = resolveSoloAction(run, { type: "attempt", actorId: "player", intent: q }, { now: T(1) });
    assert.equal(res.ok, true, `"${q}" resolves`);
    assert.notEqual(res.action.type, "move", `"${q}" must not route to move`);
    assert.equal(res.run.currentLocationId, "start_location", `"${q}" must not change position`);
  }
});

test("A1: interrogatives do not commit takes or searches either", () => {
  const run = questionRun();
  const take = resolveSoloAction(run, { type: "attempt", actorId: "player", intent: "is there anything worth taking here? maybe that crate?" }, { now: T(1) });
  assert.notEqual(take.action.type, "take");
  assert.equal((take.run.inventory || {}).q_crate, undefined, "no item minted from a question");
  const search = resolveSoloAction(run, { type: "attempt", actorId: "player", intent: "what would I find if I searched the area for anything hidden?" }, { now: T(2) });
  assert.notEqual(search.action.type, "search");
  assert.equal((search.run.locations.start_location.searchDetails || []).filter((d) => d.revealed && d.detailId === "d1").length, 0, "no reveal committed from a question");
});

test("A1 surgical: declaratives with directional verbs STILL move; takes still take", () => {
  const run = questionRun();
  const mv = resolveSoloAction(run, { type: "attempt", actorId: "player", intent: "go deeper into the ruins" }, { now: T(1) });
  assert.equal(mv.action.type, "move", "declarative directional still commits");
  assert.equal(mv.run.currentLocationId, "second_location");
  const tk = resolveSoloAction(questionRun(), { type: "attempt", actorId: "player", intent: "take the crate" }, { now: T(2) });
  assert.equal(tk.action.type, "take", "declarative take still commits");
});

test("A1 exemption: an explicit acceptance with a trailing question still ACCEPTS", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  run.currentLocationId = "second_location";
  run.locations.second_location.state = { visited: true, discovered: true };
  run.npcs = {
    npc_quest_giver: {
      npcId: "npc_quest_giver", displayName: "A waiting figure", role: "stranger",
      currentLocationId: "second_location", known: true, status: "present",
      memoryFactIds: [], tags: [], flags: {}, edition: "mainline",
      policyProfileId: "mainline_default", contentTags: [],
      questOffer: buildDeliveryOffer({ tone: "dark fantasy", name: "W" }, { giverLocationName: "here", destinationId: "third_location", destinationName: "the edge" })
    }
  };
  const res = resolveSoloAction(run, { type: "attempt", actorId: "player", intent: "Ok ill do it, where do you need me to take it?" }, { now: T(1) });
  assert.equal(res.action.type, "quest_accept", "the acceptance commits; the trailing question rides on prose");
  assert.ok(res.run.quests.quest_delivery, "quest created");
  // Sanity: resolveQuestAccept path is what fired (no double-accept possible after).
  const again = resolveQuestAccept(res.run, { type: "quest_accept", npcId: "npc_quest_giver" }, { now: T(2) });
  assert.equal(again.ok, false);
});
