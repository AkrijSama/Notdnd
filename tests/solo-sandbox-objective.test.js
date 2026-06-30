import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun } from "../server/solo/schema.js";
import { createMainQuest, getQuestPayload, advanceQuests } from "../server/solo/quests.js";

// Track A / Problem 2 — a SANDBOX (open world, no spine) must not carry a directed
// procedural objective ("Travel to … on the trail of your quarry") that contradicts
// the open-world framing. The procedural spine is suppressed at the quest layer;
// campaign runs are unchanged; player-authored goals still surface.

function runWithProceduralSpine(mode) {
  const run = createDefaultSoloRun({ now: "2026-01-01T00:00:00.000Z" });
  run.mode = mode;
  run.quests = {
    quest_main: createMainQuest(
      { name: "Mournhold", tone: "grim dark fantasy", startingLocationName: "the broken keep" },
      { secondLocationId: "second_location", secondLocationName: "The Drowned Hollows Watch", firstNpcId: "npc_quest_giver", seed: 1 }
    )
  };
  return run;
}

test("CAMPAIGN run surfaces the procedural main quest (unchanged behavior)", () => {
  const run = runWithProceduralSpine("campaign");
  const { mainQuest, activeQuests } = getQuestPayload(run);
  assert.ok(mainQuest, "campaign keeps its directed main quest");
  assert.equal(mainQuest.questId, "quest_main");
  assert.ok(activeQuests.some((q) => q.questId === "quest_main"));
});

test("SANDBOX run SUPPRESSES the procedural directed objective (kills the open-world contradiction)", () => {
  const run = runWithProceduralSpine("sandbox");
  const { mainQuest, activeQuests } = getQuestPayload(run);
  assert.equal(mainQuest, null, "no assigned quarry objective in a sandbox");
  assert.equal(activeQuests.some((q) => q.questId === "quest_main"), false, "the 'trail of your quarry' chip is not shown");
});

test("CAMPAIGN: reaching the target advances the spine (control — the spine still works)", () => {
  const run = runWithProceduralSpine("campaign");
  run.currentLocationId = "second_location";
  const out = advanceQuests(run, {});
  assert.equal(out.updated, true, "the reach_location stage advanced");
  assert.ok((out.advanced || []).some((q) => q.questId === "quest_main"));
});

test("SANDBOX: the suppressed spine cannot advance, win, or fail", () => {
  const run = runWithProceduralSpine("sandbox");
  run.currentLocationId = "second_location"; // would satisfy the reach_location stage
  const out = advanceQuests(run, {});
  assert.equal(out.wonQuest, null, "reaching the target does not win a suppressed sandbox quest");
  assert.equal(out.updated, false, "the procedural spine did not move");
  assert.equal(run.quests.quest_main.status, "active", "left untouched, not auto-completed");
});

test("SANDBOX still surfaces a PLAYER-AUTHORED objective (open world reacts to what the player declares)", () => {
  const run = runWithProceduralSpine("sandbox");
  run.quests.quest_player_1 = {
    questId: "quest_player_1",
    status: "active",
    isMain: false,
    authoredBy: "player",
    title: "Make this place your own.",
    description: "Make this place your own.",
    stages: [{ objective: "Make this place your own.", completion: null }],
    stage: 0,
    objective: "Make this place your own.",
    completion: null,
    relatedEntityIds: [],
    memoryFactIds: [],
    flags: { playerAuthored: true }
  };
  const { activeQuests } = getQuestPayload(run);
  assert.ok(activeQuests.some((q) => q.authoredBy === "player"), "the player's own goal is visible in a sandbox");
  assert.equal(activeQuests.some((q) => q.questId === "quest_main"), false, "the procedural spine stays hidden");
});
