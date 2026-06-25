import assert from "node:assert/strict";
import test from "node:test";
import {
  SOLO_MAP_WIDTH,
  SOLO_MAP_HEIGHT,
  SOLO_MAP_TILE_FEET,
  buildSoloMapTokens,
  renderSoloMapTab
} from "../src/components/soloSceneShell.js";

const scene = {
  player: { displayName: "Kael Stormwind", portraitUri: "/data/assets/run_x/player/base.png", speed: 30 },
  cast: [
    { npcId: "npc_1", displayName: "Garrick", present: true, portraitUri: "/data/assets/run_x/npc_1/base.png" },
    { npcId: "npc_2", displayName: "Mira Vale", present: true, portraitUri: "" },
    { npcId: "npc_3", displayName: "Distant Scout", present: false } // absent -> not placed
  ]
};

test("scale constants: 1 tile = 5ft on a 12x10 grid", () => {
  assert.equal(SOLO_MAP_TILE_FEET, 5);
  assert.equal(SOLO_MAP_WIDTH, 12);
  assert.equal(SOLO_MAP_HEIGHT, 10);
});

test("buildSoloMapTokens spawns the player + present NPCs, linked to entities", () => {
  const tokens = buildSoloMapTokens(scene);
  // player + 2 present NPCs (absent NPC excluded)
  assert.equal(tokens.length, 3);

  const player = tokens.find((t) => t.kind === "player");
  assert.ok(player, "player token present");
  assert.equal(player.entityId, "player");
  assert.equal(player.label, "KS"); // Kael Stormwind
  assert.equal(player.speed, 30);

  const garrick = tokens.find((t) => t.entityId === "npc_1");
  assert.ok(garrick && garrick.kind === "npc", "npc_1 token linked");
  assert.equal(garrick.id, "npc:npc_1");
  assert.equal(garrick.label, "GA"); // single-word name -> first two letters

  assert.ok(tokens.some((t) => t.entityId === "npc_2"), "present npc_2 placed");
  assert.ok(!tokens.some((t) => t.entityId === "npc_3"), "absent npc_3 not placed");
});

test("all token positions are in-bounds and unique (no overlap)", () => {
  const tokens = buildSoloMapTokens(scene);
  const seen = new Set();
  for (const t of tokens) {
    assert.ok(t.x >= 0 && t.x < SOLO_MAP_WIDTH, `x in bounds: ${t.x}`);
    assert.ok(t.y >= 0 && t.y < SOLO_MAP_HEIGHT, `y in bounds: ${t.y}`);
    const key = `${t.x},${t.y}`;
    assert.ok(!seen.has(key), `unique cell: ${key}`);
    seen.add(key);
  }
});

test("placement is deterministic", () => {
  assert.deepEqual(buildSoloMapTokens(scene), buildSoloMapTokens(scene));
});

test("crowded field stays in-bounds and collision-free", () => {
  const crowd = {
    player: { displayName: "P" },
    cast: Array.from({ length: 20 }, (_, i) => ({ npcId: `n${i}`, displayName: `N${i}`, present: true }))
  };
  const tokens = buildSoloMapTokens(crowd);
  assert.equal(tokens.length, 21);
  const seen = new Set();
  for (const t of tokens) {
    assert.ok(t.x >= 0 && t.x < SOLO_MAP_WIDTH && t.y >= 0 && t.y < SOLO_MAP_HEIGHT);
    seen.add(`${t.x},${t.y}`);
  }
  assert.equal(seen.size, 21, "no overlaps even when crowded");
});

test("renderSoloMapTab draws the grid, scale label, tokens, and legend", () => {
  const html = renderSoloMapTab(scene);
  // grid cells = width * height
  const cellCount = (html.match(/class="solo-map-cell"/g) || []).length;
  assert.equal(cellCount, SOLO_MAP_WIDTH * SOLO_MAP_HEIGHT);
  assert.match(html, /1 tile = 5 ft/);
  assert.match(html, /12×10 grid/);
  // tokens linked to entities
  assert.match(html, /data-entity-id="player"/);
  assert.match(html, /data-entity-id="npc_1"/);
  assert.match(html, /data-entity-id="npc_2"/);
  assert.doesNotMatch(html, /data-entity-id="npc_3"/);
  // portrait when present, initials when not
  assert.match(html, /src="\/data\/assets\/run_x\/npc_1\/base.png"/);
  assert.match(html, /Garrick/);
});

test("renderSoloMapTab handles an empty scene gracefully", () => {
  const html = renderSoloMapTab({});
  assert.match(html, /No combatants on the field/);
  const cellCount = (html.match(/class="solo-map-cell"/g) || []).length;
  assert.equal(cellCount, SOLO_MAP_WIDTH * SOLO_MAP_HEIGHT);
});
