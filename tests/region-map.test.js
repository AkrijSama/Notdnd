// AFFORDANCES-MAP LAW (Part B) — region-graph read model + knowledge gating.
// See docs/design/affordances-map-law.md.
import assert from "node:assert/strict";
import test from "node:test";
import { buildRegionMapPayload, mapKnowledgeReveals } from "../server/solo/regionMap.js";

function baseRun(overrides = {}) {
  return {
    currentLocationId: "a",
    world: { variant: "babel" },
    memoryFacts: [],
    goals: {},
    locations: {
      a: { locationId: "a", name: "The Fringe", tags: ["wilderness"], state: { visited: true }, connectedLocationIds: ["b", "c"] },
      b: { locationId: "b", name: "Hollow Pine", tags: ["town", "frontier"], state: { visited: false }, connectedLocationIds: ["a", "d"] },
      c: { locationId: "c", name: "The Heart", tags: ["zone", "deep"], state: { visited: false }, connectedLocationIds: ["a"] },
      d: { locationId: "d", name: "Rust Delta", tags: ["ruin"], state: { visited: false }, connectedLocationIds: ["b"] }
    },
    ...overrides
  };
}

const ids = (rm) => rm.nodes.map((n) => n.id).sort();

test("FOG: an unvisited, unrevealed node is HIDDEN — absent from the payload (no spoilers)", () => {
  const rm = buildRegionMapPayload(baseRun());
  assert.deepEqual(ids(rm), ["a"], "only the visited current node is present; b/c/d hidden entirely");
  // The payload never even names a hidden node.
  const blob = JSON.stringify(rm);
  assert.doesNotMatch(blob, /Hollow Pine|Rust Delta|The Heart/, "hidden node names never cross the wire");
  // A spoiler-free unexplored-exit COUNT hints there's more, with no destination.
  assert.equal(rm.nodes[0].unexploredExits, 2, "the current node has two exits to still-hidden nodes");
});

test("EDGES only between included nodes — no edge touches a hidden node", () => {
  const rm = buildRegionMapPayload(baseRun());
  assert.deepEqual(rm.edges, [], "no visible peer yet, so no edge — the a→b/a→c exits stay hidden");
});

test("MAP-KNOWLEDGE reveals: map:node:<id> and map:<region-tag> add nodes with revealedBy", () => {
  const run = baseRun({ memoryFacts: [{ factId: "f1", tags: ["map:node:c", "item"] }, { factId: "f2", tags: ["map:town"] }] });
  const rm = buildRegionMapPayload(run);
  assert.deepEqual(ids(rm), ["a", "b", "c"], "c (by node) and b (by town tag) revealed; d (ruin) stays hidden");
  const byId = Object.fromEntries(rm.nodes.map((n) => [n.id, n]));
  assert.equal(byId.c.revealedBy, "f1", "revealedBy records the map-node fact");
  assert.equal(byId.b.revealedBy, "f2", "revealedBy records the region-tag fact");
  assert.equal(byId.a.revealedBy, null, "a is visited, not map-revealed — revealedBy null");
  // Now edges between the three included nodes surface (a-b, a-c), but nothing to d.
  assert.deepEqual(rm.edges.map((e) => `${e.a}-${e.b}`).sort(), ["a-b", "a-c"]);
});

test("map:all / map:<variant> reveals the whole graph", () => {
  const run = baseRun({ memoryFacts: [{ factId: "atlas", tags: ["map:babel"] }] });
  const rm = buildRegionMapPayload(run);
  assert.deepEqual(ids(rm), ["a", "b", "c", "d"], "the regional map reveals every node");
});

test("RUMORS do NOT reveal — only a map: tag counts (owner ruling)", () => {
  const run = baseRun({ memoryFacts: [{ factId: "r1", tags: ["rumor", "hearsay"], text: "they say a town lies north" }] });
  assert.deepEqual(ids(buildRegionMapPayload(run)), ["a"], "hearsay draws nothing");
  assert.equal(mapKnowledgeReveals(run).size, 0, "no map-knowledge in a rumor");
});

