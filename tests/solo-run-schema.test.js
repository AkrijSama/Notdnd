import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultForbiddenPolicyProfile,
  createDefaultLocationGraph,
  createDefaultMainlinePolicyProfile,
  createDefaultSoloRun,
  validateEntityAgainstPolicy,
  validateDialogueBeat,
  validateImageAsset,
  validateInventoryItem,
  validateLocation,
  validateLocationGraph,
  validateMemoryFact,
  validateNpc,
  validatePolicyProfile,
  validatePlayerAsset,
  validatePlayerState,
  validateQuestState,
  validateRelationship,
  validateRestMetadata,
  validateSoloRun,
  validateTimelineEvent
} from "../server/solo/schema.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function errorPaths(result) {
  return result.errors.map((error) => error.path);
}

function validNpc(overrides = {}) {
  return {
    npcId: "placeholder_npc",
    displayName: "Placeholder NPC",
    role: "placeholder_role",
    currentLocationId: "start_location",
    known: true,
    status: "alive",
    memoryFactIds: [],
    tags: [],
    flags: {},
    ...overrides
  };
}

function validRelationship(overrides = {}) {
  return {
    relationshipId: "rel_player_placeholder_npc",
    sourceEntityId: "player",
    targetEntityId: "placeholder_npc",
    meters: {
      trust: 0,
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

function validMemoryFact(overrides = {}) {
  const now = new Date().toISOString();
  return {
    factId: "fact_placeholder",
    entityIds: ["player"],
    type: "placeholder_fact",
    text: "Neutral placeholder fact.",
    source: "system",
    createdAt: now,
    tags: [],
    canonical: true,
    confidence: 1,
    supersedesFactIds: [],
    ...overrides
  };
}

function validTimelineEvent(overrides = {}) {
  return {
    eventId: "event_placeholder",
    type: "placeholder_event",
    title: "Placeholder Event",
    summary: "Neutral placeholder event.",
    createdAt: new Date().toISOString(),
    locationId: "start_location",
    entityIds: ["player"],
    memoryFactIds: [],
    tags: [],
    payload: {},
    ...overrides
  };
}

function validImageAsset(overrides = {}) {
  return {
    assetId: "image_placeholder",
    targetType: "location",
    targetId: "start_location",
    status: "placeholder",
    promptSummary: "Neutral placeholder image.",
    uri: null,
    version: 1,
    createdAt: new Date().toISOString(),
    tags: [],
    flags: {},
    ...overrides
  };
}

function validPlayerAsset(overrides = {}) {
  return {
    assetId: "placeholder_base",
    type: "base",
    name: "Placeholder Base",
    locationId: "start_location",
    level: 1,
    components: {},
    resources: {},
    memoryFactIds: [],
    tags: [],
    flags: {},
    ...overrides
  };
}

function validQuest(overrides = {}) {
  return {
    questId: "placeholder_quest",
    status: "inactive",
    stage: 0,
    relatedEntityIds: [],
    memoryFactIds: [],
    flags: {},
    ...overrides
  };
}

function validInventoryItem(overrides = {}) {
  return {
    itemId: "placeholder_item",
    templateId: null,
    name: "Placeholder Item",
    quantity: 1,
    tags: [],
    flags: {},
    ...overrides
  };
}

test("createDefaultSoloRun returns a valid run", () => {
  const run = createDefaultSoloRun({
    runId: "run_test",
    userId: "user_test",
    worldSeed: "seed_test"
  });

  const result = validateSoloRun(run);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(run.runId, "run_test");
  assert.equal(run.userId, "user_test");
  assert.equal(run.status, "active");
  assert.equal(run.edition, "mainline");
  assert.equal(run.policyProfileId, "mainline_default");
  assert.equal(run.currentLocationId, "start_location");
  assert.ok(run.locations.start_location);
  assert.ok(run.locations.second_location);
  assert.ok(run.locations.third_location);
  assert.ok(run.memoryFacts.length >= 1);
  assert.ok(run.timeline.length >= 1);
  assert.equal(run.version, 1);
});

test("createDefaultSoloRun defaults to mainline", () => {
  const run = createDefaultSoloRun({ runId: "run_policy_default" });

  assert.equal(run.edition, "mainline");
  assert.equal(run.policyProfileId, "mainline_default");
  assert.equal(validateSoloRun(run).ok, true);
});

test("validateSoloRun accepts edition mainline", () => {
  const run = createDefaultSoloRun({ runId: "run_mainline" });
  run.edition = "mainline";

  const result = validateSoloRun(run);
  assert.equal(result.ok, true);
});

test("validateSoloRun rejects invalid edition", () => {
  const run = createDefaultSoloRun({ runId: "run_bad_edition" });
  run.edition = "public";

  const result = validateSoloRun(run);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("edition"));
});

test("validateSoloRun rejects missing runId", () => {
  const run = createDefaultSoloRun({ runId: "run_test" });
  delete run.runId;

  const result = validateSoloRun(run);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("runId"));
});

test("validateSoloRun rejects missing currentLocationId", () => {
  const run = createDefaultSoloRun({ runId: "run_test" });
  delete run.currentLocationId;

  const result = validateSoloRun(run);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("currentLocationId"));
});

