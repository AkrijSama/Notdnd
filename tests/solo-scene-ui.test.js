import assert from "node:assert/strict";
import test from "node:test";
import { fetchSoloGmScene, fetchSoloScene, postSoloAction, requireRunId } from "../src/components/soloSceneApi.js";
import {
  bindSoloSceneShell,
  dispatchSoloClick,
  dispatchSoloKeydown,
  createInspectAction,
  createMoveAction,
  createRestAction,
  createSearchAction,
  createTalkAction,
  createUseItemAction,
  mountSoloSceneShell,
  renderEntityDetailPanel,
  renderSoloSceneShell
} from "../src/components/soloSceneShell.js";

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
    discoveredDetails: [],
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
        enabled: true
      },
      {
        type: "talk",
        label: "Talk to Placeholder NPC",
        targetEntityId: "npc:placeholder_npc",
        enabled: true
      },
      {
        type: "rest",
        label: "Short Rest",
        restType: "short",
        enabled: true
      },
      {
        type: "use_item",
        label: "Use Field Ration",
        itemId: "field_ration",
        enabled: true
      }
    ],
    playerInventory: [
      {
        itemId: "field_ration",
        name: "Field Ration",
        description: "A neutral placeholder ration.",
        quantity: 1,
        usable: true,
        consumable: true,
        availableActions: ["use_item"]
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
  assert.match(html, /solo-scene-shell-polished/);
  assert.match(html, /Start Location/);
  assert.match(html, /Neutral placeholder description/);
});

test("renderSoloSceneShell error state surfaces the message, a retry, and a way back home", () => {
  // A failed scene load must NEVER be a silent spinner: it shows the error plus
  // both a Retry and a Return-home control so the player is never stranded.
  const html = renderSoloSceneShell({ error: "The request timed out — the server did not respond. Please try again." });
  assert.match(html, /solo-scene-shell-error/);
  assert.match(html, /did not respond/);
  assert.match(html, /data-solo-action="reload-scene"/);
  assert.match(html, /data-solo-home/);
  assert.doesNotMatch(html, /Loading solo scene/);
});

test("renderSoloSceneShell death screen replaces the playable shell with an outcome + way home", () => {
  // A terminal/dead run routes here instead of the live scene — no playable
  // shell, no spinner, and a clear path back to the home screen.
  const html = renderSoloSceneShell({
    deathScreen: true,
    runSummary: { playerName: "Bram", location: "The Ember Tavern", outcome: "dead", timePlayedMs: 1000 }
  });
  assert.match(html, /solo-death-screen/);
  assert.match(html, /has fallen/);
  assert.match(html, /data-solo-home/);
  assert.doesNotMatch(html, /solo-scene-shell-polished/);
  assert.doesNotMatch(html, /Loading solo scene/);
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
  assert.match(html, /Talk/);
});

test("renderSoloSceneShell renders available moves", () => {
  const html = renderSoloSceneShell({ scene: sampleScene() });
  assert.match(html, /Second Location/);
  assert.match(html, />east</);
  assert.match(html, /data-location-id="second_location"/);
});

test("renderSoloSceneShell renders available actions and disables unimplemented actions", () => {
  const scene = {
    ...sampleScene(),
    availableActions: [
      ...sampleScene().availableActions,
      {
        type: "interact",
        label: "Interact",
        enabled: false,
        reason: "Not implemented yet"
      }
    ]
  };
  const html = renderSoloSceneShell({ scene });
  assert.match(html, /Move to Second Location/);
  assert.match(html, /Search area/);
  assert.match(html, /Talk to Placeholder NPC/);
  assert.match(html, /data-solo-action="talk"/);
  assert.match(html, /Short Rest/);
  assert.match(html, /data-solo-action="rest"/);
  assert.match(html, /Use Field Ration/);
  assert.match(html, /data-solo-action="use_item"/);
  assert.match(html, /data-solo-action="search"/);
  assert.match(html, /Not implemented yet/);
  assert.match(html, /disabled/);
});

test("renderSoloSceneShell renders inventory panel", () => {
  const html = renderSoloSceneShell({ scene: sampleScene() });

  assert.match(html, /Inventory/);
  assert.match(html, /Field Ration/);
  assert.match(html, /Quantity: 1/);
  assert.match(html, /data-item-id="field_ration"/);
});

test("renderSoloSceneShell renders search result and discovered details", () => {
  const html = renderSoloSceneShell({
    scene: {
      ...sampleScene(),
      discoveredDetails: [
        {
          detailId: "detail_scuffed_mark",
          label: "Scuffed Mark",
          description: "A scuffed mark is visible near the edge of the path."
        }
      ]
    },
    searchResult: {
      locationId: "start_location",
      found: true,
      summary: "A scuffed mark is visible near the edge of the path.",
      revealedDetailIds: ["detail_scuffed_mark"],
      warningCodes: []
    }
  });

  assert.match(html, /Area Search/);
  assert.match(html, /Detail found/);
  assert.match(html, /Scuffed Mark/);
  assert.match(html, /A scuffed mark is visible/);
  assert.doesNotMatch(html, /"searchResult"/);
});

