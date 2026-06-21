import { buildSoloScenePayload } from "../../server/solo/scene.js";
import { createDefaultSoloRun } from "../../server/solo/schema.js";

function baseRun(runId = "fixture_run") {
  return createDefaultSoloRun({
    runId,
    now: "2026-01-01T00:00:00.000Z"
  });
}

export function defaultMainlineScene() {
  return buildSoloScenePayload(baseRun("fixture_default_mainline"));
}

export function sceneWithVisibleNpc() {
  const run = baseRun("fixture_visible_npc");
  run.npcs.placeholder_npc = {
    npcId: "placeholder_npc",
    displayName: "Placeholder NPC",
    role: "Neutral placeholder role",
    currentLocationId: "start_location",
    known: true,
    status: "alive",
    memoryFactIds: [],
    imageAssetId: null,
    tags: ["placeholder"],
    flags: {},
    edition: "mainline",
    policyProfileId: "mainline_default",
    contentTags: []
  };
  return buildSoloScenePayload(run);
}

export function sceneWithMovementMemory() {
  const run = baseRun("fixture_movement_memory");
  run.timeline.push({
    eventId: "event_recent_movement",
    type: "movement",
    title: "Movement",
    summary: "The player moved through a neutral placeholder route.",
    createdAt: "2026-01-01T00:01:00.000Z",
    locationId: "start_location",
    entityIds: ["player", "start_location"],
    memoryFactIds: ["fact_recent_movement"],
    tags: ["placeholder"],
    edition: "mainline",
    policyProfileId: "mainline_default",
    contentTags: [],
    payload: {}
  });
  run.memoryFacts.push({
    factId: "fact_recent_movement",
    entityIds: ["player", "start_location"],
    type: "location_movement",
    text: "The player recently moved through a neutral placeholder route.",
    source: "system",
    createdAt: "2026-01-01T00:01:00.000Z",
    tags: ["placeholder"],
    edition: "mainline",
    policyProfileId: "mainline_default",
    contentTags: [],
    canonical: true,
    confidence: 1,
    supersedesFactIds: []
  });
  run.locations.start_location.memoryFactIds.push("fact_recent_movement");
  return buildSoloScenePayload(run);
}

export function sceneWithForbiddenLeakSource() {
  const scene = defaultMainlineScene();
  scene.visibleEntities.push({
    entityId: "npc:forbidden_placeholder",
    entityType: "npc",
    displayName: "Forbidden Placeholder",
    summary: "Policy test only.",
    visible: true,
    inspectable: true,
    edition: "forbidden",
    policyProfileId: "forbidden_default",
    contentTags: ["adult_themes"],
    memoryFactIds: [],
    actionTypes: ["inspect"],
    tags: []
  });
  scene.relevantMemoryFacts.push({
    factId: "fact_blocked",
    entityIds: ["start_location"],
    type: "blocked_policy_test",
    text: "Blocked policy test only.",
    source: "system",
    createdAt: "2026-01-01T00:00:00.000Z",
    canonical: true,
    edition: "mainline",
    policyProfileId: "mainline_default",
    contentTags: ["explicit_sexual_content"],
    tags: []
  });
  return scene;
}

export function sceneWithMissingOptionalData() {
  const scene = defaultMainlineScene();
  delete scene.location.imageAssetId;
  scene.visibleEntities = [];
  scene.recentTimeline = [];
  scene.relevantMemoryFacts = [];
  return scene;
}
