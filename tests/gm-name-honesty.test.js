// ITEM 10 — GM-INPUT NAME HONESTY (knowledge-honesty law). buildGmSceneInput must
// never hand the model a location's PROPER NAME the run has not earned. When a run is
// in scope it routes the name through displayLocationName: an un-granted location shows
// its DESCRIPTOR, and only a real name-grant (told / entered) reveals the proper name.
import test from "node:test";
import assert from "node:assert/strict";
import { buildGmSceneInput } from "../server/solo/gm.js";
import { grantLocationName } from "../server/solo/locationNaming.js";

// A minimal-but-valid scene payload carrying the RAW proper name — proving the gate is
// enforced by buildGmSceneInput itself, not merely relayed from a pre-gated payload.
function payloadWith(location) {
  return { ok: true, runId: "run_name_honesty", location };
}
const LOC = {
  locationId: "loc_waking_mile",
  name: "The Waking Mile", // the PROPER name the player has not been told
  descriptor: "a worn dirt track", // the honest stand-in
  description: "A track winds off through wet ferns.",
  state: {},
  tags: [],
  contentTags: []
};

test("un-granted location: the GM input carries the descriptor, not the proper name", () => {
  const run = { runId: "run_name_honesty", knownLocationNames: [] };
  const input = buildGmSceneInput(payloadWith({ ...LOC, state: {} }), { run });
  assert.equal(input.ok, true, "input builds");
  assert.equal(input.location.name, "a worn dirt track", "un-granted → descriptor");
  assert.notEqual(input.location.name, "The Waking Mile", "the proper name never crosses the wire");
});

test("after a name-grant: the GM input carries the proper name", () => {
  const run = { runId: "run_name_honesty", knownLocationNames: [] };
  assert.equal(grantLocationName(run, "loc_waking_mile"), true, "grant is newly recorded");
  const input = buildGmSceneInput(payloadWith({ ...LOC, state: {} }), { run });
  assert.equal(input.location.name, "The Waking Mile", "granted → the proper name");
});

test("entering the place (state.visited) also earns the name", () => {
  const run = { runId: "run_name_honesty", knownLocationNames: [] };
  const input = buildGmSceneInput(payloadWith({ ...LOC, state: { visited: true } }), { run });
  assert.equal(input.location.name, "The Waking Mile", "standing in a place tells you its name");
});

test("no run in scope: the payload's already-resolved (honest) name passes through unchanged", () => {
  // Production always builds the payload via buildSoloScenePayload.locationPayload, which
  // already made the name honest; with no run buildGmSceneInput must not regress it.
  const input = buildGmSceneInput(payloadWith({ ...LOC, name: "a worn dirt track", state: {} }), {});
  assert.equal(input.location.name, "a worn dirt track", "passthrough keeps the honest name");
});

test("run may also arrive on the scene payload itself", () => {
  const run = { runId: "run_name_honesty", knownLocationNames: [] };
  const input = buildGmSceneInput({ ...payloadWith({ ...LOC, state: {} }), run }, {});
  assert.equal(input.location.name, "a worn dirt track", "scenePayload.run gates the name too");
});
