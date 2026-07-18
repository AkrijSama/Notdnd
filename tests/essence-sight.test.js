// ESSENCE-SIGHT v1 — the protagonist's defining trait made playable
// (docs/worlds/babel/verdance-region-v1.md §regional-law-5). Proves the founding
// cases from canon: committed server-owned traces, world-clock strength decay,
// the Warm House bright-trail hunt + Follow-the-trail, St. Brigid's aged trail,
// the Tithing Mill chalk handler-scent, the player-only sight surface (zero leak
// to NPC/OOC), fire-time minting on spawn beats, and the narrator never-invents
// contract. Server logic only; ZERO OpenRouter calls.

import test from "node:test";
import assert from "node:assert/strict";

import { createDefaultSoloRun, validateSoloRun } from "../server/solo/schema.js";
import { loadScenarioIntoRun, loadScenarioFile } from "../server/campaign/scenarioLoader.js";
import { loadThreadsFromJson, advanceThreads } from "../server/solo/threads.js";
import { deriveAffordances } from "../server/solo/affordances.js";
import { detectMoveIntent } from "../server/solo/movement.js";
import { resolveSoloAction } from "../server/solo/actions.js";
import { buildRegionMapPayload } from "../server/solo/regionMap.js";
import { buildSoloScenePayload } from "../server/solo/scene.js";
import { buildOocGroundingContext } from "../server/gm/oocGrounding.js";
import { buildActionGmMessage } from "../server/gm/actionNarration.js";
import {
  ensureEssenceTraces,
  getEssenceTraces,
  makeTrace,
  upsertTrace,
  deriveTraceStrength,
  tracesAtLocation,
  buildSightPayload,
  followableTrailsAtCurrent,
  trailFollowTargetAtCurrent,
  mintTraceFromSpawn,
  buildEssenceTraceDirective,
  auditNarratedEssenceTraces,
  TRACE_STRENGTH_BANDS
} from "../server/solo/essence.js";

const T = (n) => new Date(1730000000000 + n * 1000).toISOString();

function babelRun() {
  const run = createDefaultSoloRun({ now: T(0) });
  run.campaignId = "cmp_test";
  loadScenarioIntoRun(run, loadScenarioFile("babel"), {});
  return run;
}

// ── SCHEMA + PERSISTENCE (additive, resume-safe) ──────────────────────────────
test("essence: a fresh run carries an empty essenceTraces; a legacy run (no field) stays valid", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  assert.deepEqual(run.essenceTraces, []);
  assert.equal(validateSoloRun(run).ok, true);
  delete run.essenceTraces; // legacy save predates the field
  assert.equal(validateSoloRun(run).ok, true, "absent field is valid (resume-safe)");
  assert.deepEqual(ensureEssenceTraces(run), [], "normalizer backfills []");
});

test("essence: a malformed trace fails validation (id/kind/locationId required)", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  run.essenceTraces = [{ kind: "nope", locationId: "start_location" }]; // no id, bad kind
  assert.equal(validateSoloRun(run).ok, false);
  run.essenceTraces = [makeTrace({ id: "t1", kind: "trail", source: "x", locationId: "start_location", path: ["second_location"], bornMinutes: 0 })];
  assert.equal(validateSoloRun(run).ok, true);
});

// ── (e) STRENGTH DECAYS AS THE WORLD CLOCK ADVANCES (deterministic) ───────────
test("essence: trail strength decays deterministically with world-clock age (Law 6 tunable table)", () => {
  const trace = makeTrace({ id: "t1", kind: "trail", source: "x", locationId: "l", path: [], bornMinutes: 1000 });
  // Bands are read against a nowMinutes; same age → same band, every time.
  assert.equal(deriveTraceStrength(trace, 1000), "bright"); // age 0
  assert.equal(deriveTraceStrength(trace, 1000 + 12 * 60), "bright"); // exactly 12h, still bright
  assert.equal(deriveTraceStrength(trace, 1000 + 12 * 60 + 1), "clear"); // just past → clear
  assert.equal(deriveTraceStrength(trace, 1000 + 3 * 1440), "clear");
  assert.equal(deriveTraceStrength(trace, 1000 + 3 * 1440 + 1), "faint");
  assert.equal(deriveTraceStrength(trace, 1000 + 14 * 1440), "faint");
  assert.equal(deriveTraceStrength(trace, 1000 + 14 * 1440 + 1), "cold");
  // Deterministic repeat.
  assert.equal(deriveTraceStrength(trace, 1000 + 100000), deriveTraceStrength(trace, 1000 + 100000));
  // Table is a tunable ordered set of bands, not a hardcode at the call site.
  assert.deepEqual(TRACE_STRENGTH_BANDS.map((b) => b.band), ["bright", "clear", "faint", "cold"]);
});