test("renderSoloSceneShell renders nothing-new search result", () => {
  const html = renderSoloSceneShell({
    scene: sampleScene(),
    searchResult: {
      locationId: "start_location",
      found: false,
      summary: "You find nothing new right now.",
      revealedDetailIds: [],
      warningCodes: ["SEARCH_NOTHING_NEW"]
    }
  });

  assert.match(html, /Nothing new found/);
  assert.match(html, /You find nothing new right now/);
  assert.match(html, /SEARCH_NOTHING_NEW/);
});

test("renderSoloSceneShell renders talk result", () => {
  const html = renderSoloSceneShell({
    scene: sampleScene(),
    talkResult: {
      npcId: "placeholder_npc",
      beatId: "quiet_area",
      found: true,
      speakerName: "Placeholder NPC",
      line: "There is not much to say yet, but the area has been quiet.",
      summary: "Placeholder NPC: Quiet Area",
      revealed: true,
      checkResult: null,
      warningCodes: []
    }
  });

  assert.match(html, /Dialogue/);
  assert.match(html, /Placeholder NPC/);
  assert.match(html, /area has been quiet/);
  assert.doesNotMatch(html, /"talkResult"/);
});

test("renderSoloSceneShell renders neutral fallback talk result", () => {
  const html = renderSoloSceneShell({
    scene: sampleScene(),
    talkResult: {
      npcId: "placeholder_npc",
      beatId: null,
      found: false,
      speakerName: "Placeholder NPC",
      line: "There is not much new to say right now.",
      summary: "No new dialogue is available.",
      revealed: false,
      checkResult: {
        success: false,
        total: 8,
        dc: 12
      },
      warningCodes: ["TALK_CHECK_FAILED"]
    }
  });

  assert.match(html, /There is not much new to say/);
  assert.match(html, /Check failed/);
  assert.match(html, /TALK_CHECK_FAILED/);
});

test("renderSoloSceneShell renders rest result with recovered resources", () => {
  const html = renderSoloSceneShell({
    scene: sampleScene(),
    restResult: {
      locationId: "start_location",
      restType: "short",
      allowed: true,
      safety: "safe",
      timeAdvanced: 1,
      resourcesRecovered: [
        {
          resourceId: "stamina",
          before: 3,
          after: 5,
          amount: 2
        }
      ],
      summary: "You take a moment to recover.",
      warningCodes: []
    }
  });

  assert.match(html, /Rest/);
  assert.match(html, /Short Rest/);
  assert.match(html, /Time advanced: 1 tick/);
  assert.match(html, /stamina/);
  assert.match(html, /3 -> 5/);
  assert.doesNotMatch(html, /"restResult"/);
});

test("renderSoloSceneShell renders denied rest result", () => {
  const html = renderSoloSceneShell({
    scene: sampleScene(),
    restResult: {
      locationId: "start_location",
      restType: "short",
      allowed: false,
      safety: "unsafe",
      timeAdvanced: 0,
      resourcesRecovered: [],
      summary: "You cannot rest here right now.",
      warningCodes: ["REST_NOT_ALLOWED"]
    }
  });

  assert.match(html, /Rest denied/);
  assert.match(html, /You cannot rest here right now/);
  assert.match(html, /REST_NOT_ALLOWED/);
});

test("renderSoloSceneShell renders use item recovered resource result", () => {
  const html = renderSoloSceneShell({
    scene: sampleScene(),
    useItemResult: {
      itemId: "field_ration",
      itemName: "Field Ration",
      effectType: "recover_resource",
      used: true,
      consumed: true,
      quantityRemaining: 0,
      resourcesRecovered: [
        {
          resourceId: "stamina",
          before: 3,
          after: 4,
          amount: 1
        }
      ],
      summary: "You use the field ration and recover a little stamina.",
      revealedNote: null,
      warningCodes: []
    }
  });

  assert.match(html, /Use Item/);
  assert.match(html, /Field Ration/);
  assert.match(html, /Quantity remaining: 0/);
  assert.match(html, /Recovered Resources/);
  assert.match(html, /3 -> 4/);
  assert.doesNotMatch(html, /"useItemResult"/);
});

test("renderSoloSceneShell renders use item revealed note result", () => {
  const html = renderSoloSceneShell({
    scene: sampleScene(),
    useItemResult: {
      itemId: "plain_note",
      itemName: "Plain Note",
      effectType: "reveal_note",
      used: true,
      consumed: false,
      quantityRemaining: 1,
      resourcesRecovered: [],
      summary: "You read the plain note.",
      revealedNote: "The note contains a simple reminder to stay aware of the surroundings.",
      warningCodes: []
    }
  });

  assert.match(html, /Revealed Note/);
  assert.match(html, /simple reminder/);
});

