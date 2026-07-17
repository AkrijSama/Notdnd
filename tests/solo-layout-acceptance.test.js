import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun } from "../server/solo/schema.js";
import { buildBattleMapPayload } from "../server/solo/scene.js";
import { ensureLocationLayout, buildLayoutDirective } from "../server/solo/layout.js";
import { auditAndCommitFoundObjects } from "../server/solo/npcCommit.js";
import { renderSoloPresenceMap } from "../src/components/soloSceneShell.js";

// Map-layout law FOUNDING ACCEPTANCE — the owner's exact complaints, verified
// end to end (mint -> payload -> rendered DOM string):
//   (a) a forest location mints trees + a clearing, visible on the map
//   (b) a town-approach location mints a wall with the gate facing the road
//   (c) three cast NPCs render at distinct sensible positions, NOT a huddle
//   (d) same run re-opened -> identical layout (determinism)
//   (e) a committed found-object appears as a marker where committed

const NOW = "2026-01-01T00:00:00.000Z";

function makeRun(worldSeed = "seed_acceptance") {
  return createDefaultSoloRun({ now: NOW, worldSeed });
}

function sceneFor(run) {
  return {
    battleMap: buildBattleMapPayload(run),
    location: run.locations[run.currentLocationId],
    player: { displayName: "Wanderer" },
    cast: [],
    visibleEntities: []
  };
}

test("(a) a forest location mints trees and a clearing, visible on the map", () => {
  const run = makeRun();
  run.locations.start_location.layoutTemplate = "forest";
  const bm = buildBattleMapPayload(run);
  const trees = bm.terrain.filter((c) => c.kind === "tree");
  assert.ok(trees.length >= 10, `the forest holds real trees (got ${trees.length})`);
  const html = renderSoloPresenceMap(sceneFor(run));
  const drawn = (html.match(/solo-terrainfeat-tree/g) || []).length;
  assert.equal(drawn, trees.length, "every committed tree is drawn — no more, no less");
  assert.match(html, /terrain-forest/, "the ground reads as forest");
  // The clearing: the 5x5 block around the center holds no trees.
  const centreTrees = trees.filter((c) => Math.max(Math.abs(c.x - 6), Math.abs(c.y - 6)) <= 2);
  assert.equal(centreTrees.length, 0, "the clearing at the center is open ground");
});

test("(b) a town approached by road mints a wall with the gate facing the approach", () => {
  const run = makeRun();
  run.locations.start_location.layoutTemplate = "town-approach";
  run.locations.second_location.name = "The Old Coast Road";
  run.locations.second_location.tags = ["road"];
  const bm = buildBattleMapPayload(run);
  const walls = bm.terrain.filter((c) => c.kind === "wall");
  const gates = bm.terrain.filter((c) => c.kind === "gate");
  assert.ok(walls.length >= 6, "a perimeter wall stands");
  assert.equal(gates.length, 1, "with exactly one gate");
  const road = bm.terrain.filter((c) => c.kind === "road");
  assert.ok(
    road.every((c) => c.x === gates[0].x) || road.every((c) => c.y === gates[0].y),
    "the road runs straight to the gate — the gate faces the approach"
  );
  const html = renderSoloPresenceMap(sceneFor(run));
  assert.match(html, /solo-terrainfeat-gate/, "the gate is drawn");
  assert.match(html, /solo-terrainfeat-wall/, "the wall is drawn");
  assert.match(html, /title="the gate"/, "the gate is named on hover");
});

