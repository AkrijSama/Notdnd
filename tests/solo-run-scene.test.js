import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import {
  buildSoloScenePayload,
  getRecentTimelineEvents,
  getRelevantMemoryFacts,
  summarizeSceneForUi,
  validateSoloScenePayload
} from "../server/solo/scene.js";
import { resolveSearchAction } from "../server/solo/search.js";

function errorPaths(result) {
  return result.errors.map((error) => error.path);
}

function addNpc(run, overrides = {}) {
  const npc = {
    npcId: "placeholder_npc",
    displayName: "Placeholder NPC",
    role: "Neutral placeholder role",
    currentLocationId: "start_location",
    known: true,
    status: "alive",
    memoryFactIds: [],
    tags: [],
    flags: {},
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    contentTags: [],
    ...overrides
  };
  run.npcs[npc.npcId] = npc;
  return npc;
}

function addFact(run, overrides = {}) {
  const fact = {
    factId: "fact_extra",
    entityIds: ["start_location"],
    type: "placeholder_fact",
    text: "Neutral placeholder fact.",
    source: "system",
    createdAt: new Date().toISOString(),
    tags: ["placeholder"],
    canonical: true,
    confidence: 1,
    supersedesFactIds: [],
    ...overrides
  };
  run.memoryFacts.push(fact);
  return fact;
}

test("buildSoloScenePayload returns ok true for default run", () => {
  const run = createDefaultSoloRun({ runId: "run_scene_default" });

  const payload = buildSoloScenePayload(run);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.errors, []);
});

test("payload includes runId", () => {
  const run = createDefaultSoloRun({ runId: "run_scene_id" });

  const payload = buildSoloScenePayload(run);
  assert.equal(payload.runId, "run_scene_id");
});

test("payload includes current location", () => {
  const run = createDefaultSoloRun({ runId: "run_scene_location" });

  const payload = buildSoloScenePayload(run);
  assert.equal(payload.location.locationId, "start_location");
  assert.equal(payload.location.name, "Start Location");
});

test("payload preserves location imageAssetId", () => {
  const run = createDefaultSoloRun({ runId: "run_scene_image" });
  run.locations.start_location.imageAssetId = "image_start_location";

  const payload = buildSoloScenePayload(run);
  assert.equal(payload.location.imageAssetId, "image_start_location");
});

test("payload includes visible entities", () => {
  const run = createDefaultSoloRun({ runId: "run_scene_entities" });
  addNpc(run);

  const payload = buildSoloScenePayload(run);
  assert.ok(payload.visibleEntities.length >= 3);
  assert.ok(payload.visibleEntities.some((entity) => entity.entityId === "npc:placeholder_npc"));
});

test("payload includes current location entity", () => {
  const run = createDefaultSoloRun({ runId: "run_scene_location_entity" });

  const payload = buildSoloScenePayload(run);
  assert.ok(payload.visibleEntities.some((entity) => entity.entityId === "location:start_location"));
});

test("payload includes player entity", () => {
  const run = createDefaultSoloRun({ runId: "run_scene_player_entity" });

  const payload = buildSoloScenePayload(run);
  assert.ok(payload.visibleEntities.some((entity) => entity.entityId === "player:player"));
});

test("payload includes available moves", () => {
  const run = createDefaultSoloRun({ runId: "run_scene_moves" });

  const payload = buildSoloScenePayload(run);
  assert.ok(payload.availableMoves.some((move) => move.locationId === "second_location"));
});

test("payload includes available actions", () => {
  const run = createDefaultSoloRun({ runId: "run_scene_actions" });

  const payload = buildSoloScenePayload(run);
  assert.ok(payload.availableActions.some((action) => action.type === "move" && action.toLocationId === "second_location"));
  assert.ok(payload.availableActions.some((action) => action.type === "inspect" && action.entityId === "location:start_location"));
  assert.ok(payload.availableActions.some((action) => action.type === "search" && action.enabled === true));
});

test("scene payload includes revealed search details only", () => {
  const run = createDefaultSoloRun({ runId: "run_scene_search_details" });

  const before = buildSoloScenePayload(run);
  const searched = resolveSearchAction(run, { type: "search", actorId: "player" }, {
    now: "2026-01-01T00:00:00.000Z",
    idFactory: (prefix) => `${prefix}_test`
  });
  const after = buildSoloScenePayload(searched.run);

  assert.deepEqual(before.discoveredDetails, []);
  assert.equal(after.discoveredDetails.length, 1);
  assert.equal(after.discoveredDetails[0].detailId, "start_location_scuffed_mark");
});

test("payload includes recent timeline events", () => {
  const run = createDefaultSoloRun({ runId: "run_scene_timeline" });
  run.timeline.push({
    eventId: "event_extra",
    type: "placeholder_event",
    title: "Placeholder Event",
    summary: "Neutral placeholder event.",
    createdAt: new Date().toISOString(),
    locationId: "start_location",
    entityIds: ["start_location"],
    memoryFactIds: [],
    tags: ["placeholder"],
    payload: {}
  });

  const payload = buildSoloScenePayload(run);
  assert.equal(payload.recentTimeline.at(-1).eventId, "event_extra");
  assert.equal(getRecentTimelineEvents(run, { limit: 1 })[0].eventId, "event_extra");
});