test("renderSoloSceneShell renders denied item use", () => {
  const html = renderSoloSceneShell({
    scene: sampleScene(),
    useItemResult: {
      itemId: "field_ration",
      itemName: null,
      effectType: null,
      used: false,
      consumed: false,
      quantityRemaining: null,
      resourcesRecovered: [],
      summary: "You cannot use that item here.",
      revealedNote: null,
      warningCodes: ["ITEM_BLOCKED_BY_POLICY"]
    }
  });

  assert.match(html, /Item use denied/);
  assert.match(html, /ITEM_BLOCKED_BY_POLICY/);
});

test("renderSoloSceneShell renders timeline and memory panels", () => {
  const html = renderSoloSceneShell({ scene: sampleScene() });
  assert.match(html, /Run Created/);
  assert.match(html, /The run began at the starting location/);
});

test("renderSoloSceneShell renders GM narration when present", () => {
  const scene = {
    ...sampleScene(),
    gmNarration: {
      ok: true,
      narration: {
        title: "Start Location",
        body: "Server-truth narration placeholder.",
        tone: "neutral",
        sensoryDetails: ["quiet"],
        focusEntityIds: []
      },
      suggestedActionLabels: [],
      warnings: [],
      stateMutations: []
    }
  };

  const html = renderSoloSceneShell({ scene, debug: true });
  assert.match(html, /neutral GM Narration/);
  assert.match(html, /Server-truth narration placeholder/);
  assert.match(html, /quiet/);
  assert.match(html, /GM Mode: Placeholder/);
  assert.doesNotMatch(html, /"narration"/);
  // The GM status panel is debug-only: hidden from beta players by default.
  assert.doesNotMatch(renderSoloSceneShell({ scene }), /GM Mode:/);
});

test("renderSoloSceneShell renders GM status metadata", () => {
  const scene = {
    ...sampleScene(),
    gmNarration: {
      ok: true,
      narration: {
        title: "Start Location",
        body: "Provider narration from safe status metadata.",
        tone: "neutral",
        sensoryDetails: [],
        focusEntityIds: []
      },
      suggestedActionLabels: [],
      warnings: ["GM_LOCAL_MOCK_PROVIDER"],
      stateMutations: []
    },
    gmStatus: {
      mode: "provider",
      providerAttempted: true,
      providerName: "local",
      providerKind: "local",
      providerSucceeded: true,
      fallbackUsed: false,
      evaluationScore: 100,
      warningCodes: ["GM_LOCAL_MOCK_PROVIDER"],
      narrationLength: 48
    }
  };

  const html = renderSoloSceneShell({ scene, gmMode: "provider", debug: true });
  assert.match(html, /GM Mode: Provider/);
  assert.match(html, /Provider: local \/ local/);
  assert.match(html, /Eval 100/);
  assert.match(html, /GM_LOCAL_MOCK_PROVIDER/);
  assert.match(html, /Provider OK/);
  assert.match(html, /data-solo-gm-mode="provider"/);
  assert.doesNotMatch(html, /"gmStatus"/);
});

test("renderSoloSceneShell renders fallback GM status", () => {
  const scene = {
    ...sampleScene(),
    gmStatus: {
      mode: "fallback",
      providerAttempted: false,
      providerName: "placeholder",
      providerKind: "placeholder",
      providerSucceeded: false,
      fallbackUsed: true,
      evaluationScore: 95,
      warningCodes: ["GM_PROVIDER_DISABLED"],
      narrationLength: 120
    }
  };

  const html = renderSoloSceneShell({ scene, gmMode: "provider", debug: true });
  assert.match(html, /GM Mode: Fallback/);
  assert.match(html, /Fallback/);
  assert.match(html, /GM_PROVIDER_DISABLED/);
});

test("renderSoloSceneShell renders fallback GM placeholder when narration is absent", () => {
  const html = renderSoloSceneShell({ scene: sampleScene() });
  assert.match(html, /Future GM Narration/);
  assert.match(html, /generated from server truth and memory/);
});

test("mountSoloSceneShell loads GM narration after base scene", async () => {
  const root = {
    innerHTML: "",
    querySelectorAll() {
      return [];
    }
  };
  const apiClient = {
    async fetchSoloScene() {
      return sampleScene();
    },
    async fetchSoloGmScene() {
      return {
        ok: true,
        scene: sampleScene(),
        gmNarration: {
          ok: true,
          narration: {
            title: "Start Location",
            body: "Mounted GM narration.",
            tone: "neutral",
            sensoryDetails: [],
            focusEntityIds: []
          },
          suggestedActionLabels: [],
          warnings: [],
          stateMutations: []
        },
        gmStatus: {
          mode: "placeholder",
          providerAttempted: false,
          providerName: "placeholder",
          providerKind: "placeholder",
          providerSucceeded: false,
          fallbackUsed: false,
          evaluationScore: 100,
          warningCodes: [],
          narrationLength: 21
        },
        errors: []
      };
    },
    async postSoloAction() {
      return { ok: true };
    }
  };

  const mounted = mountSoloSceneShell(root, { apiClient, runId: "run_test" });
  await mounted.reload();
  assert.match(root.innerHTML, /Mounted GM narration/);
  // GM status panel is debug-only; not asserted here (hidden by default).
});

