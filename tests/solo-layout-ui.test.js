import test from "node:test";
import assert from "node:assert/strict";

import { renderSoloPresenceMap } from "../src/components/soloSceneShell.js";

// Map-layout law, render side: the map draws ONLY the committed layout riding
// scene.battleMap (terrain/ground/markers/tokens) — it never decorates.
// String-based like the other src/ tests (no jsdom).

function sceneWith(battleMap) {
  return {
    battleMap,
    location: { name: "The Ember Gate", tags: [] },
    player: { displayName: "Wanderer" },
    cast: [],
    visibleEntities: []
  };
}

const BASE = {
  width: 12,
  height: 12,
  tokens: [{ entityId: "player:p", kind: "player", x: 6, y: 11 }],
  features: []
};

test("committed terrain cells draw with kind classes at their committed grid position", () => {
  const html = renderSoloPresenceMap(
    sceneWith({
      ...BASE,
      ground: "forest",
      terrain: [
        { kind: "tree", x: 2, y: 3 },
        { kind: "wall", x: 4, y: 5 },
        { kind: "gate", x: 6, y: 5, name: "the gate" }
      ]
    })
  );
  assert.match(html, /solo-terrainfeat-tree" style="grid-column:3;grid-row:4;"/, "tree at its committed cell");
  assert.match(html, /solo-terrainfeat-wall" style="grid-column:5;grid-row:6;"/, "wall at its committed cell");
  assert.match(html, /solo-terrainfeat-gate[^>]*title="the gate"/, "named structures carry their name");
  assert.match(html, /♣/, "tree glyph");
  assert.match(html, /█/, "wall glyph");
});

test("committed ground kind wins over the legacy name/tag guess", () => {
  const html = renderSoloPresenceMap(sceneWith({ ...BASE, ground: "forest", terrain: [] }));
  assert.match(html, /solo-presence-grid terrain-forest/, "ground:forest -> forest skin, name regex not consulted");
  const stone = renderSoloPresenceMap(sceneWith({ ...BASE, ground: "stone", terrain: [] }));
  assert.match(stone, /solo-presence-grid terrain-stone/);
});

test("terrain draws beneath markers and tokens (layer order in the DOM)", () => {
  const html = renderSoloPresenceMap(
    sceneWith({
      ...BASE,
      terrain: [{ kind: "tree", x: 1, y: 1 }],
      features: [{ kind: "loot", x: 2, y: 2, name: "A Cache" }]
    })
  );
  const terrainAt = html.indexOf("solo-terrainfeat-tree");
  const featureAt = html.indexOf("solo-presence-feature");
  const tokenAt = html.indexOf("solo-presence-token");
  assert.ok(terrainAt !== -1 && featureAt !== -1 && tokenAt !== -1);
  assert.ok(terrainAt < featureAt && featureAt < tokenAt, "terrain, then markers, then tokens");
});

test("named terrain (the gate, exits) joins the legend beside marker features", () => {
  const html = renderSoloPresenceMap(
    sceneWith({
      ...BASE,
      terrain: [
        { kind: "gate", x: 6, y: 5, name: "the gate" },
        { kind: "exit", x: 11, y: 6, name: "The Old Coast Road" }
      ],
      features: [{ kind: "loot", x: 2, y: 2, name: "A Cache" }]
    })
  );
  const legend = html.slice(html.indexOf("solo-presence-legend"));
  for (const name of ["the gate", "The Old Coast Road", "A Cache"]) {
    assert.ok(legend.includes(name), `legend names ${name}`);
  }
});

test("HONEST to state: no committed terrain -> no terrain cells drawn (legacy payloads unchanged)", () => {
  const html = renderSoloPresenceMap(sceneWith({ ...BASE }));
  assert.doesNotMatch(html, /solo-terrainfeat-/, "nothing invented");
  assert.match(html, /solo-presence-token/, "tokens still render");
});
