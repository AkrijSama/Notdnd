import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSoloRun, validateSoloRun } from "../server/solo/schema.js";
import {
  getTalkableNpcs,
  resolveTalkAction,
  validateTalkAction
} from "../server/solo/talk.js";

const TEST_NOW = "2026-01-01T00:00:00.000Z";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function idFactory() {
  const counts = {};
  return (prefix) => {
    counts[prefix] = (counts[prefix] || 0) + 1;
    return `${prefix}_${counts[prefix]}`;
  };
}

function talkAction(overrides = {}) {
  return {
    type: "talk",
    actorId: "player",
    targetEntityId: "npc:placeholder_npc",
    ...overrides
  };
}

function addNpc(run, overrides = {}) {
  const npc = {
    npcId: "placeholder_npc",
    displayName: "Placeholder NPC",
    role: "Neutral placeholder NPC",
    currentLocationId: "start_location",
    known: true,
    status: "alive",
    memoryFactIds: [],
    tags: [],
    flags: {},
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    contentTags: [],
    dialogueBeats: [
      {
        beatId: "quiet_area",
        label: "Quiet Area",
        text: "There is not much to say yet, but the area has been quiet.",
        revealed: false,
        repeatable: false,
        contentTags: [],
        linkedMemoryFactIds: [],
        linkedQuestIds: [],
        edition: run.edition,
        policyProfileId: run.policyProfileId
      }
    ],
    ...overrides
  };
  run.npcs[npc.npcId] = npc;
  return npc;
}

function addSecondBeat(run) {
  run.npcs.placeholder_npc.dialogueBeats.push({
    beatId: "small_observation",
    label: "Small Observation",
    text: "The NPC offers a small observation about the current area.",
    revealed: false,
    repeatable: false,
    contentTags: [],
    linkedMemoryFactIds: [],
    linkedQuestIds: [],
    edition: run.edition,
    policyProfileId: run.policyProfileId
  });
}

test("validates talk action", () => {
  const run = createDefaultSoloRun({ runId: "talk_validate" });
  addNpc(run);

  const validation = validateTalkAction(run, talkAction());

  assert.equal(validation.ok, true);
});

test("talk rejects non-visible NPC", () => {
  const run = createDefaultSoloRun({ runId: "talk_hidden" });
  addNpc(run, { currentLocationId: "second_location" });

  const validation = validateTalkAction(run, talkAction());

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.path === "action.targetEntityId"));
});

test("talk rejects non-NPC entity", () => {
  const run = createDefaultSoloRun({ runId: "talk_non_npc" });

  const validation = validateTalkAction(run, talkAction({ targetEntityId: "player:player" }));

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.path === "action.targetEntityId"));
});

test("talk reveals first unrevealed dialogue beat", () => {
  const run = createDefaultSoloRun({ runId: "talk_first" });
  addNpc(run);

  const resolved = resolveTalkAction(run, talkAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.talkResult.found, true);
  assert.equal(resolved.talkResult.beatId, "quiet_area");
  assert.equal(resolved.talkResult.speakerName, "Placeholder NPC");
  assert.match(resolved.talkResult.line, /area has been quiet/);
  assert.equal(resolved.run.npcs.placeholder_npc.dialogueBeats[0].revealed, true);
});