test("mountSoloSceneShell keeps fallback if GM narration request fails", async () => {
  const root = {
    innerHTML: "",
    querySelectorAll() {
      return [];
    }
  };
  const apiClient = {
    async fetchSoloScene() {
      return sampleScene();
    },
    async fetchSoloGmScene() {
      throw new Error("GM route unavailable");
    },
    async postSoloAction() {
      return { ok: true };
    }
  };

  const mounted = mountSoloSceneShell(root, { apiClient, runId: "run_test" });
  await mounted.reload();
  // #25: the scene narration now renders through the append-only log (seeded from
  // the location description when GM narration is unavailable), so a failed GM
  // fetch still shows the scene prose and never the error screen.
  assert.match(root.innerHTML, /Neutral placeholder description/);
  assert.doesNotMatch(root.innerHTML, /Solo Scene Unavailable/);
});

test("mountSoloSceneShell posts search action and shows result", async () => {
  const searchButton = {
    handler: null,
    addEventListener(_event, handler) {
      this.handler = handler;
    }
  };
  const root = {
    innerHTML: "",
    _l: {},
    addEventListener(name, handler) {
      this._l[name] = handler;
    },
    querySelectorAll(selector) {
      return selector === "[data-solo-action='search']" ? [searchButton] : [];
    }
  };
  const calls = [];
  const discoveredScene = {
    ...sampleScene(),
    discoveredDetails: [
      {
        detailId: "detail_scuffed_mark",
        label: "Scuffed Mark",
        description: "A scuffed mark is visible near the edge of the path."
      }
    ]
  };
  const apiClient = {
    async fetchSoloScene() {
      return calls.some((call) => call[0] === "action") ? discoveredScene : sampleScene();
    },
    async fetchSoloGmScene() {
      return { ok: true, gmNarration: null, gmStatus: null };
    },
    async postSoloAction(runId, action) {
      calls.push(["action", runId, action]);
      return {
        ok: true,
        searchResult: {
          locationId: "start_location",
          found: true,
          summary: "A scuffed mark is visible near the edge of the path.",
          revealedDetailIds: ["detail_scuffed_mark"],
          warningCodes: []
        }
      };
    }
  };

  const mounted = mountSoloSceneShell(root, { apiClient, runId: "run_test" });
  await mounted.reload();
  // #15-full: the click is delegated — fire it through the single root listener.
  root._l.click({ target: clickTarget({ "[data-solo-action='search']": {} }) });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, [["action", "run_test", { type: "search", actorId: "player" }]]);
  assert.match(root.innerHTML, /Detail found/);
  assert.match(root.innerHTML, /Scuffed Mark/);
});

test("mountSoloSceneShell posts talk action and shows dialogue result", async () => {
  const talkButton = {
    handler: null,
    addEventListener(_event, handler) {
      this.handler = handler;
    },
    getAttribute(name) {
      return name === "data-entity-id" ? "npc:placeholder_npc" : "";
    }
  };
  const root = {
    innerHTML: "",
    _l: {},
    addEventListener(name, handler) {
      this._l[name] = handler;
    },
    querySelectorAll(selector) {
      return selector === "[data-solo-action='talk']" ? [talkButton] : [];
    }
  };
  const calls = [];
  const apiClient = {
    async fetchSoloScene() {
      return sampleScene();
    },
    async fetchSoloGmScene() {
      return { ok: true, gmNarration: null, gmStatus: null };
    },
    async postSoloAction(runId, action) {
      calls.push(["action", runId, action]);
      return {
        ok: true,
        talkResult: {
          npcId: "placeholder_npc",
          beatId: "quiet_area",
          found: true,
          speakerName: "Placeholder NPC",
          line: "There is not much to say yet, but the area has been quiet.",
          summary: "Placeholder NPC: Quiet Area",
          revealed: true,
          checkResult: null,
          warningCodes: []
        }
      };
    }
  };

  const mounted = mountSoloSceneShell(root, { apiClient, runId: "run_test" });
  await mounted.reload();
  root._l.click({ target: clickTarget({ "[data-solo-action='talk']": { "data-entity-id": "npc:placeholder_npc" } }) });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, [["action", "run_test", { type: "talk", actorId: "player", targetEntityId: "npc:placeholder_npc" }]]);
  assert.match(root.innerHTML, /Dialogue/);
  assert.match(root.innerHTML, /area has been quiet/);
});

