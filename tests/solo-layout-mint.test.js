import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun, validateSoloRun } from "../server/solo/schema.js";
import {
  detectDirectionHint,
  ensureLocationLayout,
  inferLayoutTemplate,
  loadLayoutTemplates,
  locationBearing,
  mintLocationLayout,
  placeEntities,
  placeMarkers,
  resolveLocationLayout
} from "../server/solo/layout.js";

// Map-layout law (docs/design/map-layout-law.md): layouts are MINTED
// deterministically from the location seed + a type template, committed on
// first need, and every committed fact/entity receives a position.

const NOW = "2026-01-01T00:00:00.000Z";

function makeRun(overrides = {}) {
  const run = createDefaultSoloRun({ now: NOW, worldSeed: overrides.worldSeed || "seed_test_1" });
  return run;
}

function pinTemplate(run, templateId, locationId = run.currentLocationId) {
  run.locations[locationId].layoutTemplate = templateId;
  return run;
}

function cellsOf(layout, kind) {
  return layout.cells.filter((c) => c.kind === kind);
}

// --- determinism -----------------------------------------------------------

test("mint is deterministic: same seed -> identical layout, forever", () => {
  const a = mintLocationLayout(pinTemplate(makeRun(), "forest"), "start_location");
  const b = mintLocationLayout(pinTemplate(makeRun(), "forest"), "start_location");
  assert.deepEqual(a, b, "two mints from the same seed are cell-for-cell identical");
});

test("different world seed -> different layout", () => {
  const a = mintLocationLayout(pinTemplate(makeRun({ worldSeed: "seed_a" }), "forest"), "start_location");
  const b = mintLocationLayout(pinTemplate(makeRun({ worldSeed: "seed_b" }), "forest"), "start_location");
  assert.notDeepEqual(a.cells, b.cells, "a different seed mints a different forest");
});

test("commit-on-first-mint: ensure commits once, is a no-op after, and the run stays valid", () => {
  const run = pinTemplate(makeRun(), "forest");
  const first = ensureLocationLayout(run, "start_location", { now: NOW });
  assert.equal(first.minted, true, "first ensure mints");
  assert.equal(run.locations.start_location.layout, first.layout, "layout committed on the location");
  assert.equal(first.layout.mintedAt, NOW);
  const second = ensureLocationLayout(run, "start_location", { now: "2027-01-01T00:00:00.000Z" });
  assert.equal(second.minted, false, "second ensure is a no-op");
  assert.equal(second.layout, first.layout, "the committed layout is returned, not re-minted");
  assert.equal(validateSoloRun(run).ok, true, "a run carrying a layout validates");
});

test("legacy lazy-mint: resolve on a layout-less run derives the exact layout ensure would commit", () => {
  const legacy = pinTemplate(makeRun(), "forest");
  const derived = resolveLocationLayout(legacy, "start_location");
  const committed = pinTemplate(makeRun(), "forest");
  ensureLocationLayout(committed, "start_location", { now: NOW });
  const { mintedAt: _a, ...derivedRest } = derived;
  const { mintedAt: _b, ...committedRest } = committed.locations.start_location.layout;
  assert.deepEqual(derivedRest, committedRest, "derive == commit (resume-safe by determinism)");
});

// --- template coverage -----------------------------------------------------

