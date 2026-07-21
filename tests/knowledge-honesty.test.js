import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { buildSoloScenePayload } from "../server/solo/scene.js";
import {
  displayLocationName,
  isLocationNameKnown,
  grantLocationName,
  locationDescriptor
} from "../server/solo/locationNaming.js";

// U2 — KNOWLEDGE HONESTY. The player "knew" the Waking Mile's name without being
// told: the opening marks it DISCOVERED (a known route) but no sign / NPC / VOICE
// ever spoke its name, yet the scene surfaced the proper name anyway. The gate:
// a location's proper name shows ONLY once granted (entering / sign / NPC / VOICE /
// map); until then the surface shows a DESCRIPTOR.

// A told-of-but-unnamed road: discovered (you know a path leads there) but NOT
// visited and with no explicit name grant.
function toldOfRoad() {
  return {
    locationId: "loc_waking_mile",
    name: "The Waking Mile",
    description: "A worn track kept calm by Her.",
    connectedLocationIds: ["start_location"],
    state: { visited: false, discovered: true },
    memoryFactIds: [],
    tags: ["poi:start-area"],
    layoutTemplate: "road",
    flags: {}
  };
}

test("U2: an un-granted (told-of, unvisited) location shows its DESCRIPTOR, not its name", () => {
  const run = createDefaultSoloRun({ runId: "run_kh_1" });
  const loc = toldOfRoad();
  assert.equal(isLocationNameKnown(run, loc), false, "discovered-but-unnamed is NOT name-known");
  const shown = displayLocationName(run, loc);
  assert.ok(!/waking mile/i.test(shown), "the proper name is withheld until granted");
  assert.equal(shown, locationDescriptor(loc), "it renders the location's descriptor");
  assert.match(shown, /track/i, "the road descriptor reads as a worn track");
});

test("U2: after an explicit name-grant (sign / NPC / VOICE), the PROPER name shows", () => {
  const run = createDefaultSoloRun({ runId: "run_kh_2" });
  const loc = toldOfRoad();
  assert.equal(grantLocationName(run, "loc_waking_mile"), true, "first grant is newly recorded");
  assert.equal(grantLocationName(run, "loc_waking_mile"), false, "the grant is idempotent");
  assert.ok(Array.isArray(run.knownLocationNames) && run.knownLocationNames.includes("loc_waking_mile"));
  assert.equal(isLocationNameKnown(run, loc), true);
  assert.equal(displayLocationName(run, loc), "The Waking Mile", "the granted proper name now surfaces");
});

test("U2: ENTERING (state.visited) is itself a name-grant", () => {
  const run = createDefaultSoloRun({ runId: "run_kh_3" });
  const loc = toldOfRoad();
  loc.state.visited = true; // the player has stood here — movement commits this on arrival
  assert.equal(isLocationNameKnown(run, loc), true, "having been here means knowing where you are");
  assert.equal(displayLocationName(run, loc), "The Waking Mile");
});

test("U2: an authored descriptor overrides the derived one; unknown-template falls back", () => {
  assert.equal(locationDescriptor({ locationId: "x", name: "Secret Vale", descriptor: "a shadowed hollow" }), "a shadowed hollow");
  assert.equal(locationDescriptor({ locationId: "x", name: "Nowhere", tags: [] }), "an unfamiliar place");
  assert.match(locationDescriptor({ locationId: "x", name: "X", tags: ["forest", "grove"] }), /forest/i);
});

test("U2 (scene wiring): the scene payload withholds an un-granted current-location name", () => {
  const run = createDefaultSoloRun({ runId: "run_kh_scene" });
  const here = run.locations[run.currentLocationId];
  here.name = "The Hidden Vale";
  here.layoutTemplate = "clearing";
  // Simulate a current location the player has NOT been told the name of.
  here.state = { ...here.state, visited: false, discovered: true };

  const before = buildSoloScenePayload(run);
  assert.equal(before.ok, true, "scene payload built");
  assert.ok(!/hidden vale/i.test(before.location.name), "the proper name is withheld in the scene payload");
  assert.equal(before.location.nameKnown, false);
  assert.match(before.location.name, /clearing/i, "the descriptor surfaces instead");

  // Grant the name (a sign / the VOICE names it) and rebuild — now it shows.
  grantLocationName(run, run.currentLocationId);
  const after = buildSoloScenePayload(run);
  assert.equal(after.location.name, "The Hidden Vale");
  assert.equal(after.location.nameKnown, true);
});

test("U2: a visited current location keeps showing its proper name (no regression)", () => {
  // The default start_location is visited:true — its name must still surface.
  const run = createDefaultSoloRun({ runId: "run_kh_default" });
  const payload = buildSoloScenePayload(run);
  assert.equal(payload.location.name, "Start Location");
  assert.equal(payload.location.nameKnown, true);
});
