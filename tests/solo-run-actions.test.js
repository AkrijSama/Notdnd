import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import {
  getAvailableSoloActions,
  normalizeSoloAction,
  resolveSoloAction,
  validateSoloAction
} from "../server/solo/actions.js";

const TEST_NOW = "2026-01-01T00:00:00.000Z";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function errorPaths(result) {
  return result.errors.map((error) => error.path);
}

function idFactory() {
  const counts = {};
  return (prefix) => {
    counts[prefix] = (counts[prefix] || 0) + 1;
    return `${prefix}_${counts[prefix]}`;
  };
}

function moveAction(overrides = {}) {
  return {
    type: "move",
    actorId: "player",
    fromLocationId: "start_location",
    toLocationId: "second_location",
    direction: "east",
    ...overrides
  };
}

function addNpc(run) {
  run.npcs.placeholder_npc = {
    npcId: "placeholder_npc",
    displayName: "Placeholder NPC",
    role: "Neutral placeholder NPC",
    currentLocationId: "start_location",
    known: true,
    status: "alive",
    memoryFactIds: [],
    tags: [],
    flags: {},
    dialogueBeats: [
      {
        beatId: "quiet_area",
        label: "Quiet Area",
        text: "There is not much to say yet, but the area has been quiet.",
        revealed: false,
        repeatable: false,
        contentTags: [],
        linkedMemoryFactIds: [],
        linkedQuestIds: []
      }
    ]
  };
}

test("normalizeSoloAction lowercases type and defaults actorId", () => {
  const normalized = normalizeSoloAction({ type: " MOVE ", toLocationId: "second_location" });

  assert.equal(normalized.type, "move");
  assert.equal(normalized.actorId, "player");
});

test("getAvailableSoloActions includes legal movement actions", () => {
  const run = createDefaultSoloRun({ runId: "run_actions_available" });

  const actions = getAvailableSoloActions(run);
  assert.ok(actions.some((action) => action.type === "move" && action.toLocationId === "second_location"));
  assert.ok(actions.some((action) => action.type === "inspect" && action.entityId === "location:start_location" && action.enabled === true));
});

test("resolveSoloAction handles move through movement resolver", () => {
  const run = createDefaultSoloRun({ runId: "run_action_move" });

  const result = resolveSoloAction(run, moveAction(), { now: TEST_NOW, idFactory: idFactory() });
  assert.equal(result.ok, true);
  assert.equal(result.action.type, "move");
  assert.equal(result.run.currentLocationId, "second_location");
});

test("resolveSoloAction rejects missing action", () => {
  const run = createDefaultSoloRun({ runId: "run_action_missing" });

  const result = resolveSoloAction(run, null);
  assert.equal(result.ok, false);
  assert.equal(result.code, "ACTION_INVALID");
  assert.ok(errorPaths(result).includes("action"));
});

