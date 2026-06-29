import assert from "node:assert/strict";
import test from "node:test";
import {
  renderSoloPresenceMap,
  renderSoloAreaMap
} from "../src/components/soloSceneShell.js";
import { buildAreaMapPayload } from "../server/solo/scene.js";

// ---------------------------------------------------------------------------
// Part 1: the presence/battle map must render terrain + grid BENEATH the tokens
// (no more black void of floating tokens).
// ---------------------------------------------------------------------------

const presenceScene = {
  location: { name: "Hollow Ruins", tags: ["ruins", "stone"] },
  battleMap: {
    width: 12,
    height: 12,
    tokens: [
      { entityId: "player:player", kind: "player", x: 6, y: 6 },
      { entityId: "npc:npc_hale", kind: "npc", x: 7, y: 6 }
    ]
  }
};

test("presence map renders a terrain+grid layer beneath the tokens", () => {
  const html = renderSoloPresenceMap(presenceScene);
  // One background cell per grid coordinate (12x12 = 144) — the readable ground.
  const cells = (html.match(/class="solo-presence-cell"/g) || []).length;
  assert.equal(cells, 144, "a terrain cell exists for every grid coordinate");
  // Terrain skin chosen from the location (ruins -> stone/ruins floor, not void).
  assert.match(html, /solo-presence-grid terrain-ruins/);
  // Tokens still render on top.
  assert.match(html, /solo-token-player/);
  assert.match(html, /solo-token-npc/);
});

test("presence terrain is deterministic and location-aware", () => {
  assert.equal(renderSoloPresenceMap(presenceScene), renderSoloPresenceMap(presenceScene));
  const forest = renderSoloPresenceMap({
    location: { name: "Whispering Wood", tags: ["forest"] },
    battleMap: { width: 6, height: 6, tokens: [{ entityId: "player:player", kind: "player", x: 3, y: 3 }] }
  });
  assert.match(forest, /terrain-forest/);
});

test("presence map still shows the empty state when there are no tokens", () => {
  const html = renderSoloPresenceMap({ location: { name: "Nowhere" }, battleMap: { tokens: [] } });
  assert.doesNotMatch(html, /solo-presence-cell/);
  assert.match(html, /hasn't taken shape/);
});

// ---------------------------------------------------------------------------
// Part 2: procedural local-area map + persistent discovered-POI memory.
// ---------------------------------------------------------------------------

function runWith(locations, { currentLocationId = "start_location", worldSeed = "seed_abc" } = {}) {
  return { runId: "run_1", worldSeed, currentLocationId, locations };
}

const baseLocations = {
  start_location: { locationId: "start_location", name: "The Ruins", tags: ["ruins"], state: { discovered: true } },
  forest_glade: { locationId: "forest_glade", name: "Forest Glade", tags: ["forest"], state: { discovered: true, visited: true } },
  hidden_shrine: { locationId: "hidden_shrine", name: "Hidden Shrine", tags: ["temple"], state: {} }
};

test("area map emits home base + discovered POIs and fogs the undiscovered", () => {
  const payload = buildAreaMapPayload(runWith(baseLocations));
  assert.equal(payload.scale, "local");
  assert.equal(payload.homeLocationId, "start_location");
  const ids = payload.pois.map((p) => p.locationId).sort();
  assert.deepEqual(ids, ["forest_glade", "start_location"]);
  assert.equal(payload.undiscoveredCount, 1, "the undiscovered shrine stays fogged");
  const home = payload.pois.find((p) => p.locationId === "start_location");
  assert.equal(home.isHome, true);
  assert.equal(home.kind, "home");
  // Home anchors the centre of the 16x16 area grid.
  assert.equal(home.x, 8);
  assert.equal(home.y, 8);
});

test("POI positions are deterministic, in-bounds, and collision-free (remembered layout)", () => {
  const a = buildAreaMapPayload(runWith(baseLocations));
  const b = buildAreaMapPayload(runWith(baseLocations));
  assert.deepEqual(a.pois, b.pois, "same run lays the area out identically (persisted-position-free)");
  const seen = new Set();
  for (const poi of a.pois) {
    assert.ok(poi.x >= 0 && poi.x < a.width && poi.y >= 0 && poi.y < a.height, "in bounds");
    const key = `${poi.x},${poi.y}`;
    assert.ok(!seen.has(key), `no two POIs stack: ${key}`);
    seen.add(key);
  }
});

test("discovering a place persists it into the remembered map (rides location.state.discovered)", () => {
  // Before: the shrine is undiscovered -> fogged (not a POI).
  const before = buildAreaMapPayload(runWith(baseLocations));
  assert.ok(!before.pois.some((p) => p.locationId === "hidden_shrine"));

  // Simulate movement.applyMove flipping the persisted discovered flag.
  const discoveredRun = runWith({
    ...baseLocations,
    hidden_shrine: { ...baseLocations.hidden_shrine, state: { discovered: true, visited: true } }
  });
  const after = buildAreaMapPayload(discoveredRun);
  const shrine = after.pois.find((p) => p.locationId === "hidden_shrine");
  assert.ok(shrine, "once discovered, the shrine is remembered on the map");
  assert.equal(after.undiscoveredCount, 0);

  // And its remembered position is stable across reloads (same seed+id).
  const reloaded = buildAreaMapPayload(discoveredRun);
  const shrine2 = reloaded.pois.find((p) => p.locationId === "hidden_shrine");
  assert.deepEqual({ x: shrine.x, y: shrine.y }, { x: shrine2.x, y: shrine2.y });
});

test("renderSoloAreaMap draws the home base, current marker, and fog footer", () => {
  const payload = buildAreaMapPayload(runWith(baseLocations));
  const html = renderSoloAreaMap({ areaMap: payload });
  assert.match(html, /solo-area-poi[^"]*is-home/);
  assert.match(html, /solo-area-poi[^"]*is-current/);
  assert.match(html, /The Ruins/);
  assert.match(html, /Forest Glade/);
  assert.match(html, /still hidden in the fog/);
  // Undiscovered shrine never leaks its name into the markup.
  assert.doesNotMatch(html, /Hidden Shrine/);
});

test("renderSoloAreaMap handles a scene with no charted places", () => {
  const html = renderSoloAreaMap({ areaMap: { scale: "local", width: 16, height: 16, pois: [], undiscoveredCount: 0 } });
  assert.match(html, /explore to chart the area/);
});
