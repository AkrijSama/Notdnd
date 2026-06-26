import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun, validateQuestState } from "../server/solo/schema.js";
import { createMainQuest, advanceQuests, getQuestPayload } from "../server/solo/quests.js";
import { resolveSoloAction } from "../server/solo/actions.js";

const WORLD = { name: "Ashenmoor", tone: "grim", startingLocationName: "The Hollow" };

function runWithQuest(quest, patch = {}) {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  run.quests = { quest_main: quest };
  return Object.assign(run, patch);
}

test("createMainQuest returns a valid quest record", () => {
  const quest = createMainQuest(WORLD, { secondLocationId: "second_location", firstNpcId: "npc_quest_giver" });

  assert.equal(quest.questId, "quest_main");
  assert.equal(quest.status, "active");
  assert.equal(quest.isMain, true);
  assert.equal(quest.stage, 0);
  assert.ok(typeof quest.title === "string" && quest.title.length > 0);
  assert.ok(typeof quest.objective === "string" && quest.objective.length > 0);
  assert.deepEqual(quest.relatedEntityIds, []);
  assert.deepEqual(quest.memoryFactIds, []);
  assert.deepEqual(quest.flags, {});
  // Top-level completion mirrors the active (stage 0) completion for back-compat.
  assert.deepEqual(quest.completion, { kind: "reach_location", targetId: "second_location" });

  // Passes the schema validator (so it survives validateSoloRun).
  assert.equal(validateQuestState(quest).ok, true);
});

test("createMainQuest builds two stages: reach the location, then talk", () => {
  const quest = createMainQuest(WORLD, {
    secondLocationId: "second_location",
    secondLocationName: "Market Square",
    firstNpcId: "npc_quest_giver"
  });

  assert.equal(Array.isArray(quest.stages), true);
  assert.equal(quest.stages.length, 2);
  assert.deepEqual(quest.stages[0].completion, { kind: "reach_location", targetId: "second_location" });
  assert.deepEqual(quest.stages[1].completion, { kind: "talk_beat", targetId: "npc_quest_giver" });
  // Stage 0 objective references the destination by name.
  assert.match(quest.stages[0].objective, /Market Square/);
  // Title + description reference the arc from the start.
  assert.match(quest.description, /Market Square/);
  // Top-level fields mirror stage 0.
  assert.deepEqual(quest.completion, quest.stages[0].completion);
  assert.equal(quest.objective, quest.stages[0].objective);
});

test("createMainQuest defaults stage 0 to reach_location at second_location", () => {
  const quest = createMainQuest(WORLD);
  assert.deepEqual(quest.stages[0].completion, { kind: "reach_location", targetId: "second_location" });
  assert.deepEqual(quest.completion, { kind: "reach_location", targetId: "second_location" });
});

test("stage 0 predicate fires -> advances to stage 1, NOT completed", () => {
  const quest = createMainQuest(WORLD, { secondLocationId: "second_location", firstNpcId: "npc_quest_giver" });
  const run = runWithQuest(quest, { currentLocationId: "second_location" });

  const outcome = advanceQuests(run, {});

  assert.equal(outcome.updated, true);
  assert.equal(outcome.wonQuest, null, "reaching the location is not a win");
  assert.equal(run.quests.quest_main.stage, 1, "advanced to stage 1");
  assert.equal(run.quests.quest_main.status, "active", "still active, not completed");
  assert.equal(outcome.advanced[0].questId, "quest_main");
  assert.deepEqual(outcome.completed, []);
  // Top-level completion now mirrors stage 1 (the talk beat).
  assert.deepEqual(run.quests.quest_main.completion, { kind: "talk_beat", targetId: "npc_quest_giver" });
});

test("stage 1 predicate fires -> quest completes (and is a win for the main quest)", () => {
  const quest = createMainQuest(WORLD, { secondLocationId: "second_location", firstNpcId: "npc_quest_giver" });
  quest.stage = 1; // already advanced to the talk stage
  const run = runWithQuest(quest);

  const outcome = advanceQuests(run, { talkResult: { linkedQuestIds: ["quest_main"] } });

  assert.equal(outcome.updated, true);
  assert.ok(outcome.wonQuest);
  assert.equal(outcome.wonQuest.questId, "quest_main");
  assert.equal(run.quests.quest_main.status, "completed");
  assert.deepEqual(outcome.advanced, [], "completing is not a stage advance");
});

