import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGmSceneInput,
  generatePlaceholderGmNarration,
  sanitizeGmNarration,
  validateGmSceneOutput
} from "../server/solo/gm.js";
import { buildSoloScenePayload } from "../server/solo/scene.js";
import { createDefaultSoloRun } from "../server/solo/schema.js";

function makeRun(overrides = {}) {
  const run = createDefaultSoloRun({
    runId: overrides.runId || "run_gm",
    now: "2026-01-01T00:00:00.000Z"
  });
  return run;
}

function addNpc(run, overrides = {}) {
  const npc = {
    npcId: overrides.npcId || "placeholder_npc",
    displayName: overrides.displayName || "Placeholder NPC",
    role: "Neutral placeholder role",
    currentLocationId: "start_location",
    known: true,
    status: "alive",
    memoryFactIds: overrides.memoryFactIds || [],
    imageAssetId: null,
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
    factId: overrides.factId || "fact_extra",
    entityIds: overrides.entityIds || ["start_location"],
    type: "placeholder_fact",
    text: overrides.text || "Neutral placeholder fact.",
    source: "system",
    createdAt: "2026-01-01T00:00:00.000Z",
    tags: ["placeholder"],
    canonical: true,
    confidence: 1,
    supersedesFactIds: [],
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    contentTags: [],
    ...overrides
  };
  run.memoryFacts.push(fact);
  return fact;
}

function validOutput(overrides = {}) {
  return {
    ok: true,
    narration: {
      title: "Start Location",
      body: "Neutral narration.",
      tone: "neutral",
      sensoryDetails: [],
      focusEntityIds: [],
      ...(overrides.narration || {})
    },
    suggestedActionLabels: [],
    warnings: [],
    stateMutations: [],
    ...overrides
  };
}

test("buildGmSceneInput accepts valid scene payload", () => {
  const scene = buildSoloScenePayload(makeRun());

  const input = buildGmSceneInput(scene);
  assert.equal(input.ok, true);
  assert.deepEqual(input.errors, []);
});

test("GM input includes location", () => {
  const scene = buildSoloScenePayload(makeRun());

  const input = buildGmSceneInput(scene);
  assert.equal(input.location.locationId, "start_location");
  assert.equal(input.location.name, "Start Location");
});

test("GM input includes visible entities", () => {
  const run = makeRun();
  addNpc(run);

  const input = buildGmSceneInput(buildSoloScenePayload(run));
  assert.ok(input.visibleEntities.some((entity) => entity.entityId === "npc:placeholder_npc"));
});

test("GM input includes available moves and actions", () => {
  const input = buildGmSceneInput(buildSoloScenePayload(makeRun()));

  assert.ok(input.availableMoves.some((move) => move.locationId === "second_location"));
  assert.ok(input.availableActions.some((action) => action.type === "move"));
});

test("GM input includes recent timeline and memory facts", () => {
  const input = buildGmSceneInput(buildSoloScenePayload(makeRun()));

  assert.ok(input.recentTimeline.some((event) => event.eventId === "event_run_created"));
  assert.ok(input.relevantMemoryFacts.some((fact) => fact.factId === "fact_run_created"));
});

test("GM input includes policy and edition", () => {
  const input = buildGmSceneInput(buildSoloScenePayload(makeRun()));

  assert.equal(input.edition, "mainline");
  assert.equal(input.policyProfileId, "mainline_default");
  assert.equal(input.gmInstructions.mode, "scene_framing");
  assert.equal(input.gmInstructions.doNotMutateState, true);
  assert.equal(input.gmInstructions.respectPolicy, true);
  assert.equal(input.gmInstructions.noCanonInvention, true);
});

test("mainline GM input excludes forbidden visible entity", () => {
  const scene = buildSoloScenePayload(makeRun());
  scene.visibleEntities.push({
    entityId: "npc:forbidden_placeholder",
    entityType: "npc",
    displayName: "Forbidden Placeholder",
    summary: "Policy test only.",
    visible: true,
    inspectable: true,
    memoryFactIds: [],
    actionTypes: ["inspect"],
    edition: "forbidden",
    policyProfileId: "forbidden_default",
    contentTags: ["adult_themes"],
    tags: []
  });

  const input = buildGmSceneInput(scene);
  assert.equal(input.visibleEntities.some((entity) => entity.entityId === "npc:forbidden_placeholder"), false);
});