test("validateSoloRun rejects currentLocationId that does not exist in locations", () => {
  const run = createDefaultSoloRun({ runId: "run_test" });
  run.currentLocationId = "missing_location";

  const result = validateSoloRun(run);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.path === "currentLocationId" && /does not exist/.test(error.message)));
});

test("validatePlayerState rejects missing stats", () => {
  const run = createDefaultSoloRun({ runId: "run_test" });
  const player = clone(run.player);
  delete player.stats;

  const result = validatePlayerState(player);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("stats"));
});

test("validateLocation requires connectedLocationIds array", () => {
  const run = createDefaultSoloRun({ runId: "run_test" });
  const location = clone(run.locations.start_location);
  delete location.connectedLocationIds;

  const result = validateLocation(location);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("connectedLocationIds"));
});

test("default solo run has valid location graph", () => {
  const run = createDefaultSoloRun({ runId: "run_graph_default" });

  const result = validateLocationGraph(run.locations, {
    currentLocationId: run.currentLocationId
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("validateLocationGraph accepts valid graph", () => {
  const graph = createDefaultLocationGraph();

  const result = validateLocationGraph(graph, { currentLocationId: "start_location" });
  assert.equal(result.ok, true);
});

test("validateLocationGraph rejects missing locationId", () => {
  const graph = createDefaultLocationGraph();
  delete graph.start_location.locationId;

  const result = validateLocationGraph(graph);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("locations.start_location.locationId"));
});

test("validateLocationGraph rejects connectedLocationId that does not exist", () => {
  const graph = createDefaultLocationGraph();
  graph.start_location.connectedLocationIds = ["missing_location"];

  const result = validateLocationGraph(graph);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("locations.start_location.connectedLocationIds.0"));
});

test("validateLocationGraph rejects invalid currentLocationId", () => {
  const graph = createDefaultLocationGraph();

  const result = validateLocationGraph(graph, { currentLocationId: "missing_location" });
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("currentLocationId"));
});

test("validateLocationGraph rejects non-array connectedLocationIds", () => {
  const graph = createDefaultLocationGraph();
  graph.start_location.connectedLocationIds = "second_location";

  const result = validateLocationGraph(graph);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("locations.start_location.connectedLocationIds"));
});

test("validateLocationGraph rejects duplicate connections", () => {
  const graph = createDefaultLocationGraph();
  graph.start_location.connectedLocationIds = ["second_location", "second_location"];

  const result = validateLocationGraph(graph);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("locations.start_location.connectedLocationIds.1"));
});

test("validateLocationGraph rejects self-connection unless allowed", () => {
  const graph = createDefaultLocationGraph();
  graph.start_location.connectedLocationIds = ["start_location"];

  const rejected = validateLocationGraph(graph);
  const allowed = validateLocationGraph(graph, { allowSelfConnections: true });
  assert.equal(rejected.ok, false);
  assert.ok(errorPaths(rejected).includes("locations.start_location.connectedLocationIds.0"));
  assert.equal(allowed.ok, true);
});

test("location imageAssetId remains optional", () => {
  const graph = createDefaultLocationGraph();
  delete graph.start_location.imageAssetId;

  const result = validateLocationGraph(graph);
  assert.equal(result.ok, true);
});

test("location memoryFactIds must be array", () => {
  const graph = createDefaultLocationGraph();
  graph.start_location.memoryFactIds = "fact_start";

  const result = validateLocationGraph(graph);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("locations.start_location.memoryFactIds"));
});

