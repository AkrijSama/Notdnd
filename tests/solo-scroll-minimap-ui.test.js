import assert from "node:assert/strict";
import test from "node:test";
import { renderSoloSceneShell, renderSoloPresenceMap } from "../src/components/soloSceneShell.js";

// Track B — scroll preservation/anchoring + minimap feature render. These are
// STRUCTURAL regression guards (the painted-DOM behaviour is verified separately
// in a headless linkedom render); they lock the invariants the fixes depend on.

function sampleScene(extra = {}) {
  return {
    ok: true,
    runId: "run_test",
    location: { locationId: "start_location", name: "The Pale Ruins", description: "Cold stone.", state: {}, tags: [], contentTags: [] },
    locationImageUri: "/data/assets/run_test/location_start/base.png",
    visibleEntities: [],
    availableActions: [{ type: "search", enabled: true }],
    availableMoves: [],
    recentTimeline: [],
    quests: {},
    player: { displayName: "Vesh", resources: { hitPoints: { current: 8, max: 10 } } },
    ...extra
  };
}

// ── TASK 1: the "GM is thinking" banner is inside the scroll container and ABOVE
// the input bar, so anchoring on the live turn keeps the banner + input in view. ──
test("scroll: GM-thinking banner renders inside the scroll container, above the input", () => {
  const html = renderSoloSceneShell({ scene: sampleScene(), gmThinking: true });
  assert.match(html, /solo-thinking/);
  assert.match(html, /GM is thinking/);
  const idxContent = html.indexOf("solo-game-content");
  const idxBanner = html.indexOf("solo-thinking");
  const idxInput = html.indexOf("solo-scene-input");
  assert.ok(idxContent !== -1 && idxBanner !== -1 && idxInput !== -1, "all three regions render");
  assert.ok(idxContent < idxBanner, "banner is inside the scroll container");
  assert.ok(idxBanner < idxInput, "banner precedes the input bar (anchoring keeps both visible)");
});

test("scroll: a settled scene drops the thinking banner (no stale indicator)", () => {
  const html = renderSoloSceneShell({ scene: sampleScene() });
  assert.doesNotMatch(html, /solo-thinking/);
  assert.match(html, /solo-scene-input/, "the input bar remains as the live-turn anchor");
});

// ── TASK 2: the presence minimap draws state-placed features, honestly. ──────────
test("minimap: state-placed features paint as markers with their real names/positions", () => {
  const features = [
    { kind: "exit", x: 11, y: 6, name: "Path to Mournhold Market" },
    { kind: "ruins", x: 8, y: 8, name: "Collapsed Watchtower" },
    { kind: "loot", x: 3, y: 9, name: "Half-buried cache" }
  ];
  const html = renderSoloPresenceMap({
    location: { name: "The Pale Ruins" },
    player: { displayName: "Vesh" },
    battleMap: { width: 12, height: 12, tokens: [{ kind: "player", entityId: "player:p", x: 6, y: 6 }], features }
  });
  assert.equal((html.match(/solo-presence-feature/g) || []).length, 3, "all 3 features paint");
  assert.match(html, /solo-feature-exit/);
  assert.match(html, /solo-feature-ruins/);
  assert.match(html, /solo-feature-loot/);
  assert.match(html, /Path to Mournhold Market/, "feature carries its real name");
  assert.match(html, /grid-column:12/, "feature placed at its state x (11 -> column 12)");
  assert.match(html, /solo-presence-token/, "the player token still renders");
});

test("minimap: HONEST to state — no features in state paints zero markers (none invented)", () => {
  const html = renderSoloPresenceMap({
    location: { name: "The Pale Ruins" },
    player: { displayName: "Vesh" },
    battleMap: { width: 12, height: 12, tokens: [{ kind: "player", entityId: "player:p", x: 6, y: 6 }] }
  });
  assert.doesNotMatch(html, /solo-presence-feature/);
  assert.match(html, /solo-presence-token/, "the map otherwise renders unchanged (player token present)");
});

test("minimap: malformed features (missing x/y) are skipped, not placed at 0,0", () => {
  const html = renderSoloPresenceMap({
    location: { name: "The Pale Ruins" },
    player: { displayName: "Vesh" },
    battleMap: {
      width: 12, height: 12,
      tokens: [{ kind: "player", entityId: "player:p", x: 6, y: 6 }],
      features: [{ kind: "exit", name: "no coords" }, { kind: "poi", x: 5, y: 5, name: "Real Landmark" }]
    }
  });
  assert.equal((html.match(/solo-presence-feature/g) || []).length, 1, "only the well-formed feature paints");
  assert.match(html, /Real Landmark/);
});