test("mainline GM input excludes blocked-tag memory fact", () => {
  const scene = buildSoloScenePayload(makeRun());
  scene.relevantMemoryFacts.push({
    factId: "fact_blocked",
    entityIds: ["start_location"],
    type: "blocked_policy_test",
    text: "Policy test only.",
    source: "system",
    createdAt: "2026-01-01T00:00:00.000Z",
    canonical: true,
    edition: "mainline",
    policyProfileId: "mainline_default",
    contentTags: ["explicit_sexual_content"],
    tags: []
  });

  const input = buildGmSceneInput(scene);
  assert.equal(input.relevantMemoryFacts.some((fact) => fact.factId === "fact_blocked"), false);
});

test("forbidden GM input can include forbidden entity and fact if policy allows", () => {
  const run = makeRun({ runId: "run_gm_forbidden" });
  run.edition = "forbidden";
  run.policyProfileId = "forbidden_default";
  run.locations.start_location.edition = "forbidden";
  run.locations.start_location.policyProfileId = "forbidden_default";
  run.locations.start_location.contentTags = ["adult_themes"];
  addFact(run, {
    factId: "fact_forbidden",
    entityIds: ["placeholder_npc"],
    edition: "forbidden",
    policyProfileId: "forbidden_default",
    contentTags: ["adult_themes"]
  });
  addNpc(run, {
    edition: "forbidden",
    policyProfileId: "forbidden_default",
    contentTags: ["adult_themes"],
    memoryFactIds: ["fact_forbidden"]
  });

  const input = buildGmSceneInput(buildSoloScenePayload(run));
  assert.ok(input.visibleEntities.some((entity) => entity.entityId === "npc:placeholder_npc"));
  assert.ok(input.relevantMemoryFacts.some((fact) => fact.factId === "fact_forbidden"));
});

test("validateGmSceneOutput accepts valid narration", () => {
  const validation = validateGmSceneOutput(validOutput());
  assert.equal(validation.ok, true);
});

test("validateGmSceneOutput rejects state mutations", () => {
  const validation = validateGmSceneOutput(validOutput({ stateMutations: [{ op: "set", path: "currentLocationId" }] }));
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.path === "stateMutations"));
});

test("sanitizeGmNarration strips script and html injection", () => {
  const sanitized = sanitizeGmNarration(
    validOutput({
      narration: {
        title: "<strong>Start</strong><script>alert(1)</script>",
        body: "Plain <em>text</em><script>bad()</script>",
        tone: "neutral"
      },
      suggestedActionLabels: ["<b>Move</b>"]
    })
  );

  assert.equal(sanitized.ok, true);
  assert.equal(sanitized.narration.title, "Start");
  assert.equal(sanitized.narration.body, "Plain text");
  assert.deepEqual(sanitized.suggestedActionLabels, ["Move"]);
});

test("placeholder GM creates deterministic title and body", () => {
  const scene = buildSoloScenePayload(makeRun());

  const first = generatePlaceholderGmNarration(scene);
  const second = generatePlaceholderGmNarration(scene);
  assert.deepEqual(first, second);
  assert.equal(first.narration.title, "Start Location");
  assert.match(first.narration.body, /Neutral placeholder starting location/);
});

test("placeholder GM does not invent lore names", () => {
  const narration = generatePlaceholderGmNarration(buildSoloScenePayload(makeRun()));

  assert.doesNotMatch(narration.narration.body, /Alchemist God|Akrij|canon/i);
});

test("placeholder GM does not mutate scene or run", () => {
  const run = makeRun();
  const scene = buildSoloScenePayload(run);
  const beforeRun = JSON.stringify(run);
  const beforeScene = JSON.stringify(scene);

  generatePlaceholderGmNarration(scene);
  assert.equal(JSON.stringify(run), beforeRun);
  assert.equal(JSON.stringify(scene), beforeScene);
});

test("scene payload can include gmNarration if option enabled", () => {
  const scene = buildSoloScenePayload(makeRun(), { includePlaceholderGm: true });

  assert.equal(scene.ok, true);
  assert.equal(scene.gmNarration.ok, true);
  assert.equal(scene.gmNarration.narration.title, "Start Location");
});
