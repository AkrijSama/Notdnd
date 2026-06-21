import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultMainlinePolicyProfile,
  createDefaultSoloRun,
  validateEntityAgainstPolicy
} from "../server/solo/schema.js";
import {
  createEntityDetailPayload,
  getInspectableEntity,
  getVisibleEntities,
  validateVisibleEntity
} from "../server/solo/entities.js";
import { resolveSoloAction } from "../server/solo/actions.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function errorPaths(result) {
  return result.errors.map((error) => error.path);
}

function validEntity(overrides = {}) {
  return {
    entityId: "npc:placeholder_npc",
    entityType: "npc",
    displayName: "Placeholder NPC",
    summary: "Neutral placeholder role",
    locationId: "start_location",
    visible: true,
    inspectable: true,
    imageAssetId: null,
    relationshipId: null,
    memoryFactIds: [],
    actionTypes: ["inspect", "talk"],
    edition: "mainline",
    policyProfileId: "mainline_default",
    contentTags: [],
    tags: [],
    flags: {},
    ...overrides
  };
}

function validNpc(overrides = {}) {
  return {
    npcId: "placeholder_npc",
    displayName: "Placeholder NPC",
    role: "Neutral placeholder role",
    currentLocationId: "start_location",
    known: true,
    status: "alive",
    memoryFactIds: [],
    tags: [],
    flags: {},
    edition: "mainline",
    policyProfileId: "mainline_default",
    contentTags: [],
    ...overrides
  };
}

function validRelationship(overrides = {}) {
  return {
    relationshipId: "rel_player_placeholder_npc",
    sourceEntityId: "player",
    targetEntityId: "placeholder_npc",
    meters: {
      trust: 1,
      affection: 0,
      fear: 0,
      debt: 0,
      suspicion: 0,
      loyalty: 0,
      rivalry: 0
    },
    memoryFactIds: [],
    flags: {},
    ...overrides
  };
}

function addVisibleNpc(run, overrides = {}) {
  const npc = validNpc(overrides);
  run.npcs[npc.npcId] = npc;
  return npc;
}

test("validateVisibleEntity accepts valid entity", () => {
  const result = validateVisibleEntity(validEntity());

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("validateVisibleEntity rejects missing entityId", () => {
  const entity = validEntity();
  delete entity.entityId;

  const result = validateVisibleEntity(entity);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("entityId"));
});

test("validateVisibleEntity rejects invalid entityType", () => {
  const result = validateVisibleEntity(validEntity({ entityType: "monster_card" }));

  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("entityType"));
});

test("getVisibleEntities includes current location as inspectable entity", () => {
  const run = createDefaultSoloRun({ runId: "run_entities_location" });

  const entities = getVisibleEntities(run);
  const location = entities.find((entity) => entity.entityId === "location:start_location");
  assert.ok(location);
  assert.equal(location.entityType, "location_object");
  assert.equal(location.inspectable, true);
});

test("getVisibleEntities includes NPC at current location", () => {
  const run = createDefaultSoloRun({ runId: "run_entities_npc" });
  addVisibleNpc(run);

  const entities = getVisibleEntities(run);
  assert.ok(entities.some((entity) => entity.entityId === "npc:placeholder_npc"));
});

test("getVisibleEntities excludes NPC in different location", () => {
  const run = createDefaultSoloRun({ runId: "run_entities_far_npc" });
  addVisibleNpc(run, { currentLocationId: "third_location" });

  const entities = getVisibleEntities(run);
  assert.equal(entities.some((entity) => entity.entityId === "npc:placeholder_npc"), false);
});

test("getVisibleEntities preserves imageAssetId", () => {
  const run = createDefaultSoloRun({ runId: "run_entities_image" });
  addVisibleNpc(run, { imageAssetId: "image_placeholder_npc" });

  const entity = getVisibleEntities(run).find((entry) => entry.entityId === "npc:placeholder_npc");
  assert.equal(entity.imageAssetId, "image_placeholder_npc");
});

test("getVisibleEntities respects mainline and forbidden edition separation", () => {
  const mainlineRun = createDefaultSoloRun({ runId: "run_entities_mainline" });
  addVisibleNpc(mainlineRun, {
    edition: "forbidden",
    policyProfileId: "forbidden_default",
    contentTags: ["adult_themes"]
  });

  assert.equal(getVisibleEntities(mainlineRun).some((entity) => entity.entityId === "npc:placeholder_npc"), false);

  const forbiddenRun = createDefaultSoloRun({ runId: "run_entities_forbidden" });
  forbiddenRun.edition = "forbidden";
  forbiddenRun.policyProfileId = "forbidden_default";
  addVisibleNpc(forbiddenRun, {
    edition: "forbidden",
    policyProfileId: "forbidden_default",
    contentTags: ["adult_themes"]
  });

  assert.equal(getVisibleEntities(forbiddenRun).some((entity) => entity.entityId === "npc:placeholder_npc"), true);
});