test("repeated talk returns next beat if present", () => {
  const run = createDefaultSoloRun({ runId: "talk_next" });
  addNpc(run);
  addSecondBeat(run);

  const first = resolveTalkAction(run, talkAction(), { now: TEST_NOW, idFactory: idFactory() });
  const second = resolveTalkAction(first.run, talkAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(first.talkResult.beatId, "quiet_area");
  assert.equal(second.talkResult.beatId, "small_observation");
  assert.match(second.talkResult.line, /small observation/);
});

test("repeated talk with no beats returns neutral fallback", () => {
  const run = createDefaultSoloRun({ runId: "talk_none_left" });
  addNpc(run);

  const first = resolveTalkAction(run, talkAction(), { now: TEST_NOW, idFactory: idFactory() });
  const second = resolveTalkAction(first.run, talkAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(second.ok, true);
  assert.equal(second.talkResult.found, false);
  assert.equal(second.memoryFact, null);
  assert.ok(second.talkResult.warningCodes.includes("TALK_NOTHING_NEW"));
});

test("talk creates timeline event", () => {
  const run = createDefaultSoloRun({ runId: "talk_event" });
  addNpc(run);

  const resolved = resolveTalkAction(run, talkAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.event.type, "talk");
  assert.equal(resolved.run.timeline.at(-1).eventId, resolved.event.eventId);
});

test("talk creates memory fact only for new meaningful beat", () => {
  const run = createDefaultSoloRun({ runId: "talk_memory_once" });
  addNpc(run);

  const first = resolveTalkAction(run, talkAction(), { now: TEST_NOW, idFactory: idFactory() });
  const second = resolveTalkAction(first.run, talkAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(first.memoryFact.type, "dialogue_beat");
  assert.equal(second.memoryFact, null);
  assert.equal(second.run.memoryFacts.filter((fact) => fact.type === "dialogue_beat").length, 1);
  assert.ok(second.run.npcs.placeholder_npc.memoryFactIds.includes(first.memoryFact.factId));
});

test("talk respects mainline blocked tags", () => {
  const run = createDefaultSoloRun({ runId: "talk_policy_block" });
  addNpc(run, {
    dialogueBeats: [
      {
        beatId: "blocked_dialogue",
        label: "Blocked Dialogue",
        text: "Blocked placeholder dialogue.",
        revealed: false,
        repeatable: false,
        contentTags: ["explicit_sexual_content"],
        linkedMemoryFactIds: [],
        linkedQuestIds: [],
        edition: "mainline",
        policyProfileId: "mainline_default"
      }
    ]
  });

  const resolved = resolveTalkAction(run, talkAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.talkResult.found, false);
  assert.equal(resolved.run.npcs.placeholder_npc.dialogueBeats[0].revealed, false);
  assert.equal(resolved.memoryFact, null);
});

test("forbidden lane can reveal allowed forbidden-lane dialogue", () => {
  const run = createDefaultSoloRun({ runId: "talk_forbidden_allowed" });
  run.edition = "forbidden";
  run.policyProfileId = "forbidden_default";
  run.locations.start_location.edition = "forbidden";
  run.locations.start_location.policyProfileId = "forbidden_default";
  addNpc(run, {
    edition: "forbidden",
    policyProfileId: "forbidden_default",
    contentTags: ["adult_themes"],
    dialogueBeats: [
      {
        beatId: "forbidden_safe_dialogue",
        label: "Forbidden Lane Placeholder",
        text: "A mature-lane placeholder dialogue beat is available here.",
        revealed: false,
        repeatable: false,
        contentTags: ["adult_themes"],
        linkedMemoryFactIds: [],
        linkedQuestIds: [],
        edition: "forbidden",
        policyProfileId: "forbidden_default"
      }
    ]
  });

  const resolved = resolveTalkAction(run, talkAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.talkResult.found, true);
  assert.equal(resolved.memoryFact.edition, "forbidden");
  assert.deepEqual(resolved.memoryFact.contentTags, ["adult_themes"]);
});

test("optional check success reveals beat", () => {
  const run = createDefaultSoloRun({ runId: "talk_check_success" });
  run.player.abilities.charisma = 14;
  run.player.skills.persuasion = 2;
  addNpc(run);
  run.npcs.placeholder_npc.dialogueBeats[0].check = {
    ability: "charisma",
    skill: "persuasion",
    dc: 15
  };

  const resolved = resolveTalkAction(run, talkAction(), { now: TEST_NOW, idFactory: idFactory(), fixedRoll: 12 });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.talkResult.found, true);
  assert.equal(resolved.talkResult.checkResult.success, true);
  assert.equal(resolved.memoryFact.type, "dialogue_beat");
});

test("optional check failure does not reveal beat", () => {
  const run = createDefaultSoloRun({ runId: "talk_check_failure" });
  addNpc(run);
  run.npcs.placeholder_npc.dialogueBeats[0].check = {
    ability: "charisma",
    skill: "persuasion",
    dc: 18
  };

  const resolved = resolveTalkAction(run, talkAction(), { now: TEST_NOW, idFactory: idFactory(), fixedRoll: 9 });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.talkResult.found, false);
  assert.equal(resolved.talkResult.checkResult.success, false);
  assert.equal(resolved.run.npcs.placeholder_npc.dialogueBeats[0].revealed, false);
  assert.equal(resolved.memoryFact, null);
  assert.ok(resolved.talkResult.warningCodes.includes("TALK_CHECK_FAILED"));
});

test("talk validates final run", () => {
  const run = createDefaultSoloRun({ runId: "talk_valid_final" });
  addNpc(run);

  const resolved = resolveTalkAction(run, talkAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.ok, true);
  assert.equal(validateSoloRun(resolved.run).ok, true);
});

test("talk does not call GM provider or mutate original run", () => {
  const run = createDefaultSoloRun({ runId: "talk_no_provider" });
  addNpc(run);
  const before = clone(run);

  const resolved = resolveTalkAction(run, talkAction(), { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(resolved.ok, true);
  assert.deepEqual(run, before);
  assert.equal(resolved.gmNarration, undefined);
});

test("getTalkableNpcs returns visible NPCs only", () => {
  const run = createDefaultSoloRun({ runId: "talkable_npcs" });
  addNpc(run);
  run.npcs.hidden_npc = {
    npcId: "hidden_npc",
    displayName: "Hidden NPC",
    role: "Neutral hidden role",
    currentLocationId: "second_location",
    known: true,
    status: "alive",
    memoryFactIds: [],
    tags: [],
    flags: {},
    dialogueBeats: []
  };

  const talkable = getTalkableNpcs(run);

  assert.equal(talkable.length, 1);
  assert.equal(talkable[0].npc.npcId, "placeholder_npc");
});