test("questJustAdvanced is set on a stage advance via resolveSoloAction", () => {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  run.quests = {
    quest_main: createMainQuest(WORLD, { secondLocationId: "second_location", firstNpcId: "npc_quest_giver" })
  };

  // Moving into the second location satisfies stage 0 -> advances to stage 1.
  const result = resolveSoloAction(run, { type: "move", actorId: "player", toLocationId: "second_location" });

  assert.equal(result.ok, true);
  assert.ok(!result.runWon, "a stage advance is not a win");
  assert.ok(result.questJustAdvanced, "questJustAdvanced set on stage advance");
  assert.equal(result.questJustAdvanced.questId, "quest_main");
  assert.equal(result.run.quests.quest_main.stage, 1);
  assert.equal(result.run.quests.quest_main.status, "active");
});

test("advanceQuests does NOT advance before the active stage's predicate is met", () => {
  const quest = createMainQuest(WORLD, { secondLocationId: "second_location", firstNpcId: "npc_quest_giver" });
  // Still at the start location — stage 0's reach predicate is not satisfied.
  const run = runWithQuest(quest, { currentLocationId: "start_location" });

  const outcome = advanceQuests(run, {});

  assert.equal(outcome.updated, false);
  assert.equal(outcome.wonQuest, null);
  assert.equal(run.quests.quest_main.stage, 0);
  assert.equal(run.quests.quest_main.status, "active");
});

test("advanceQuests does not mutate on a non-matching action", () => {
  const quest = createMainQuest(WORLD, { secondLocationId: "second_location", firstNpcId: "npc_quest_giver" });
  const run = runWithQuest(quest, { currentLocationId: "start_location" });
  const before = JSON.stringify(run.quests);

  // A search action has no bearing on stage 0's reach_location predicate.
  const outcome = advanceQuests(run, { searchResult: { found: false } });

  assert.equal(outcome.updated, false);
  assert.equal(JSON.stringify(run.quests), before, "quests unchanged");
});

test("the talk stage completes only when the beat links this quest", () => {
  const quest = createMainQuest(WORLD, { secondLocationId: "second_location", firstNpcId: "npc_quest_giver" });
  quest.stage = 1; // on the talk stage
  const run = runWithQuest(quest);

  assert.equal(advanceQuests(run, { talkResult: { linkedQuestIds: [] } }).updated, false);
  assert.equal(advanceQuests(run, { talkResult: { linkedQuestIds: ["quest_side"] } }).updated, false);
  assert.equal(run.quests.quest_main.status, "active");

  const outcome = advanceQuests(run, { talkResult: { linkedQuestIds: ["quest_main"] } });
  assert.equal(outcome.updated, true);
  assert.equal(run.quests.quest_main.status, "completed");
});

test("advanceQuests skips an already-completed quest (idempotent)", () => {
  const quest = createMainQuest(WORLD, { secondLocationId: "second_location", firstNpcId: "npc_quest_giver" });
  const run = runWithQuest(quest, { currentLocationId: "second_location" });

  advanceQuests(run, {}); // stage 0 -> 1
  advanceQuests(run, { talkResult: { linkedQuestIds: ["quest_main"] } }); // stage 1 -> completed
  assert.equal(run.quests.quest_main.status, "completed");

  const again = advanceQuests(run, { talkResult: { linkedQuestIds: ["quest_main"] } });
  assert.equal(again.updated, false);
  assert.equal(again.wonQuest, null);
});

test("getQuestPayload returns active quests and the main quest", () => {
  const quest = createMainQuest(WORLD, { secondLocationId: "second_location", firstNpcId: "npc_quest_giver" });
  const run = runWithQuest(quest);

  const payload = getQuestPayload(run);
  assert.equal(payload.activeQuests.length, 1);
  assert.equal(payload.mainQuest.questId, "quest_main");

  // Once completed it drops out of activeQuests but remains the main quest.
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