test("render() preserves focus + caret of the action input across a re-render", async () => {
  // Regression: a direct render() (runAction finally / loadScene) rebuilds
  // innerHTML and used to drop focus + caret of whichever text box the player was
  // typing in — the "works for a second then freezes" bug. render() now captures
  // the focused field (by its stable data-attr) and re-focuses it after rebuild.
  const fakeInput = {
    _attrs: { "data-solo-attempt-input": "" },
    selectionStart: 3,
    selectionEnd: 3,
    disabled: false,
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this._attrs, name);
    },
    focusCount: 0,
    focus() {
      this.focusCount += 1;
    },
    rangeCalls: [],
    setSelectionRange(start, end) {
      this.rangeCalls.push([start, end]);
    }
  };
  const root = {
    innerHTML: "",
    contains() {
      return true;
    }, // the focused input counts as inside the shell
    querySelectorAll() {
      return [];
    },
    querySelector(selector) {
      return selector === "[data-solo-attempt-input]" ? fakeInput : null;
    }
  };
  const apiClient = {
    async fetchSoloScene() {
      return sampleScene();
    },
    async fetchSoloGmScene() {
      return { ok: true, gmNarration: null, gmStatus: null };
    }
  };

  const prevDocument = globalThis.document;
  globalThis.document = { activeElement: fakeInput }; // simulate the player typing
  try {
    const mounted = mountSoloSceneShell(root, { apiClient, runId: "run_focus" });
    await mounted.reload(); // loadScene → render() (start + finally) → capture/restore
    assert.ok(fakeInput.focusCount >= 1, "the focused action input is re-focused after the rebuild");
    assert.deepEqual(fakeInput.rangeCalls.at(-1), [3, 3], "the caret position is restored");
  } finally {
    if (prevDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = prevDocument;
    }
  }
});