test("template coverage: every shipped template mints its common-sense shape", () => {
  const templates = loadLayoutTemplates();
  for (const id of ["forest", "clearing", "road", "town-approach", "town-street", "interior", "ruin", "cave"]) {
    assert.ok(templates[id], `template data ships ${id}`);
  }

  const forest = mintLocationLayout(pinTemplate(makeRun(), "forest"), "start_location");
  assert.ok(cellsOf(forest, "tree").length >= 10, "forest mints scattered trees");
  const centre = forest.anchors.center;
  const treesInClearing = cellsOf(forest, "tree").filter(
    (c) => Math.max(Math.abs(c.x - centre.x), Math.abs(c.y - centre.y)) <= 2
  );
  assert.equal(treesInClearing.length, 0, "the clearing at the center holds no trees");

  const approach = mintLocationLayout(pinTemplate(makeRun(), "town-approach"), "start_location");
  assert.ok(cellsOf(approach, "wall").length >= 6, "town-approach mints a perimeter wall");
  assert.equal(cellsOf(approach, "gate").length, 1, "exactly one gate");
  assert.ok(cellsOf(approach, "road").length >= 3, "a road runs to the gate");

  const interior = mintLocationLayout(pinTemplate(makeRun(), "interior"), "start_location");
  assert.ok(cellsOf(interior, "wall").length >= 20, "interior mints bounding walls");
  assert.ok(cellsOf(interior, "door").length >= 1, "with a door");
  for (const door of cellsOf(interior, "door")) {
    assert.ok(
      door.x === 0 || door.x === interior.width - 1 || door.y === 0 || door.y === interior.height - 1,
      "doors sit in the bounding wall"
    );
  }

  const ruin = mintLocationLayout(pinTemplate(makeRun(), "ruin"), "start_location");
  const ruinPerimeter = 4 * (ruin.width - 2 * 2) - 4; // inset-2 border cell count
  assert.ok(cellsOf(ruin, "wall").length < ruinPerimeter, "ruin walls are broken (gaps fell)");
  assert.ok(cellsOf(ruin, "wall").length + cellsOf(ruin, "rubble").length > 0, "but something still stands");

  const street = mintLocationLayout(pinTemplate(makeRun(), "town-street"), "start_location");
  assert.ok(cellsOf(street, "building").length >= 8, "town-street mints buildings");
  assert.ok(cellsOf(street, "road").length >= 8, "along a street");

  const cave = mintLocationLayout(pinTemplate(makeRun(), "cave"), "start_location");
  assert.ok(cellsOf(cave, "rock").length >= 10, "cave mints rock bounds");
  assert.ok(cellsOf(cave, "water").length >= 1, "with standing water");

  const road = mintLocationLayout(pinTemplate(makeRun(), "road"), "start_location");
  assert.ok(cellsOf(road, "road").length >= 10, "road runs edge to edge");
});

test("the gate faces the approach exit (committed adjacency, not decoration)", () => {
  const run = makeRun();
  run.locations.start_location.layoutTemplate = "town-approach";
  // Make the connected neighbour road-shaped so it is chosen as the approach.
  run.locations.second_location.name = "The Old Coast Road";
  run.locations.second_location.tags = ["road"];
  const side = locationBearing(run.worldSeed, "start_location", "second_location");
  const layout = mintLocationLayout(run, "start_location");
  const gate = layout.cells.find((c) => c.kind === "gate");
  assert.ok(gate, "gate minted");
  assert.equal(layout.anchors.approachSide, side, "approach side derived from committed adjacency");
  // The wall line sits between the approach edge and the far side; the gate is
  // in that wall, on the road's axis — i.e. the gate opening faces the
  // approach edge, with open ground (the road) between them.
  const roadCells = cellsOf(layout, "road");
  const onGateAxis =
    side === "N" || side === "S" ? roadCells.every((c) => c.x === gate.x) : roadCells.every((c) => c.y === gate.y);
  assert.ok(onGateAxis, "the road runs straight from the approach edge to the gate");
});

// --- type inference --------------------------------------------------------

test("inference table: authored pin > world config > tags/name > default", () => {
  const run = makeRun();

  // authored pin wins over everything
  run.locations.start_location.layoutTemplate = "cave";
  run.locations.start_location.tags = ["forest"];
  assert.deepEqual(inferLayoutTemplate(run.locations.start_location, run), { templateId: "cave", via: "authored" });
  delete run.locations.start_location.layoutTemplate;

  // world config (start location only)
  run.world.startingLocationType = "tavern";
  run.locations.start_location.tags = [];
  run.locations.start_location.name = "The Ember";
  assert.deepEqual(inferLayoutTemplate(run.locations.start_location, run), {
    templateId: "interior",
    via: "world-config"
  });
  delete run.world.startingLocationType;

  // tags/name rules, ordered
  const cases = [
    [{ name: "The Ashen Watch Gatehouse", tags: ["gatehouse"] }, "town-approach"],
    [{ name: "Ashenmoor Market Square", tags: ["market"] }, "town-street"],
    [{ name: "The Shattered Flagon", tags: ["tavern"] }, "interior"],
    [{ name: "Mirewood", tags: ["forest", "wild"] }, "forest"],
    [{ name: "The Sunken Crypt", tags: ["ruin"] }, "ruin"],
    [{ name: "Blackmaw Cavern", tags: [] }, "cave"],
    [{ name: "The Old Coast Road", tags: [] }, "road"],
    [{ name: "Hunter's Glade", tags: ["clearing"] }, "clearing"],
    // a ruined temple is a ruin, not an interior (rule order)
    [{ name: "Ruined Temple of Sil", tags: [] }, "ruin"]
  ];
  for (const [loc, expected] of cases) {
    const got = inferLayoutTemplate({ locationId: "x", ...loc }, run);
    assert.equal(got.templateId, expected, `${loc.name} -> ${expected}`);
    assert.equal(got.via, "tags-name");
  }

  // sane default
  assert.deepEqual(inferLayoutTemplate({ locationId: "x", name: "Somewhere", tags: [] }, run), {
    templateId: "clearing",
    via: "default"
  });
});