test("mainline policy rejects blocked contentTags", () => {
  const entity = validEntity({ contentTags: ["dark_fantasy", "explicit_sexual_content"] });

  const result = validateEntityAgainstPolicy(entity, createDefaultMainlinePolicyProfile());
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("contentTags.1"));
});

test("getInspectableEntity returns visible inspectable entity", () => {
  const run = createDefaultSoloRun({ runId: "run_entities_inspectable" });

  const result = getInspectableEntity(run, "location:start_location");
  assert.equal(result.ok, true);
  assert.equal(result.entity.entityId, "location:start_location");
});

test("getInspectableEntity rejects hidden entity", () => {
  const run = createDefaultSoloRun({ runId: "run_entities_hidden" });
  addVisibleNpc(run, { known: false });

  const result = getInspectableEntity(run, "npc:placeholder_npc");
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("entityId"));
});

test("getInspectableEntity rejects non-inspectable entity", () => {
  const run = createDefaultSoloRun({ runId: "run_entities_noninspect" });

  const result = getInspectableEntity(run, "exit:second_location");
  assert.equal(result.ok, false);
  assert.equal(result.entity.entityType, "exit");
  assert.ok(errorPaths(result).includes("entityId"));
});

test("createEntityDetailPayload returns structured details", () => {
  const run = createDefaultSoloRun({ runId: "run_entities_detail" });

  const result = createEntityDetailPayload(run, "location:start_location");
  assert.equal(result.ok, true);
  assert.equal(result.details.title, "Start Location");
  assert.equal(result.details.description, "Neutral placeholder starting location.");
  assert.equal(typeof result.details.stats, "object");
  assert.ok(Array.isArray(result.details.availableActions));
});

test("createEntityDetailPayload includes relationship and memory refs when present", () => {
  const run = createDefaultSoloRun({ runId: "run_entities_refs" });
  run.memoryFacts.push({
    factId: "fact_placeholder_npc",
    entityIds: ["placeholder_npc"],
    type: "placeholder_fact",
    text: "Neutral placeholder NPC fact.",
    source: "system",
    createdAt: new Date().toISOString(),
    tags: ["placeholder"],
    canonical: true,
    confidence: 1,
    supersedesFactIds: []
  });
  addVisibleNpc(run, { memoryFactIds: ["fact_placeholder_npc"] });
  run.relationships.rel_player_placeholder_npc = validRelationship();

  const result = createEntityDetailPayload(run, "npc:placeholder_npc");
  assert.equal(result.ok, true);
  assert.equal(result.details.memoryFacts.length, 1);
  assert.equal(result.details.relationships.length, 1);
});

test("inspect action resolves through resolveSoloAction", () => {
  const run = createDefaultSoloRun({ runId: "run_entities_action" });

  const result = resolveSoloAction(run, {
    type: "inspect",
    actorId: "player",
    entityId: "location:start_location"
  });
  assert.equal(result.ok, true);
  assert.equal(result.entity.entityId, "location:start_location");
  assert.equal(result.details.title, "Start Location");
});

test("inspect action rejects missing entityId", () => {
  const run = createDefaultSoloRun({ runId: "run_entities_action_missing" });

  const result = resolveSoloAction(run, { type: "inspect", actorId: "player" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "ACTION_INVALID");
  assert.ok(errorPaths(result).includes("action.entityId"));
});

test("inspect action rejects non-visible entity", () => {
  const run = createDefaultSoloRun({ runId: "run_entities_action_hidden" });
  addVisibleNpc(run, { currentLocationId: "third_location" });

  const result = resolveSoloAction(run, {
    type: "inspect",
    entityId: "npc:placeholder_npc"
  });
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("action.entityId"));
});

test("inspect action returns availableMoves and availableActions", () => {
  const run = createDefaultSoloRun({ runId: "run_entities_action_available" });

  const result = resolveSoloAction(run, {
    type: "inspect",
    entityId: "location:start_location"
  });
  assert.equal(result.ok, true);
  assert.ok(result.availableMoves.some((move) => move.locationId === "second_location"));
  assert.ok(result.availableActions.some((action) => action.type === "inspect" && action.entityId === "location:start_location"));
});

test("inspect does not mutate run", () => {
  const run = createDefaultSoloRun({ runId: "run_entities_no_mutation" });
  const before = clone(run);

  const result = resolveSoloAction(run, {
    type: "inspect",
    entityId: "location:start_location"
  });
  assert.equal(result.ok, true);
  assert.deepEqual(run, before);
});

test("useful path values appear in errors", () => {
  const result = validateVisibleEntity(validEntity({
    entityId: "",
    entityType: "bad_type",
    memoryFactIds: "fact"
  }));

  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("entityId"));
  assert.ok(errorPaths(result).includes("entityType"));
  assert.ok(errorPaths(result).includes("memoryFactIds"));
});
