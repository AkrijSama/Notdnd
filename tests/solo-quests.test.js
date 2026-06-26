import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun, validateQuestState } from "../server/solo/schema.js";
import { createMainQuest, advanceQuests, getQuestPayload } from "../server/solo/quests.js";

const WORLD = { name: "Ashenmoor", tone: "grim", startingLocationName: "The Hollow" };

function runWithQuest(quest, patch = {}) {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  run.quests = { quest_main: quest };
  return Object.assign(run, patch);
}

test("createMainQuest returns a valid quest record", () => {
  const quest = createMainQuest(WORLD, { secondLocationId: "second_location", firstNpcId: "npc_start_contact" });

  // Shape from the scoping report.
  assert.equal(quest.questId, "quest_main");
  assert.equal(quest.status, "active");
  assert.equal(quest.isMain, true);
  assert.equal(quest.stage, 0);
  assert.ok(typeof quest.title === "string" && quest.title.length > 0);
  assert.ok(typeof quest.objective === "string" && quest.objective.length > 0);
  assert.deepEqual(quest.relatedEntityIds, []);
  assert.deepEqual(quest.memoryFactIds, []);
  assert.deepEqual(quest.flags, {});
  // Prefers reach_location at the supplied second location.
  assert.deepEqual(quest.completion, { kind: "reach_location", targetId: "second_location" });

  // Passes the schema validator (so it survives validateSoloRun).
  assert.equal(validateQuestState(quest).ok, true);
});

test("createMainQuest falls back to talk_beat when no second location exists", () => {
  const quest = createMainQuest(WORLD, { firstNpcId: "npc_start_contact" });
  assert.deepEqual(quest.completion, { kind: "talk_beat", targetId: "npc_start_contact" });
  assert.equal(validateQuestState(quest).ok, true);
});

test("createMainQuest defaults to reach_location at second_location with no options", () => {
  const quest = createMainQuest(WORLD);
  assert.deepEqual(quest.completion, { kind: "reach_location", targetId: "second_location" });
});

test("advanceQuests flips status to completed when a predicate matches", () => {
  const quest = createMainQuest(WORLD, { secondLocationId: "second_location" });
  const run = runWithQuest(quest, { currentLocationId: "second_location" });

  const outcome = advanceQuests(run, {});

  assert.equal(outcome.updated, true);
  assert.ok(outcome.wonQuest);
  assert.equal(outcome.wonQuest.questId, "quest_main");
  assert.equal(run.quests.quest_main.status, "completed");
});

test("advanceQuests does NOT flip status before the predicate is met", () => {
  const quest = createMainQuest(WORLD, { secondLocationId: "second_location" });
  // Player is still at the start location — the reach predicate is not satisfied.
  const run = runWithQuest(quest, { currentLocationId: "start_location" });

  const outcome = advanceQuests(run, {});

  assert.equal(outcome.updated, false);
  assert.equal(outcome.wonQuest, null);
  assert.equal(run.quests.quest_main.status, "active");
});

test("advanceQuests does not mutate on a non-matching action", () => {
  const quest = createMainQuest(WORLD, { secondLocationId: "second_location" });
  const run = runWithQuest(quest, { currentLocationId: "start_location" });
  const before = JSON.stringify(run.quests);

  // A search action with no bearing on a reach_location quest.
  const outcome = advanceQuests(run, { searchResult: { found: false } });

  assert.equal(outcome.updated, false);
  assert.equal(outcome.wonQuest, null);
  assert.equal(JSON.stringify(run.quests), before, "quests unchanged");
});

test("advanceQuests completes a talk_beat quest only when the beat links it", () => {
  const quest = createMainQuest(WORLD, { firstNpcId: "npc_start_contact" });
  const run = runWithQuest(quest);

  // Wrong / empty links: no completion.
  assert.equal(advanceQuests(run, { talkResult: { linkedQuestIds: [] } }).updated, false);
  assert.equal(advanceQuests(run, { talkResult: { linkedQuestIds: ["quest_side"] } }).updated, false);
  assert.equal(run.quests.quest_main.status, "active");

  // The beat links this quest: completion fires.
  const outcome = advanceQuests(run, { talkResult: { linkedQuestIds: ["quest_main"] } });
  assert.equal(outcome.updated, true);
  assert.equal(outcome.wonQuest.questId, "quest_main");
  assert.equal(run.quests.quest_main.status, "completed");
});

test("advanceQuests skips already-completed quests (idempotent)", () => {
  const quest = createMainQuest(WORLD, { secondLocationId: "second_location" });
  const run = runWithQuest(quest, { currentLocationId: "second_location" });

  const first = advanceQuests(run, {});
  assert.equal(first.updated, true);
  // Running again must not re-flip or re-report a win.
  const second = advanceQuests(run, {});
  assert.equal(second.updated, false);
  assert.equal(second.wonQuest, null);
});

test("getQuestPayload returns active quests and the main quest", () => {
  const quest = createMainQuest(WORLD, { secondLocationId: "second_location" });
  const run = runWithQuest(quest);

  const payload = getQuestPayload(run);
  assert.equal(payload.activeQuests.length, 1);
  assert.equal(payload.mainQuest.questId, "quest_main");

  // Once completed, it drops out of activeQuests but remains the main quest.
  run.quests.quest_main.status = "completed";
  const after = getQuestPayload(run);
  assert.equal(after.activeQuests.length, 0);
  assert.equal(after.mainQuest.questId, "quest_main");
});

test("getQuestPayload is safe on a run with no quests", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  const payload = getQuestPayload(run);
  assert.deepEqual(payload.activeQuests, []);
  assert.equal(payload.mainQuest, null);
});
