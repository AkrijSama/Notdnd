import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VISION_TILES,
  visibleFrom,
  computeRevealed
} from "../src/components/battleMapEngine.js";
import { renderSoloMapTab } from "../src/components/soloSceneShell.js";

test("visibleFrom is a circular radius, in-bounds", () => {
  // radius 1 -> plus shape (diagonals are distance sqrt(2) > 1)
  const r1 = visibleFrom(10, 10, 5, 5, 1);
  assert.deepEqual([...r1].sort(), ["4,5", "5,4", "5,5", "5,6", "6,5"].sort());
  // clamped at the corner
  const corner = visibleFrom(10, 10, 0, 0, 1);
  assert.deepEqual([...corner].sort(), ["0,0", "0,1", "1,0"].sort());
});

test("computeRevealed unions viewers and defaults the radius", () => {
  const revealed = computeRevealed(20, 20, [
    { x: 2, y: 2, radius: 1 },
    { x: 10, y: 10, radius: 1 }
  ]);
  assert.ok(revealed.has("2,2") && revealed.has("10,10"));
  assert.ok(revealed.has("2,3") && revealed.has("10,9"));
  assert.ok(!revealed.has("6,6"), "gap between viewers stays hidden");

  // undefined radius falls back to the default vision
  const def = computeRevealed(40, 40, [{ x: 20, y: 20 }]);
  assert.ok(def.has(`${20 + DEFAULT_VISION_TILES},20`), "default vision reaches its edge");
});

test("renderSoloMapTab fogs unexplored cells and hides tokens in fog", () => {
  const scene = {
    player: { displayName: "Kael", speed: 30 },
    cast: [{ npcId: "n1", displayName: "Garrick", present: true }]
  };
  // Player bottom-centre (6,9); NPC far at top (1,1) -> fogged/hidden.
  const html = renderSoloMapTab(scene, {
    positions: { player: { x: 6, y: 9 }, "npc:n1": { x: 1, y: 1 } },
    revealed: []
  });
  assert.match(html, /solo-map-cell fogged/); // fog is rendered
  assert.match(html, /data-entity-id="player"/); // player reveals around itself
  assert.doesNotMatch(html, /data-entity-id="npc:n1"|data-entity-id="n1"/); // NPC hidden in fog
});

test("explored (revealed) cells un-fog and surface tokens there", () => {
  const scene = {
    player: { displayName: "Kael", speed: 30 },
    cast: [{ npcId: "n1", displayName: "Garrick", present: true }]
  };
  const html = renderSoloMapTab(scene, {
    positions: { player: { x: 6, y: 9 }, "npc:n1": { x: 1, y: 1 } },
    revealed: ["1,1", "0,0", "0,1", "1,0", "2,1", "1,2"] // explored the NPC's corner
  });
  assert.match(html, /data-entity-id="n1"/); // now visible
});