test("essence: STANDING traces (portal residue) never fade regardless of clock", () => {
  const residue = makeTrace({ id: "r1", kind: "residue", source: "portal", locationId: "l", standing: true, bornMinutes: 0 });
  assert.equal(deriveTraceStrength(residue, 0), "bright");
  assert.equal(deriveTraceStrength(residue, 999999), "bright", "guardians never leave — residue stays strong");
});

test("essence: the sight surface decays as the run's world clock advances (end-to-end)", () => {
  const run = babelRun();
  run.currentLocationId = "loc_warm_house";
  const bandNow = () => buildSightPayload(run).traces[0].band;
  assert.equal(bandNow(), "bright", "the fresh Warm House trail reads bright at run-start");
  run.world.time.minutes += 13 * 60; // +13h
  assert.equal(bandNow(), "clear");
  run.world.time.minutes += 4 * 1440; // well past 3d total
  assert.equal(bandNow(), "faint");
  run.world.time.minutes += 20 * 1440;
  assert.equal(bandNow(), "cold");
});

// ── LOADER SEEDING: the four Verdance POI rows ────────────────────────────────
test("essence: the Verdance loader seeds the four founding traces from POI rows", () => {
  const run = babelRun();
  assert.equal(validateSoloRun(run).ok, true);
  const at = (loc) => {
    run.currentLocationId = loc;
    return buildSightPayload(run).traces;
  };
  // (a) Warm House — fresh outbound trail toward the mill, bright + followable.
  const warm = at("loc_warm_house");
  assert.equal(warm.length, 1);
  assert.equal(warm[0].kind, "trail");
  assert.equal(warm[0].band, "bright");
  assert.equal(warm[0].followable, true);
  assert.equal(warm[0].targetLocationId, "loc_tithing_mill");
  // (b) St. Brigid's — OLD outbound trail, aged into faint (age derivation).
  const brigid = at("loc_st_brigids");
  assert.equal(brigid[0].kind, "trail");
  assert.equal(brigid[0].band, "faint");
  assert.equal(brigid[0].targetLocationId, "loc_old_rapture");
  // (c) Tithing Mill — chalk MARK carrying a handler-scent, readable at the site.
  const mill = at("loc_tithing_mill");
  assert.equal(mill[0].kind, "mark");
  assert.match(mill[0].meta.handlerScent, /oil-and-ash|marked the doorposts/i);
  // Cold Door — portal RESIDUE, standing-strong.
  const cold = at("loc_cold_door");
  assert.equal(cold[0].kind, "residue");
  assert.equal(cold[0].band, "bright");
});

// ── (a) THE WARM HOUSE HUNT: sight + affordance + follow commits the move ─────
test("essence (a): Warm House shows a bright trail + 'Follow the trail' affordance; following advances to the committed destination", () => {
  const run = babelRun();
  run.currentLocationId = "loc_warm_house";
  run.locations.loc_warm_house.state.visited = true;

  // sight payload carries the bright trail
  const scene = buildSoloScenePayload(run);
  assert.equal(scene.sight.traces[0].band, "bright");
  assert.equal(scene.sight.followable, true);

  // the affordance chip appears (source: sight)
  const chip = deriveAffordances(run).find((a) => a.source === "sight");
  assert.ok(chip, "Follow-the-trail chip present");
  assert.match(chip.label, /Follow the trail — bright/i);

  // following the trail routes through the normal move pipeline and COMMITS
  const res = resolveSoloAction(run, { type: "attempt", actorId: "player", intent: chip.intent }, { now: T(1) });
  assert.equal(res.ok, true);
  assert.equal(res.action.type, "move");
  assert.equal(res.run.currentLocationId, "loc_tithing_mill", "tracked along the committed edge");
});