test("location edition policy and contentTags validate through graph", () => {
  const graph = createDefaultLocationGraph();
  graph.start_location.edition = "side_channel";
  graph.start_location.policyProfileId = 42;
  graph.start_location.contentTags = "dark_fantasy";

  const result = validateLocationGraph(graph);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("locations.start_location.edition"));
  assert.ok(errorPaths(result).includes("locations.start_location.policyProfileId"));
  assert.ok(errorPaths(result).includes("locations.start_location.contentTags"));
});

test("forbidden location can exist in schema and remains identifiable", () => {
  const graph = createDefaultLocationGraph();
  graph.third_location.edition = "forbidden";
  graph.third_location.policyProfileId = "forbidden_default";
  graph.third_location.contentTags = ["adult_themes"];

  const result = validateLocationGraph(graph);
  assert.equal(result.ok, true);
  assert.equal(graph.third_location.edition, "forbidden");
  assert.equal(graph.third_location.policyProfileId, "forbidden_default");
});

test("mainline policy helper rejects location with blocked contentTags", () => {
  const profile = createDefaultMainlinePolicyProfile();
  const location = createDefaultLocationGraph().start_location;
  location.contentTags = ["dark_fantasy", "explicit_sexual_content"];

  const result = validateEntityAgainstPolicy(location, profile);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("contentTags.1"));
});

test("validateNpc accepts optional imageAssetId", () => {
  const withoutImage = validateNpc(validNpc());
  const withImage = validateNpc(validNpc({ imageAssetId: "image_placeholder_npc" }));

  assert.equal(withoutImage.ok, true);
  assert.equal(withImage.ok, true);
});

test("validateDialogueBeat accepts neutral structured dialogue", () => {
  const result = validateDialogueBeat({
    beatId: "quiet_area",
    label: "Quiet Area",
    text: "There is not much to say yet, but the area has been quiet.",
    revealed: false,
    repeatable: false,
    contentTags: [],
    linkedMemoryFactIds: [],
    linkedQuestIds: []
  });

  assert.equal(result.ok, true);
});

test("validateRestMetadata accepts neutral rest configuration", () => {
  const result = validateRestMetadata({
    allowed: true,
    safety: "safe",
    availableTypes: ["short", "long"],
    contentTags: []
  });

  assert.equal(result.ok, true);
});

test("validateNpc rejects duplicate dialogue beat ids", () => {
  const result = validateNpc(validNpc({
    dialogueBeats: [
      {
        beatId: "quiet_area",
        label: "Quiet Area",
        text: "Neutral dialogue.",
        revealed: false,
        repeatable: false,
        contentTags: [],
        linkedMemoryFactIds: [],
        linkedQuestIds: []
      },
      {
        beatId: "quiet_area",
        label: "Quiet Area Again",
        text: "Neutral dialogue again.",
        revealed: false,
        repeatable: false,
        contentTags: [],
        linkedMemoryFactIds: [],
        linkedQuestIds: []
      }
    ]
  }));

  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("dialogueBeats.1.beatId"));
});

test("validateRelationship validates all required meters", () => {
  const relationship = validRelationship();
  delete relationship.meters.trust;

  const result = validateRelationship(relationship);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("meters.trust"));
});

test("validateMemoryFact requires text/source/entityIds", () => {
  const fact = validMemoryFact();
  delete fact.text;
  delete fact.source;
  delete fact.entityIds;

  const result = validateMemoryFact(fact);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("text"));
  assert.ok(errorPaths(result).includes("source"));
  assert.ok(errorPaths(result).includes("entityIds"));
});

test("validateTimelineEvent requires summary and createdAt", () => {
  const event = validTimelineEvent();
  delete event.summary;
  delete event.createdAt;

  const result = validateTimelineEvent(event);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("summary"));
  assert.ok(errorPaths(result).includes("createdAt"));
});

test("validateImageAsset validates targetType/status/version", () => {
  const asset = validImageAsset({
    targetType: "unsupported",
    status: "missing",
    version: "one"
  });

  const result = validateImageAsset(asset);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("targetType"));
  assert.ok(errorPaths(result).includes("status"));
  assert.ok(errorPaths(result).includes("version"));
});

test("validatePolicyProfile accepts mainline_default", () => {
  const result = validatePolicyProfile(createDefaultMainlinePolicyProfile());

  assert.equal(result.ok, true);
});

test("validatePolicyProfile accepts forbidden_default", () => {
  const result = validatePolicyProfile(createDefaultForbiddenPolicyProfile());

  assert.equal(result.ok, true);
});

test("validatePolicyProfile rejects invalid contentRating", () => {
  const profile = createDefaultMainlinePolicyProfile();
  profile.contentRating = "everyone";

  const result = validatePolicyProfile(profile);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("contentRating"));
});

