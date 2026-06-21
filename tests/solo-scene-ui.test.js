import assert from "node:assert/strict";
import test from "node:test";
import { fetchSoloScene, postSoloAction, requireRunId } from "../src/components/soloSceneApi.js";
import { createInspectAction, createMoveAction, renderSoloSceneShell } from "../src/components/soloSceneShell.js";

function sampleScene() {
  return {
    ok: true,
    runId: "run_test",
    edition: "mainline",
    policyProfileId: "mainline_default",
    location: {
      locationId: "start_location",
      name: "Start Location",
      description: "Neutral placeholder description.",
      imageAssetId: "image_start",
      state: {},
      tags: [],
      contentTags: []
    },
    visibleEntities: [
      {
        entityId: "location:start_location",
        entityType: "location_object",
        displayName: "Start Location",
        summary: "Current location",
        visible: true,
        inspectable: true,
        actionTypes: ["inspect"]
      },
      {
        entityId: "npc:placeholder_npc",
        entityType: "npc",
        displayName: "Placeholder NPC",
        summary: "Neutral placeholder NPC.",
        visible: true,
        inspectable: true,
        actionTypes: ["inspect", "talk"]
      }
    ],
    availableMoves: [
      {
        locationId: "second_location",
        name: "Second Location",
        direction: "east",
        imageAssetId: null,
        edition: "mainline",
        policyProfileId: "mainline_default"
      }
    ],
    availableActions: [
      {
        type: "move",
        label: "Move to Second Location",
        toLocationId: "second_location",
        enabled: true
      },
      {
        type: "search",
        label: "Search area",
        enabled: false,
        reason: "Not implemented yet"
      }
    ],
    recentTimeline: [
      {
        eventId: "event_start",
        type: "run_created",
        title: "Run Created",
        summary: "The solo run was created."
      }
    ],
    relevantMemoryFacts: [
      {
        factId: "fact_start",
        type: "starting_state",
        text: "The run began at the starting location."
      }
    ],
    uiHints: {
      layout: "spatial_scene",
      showLocationImage: true,
      showActionBar: true,
      showEntityPanel: true,
      showTimeline: true
    },
    errors: []
  };
}

test("renderSoloSceneShell renders location name and description", () => {
  const html = renderSoloSceneShell({ scene: sampleScene() });
  assert.match(html, /Start Location/);
  assert.match(html, /Neutral placeholder description/);
});

test("renderSoloSceneShell renders image placeholder and asset reference", () => {
  const html = renderSoloSceneShell({ scene: sampleScene() });
  assert.match(html, /Image asset: image_start/);
  assert.match(html, /data-image-asset-id="image_start"/);
});

test("renderSoloSceneShell renders visible entities", () => {
  const html = renderSoloSceneShell({ scene: sampleScene() });
  assert.match(html, /Placeholder NPC/);
  assert.match(html, /data-entity-id="npc:placeholder_npc"/);
});

test("renderSoloSceneShell renders available moves", () => {
  const html = renderSoloSceneShell({ scene: sampleScene() });
  assert.match(html, /east: Second Location/);
  assert.match(html, /data-location-id="second_location"/);
});

test("renderSoloSceneShell renders available actions and disables unimplemented actions", () => {
  const html = renderSoloSceneShell({ scene: sampleScene() });
  assert.match(html, /Move to Second Location/);
  assert.match(html, /Search area/);
  assert.match(html, /disabled/);
});

test("renderSoloSceneShell renders timeline and memory panels", () => {
  const html = renderSoloSceneShell({ scene: sampleScene() });
  assert.match(html, /Run Created/);
  assert.match(html, /The run began at the starting location/);
});

test("renderSoloSceneShell renders inspect details", () => {
  const html = renderSoloSceneShell({
    scene: sampleScene(),
    detail: {
      entity: { displayName: "Placeholder NPC" },
      details: {
        title: "Placeholder NPC",
        description: "Structured details only.",
        availableActions: [{ type: "inspect" }]
      }
    }
  });
  assert.match(html, /Structured details only/);
  assert.match(html, /Actions: inspect/);
});

test("renderSoloSceneShell renders loading state", () => {
  const html = renderSoloSceneShell({ loading: true });
  assert.match(html, /Loading solo scene/);
});

test("renderSoloSceneShell renders error state", () => {
  const html = renderSoloSceneShell({ error: "Failed to load" });
  assert.match(html, /Solo Scene Unavailable/);
  assert.match(html, /Failed to load/);
});

test("createMoveAction builds persisted move action shape", () => {
  assert.deepEqual(createMoveAction(sampleScene(), { locationId: "second_location", direction: "east" }), {
    type: "move",
    actorId: "player",
    fromLocationId: "start_location",
    toLocationId: "second_location",
    direction: "east"
  });
});

test("createInspectAction builds inspect action shape", () => {
  assert.deepEqual(createInspectAction({ entityId: "npc:placeholder_npc" }), {
    type: "inspect",
    actorId: "player",
    entityId: "npc:placeholder_npc"
  });
});

test("solo scene API helpers call auth-aware client methods", async () => {
  const calls = [];
  const apiClient = {
    async fetchSoloScene(runId) {
      calls.push(["scene", runId]);
      return { ok: true, runId };
    },
    async postSoloAction(runId, action) {
      calls.push(["action", runId, action]);
      return { ok: true, action };
    }
  };

  assert.deepEqual(await fetchSoloScene(apiClient, "run_test"), { ok: true, runId: "run_test" });
  assert.deepEqual(await postSoloAction(apiClient, "run_test", { type: "inspect" }), {
    ok: true,
    action: { type: "inspect" }
  });
  assert.deepEqual(calls, [
    ["scene", "run_test"],
    ["action", "run_test", { type: "inspect" }]
  ]);
});

test("requireRunId rejects missing run id", () => {
  assert.throws(() => requireRunId(""), /Solo run id is required/);
});
