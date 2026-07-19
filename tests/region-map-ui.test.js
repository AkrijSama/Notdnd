// AFFORDANCES-MAP LAW (Part B) — client: region render, zoom toggle, tap→intent.
// String-based per the shell test idiom.
import assert from "node:assert/strict";
import test from "node:test";
import {
  renderSoloRegionMap,
  renderSoloMapToggle,
  renderSoloMapSurface,
  renderSoloStageHud,
  renderSoloMapDrawer,
  dispatchSoloClick
} from "../src/components/soloSceneShell.js";

function regionScene() {
  return {
    scene: {
      location: { name: "The Fringe" },
      regionMap: {
        current: "a",
        nodes: [
          { id: "a", name: "The Fringe", type: "forest", visited: true, isCurrent: true, reachable: false, unexploredExits: 1, hazard: "storm-breaking" },
          { id: "b", name: "Hollow Pine", type: "town-street", visited: false, revealedBy: "f2", isCurrent: false, reachable: true, unexploredExits: 1, hazard: null },
          { id: "c", name: "The Heart", type: "cave", visited: false, revealedBy: "f1", isCurrent: false, reachable: true, unexploredExits: 0, hazard: null }
        ],
        edges: [{ a: "a", b: "b", travelTime: 25 }, { a: "a", b: "c", blocked: true }],
        goalPins: [{ goalId: "g1", locationId: "b", summary: "Reach the town", scale: "project" }]
      }
    }
  };
}

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

test("TYPE GLYPH mapping: each node renders its type glyph, never a generic circle", () => {
  const html = renderSoloRegionMap(regionScene().scene);
  assert.ok(html.includes("♣"), "forest glyph");
  assert.ok(html.includes("⌂"), "town-street glyph");
  assert.ok(html.includes("◗"), "cave glyph");
  assert.match(html, /solo-region-type-forest/);
  assert.match(html, /solo-region-type-cave/);
});

test("position marker, goal pin, hazard tint, travel-time label, blocked edge all render from committed data", () => {
  const html = renderSoloRegionMap(regionScene().scene);
  assert.match(html, /solo-region-here/, "current-position marker");
  assert.ok(html.includes("◎"), "goal pin on the located goal's node");
  assert.match(html, /is-hazard/, "hazard tint on the storm node");
  assert.ok(html.includes("25m"), "committed edge travel-time label");
  assert.match(html, /solo-region-edge is-blocked/, "blocked edge rendered");
  assert.ok(html.includes("⋯"), "frayed unexplored-exit stub");
});

test("TAP→INTENT: a reachable node carries the move affordance; current/unreachable do not", () => {
  const html = renderSoloRegionMap(regionScene().scene);
  assert.match(html, /data-solo-action="move" data-location-id="b"/, "reachable node b is a travel target");
  assert.match(html, /data-solo-action="move" data-location-id="c"/, "reachable node c is a travel target");
  assert.doesNotMatch(html, /data-location-id="a"/, "the current node a is never a travel target");
});

test("TAP→INTENT: dispatchSoloClick routes a node tap through onMove (exits-equivalent)", () => {
  let moved = null;
  const handled = dispatchSoloClick(
    clickTarget({ "[data-solo-action='move']": { "data-location-id": "b", "data-direction": null } }),
    { onMove: (m) => { moved = m; } }
  );
  assert.equal(handled, true);
  assert.equal(moved.locationId, "b", "the node tap fires the same onMove path as an exit");
});

test("hidden geography never reaches the client render (no spoiler names/ids)", () => {
  const html = renderSoloRegionMap(regionScene().scene);
  // The payload only carries revealed nodes; the render can't leak what it isn't given.
  assert.doesNotMatch(html, /Rust Delta/);
});

test("empty region (no mapped ground) shows an honest empty state", () => {
  assert.match(renderSoloRegionMap({ regionMap: { current: "a", nodes: [], edges: [], goalPins: [] } }), /No mapped ground/);
  assert.match(renderSoloRegionMap({}), /No mapped ground/);
});

test("ZOOM TOGGLE: local is the default active view", () => {
  const t = renderSoloMapToggle("local");
  assert.match(t, /data-solo-map-view="local" aria-pressed="true"/);
  assert.match(t, /data-solo-map-view="region" aria-pressed="false"/);
});

test("map surface: default (local) shows the floor plan, NOT the region graph", () => {
  const local = renderSoloMapSurface(regionScene().scene, "local");
  assert.doesNotMatch(local, /solo-region-svg/, "local view has no region SVG");
  assert.match(local, /solo-map-toggle/, "toggle present");
  const region = renderSoloMapSurface(regionScene().scene, "region");
  assert.match(region, /solo-region-svg/, "region view draws the graph");
});

test("the map HUD widget carries the toggle; the map drawer defaults to LOCAL", () => {
  // No right column (owner 2026-07-19): the map floats as a HUD widget over the
  // banner (local/region toggle) and expands into the map drawer.
  const hud = renderSoloStageHud(regionScene().scene, { mapView: undefined });
  assert.match(hud, /solo-map-toggle/, "the zoom toggle is on the HUD map widget");
  assert.match(hud, /data-solo-scene-map/, "the widget expands into the map drawer");
  const drawer = renderSoloMapDrawer(regionScene().scene, { mapView: undefined });
  assert.doesNotMatch(drawer, /solo-region-svg/, "the map opens on the local floor plan by default");
});

test("dispatchSoloClick maps the toggle button to onMapView", () => {
  let view = null;
  const handled = dispatchSoloClick(
    clickTarget({ "[data-solo-map-view]": { "data-solo-map-view": "region" } }),
    { onMapView: ({ view: v }) => { view = v; } }
  );
  assert.equal(handled, true);
  assert.equal(view, "region");
});