test("VISITED persists across a reload (committed state) even without map-knowledge", () => {
  const run = baseRun();
  run.locations.b.state.visited = true; // player has been to b
  const rm = buildRegionMapPayload(run);
  assert.deepEqual(ids(rm), ["a", "b"], "the visited node stays on the map");
  assert.equal(rm.nodes.find((n) => n.id === "b").visited, true);
});

test("TYPE reuses the layout type-inference table (glyph-able types, never generic)", () => {
  const run = baseRun({ memoryFacts: [{ factId: "atlas", tags: ["map:all"] }] });
  const rm = buildRegionMapPayload(run);
  const byId = Object.fromEntries(rm.nodes.map((n) => [n.id, n.type]));
  assert.equal(byId.b, "town-street", "town tag → town-street");
  assert.equal(byId.d, "ruin", "ruin tag → ruin");
  // Every node carries a concrete template type from the shared table (no null/circle).
  const TEMPLATE_TYPES = new Set(["forest", "clearing", "road", "town-approach", "town-street", "interior", "ruin", "cave"]);
  for (const n of rm.nodes) {
    assert.ok(TEMPLATE_TYPES.has(n.type), `node ${n.id} has a concrete type (${n.type})`);
  }
});

test("REACHABILITY: only exits of the current node are tappable; a revealed-but-distant node is not", () => {
  const run = baseRun({ memoryFacts: [{ factId: "atlas", tags: ["map:all"] }] });
  const rm = buildRegionMapPayload(run);
  const byId = Object.fromEntries(rm.nodes.map((n) => [n.id, n]));
  assert.equal(byId.b.reachable, true, "b is an exit of current a");
  assert.equal(byId.c.reachable, true, "c is an exit of current a");
  assert.equal(byId.d.reachable, false, "d is revealed but not adjacent — known, not travel-able");
  assert.equal(byId.a.reachable, false, "the current node is not a travel target");
});

test("BLOCKED edge where committed; travelTime where committed", () => {
  const run = baseRun({ memoryFacts: [{ factId: "atlas", tags: ["map:all"] }] });
  run.locations.c.flags = { objectStates: { "the-road-watch": { state: "sealed-shut" } } };
  run.locations.c.travelMinutes = 25;
  const rm = buildRegionMapPayload(run);
  const ac = rm.edges.find((e) => e.a === "a" && e.b === "c");
  assert.equal(ac.blocked, true, "a committed sealed passage marks the edge blocked");
  assert.equal(ac.travelTime, 25, "a committed travelMinutes surfaces as the edge label");
  const ab = rm.edges.find((e) => e.a === "a" && e.b === "b");
  assert.ok(!("blocked" in ab), "no block committed on a-b → no blocked flag");
  assert.ok(!("travelTime" in ab), "no travel time committed on a-b → no label");
});

test("GOAL PINS: a committed active goal with a locationId on an included node pins", () => {
  const run = baseRun({
    memoryFacts: [{ factId: "atlas", tags: ["map:all"] }],
    goals: {
      g1: { goalId: "g1", summary: "Reach the timber town", scale: "project", state: "active", locationId: "b" },
      g2: { goalId: "g2", summary: "an ambition with no place", scale: "ambition", state: "active" },
      g3: { goalId: "g3", summary: "achieved", scale: "task", state: "achieved", locationId: "b" }
    }
  });
  const rm = buildRegionMapPayload(run);
  assert.equal(rm.goalPins.length, 1, "only the active, located goal pins");
  assert.equal(rm.goalPins[0].goalId, "g1");
  assert.equal(rm.goalPins[0].locationId, "b");
});

test("null-safe: a run with no locations yields null", () => {
  assert.equal(buildRegionMapPayload({}), null);
  assert.equal(buildRegionMapPayload(null), null);
});
