// B3 — GEOMETRY AUDITOR. Flags narration that invents structure the committed minted
// layout doesn't have; guards figurative language. Calibrated per template.
import test from "node:test";
import assert from "node:assert/strict";
import { detectGeometryContradiction } from "../server/solo/geometryAudit.js";

// A run whose current location commits a given layout template.
function runWith(template) {
  return {
    currentLocationId: "loc_x",
    worldSeed: "seed",
    locations: { loc_x: { locationId: "loc_x", name: "Here", layoutTemplate: template, connectedLocationIds: [], tags: [], state: {}, flags: {} } }
  };
}
const flags = (text, run) => detectGeometryContradiction(text, run).map((h) => h.kind).sort();

test("open template (forest): a built door / gate / stone wall / pond are all invented geometry", () => {
  const run = runWith("forest");
  assert.deepEqual(flags("You push through the door into the next room.", run), ["door"]);
  assert.deepEqual(flags("The gate creaks open ahead.", run), ["gate"]);
  assert.deepEqual(flags("You put your back to the stone walls.", run), ["wall"]);
  assert.deepEqual(flags("A pond glints in the hollow.", run), ["water"]);
});

test("interior template HAS a door + walls: those claims do NOT flag; a gate still does", () => {
  const run = runWith("interior");
  assert.deepEqual(flags("You open the door and step through.", run), [], "interior commits a door");
  assert.deepEqual(flags("The plaster walls of the room press close.", run), [], "interior commits walls");
  assert.deepEqual(flags("A gate bars the way.", run), ["gate"], "interior has no gate");
});

test("cave template HAS rock + water: stone walls + a pond do NOT flag", () => {
  const run = runWith("cave");
  assert.deepEqual(flags("Stone walls sweat around you and a dark pool spreads at your feet.", run), [], "cave commits rock (walls) + water (pool)");
});

test("FIGURATIVE language never flags (the starterZone-precedent guard)", () => {
  const run = runWith("forest");
  assert.deepEqual(flags("A wall of rain sweeps the clearing.", run), [], "wall of rain is weather");
  assert.deepEqual(flags("This could be your door to freedom.", run), [], "door to freedom is a metaphor");
  assert.deepEqual(flags("You stand at death's door, bleeding.", run), [], "death's door is idiom");
  assert.deepEqual(flags("Walls of green close in — the canopy thickens.", run), [], "walls of green is figurative");
});

test("clean narration on an open template does not flag; no location = no audit", () => {
  const run = runWith("clearing");
  assert.deepEqual(flags("Soft light falls across the moss. A game trail runs plainly north.", run), []);
  assert.deepEqual(detectGeometryContradiction("a door to the north", {}), [], "no current location → no audit");
  assert.deepEqual(detectGeometryContradiction("", run), [], "empty narration → clean");
});