test("(c) three cast NPCs render at distinct sensible positions — not a huddle around the player", () => {
  const run = makeRun();
  run.locations.start_location.layoutTemplate = "town-approach";
  run.npcs = {
    npc_hale: { npcId: "npc_hale", displayName: "Hale", role: "gatekeeper", currentLocationId: "start_location", known: true, status: "alive", memoryFactIds: [], tags: [], flags: {} },
    npc_mara: { npcId: "npc_mara", displayName: "Mara", role: "traveler", currentLocationId: "start_location", known: true, status: "alive", memoryFactIds: [], tags: [], flags: {} },
    npc_fenn: { npcId: "npc_fenn", displayName: "Fenn", role: "pilgrim", currentLocationId: "start_location", known: true, status: "alive", memoryFactIds: [], tags: [], flags: {} }
  };
  const bm = buildBattleMapPayload(run);
  assert.equal(bm.tokens.length, 4, "player + three NPCs");
  const seen = new Set(bm.tokens.map((t) => `${t.x},${t.y}`));
  assert.equal(seen.size, 4, "all four stand on distinct cells");
  const player = bm.tokens.find((t) => t.kind === "player");
  const nonKeeperDistances = bm.tokens
    .filter((t) => t.kind === "npc" && t.entityId !== "npc:npc_hale")
    .map((t) => Math.max(Math.abs(t.x - player.x), Math.abs(t.y - player.y)));
  assert.ok(
    nonKeeperDistances.every((d) => d >= 2),
    `NPCs hold their own ground, not the player's pocket (distances ${nonKeeperDistances})`
  );
  const html = renderSoloPresenceMap({ ...sceneFor(run), cast: [
    { npcId: "npc_hale", displayName: "Hale" },
    { npcId: "npc_mara", displayName: "Mara" },
    { npcId: "npc_fenn", displayName: "Fenn" }
  ] });
  for (const name of ["Hale", "Mara", "Fenn"]) {
    assert.match(html, new RegExp(`aria-label="${name}"`), `${name} renders on the map`);
  }
});

test("(d) same run re-opened -> identical layout (determinism + commit)", () => {
  const run = makeRun();
  run.locations.start_location.layoutTemplate = "forest";
  const before = buildBattleMapPayload(run); // pure derive (legacy view)
  ensureLocationLayout(run, "start_location", { now: NOW }); // the commit
  const after = buildBattleMapPayload(run); // committed view
  assert.deepEqual(after, before, "derive == commit — reopening the run redraws the same map");
  const reopened = makeRun(); // same world seed = the same persisted world
  reopened.locations.start_location.layoutTemplate = "forest";
  assert.deepEqual(buildBattleMapPayload(reopened), before, "a fresh load of the same run is identical");
});

test("(e) a committed found-object appears as a marker where committed (direction honored)", () => {
  const run = makeRun();
  run.locations.start_location.layoutTemplate = "forest";
  const committed = auditAndCommitFoundObjects(
    run,
    "You push through the bracken. You uncover a rusted strongbox half-buried to the north, its casing split."
  );
  assert.equal(committed.length, 1, "the found-object auditor committed the discovery");
  const objectState = Object.values(run.locations.start_location.flags.objectStates)[0];
  assert.equal(objectState.direction, "north", "the directional hint is committed with the object");
  const bm = buildBattleMapPayload(run);
  const marker = bm.features.find((f) => f.name === objectState.label);
  assert.ok(marker, "the committed discovery is a map marker");
  assert.ok(marker.y <= 2, `and it sits to the north, where it was narrated (y=${marker.y})`);
  const html = renderSoloPresenceMap(sceneFor(run));
  assert.match(html, new RegExp(`title="${objectState.label}"`), "the marker renders with its committed name");
});

test("the narrator receives the committed geometry as prompt facts", () => {
  const run = makeRun();
  run.locations.start_location.layoutTemplate = "town-approach";
  run.locations.start_location.name = "The Ember Gate";
  const directive = buildLayoutDirective(run);
  assert.match(directive, /SCENE GEOMETRY \(committed map of The Ember Gate\)/);
  assert.match(directive, /the gate to the (north|south|east|west)/, "the gate rides with its committed side");
  assert.match(directive, /never contradict these positions/, "with the no-invention contract");
});