test("essence: the trail branch resolves the committed next node even when UNDISCOVERED (track by sight)", () => {
  const run = babelRun();
  run.currentLocationId = "loc_warm_house";
  // loc_tithing_mill is undiscovered — name-matching could not find it, but sight can.
  assert.notEqual(run.locations.loc_tithing_mill.state?.discovered, true);
  const d = detectMoveIntent(run, "I follow the essence trail my sight reads.");
  assert.equal(d.reachable, true);
  assert.equal(d.toLocationId, "loc_tithing_mill");
  assert.equal(d.viaTrail, true);
});

test("essence: no committed trail here → the follow phrase never commits a false arrival", () => {
  const run = babelRun();
  run.currentLocationId = "loc_elkwater_crossing";
  run.locations.loc_elkwater_crossing.state.visited = true;
  assert.equal(followableTrailsAtCurrent(run).length, 0);
  assert.ok(!deriveAffordances(run).some((a) => a.source === "sight"), "no trail chip where no trail");
  assert.equal(detectMoveIntent(run, "I follow the essence trail my sight reads."), null, "falls through, no move");
  const res = resolveSoloAction(run, { type: "attempt", actorId: "player", intent: "I follow the essence trail my sight reads." }, { now: T(1) });
  assert.equal(res.run.currentLocationId, "loc_elkwater_crossing", "position unchanged");
});

// ── (d) PLAYER-ONLY: zero trace data on any NPC / OOC surface ─────────────────
test("essence (d): NPC payloads and OOC grounding contain ZERO trace data", () => {
  const run = babelRun();
  run.currentLocationId = "loc_tithing_mill"; // the mark with a handler-scent
  run.locations.loc_tithing_mill.state.visited = true;
  const scene = buildSoloScenePayload(run);
  assert.ok(scene.sight.traces.length > 0, "the player DOES perceive the trace");

  const leak = /handlerScent|handler-scent|essenceTrace|essence trail|oil-and-ash|sightReveal/i;
  assert.equal(leak.test(JSON.stringify(scene.cast || [])), false, "cast roster is clean");
  assert.equal(leak.test(JSON.stringify(scene.visibleEntities || [])), false, "visible entities are clean");
  assert.equal(leak.test(buildOocGroundingContext(run)), false, "OOC grounding carries no trace data");
});

// ── FIRE-TIME MINTING: a spawn beat mints an outbound trail (regional law 2) ──
test("essence: a demon/rapture-spawning beat mints an outbound trail at fire time; idempotent", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  const front = {
    frontId: "thread_spawn", kind: "danger", origin: "worldgen", title: "Spawn", agenda: "x",
    revealState: "hidden", groundedIn: { locationRefs: ["start"] }, clock: { minTurnsBetweenBeats: 1 },
    beats: [{
      beatId: "b0", label: "rapture", reveal: "rumored", brief: "A rapture.", decision: "?",
      trigger: { descriptive: { onPlayerAt: "start" } },
      payload: { fact: { text: "A rapture at {place}." }, spawn: { kind: "rapture", trailTo: "second_location", source: "test_rapture" } }
    }],
    resolution: [{ kind: "beat_final", outcome: "resolved" }]
  };
  loadThreadsFromJson(run, [front], {});
  assert.equal(getEssenceTraces(run).length, 0);
  const fired = advanceThreads(run, {}, { now: T(1) });
  assert.equal(fired.fired, true);
  assert.equal(run.essenceTraces.length, 1);
  const trace = run.essenceTraces[0];
  assert.equal(trace.kind, "trail");
  assert.equal(trace.locationId, "start_location");
  assert.deepEqual(trace.path, ["second_location"]);
  assert.equal(trace.bornMinutes, run.world.time.minutes, "born at the committed world clock");
  // Re-firing the same committed beat never duplicates (deterministic id).
  advanceThreads(run, {}, { now: T(2) });
  assert.equal(run.essenceTraces.length, 1, "idempotent by deterministic id");
});