// --- placement -------------------------------------------------------------

test("committed markers receive positions; a directional hint places the marker on that side", () => {
  const layout = mintLocationLayout(pinTemplate(makeRun(), "forest"), "start_location");
  const positions = placeMarkers(layout, [
    { id: "found-idol", direction: "north" },
    { id: "found-cache", direction: null }
  ]);
  const idol = positions.get("found-idol");
  assert.ok(idol.y <= 2, `"north" places the marker in the top band (got y=${idol.y})`);
  const again = placeMarkers(layout, [
    { id: "found-idol", direction: "north" },
    { id: "found-cache", direction: null }
  ]);
  assert.deepEqual([...positions.entries()], [...again.entries()], "marker placement is deterministic");
});

test("direction hints are detected in narrated discovery sentences", () => {
  assert.equal(detectDirectionHint("A rusted generator sits half-buried to the north."), "north");
  assert.equal(detectDirectionHint("You spot a cache at the southwest corner."), "southwest");
  assert.equal(detectDirectionHint("Something glints westward, past the trees."), "west");
  assert.equal(detectDirectionHint("A strongbox lies under the floorboards."), null);
});

test("entities spread across the layout — no huddle; keeper takes the post; drags still win", () => {
  const layout = mintLocationLayout(pinTemplate(makeRun(), "town-approach"), "start_location");
  const members = [
    { entityId: "player:p1", kind: "player" },
    { entityId: "npc:keeper", kind: "npc", role: "gatekeeper" },
    { entityId: "npc:alpha", kind: "npc", role: "traveler" },
    { entityId: "npc:beta", kind: "npc", role: "pilgrim" }
  ];
  const positions = placeEntities(layout, members);
  const cells = [...positions.values()].map((c) => `${c.x},${c.y}`);
  assert.equal(new Set(cells).size, members.length, "every entity holds a distinct cell");
  const player = positions.get("player:p1");
  const spread = ["npc:alpha", "npc:beta"].map((id) => {
    const c = positions.get(id);
    return Math.max(Math.abs(c.x - player.x), Math.abs(c.y - player.y));
  });
  assert.ok(spread.every((d) => d >= 2), `non-keeper NPCs stand apart from the player (distances ${spread})`);
  const keeper = positions.get("npc:keeper");
  const gate = layout.anchors.gate;
  assert.ok(
    Math.max(Math.abs(keeper.x - gate.x), Math.abs(keeper.y - gate.y)) <= 2,
    "the keeper stands at their post by the gate"
  );

  const dragged = placeEntities(layout, members, new Map([["npc:alpha", { x: 1, y: 1 }]]));
  assert.deepEqual(dragged.get("npc:alpha"), { x: 1, y: 1 }, "a persisted (player-dragged) position wins");
});

test("hand-placed set-piece layouts are adopted verbatim (world-book authorship)", () => {
  const run = makeRun();
  const setPiece = {
    version: 1,
    templateId: "authored",
    seed: "authored",
    width: 12,
    height: 12,
    ground: "stone",
    playerAnchor: "center",
    cells: [{ kind: "wall", x: 5, y: 5, name: "The Tower" }],
    anchors: { center: { x: 6, y: 6 }, posts: [] },
    mintedAt: NOW
  };
  run.locations.start_location.layout = setPiece;
  assert.equal(resolveLocationLayout(run, "start_location"), setPiece, "authored layout is served untouched");
  assert.equal(validateSoloRun(run).ok, true);
});