test("mountSoloSceneShell auto-opens VN for a freeform speaker with the NPC's own line, not GM narration", async () => {
  const root = {
    innerHTML: "",
    querySelectorAll() {
      return [];
    }
  };
  const calls = [];
  const vnScene = () => ({
    ...sampleScene(),
    vnMode: true,
    // The freeform "speak to X" trigger surfaces the RAW npcId on the scene; the
    // GM-driven path can surface a prefixed one. Either must resolve the beat.
    speakerId: "placeholder_npc",
    cast: [{ npcId: "placeholder_npc", displayName: "Placeholder NPC", portraitUri: null }]
  });
  const apiClient = {
    async fetchSoloScene() {
      return vnScene();
    },
    async fetchSoloGmScene() {
      return {
        ok: true,
        gmNarration: {
          narration: { title: "Start", body: "You are Akrij and the neon city settles over you.", tone: "mysterious" }
        },
        gmStatus: null
      };
    },
    async postSoloAction(runId, action) {
      calls.push(action);
      // Mirror the server: the talk pipeline only resolves a beat for the PREFIXED
      // visible entity id. A raw id (the old bug) returns no talkResult, which used
      // to make the overlay fall through to GM narration under a generic "NPC".
      if (action.type === "talk" && action.targetEntityId === "npc:placeholder_npc") {
        return {
          ok: true,
          talkResult: {
            npcId: "placeholder_npc",
            beatId: "quiet_area",
            found: true,
            speakerName: "Placeholder NPC",
            line: "The keeper sizes you up and says her piece.",
            summary: "Placeholder NPC: Quiet Area",
            revealed: true,
            expressionVariants: {},
            warningCodes: []
          }
        };
      }
      return { ok: true };
    }
  };

  const mounted = mountSoloSceneShell(root, { apiClient, runId: "run_test" });
  await mounted.reload();

  // FIX I: the talk pipeline is invoked with the PREFIXED entity id (the raw
  // speakerId is normalized), so the beat actually resolves.
  const talkCall = calls.find((action) => action.type === "talk");
  assert.ok(talkCall, "a talk action was posted for the freeform speaker");
  assert.equal(talkCall.targetEntityId, "npc:placeholder_npc");
  // The overlay opens showing the NPC's NAME (not the generic "NPC")...
  assert.match(root.innerHTML, /data-solo-dialogue-overlay/);
  assert.match(root.innerHTML, /solo-vn-speaker">Placeholder NPC</);
  // ...speaking the NPC's OWN beat line, never the GM opening narration.
  assert.match(root.innerHTML, /data-fulltext="The keeper sizes you up/);
  assert.doesNotMatch(root.innerHTML, /data-fulltext="You are Akrij/);
});

test("VN reply input stays typeable while busy; only the submit button is gated", () => {
  // FIX J: the global busy flag is held by the action that opens the overlay, so
  // gating the text input on it made the box dead on arrival. The input must never
  // be disabled; the submit button keeps the busy state for double-submit feedback.
  const html = renderSoloSceneShell({
    scene: sampleScene(),
    busy: "talk",
    dialogueActive: true,
    talkResult: {
      npcId: "placeholder_npc",
      speakerName: "Placeholder NPC",
      line: "Well? Out with it.",
      found: true,
      expressionVariants: {},
      warningCodes: []
    }
  });
  const inputTag = html.match(/<input[^>]*data-solo-dialogue-reply-input[^>]*>/);
  assert.ok(inputTag, "reply input is rendered");
  assert.doesNotMatch(inputTag[0], /disabled/);
  // Submit button reflects busy so double-sends are visibly guarded.
  assert.match(html, /data-solo-dialogue-reply-submit disabled/);
});

test("mountSoloSceneShell posts rest action and shows rest result", async () => {
  const restButton = {
    handler: null,
    addEventListener(_event, handler) {
      this.handler = handler;
    },
    getAttribute(name) {
      return name === "data-rest-type" ? "short" : "";
    }
  };
  const root = {
    innerHTML: "",
    _l: {},
    addEventListener(name, handler) {
      this._l[name] = handler;
    },
    querySelectorAll(selector) {
      return selector === "[data-solo-action='rest']" ? [restButton] : [];
    }
  };
  const calls = [];
  const apiClient = {
    async fetchSoloScene() {
      return sampleScene();
    },
    async fetchSoloGmScene() {
      return { ok: true, gmNarration: null, gmStatus: null };
    },
    async postSoloAction(runId, action) {
      calls.push(["action", runId, action]);
      return {
        ok: true,
        restResult: {
          locationId: "start_location",
          restType: "short",
          allowed: true,
          safety: "safe",
          timeAdvanced: 1,
          resourcesRecovered: [
            {
              resourceId: "stamina",
              before: 3,
              after: 5,
              amount: 2
            }
          ],
          summary: "You take a moment to recover.",
          warningCodes: []
        }
      };
    }
  };

  const mounted = mountSoloSceneShell(root, { apiClient, runId: "run_test" });
  await mounted.reload();
  root._l.click({ target: clickTarget({ "[data-solo-action='rest']": { "data-rest-type": "short" } }) });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, [["action", "run_test", { type: "rest", actorId: "player", restType: "short" }]]);
  assert.match(root.innerHTML, /Short Rest/);
  assert.match(root.innerHTML, /You take a moment to recover/);
  assert.match(root.innerHTML, /stamina/);
});

test("mountSoloSceneShell posts use_item action and shows item result", async () => {
  const useButton = {
    handler: null,
    addEventListener(_event, handler) {
      this.handler = handler;
    },
    getAttribute(name) {
      return name === "data-item-id" ? "field_ration" : "";
    }
  };
  const root = {
    innerHTML: "",
    _l: {},
    addEventListener(name, handler) {
      this._l[name] = handler;
    },
    querySelectorAll(selector) {
      return selector === "[data-solo-action='use_item']" ? [useButton] : [];
    }
  };
  const calls = [];
  const apiClient = {
    async fetchSoloScene() {
      return sampleScene();
    },
    async fetchSoloGmScene() {
      return { ok: true, gmNarration: null, gmStatus: null };
    },
    async postSoloAction(runId, action) {
      calls.push(["action", runId, action]);
      return {
        ok: true,
        useItemResult: {
          itemId: "field_ration",
          itemName: "Field Ration",
          effectType: "recover_resource",
          used: true,
          consumed: true,
          quantityRemaining: 0,
          resourcesRecovered: [
            {
              resourceId: "stamina",
              before: 3,
              after: 4,
              amount: 1
            }
          ],
          summary: "You use the field ration and recover a little stamina.",
          revealedNote: null,
          warningCodes: []
        }
      };
    }
  };

  const mounted = mountSoloSceneShell(root, { apiClient, runId: "run_test" });
  await mounted.reload();
  root._l.click({ target: clickTarget({ "[data-solo-action='use_item']": { "data-item-id": "field_ration" } }) });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, [["action", "run_test", {
    type: "use_item",
    actorId: "player",
    itemId: "field_ration",
    targetEntityId: null,
    targetLocationId: null
  }]]);
  assert.match(root.innerHTML, /Use Item/);
  assert.match(root.innerHTML, /Field Ration/);
  assert.match(root.innerHTML, /Quantity remaining: 0/);
});

test("renderSoloSceneShell renders inspect details", () => {
  const html = renderSoloSceneShell({
    scene: sampleScene(),
    detail: {
      entity: {
        entityId: "npc:placeholder_npc",
        entityType: "npc",
        displayName: "Placeholder NPC",
        imageAssetId: "npc_image"
      },
      details: {
        title: "Placeholder NPC",
        description: "Structured details only.",
        stats: { trust: 1, fear: 0 },
        relationships: [{ label: "Player", summary: "Known entity" }],
        memoryFacts: [{ type: "meeting", text: "Met in this scene." }],
        tags: ["placeholder"],
        availableActions: [{ type: "inspect" }]
      }
    }
  });
  assert.match(html, /Entity Sheet/);
  assert.match(html, /Structured details only/);
  assert.match(html, /npc_image/);
  assert.match(html, /Stats/);
  assert.match(html, /Relationships/);
  assert.match(html, /Linked Memories/);
  assert.match(html, /Met in this scene/);
  assert.match(html, /selected/);
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

test("renderEntityDetailPanel handles missing memories and relationships gracefully", () => {
  const html = renderEntityDetailPanel({
    entity: {
      entityId: "location:start_location",
      entityType: "location_object",
      displayName: "Start Location",
      summary: "Current location"
    },
    details: {
      title: "Start Location",
      description: "Current location"
    }
  });
  assert.match(html, /No known relationship data yet/);
  assert.match(html, /No linked memories yet/);
  assert.match(html, /No image assigned/);
  assert.doesNotMatch(html, /"entityId"/);
});

test("renderSoloSceneShell handles empty timeline and memory panels", () => {
  const scene = {
    ...sampleScene(),
    recentTimeline: [],
    relevantMemoryFacts: []
  };
  const html = renderSoloSceneShell({ scene });
  assert.match(html, /No recent events yet/);
  assert.match(html, /No linked memories yet/);
});

test("renderSoloSceneShell includes mobile-friendly layout markers", () => {
  const html = renderSoloSceneShell({ scene: sampleScene() });
  assert.match(html, /solo-scene-grid/);
  assert.match(html, /solo-scene-main/);
  assert.match(html, /solo-scene-side/);
});

// #15-full: action handlers are now DELEGATED — dispatchSoloClick(target) walks
// the target via closest(). A fake target matches a set of selectors and carries
// per-selector attributes, so these tests exercise the real dispatch a browser
// click would produce (target.closest(sel) → element.getAttribute(attr)).
function clickTarget(matches = {}) {
  return {
    closest(selector) {
      if (!(selector in matches)) {
        return null;
      }
      const attrs = matches[selector] || {};
      return { getAttribute: (name) => (name in attrs ? attrs[name] : null) };
    }
  };
}

test("dispatchSoloClick: inspectable entity card triggers inspect", () => {
  let inspected = null;
  const handled = dispatchSoloClick(
    clickTarget({ ".solo-entity-card.inspectable": { "data-entity-id": "npc:placeholder_npc" } }),
    { onInspect: (e) => (inspected = e) }
  );
  assert.equal(handled, true);
  assert.deepEqual(inspected, { entityId: "npc:placeholder_npc" });
});

test("dispatchSoloClick: GM mode button requests the mode change", () => {
  const calls = [];
  dispatchSoloClick(clickTarget({ "[data-solo-gm-mode]": { "data-solo-gm-mode": "provider" } }), { onGmMode: (m) => calls.push(m) });
  dispatchSoloClick(clickTarget({ "[data-solo-gm-mode]": { "data-solo-gm-mode": "placeholder" } }), { onGmMode: (m) => calls.push(m) });
  assert.deepEqual(calls, [{ mode: "provider" }, { mode: "placeholder" }]);
});

test("dispatchSoloClick: Search Area triggers search", () => {
  let searched = false;
  dispatchSoloClick(clickTarget({ "[data-solo-action='search']": {} }), { onSearch: () => (searched = true) });
  assert.equal(searched, true);
});

test("dispatchSoloClick: Talk triggers talk with entity + target", () => {
  let talked = null;
  dispatchSoloClick(
    clickTarget({ "[data-solo-action='talk']": { "data-entity-id": "npc:placeholder_npc" } }),
    { onTalk: (e) => (talked = e) }
  );
  assert.deepEqual(talked, { entityId: "npc:placeholder_npc", targetEntityId: "npc:placeholder_npc" });
});

test("dispatchSoloClick: Rest triggers rest with rest type", () => {
  let rested = null;
  dispatchSoloClick(clickTarget({ "[data-solo-action='rest']": { "data-rest-type": "long" } }), { onRest: (a) => (rested = a) });
  assert.deepEqual(rested, { restType: "long" });
});

test("dispatchSoloClick: Use triggers use item", () => {
  let used = null;
  dispatchSoloClick(clickTarget({ "[data-solo-action='use_item']": { "data-item-id": "field_ration" } }), { onUseItem: (a) => (used = a) });
  assert.deepEqual(used, { itemId: "field_ration" });
});

test("dispatchSoloClick: a Talk button INSIDE an inspectable card fires talk, NOT the card's inspect", () => {
  // Both selectors match (the button sits inside the card). The more-specific
  // action must win — this reproduces the old per-button stopPropagation.
  let talked = null;
  let inspected = null;
  dispatchSoloClick(
    clickTarget({
      "[data-solo-action='talk']": { "data-entity-id": "npc:x" },
      ".solo-entity-card.inspectable": { "data-entity-id": "npc:x" }
    }),
    { onTalk: (e) => (talked = e), onInspect: (e) => (inspected = e) }
  );
  assert.deepEqual(talked, { entityId: "npc:x", targetEntityId: "npc:x" });
  assert.equal(inspected, null, "card inspect must NOT also fire");
});

test("dispatchSoloClick: move, tab, bring-back and cog dispatch correctly", () => {
  let moved = null;
  let tabbed = null;
  let broughtBack = null;
  let cog = null;
  dispatchSoloClick(clickTarget({ "[data-solo-action='move']": { "data-location-id": "loc_b", "data-direction": "east" } }), { onMove: (m) => (moved = m) });
  dispatchSoloClick(clickTarget({ "[data-solo-tab]": { "data-solo-tab": "journal" } }), { onTab: (t) => (tabbed = t) });
  dispatchSoloClick(clickTarget({ "[data-solo-npc-bringback]": { "data-entity-id": "npc:y" } }), { onBringBack: (e) => (broughtBack = e) });
  dispatchSoloClick(clickTarget({ "[data-solo-cog]": { "data-solo-cog": "settings" } }), { onCogPlaceholder: (v) => (cog = v) });
  assert.deepEqual(moved, { locationId: "loc_b", direction: "east" });
  assert.deepEqual(tabbed, { tab: "journal" });
  assert.deepEqual(broughtBack, { entityId: "npc:y" });
  assert.equal(cog, "settings");
});

test("dispatchSoloClick returns false for an unrelated target", () => {
  assert.equal(dispatchSoloClick(clickTarget({ ".something-else": {} }), {}), false);
});

test("dispatchSoloKeydown: Enter on an inspectable card triggers inspect", () => {
  let inspected = null;
  let prevented = false;
  const handled = dispatchSoloKeydown(
    { key: "Enter", preventDefault: () => (prevented = true), target: clickTarget({ ".solo-entity-card.inspectable": { "data-entity-id": "npc:z" } }) },
    { onInspect: (e) => (inspected = e) }
  );
  assert.equal(handled, true);
  assert.equal(prevented, true);
  assert.deepEqual(inspected, { entityId: "npc:z" });
});

test("bindSoloSceneShell binds ONE delegated click listener on the stable root", () => {
  const listeners = {};
  let addCount = 0;
  const root = {
    querySelectorAll() {
      return [];
    },
    addEventListener(name, handler) {
      addCount += 1;
      listeners[name] = handler;
    }
  };
  let searched = false;
  bindSoloSceneShell(root, { onSearch: () => (searched = true) });
  // Bound once for click, once for keydown — not per element.
  assert.equal(addCount, 2);
  assert.equal(typeof listeners.click, "function");
  // A delegated click on a search button routes through the single listener.
  listeners.click({ target: clickTarget({ "[data-solo-action='search']": {} }) });
  assert.equal(searched, true);
  // Re-binding on a subsequent full render does NOT add duplicate listeners.
  bindSoloSceneShell(root, { onSearch: () => {} });
  assert.equal(addCount, 2, "delegation is bound exactly once per root");
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

test("createSearchAction builds search action shape", () => {
  assert.deepEqual(createSearchAction(), {
    type: "search",
    actorId: "player"
  });
});

test("createRestAction builds rest action shape", () => {
  assert.deepEqual(createRestAction({ restType: "long" }), {
    type: "rest",
    actorId: "player",
    restType: "long"
  });
});

test("createUseItemAction builds use item action shape", () => {
  assert.deepEqual(createUseItemAction({ itemId: "field_ration" }), {
    type: "use_item",
    actorId: "player",
    itemId: "field_ration",
    targetEntityId: null,
    targetLocationId: null
  });
});

test("createTalkAction builds talk action shape", () => {
  assert.deepEqual(createTalkAction({ entityId: "npc:placeholder_npc" }), {
    type: "talk",
    actorId: "player",
    targetEntityId: "npc:placeholder_npc"
  });
});

test("solo scene API helpers call auth-aware client methods", async () => {
  const calls = [];
  const apiClient = {
    async fetchSoloScene(runId) {
      calls.push(["scene", runId]);
      return { ok: true, runId };
    },
    async fetchSoloGmScene(runId, options) {
      calls.push(["gmScene", runId, options]);
      return { ok: true, runId, gmNarration: {} };
    },
    async postSoloAction(runId, action) {
      calls.push(["action", runId, action]);
      return { ok: true, action };
    }
  };

  assert.deepEqual(await fetchSoloScene(apiClient, "run_test"), { ok: true, runId: "run_test" });
  assert.deepEqual(await fetchSoloGmScene(apiClient, "run_test", { mode: "provider" }), {
    ok: true,
    runId: "run_test",
    gmNarration: {}
  });
  assert.deepEqual(await postSoloAction(apiClient, "run_test", { type: "inspect" }), {
    ok: true,
    action: { type: "inspect" }
  });
  assert.deepEqual(calls, [
    ["scene", "run_test"],
    ["gmScene", "run_test", { mode: "provider" }],
    ["action", "run_test", { type: "inspect" }]
  ]);
});

test("requireRunId rejects missing run id", () => {
  assert.throws(() => requireRunId(""), /Solo run id is required/);
});