test("essence: mintTraceFromSpawn never invents an edge — it drifts along a committed exit only", () => {
  const run = babelRun();
  // trailTo a NON-adjacent node is refused; falls back to a real committed exit.
  const t = mintTraceFromSpawn(run, { kind: "rapture", trailTo: "loc_her_clearing", source: "x" }, { id: "s1", locationId: "loc_warm_house", nowMinutes: 500 });
  assert.ok(t);
  assert.ok(run.locations.loc_warm_house.connectedLocationIds.includes(t.path[0]), "path[0] is a committed edge");
  assert.notEqual(t.path[0], "loc_her_clearing", "the non-adjacent target was refused");
});

// ── NARRATOR CONTRACT: sight-facts, perception register, never-invents ───────
test("essence: committed traces ride the prompt as sight-facts with the perception register", () => {
  const run = babelRun();
  run.currentLocationId = "loc_tithing_mill";
  const directive = buildEssenceTraceDirective(run);
  assert.match(directive, /SIGHT-FACTS/);
  assert.match(directive, /handler-scent/i);
  assert.match(directive, /ONLY the champion perceives/i, "player-only perception register");
  assert.match(directive, /never invent/i);

  // A quiet scene still bans invention (the WINDOW shows none).
  run.currentLocationId = "loc_elkwater_crossing";
  assert.match(buildEssenceTraceDirective(run), /reads NO essence trace here/i);
});

test("essence: the narrator never-invents auditor strips an invented trace where none is committed, keeps a described one", () => {
  const run = babelRun();
  // trace-less location: an invented essence trail is stripped
  run.currentLocationId = "loc_elkwater_crossing";
  const invented = "You reach the market. A fresh essence trail glows across the cobbles, leading north. Ruth waves.";
  const a1 = auditNarratedEssenceTraces(run, invented);
  assert.equal(a1.stripped.length, 1);
  assert.ok(!/essence trail/i.test(a1.text), "the invention is stripped");
  assert.match(a1.text, /Ruth waves/, "the rest of the prose survives");

  // trace-bearing location: describing the committed trail is KEPT verbatim
  run.currentLocationId = "loc_warm_house";
  const described = "The essence trail leads out the back door, still bright.";
  const a2 = auditNarratedEssenceTraces(run, described);
  assert.equal(a2.stripped.length, 0);
  assert.equal(a2.text, described);

  // false-positive guard: a literal footpath is not an essence trace
  run.currentLocationId = "loc_elkwater_crossing";
  assert.equal(auditNarratedEssenceTraces(run, "The trail winds up toward the ford.").stripped.length, 0);
});

test("essence: the anti-withheld UNDISCOVERED LAW rides the action-narration style contract", () => {
  const run = babelRun();
  // Any action-narration message carries styleSuffix; use the gated branch (a
  // deterministic string) to read the shipped style contract.
  const msg = buildActionGmMessage(run, { action: { type: "attempt" }, attemptResult: { gated: true, intent: "open the sealed door" } });
  assert.match(msg, /UNDISCOVERED LAW/);
  assert.match(msg, /unavailable, locked, sealed-off/i);
  assert.match(msg, /simply UNDISCOVERED, not withheld/i);
});

// ── REGION MAP: sight silhouette + trail edge glow (fog-safe) ─────────────────
test("essence: a followable trail reveals a fog-safe SILHOUETTE next node + a banded trail edge", () => {
  const run = babelRun();
  run.currentLocationId = "loc_warm_house";
  run.locations.loc_warm_house.state.visited = true;
  const region = buildRegionMapPayload(run);
  const sil = region.nodes.find((n) => n.sightReveal);
  assert.ok(sil, "the next node is revealed as a silhouette");
  assert.equal(sil.id, "loc_tithing_mill");
  assert.equal(sil.sightReveal, "bright");
  assert.equal(sil.name, "", "fog-safe: the place-name never crosses the wire");
  assert.equal(sil.type, null, "fog-safe: no template/kind leaks");
  const edge = region.edges.find((e) => e.trail);
  assert.ok(edge, "the trail edge glows");
  assert.equal(edge.trail, "bright");
});

test("essence: with no committed trail, the region map is unchanged (no silhouettes, no glow)", () => {
  const run = createDefaultSoloRun({ now: T(0) });
  const region = buildRegionMapPayload(run);
  assert.ok(!region.nodes.some((n) => n.sightReveal));
  assert.ok(!region.edges.some((e) => e.trail));
});