test("resolveSoloAction rejects unknown action type", () => {
  const run = createDefaultSoloRun({ runId: "run_action_unknown" });

  const result = resolveSoloAction(run, { type: "dance" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "ACTION_INVALID");
  assert.ok(errorPaths(result).includes("action.type"));
});

test("resolveSoloAction returns ACTION_NOT_IMPLEMENTED for recognized future action", () => {
  const run = createDefaultSoloRun({ runId: "run_action_rest" });

  const result = resolveSoloAction(run, { type: "rest" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "ACTION_NOT_IMPLEMENTED");
  assert.equal(result.actionType, "rest");
  assert.ok(errorPaths(result).includes("action.type"));
});

test("move result updates currentLocationId", () => {
  const run = createDefaultSoloRun({ runId: "run_action_location" });

  const result = resolveSoloAction(run, moveAction(), { now: TEST_NOW, idFactory: idFactory() });
  assert.equal(result.ok, true);
  assert.equal(result.run.currentLocationId, "second_location");
});

test("move result appends timeline event", () => {
  const run = createDefaultSoloRun({ runId: "run_action_event" });

  const result = resolveSoloAction(run, moveAction(), { now: TEST_NOW, idFactory: idFactory() });
  assert.equal(result.ok, true);
  assert.equal(result.event.type, "movement");
  assert.equal(result.run.timeline.at(-1).eventId, result.event.eventId);
});

test("move result appends memory fact", () => {
  const run = createDefaultSoloRun({ runId: "run_action_fact" });

  const result = resolveSoloAction(run, moveAction(), { now: TEST_NOW, idFactory: idFactory() });
  assert.equal(result.ok, true);
  assert.equal(result.memoryFact.type, "location_movement");
  assert.equal(result.run.memoryFacts.at(-1).factId, result.memoryFact.factId);
});

test("move result returns availableMoves", () => {
  const run = createDefaultSoloRun({ runId: "run_action_moves" });

  const result = resolveSoloAction(run, moveAction(), { now: TEST_NOW, idFactory: idFactory() });
  assert.equal(result.ok, true);
  assert.ok(result.availableMoves.some((move) => move.locationId === "start_location"));
  assert.ok(result.availableMoves.some((move) => move.locationId === "third_location"));
});

test("move result returns availableActions", () => {
  const run = createDefaultSoloRun({ runId: "run_action_next_actions" });

  const result = resolveSoloAction(run, moveAction(), { now: TEST_NOW, idFactory: idFactory() });
  assert.equal(result.ok, true);
  assert.ok(result.availableActions.some((action) => action.type === "move" && action.toLocationId === "third_location"));
  assert.ok(result.availableActions.some((action) => action.type === "search" && action.enabled === true));
});

test("action dispatcher resolves search", () => {
  const run = createDefaultSoloRun({ runId: "run_action_search" });

  const result = resolveSoloAction(run, { type: "search", actorId: "player" }, { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(result.ok, true);
  assert.equal(result.action.type, "search");
  assert.equal(result.searchResult.found, true);
  assert.equal(result.event.type, "search");
  assert.equal(result.memoryFact.type, "search_discovery");
  assert.equal(result.run.locations.start_location.searchDetails[0].revealed, true);
});

test("getAvailableSoloActions includes talk when NPC is visible", () => {
  const run = createDefaultSoloRun({ runId: "run_action_talk_available" });
  addNpc(run);

  const actions = getAvailableSoloActions(run);

  assert.ok(actions.some((action) => action.type === "talk" && action.targetEntityId === "npc:placeholder_npc"));
});

test("action dispatcher resolves talk", () => {
  const run = createDefaultSoloRun({ runId: "run_action_talk" });
  addNpc(run);

  const result = resolveSoloAction(run, {
    type: "talk",
    actorId: "player",
    targetEntityId: "npc:placeholder_npc"
  }, { now: TEST_NOW, idFactory: idFactory() });

  assert.equal(result.ok, true);
  assert.equal(result.action.type, "talk");
  assert.equal(result.talkResult.found, true);
  assert.equal(result.event.type, "talk");
  assert.equal(result.memoryFact.type, "dialogue_beat");
  assert.equal(result.run.npcs.placeholder_npc.dialogueBeats[0].revealed, true);
  assert.ok(result.availableActions.some((action) => action.type === "search" && action.enabled === true));
});

test("invalid move returns useful path errors", () => {
  const run = createDefaultSoloRun({ runId: "run_action_invalid_move" });

  const result = resolveSoloAction(run, moveAction({ toLocationId: "third_location" }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "ACTION_INVALID");
  assert.ok(errorPaths(result).includes("action.toLocationId"));
});

test("validateSoloAction exposes move validation errors", () => {
  const run = createDefaultSoloRun({ runId: "run_action_validate" });

  const result = validateSoloAction(run, moveAction({ fromLocationId: "third_location" }));
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("action.fromLocationId"));
});

test("mainline run cannot move into forbidden location", () => {
  const run = createDefaultSoloRun({ runId: "run_action_forbidden_block" });
  run.locations.second_location.edition = "forbidden";
  run.locations.second_location.policyProfileId = "forbidden_default";
  run.locations.second_location.contentTags = ["adult_themes"];

  const result = resolveSoloAction(run, moveAction());
  assert.equal(result.ok, false);
  assert.equal(result.code, "ACTION_INVALID");
  assert.ok(errorPaths(result).includes("action.toLocationId"));
});

test("original run is not mutated by move action", () => {
  const run = createDefaultSoloRun({ runId: "run_action_no_mutation" });
  const before = clone(run);

  const result = resolveSoloAction(run, moveAction(), { now: TEST_NOW, idFactory: idFactory() });
  assert.equal(result.ok, true);
  assert.deepEqual(run, before);
});