test("payload includes relevant location memory facts", () => {
  const run = createDefaultSoloRun({ runId: "run_scene_location_fact" });

  const payload = buildSoloScenePayload(run);
  assert.ok(payload.relevantMemoryFacts.some((fact) => fact.factId === "fact_run_created"));
});

test("payload includes relevant entity memory facts", () => {
  const run = createDefaultSoloRun({ runId: "run_scene_entity_fact" });
  addFact(run, {
    factId: "fact_placeholder_npc",
    entityIds: ["placeholder_npc"],
    text: "Neutral placeholder NPC fact."
  });
  addNpc(run, { memoryFactIds: ["fact_placeholder_npc"] });

  const payload = buildSoloScenePayload(run);
  assert.ok(payload.relevantMemoryFacts.some((fact) => fact.factId === "fact_placeholder_npc"));
  assert.ok(getRelevantMemoryFacts(run).some((fact) => fact.factId === "fact_placeholder_npc"));
});

test("payload filters forbidden entities from mainline scene", () => {
  const run = createDefaultSoloRun({ runId: "run_scene_filter_forbidden_entity" });
  addNpc(run, {
    edition: "forbidden",
    policyProfileId: "forbidden_default",
    contentTags: ["adult_themes"]
  });

  const payload = buildSoloScenePayload(run);
  assert.equal(payload.visibleEntities.some((entity) => entity.entityId === "npc:placeholder_npc"), false);
});

test("payload filters blocked contentTags from mainline scene", () => {
  const run = createDefaultSoloRun({ runId: "run_scene_filter_blocked_tags" });
  addFact(run, {
    factId: "fact_blocked",
    entityIds: ["start_location"],
    contentTags: ["explicit_sexual_content"]
  });
  addNpc(run, {
    contentTags: ["explicit_sexual_content"]
  });

  const payload = buildSoloScenePayload(run);
  assert.equal(payload.visibleEntities.some((entity) => entity.entityId === "npc:placeholder_npc"), false);
  assert.equal(payload.relevantMemoryFacts.some((fact) => fact.factId === "fact_blocked"), false);
});

test("forbidden run can include forbidden entity and fact if policy allows", () => {
  const run = createDefaultSoloRun({ runId: "run_scene_forbidden" });
  run.edition = "forbidden";
  run.policyProfileId = "forbidden_default";
  run.locations.start_location.edition = "forbidden";
  run.locations.start_location.policyProfileId = "forbidden_default";
  run.locations.start_location.contentTags = ["adult_themes"];
  addNpc(run, {
    edition: "forbidden",
    policyProfileId: "forbidden_default",
    contentTags: ["adult_themes"]
  });
  addFact(run, {
    factId: "fact_forbidden",
    entityIds: ["placeholder_npc"],
    edition: "forbidden",
    policyProfileId: "forbidden_default",
    contentTags: ["adult_themes"]
  });
  run.npcs.placeholder_npc.memoryFactIds = ["fact_forbidden"];

  const payload = buildSoloScenePayload(run);
  assert.equal(payload.ok, true);
  assert.ok(payload.visibleEntities.some((entity) => entity.entityId === "npc:placeholder_npc"));
  assert.ok(payload.relevantMemoryFacts.some((fact) => fact.factId === "fact_forbidden"));
});

test("invalid currentLocationId returns ok false", () => {
  const run = createDefaultSoloRun({ runId: "run_scene_invalid_location" });
  run.currentLocationId = "missing_location";

  const payload = buildSoloScenePayload(run);
  assert.equal(payload.ok, false);
  assert.ok(errorPaths(payload).includes("currentLocationId"));
});

test("scene validation accepts valid payload", () => {
  const run = createDefaultSoloRun({ runId: "run_scene_validate" });
  const payload = buildSoloScenePayload(run);

  const result = validateSoloScenePayload(payload);
  assert.equal(result.ok, true);
});

test("scene validation rejects missing location", () => {
  const run = createDefaultSoloRun({ runId: "run_scene_missing_location" });
  const payload = buildSoloScenePayload(run);
  delete payload.location;

  const result = validateSoloScenePayload(payload);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("location"));
});

test("uiHints include spatial scene action and entity hints", () => {
  const run = createDefaultSoloRun({ runId: "run_scene_hints" });
  const payload = buildSoloScenePayload(run);

  assert.equal(payload.uiHints.layout, "spatial_scene");
  assert.equal(payload.uiHints.showActionBar, true);
  assert.equal(payload.uiHints.showEntityPanel, true);
  assert.equal(payload.uiHints.showLocationImage, true);
});

test("payload is deterministic enough for tests", () => {
  const run = createDefaultSoloRun({ runId: "run_scene_deterministic" });

  const first = summarizeSceneForUi(buildSoloScenePayload(run));
  const second = summarizeSceneForUi(buildSoloScenePayload(run));
  assert.deepEqual(first, second);
});