test("validatePolicyProfile rejects invalid distribution channel", () => {
  const profile = createDefaultMainlinePolicyProfile();
  profile.distributionChannels = ["web", "side_channel"];

  const result = validatePolicyProfile(profile);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("distributionChannels.1"));
});

test("entity with valid edition passes", () => {
  const location = clone(createDefaultSoloRun({ runId: "run_entity_valid" }).locations.start_location);
  location.edition = "mainline";

  const result = validateLocation(location);
  assert.equal(result.ok, true);
});

test("entity with invalid edition fails", () => {
  const location = clone(createDefaultSoloRun({ runId: "run_entity_invalid" }).locations.start_location);
  location.edition = "side_story";

  const result = validateLocation(location);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("edition"));
});

test("mainline policy rejects blocked contentTags", () => {
  const profile = createDefaultMainlinePolicyProfile();
  const entity = {
    edition: "mainline",
    contentTags: ["dark_fantasy", "explicit_sexual_content"]
  };

  const result = validateEntityAgainstPolicy(entity, profile);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("contentTags.1"));
});

test("mainline policy allows safe contentTags", () => {
  const profile = createDefaultMainlinePolicyProfile();
  const entity = {
    edition: "mainline",
    contentTags: ["dark_fantasy", "fade_to_black"]
  };

  const result = validateEntityAgainstPolicy(entity, profile);
  assert.equal(result.ok, true);
});

test("forbidden policy is separate from mainline", () => {
  const mainline = createDefaultMainlinePolicyProfile();
  const forbidden = createDefaultForbiddenPolicyProfile();
  const entity = {
    edition: "forbidden",
    contentTags: ["adult_themes"]
  };

  assert.equal(validateEntityAgainstPolicy(entity, forbidden).ok, true);
  assert.equal(validateEntityAgainstPolicy(entity, mainline).ok, false);
});

test("image asset can carry policyProfileId", () => {
  const asset = validImageAsset({
    edition: "mainline",
    policyProfileId: "mainline_default",
    contentTags: ["dark_fantasy"]
  });

  const result = validateImageAsset(asset);
  assert.equal(result.ok, true);
});

test("memory fact can carry contentTags/policyProfileId", () => {
  const fact = validMemoryFact({
    edition: "mainline",
    policyProfileId: "mainline_default",
    contentTags: ["dark_fantasy"]
  });

  const result = validateMemoryFact(fact);
  assert.equal(result.ok, true);
});

test("validatePlayerAsset validates type/level/components/resources", () => {
  const asset = validPlayerAsset({
    type: "castle",
    level: "one",
    components: [],
    resources: null
  });

  const result = validatePlayerAsset(asset);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("type"));
  assert.ok(errorPaths(result).includes("level"));
  assert.ok(errorPaths(result).includes("components"));
  assert.ok(errorPaths(result).includes("resources"));
});

test("validateQuestState validates status", () => {
  const result = validateQuestState(validQuest({ status: "paused" }));

  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("status"));
});

test("validateInventoryItem validates quantity", () => {
  const result = validateInventoryItem(validInventoryItem({ quantity: "many" }));

  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("quantity"));
});

test("validateInventoryItem accepts minimal usable item effect", () => {
  const item = {
    itemId: "field_ration",
    templateId: "placeholder_field_ration",
    name: "Field Ration",
    description: "Neutral placeholder ration.",
    quantity: 1,
    usable: true,
    consumable: true,
    use: {
      effectType: "recover_resource",
      label: "Use ration",
      summary: "Recover a little stamina.",
      resource: "stamina",
      amount: 1,
      note: null,
      requiresTarget: false
    },
    tags: [],
    flags: {},
    imageAssetId: null,
    edition: "mainline",
    policyProfileId: "mainline_default",
    contentTags: []
  };

  assert.equal(validateInventoryItem(item).ok, true);
});

test("validation errors include useful path values", () => {
  const run = createDefaultSoloRun({ runId: "run_test" });
  run.player.stats.alchemy = "high";
  run.locations.start_location.state.visited = "yes";
  run.locations.start_location.connectedLocationIds = ["missing_location"];

  const result = validateSoloRun(run);
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes("player.stats.alchemy"));
  assert.ok(errorPaths(result).includes("locations.start_location.state.visited"));
  assert.ok(errorPaths(result).includes("locations.start_location.connectedLocationIds.0"));
});
