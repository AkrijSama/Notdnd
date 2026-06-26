import assert from "node:assert/strict";
import test from "node:test";
import {
  SOLO_MAP_WIDTH,
  SOLO_MAP_HEIGHT,
  resolveBattleTokens,
  renderSoloMapTab
} from "../src/components/soloSceneShell.js";

const scene = {
  player: { displayName: "Kael", speed: 30 },
  cast: [{ npcId: "n1", displayName: "Garrick", present: true }]
};

test("resolveBattleTokens overrides default positions with saved ones", () => {
  const { tokens, positionsById } = resolveBattleTokens(scene, {
    positions: { player: { x: 0, y: 0 } }
  });
  const player = tokens.find((t) => t.id === "player");
  assert.equal(player.x, 0);
  assert.equal(player.y, 0);
  assert.deepEqual(positionsById.player, { x: 0, y: 0 });
  // NPC without a saved position keeps its deterministic placement
  assert.ok(positionsById["npc:n1"]);
});

test("selected token renders highlighted with legal move tiles", () => {
  const html = renderSoloMapTab(scene, {
    positions: { player: { x: 5, y: 9 }, "npc:n1": { x: 5, y: 1 } },
    selectedTokenId: "player",
    movedTiles: 0,
    history: []
  });
  assert.match(html, /solo-token-selected/);
  assert.match(html, /class="solo-map-cell legal"/); // at least one reachable tile
  // movement budget surfaced (30ft for the player)
  assert.match(html, /30 ft of movement left/);
});

test("no legal tiles glow when nothing is selected", () => {
  const html = renderSoloMapTab(scene, { positions: {}, selectedTokenId: null });
  assert.doesNotMatch(html, /class="solo-map-cell legal"/);
  assert.doesNotMatch(html, /solo-token-selected/);
  assert.match(html, /Select a token/);
});

test("remaining budget shrinks after partial movement", () => {
  const html = renderSoloMapTab(scene, {
    positions: { player: { x: 5, y: 5 } },
    selectedTokenId: "player",
    movedTiles: 2, // moved 2 tiles -> 4 tiles / 20ft left
    history: [{}]
  });
  assert.match(html, /20 ft of movement left/);
});

test("undo button reflects history state", () => {
  const empty = renderSoloMapTab(scene, { selectedTokenId: "player", history: [] });
  assert.match(empty, /data-map-undo disabled/);
  const withHistory = renderSoloMapTab(scene, {
    positions: { player: { x: 5, y: 4 } },
    selectedTokenId: "player",
    history: [{ tokenId: "player", from: { x: 5, y: 5 }, to: { x: 5, y: 4 }, cost: 1 }]
  });
  assert.doesNotMatch(withHistory, /data-map-undo disabled/);
});

test("board exposes keyboard + drag hooks", () => {
  const html = renderSoloMapTab(scene, { selectedTokenId: "player" });
  assert.match(html, /data-solo-map/); // arrow-key target (tabindex)
  assert.match(html, /tabindex="0"/);
  assert.match(html, /draggable="true"/); // tokens are draggable
  assert.equal(SOLO_MAP_WIDTH, 12);
  assert.equal(SOLO_MAP_HEIGHT, 10);
});
