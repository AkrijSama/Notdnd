// STARTER-ZONE ANTI-LOST LAW (owner ruling 2026-07-19). The Waking Mile + the Green
// Static Fringe are HER kept-clear ground: honest paths, orientation never in doubt;
// the shimmer is a BOUNDARY MARKER, not a confusion field. Three layers proven here:
//   (a) DATA — babel.json starter-zone records carry no disorientation vocabulary.
//   (b) DIRECTIVE — the narrator contract gains the anti-lost rule for starter scenes.
//   (c) AUDITOR — the lost-motif check, calibrated against the LIVE run_c50caf3c turns.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isStarterZoneLocation,
  detectStarterZoneLostMotif,
  STARTER_ZONE_TAG
} from "../server/solo/starterZone.js";
import { buildProviderPromptMessages } from "../server/solo/gmProvider.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const babel = JSON.parse(fs.readFileSync(path.join(dir, "../server/campaign/scenarios/babel.json"), "utf8"));

// ── the LIVE run_c50caf3c turns (verbatim), the ground truth for calibration ──
const TURN4 = "You push north toward the town, but the trees shift around you in ways that have nothing to do with wind. The sun stays fixed overhead through gaps that don't match the canopy you just passed. Your sense of direction unravels entirely, the dirt track south is gone behind you, replaced by mossy ground that slopes gently into deeper shadow.";
const TURN3 = "You sweep the fringe one more time. The ground yields nothing it hasn't already shown you: scattered rock, brittle lichen, the faded trace of an old game trail that leads nowhere worth following. The woods thicken into a wall of green and shadow that swallows light.";
const FRINGE = { locationId: "start_location", name: "The Green Static — Fringe", tags: ["modern arcane", "zone", "wilderness"] };
const WAKING = { locationId: "loc_waking_mile", tags: [STARTER_ZONE_TAG] };
const HEART = { locationId: "third_location", tags: ["zone", "deep"] };

// ── (a) DATA ──────────────────────────────────────────────────────────────────
test("DATA: the Green Static Fringe start description carries NO disorientation vocabulary", () => {
  const desc = babel.locations.start_location.description;
  assert.doesNotMatch(desc, /half-beat/i, "no 'half-beat wrong'");
  assert.doesNotMatch(desc, /compass needles/i, "no compass/sun navigation-confusion seed");
  assert.doesNotMatch(desc, /wrong woods/i, "the ground here is not framed as the wrong woods");
  assert.deepEqual(detectStarterZoneLostMotif(desc, FRINGE), [], "no lost-motif hits in the committed description");
  // reframed per the twist: honest ground + the shimmer as a boundary marker
  assert.match(desc, /boundary/i);
  assert.match(desc, /paths are honest|way is easy to read/i);
});

test("DATA: the start location is marked as kept-clear starter zone; the Waking Mile stays correct", () => {
  assert.ok(babel.locations.start_location.tags.includes(STARTER_ZONE_TAG), "start_location tagged poi:start-area");
  assert.ok(babel.locations.loc_waking_mile.tags.includes(STARTER_ZONE_TAG), "waking mile still tagged");
  const wm = babel.locations.loc_waking_mile.description;
  assert.match(wm, /boundary marker/i, "the shimmer is a boundary marker (unchanged, correct)");
  assert.deepEqual(detectStarterZoneLostMotif(wm, WAKING), [], "waking-mile boundary text does NOT flag");
});

test("DATA: the scene-opening template is scrubbed of starter-zone disorientation", () => {
  assert.doesNotMatch(babel.opening.situation, /wrong woods breathe/i, "situation no longer breathes the wrong woods around you");
  assert.doesNotMatch(babel.opening.authoredBeats[0], /half-beat wrong/i, "the waking beat drops 'a half-beat wrong'");
});

// ── (b) DIRECTIVE ───────────────────────────────────────────────────────────────
test("DIRECTIVE: the narrator contract gains the anti-lost rule for starter-zone scenes", () => {
  const inStarter = buildProviderPromptMessages({ runId: "r1", edition: "mainline", location: { locationId: "start_location", name: "Fringe", starterZone: true } });
  const sys = inStarter[0].content;
  assert.match(sys, /STARTER ZONE \(Her kept-clear ground\)/);
  assert.match(sys, /orientation is NEVER in doubt/i);
  assert.match(sys, /BOUNDARY MARKER, not a confusion field/i);
});

test("DIRECTIVE: non-starter scenes do NOT carry the anti-lost rule", () => {
  const beyond = buildProviderPromptMessages({ runId: "r1", edition: "mainline", location: { locationId: "third_location", name: "The Heart", starterZone: false } });
  assert.doesNotMatch(beyond[0].content, /STARTER ZONE \(Her kept-clear ground\)/);
});

// ── (c) AUDITOR — calibrated against the transcript ─────────────────────────────
test("AUDITOR: detection is id-OR-tag (a pre-tag run copy is still caught by id)", () => {
  assert.equal(isStarterZoneLocation(FRINGE), true, "start_location by id, even without the tag");
  assert.equal(isStarterZoneLocation(WAKING), true, "waking mile by tag");
  assert.equal(isStarterZoneLocation(HEART), false, "the Heart (beyond the shimmer) is not starter zone");
  assert.equal(isStarterZoneLocation({}), false);
});

test("AUDITOR: the live last turn FLAGS (true-positive) inside the starter zone", () => {
  const hits = detectStarterZoneLostMotif(TURN4, FRINGE);
  assert.ok(hits.length >= 1, "turn 4 flags");
  const phrases = hits.map((h) => h.phrase.toLowerCase()).join(" | ");
  assert.match(phrases, /sense of direction unravels/);
  assert.match(phrases, /gone behind you/);
  // the two prior turns also carried lost motifs — they flag too
  assert.ok(detectStarterZoneLostMotif(TURN3, FRINGE).length >= 1, "turn 3 (leads nowhere / swallows light) flags");
});

test("AUDITOR: the shimmer-boundary text does NOT flag (marker, not confusion)", () => {
  assert.deepEqual(detectStarterZoneLostMotif(babel.locations.loc_waking_mile.description, WAKING), [], "boundary marker is clean");
  assert.deepEqual(detectStarterZoneLostMotif(babel.locations.start_location.description, FRINGE), [], "corrected Fringe is clean");
});

test("AUDITOR: fires ONLY inside the starter zone (same lost text beyond the shimmer is ignored)", () => {
  assert.deepEqual(detectStarterZoneLostMotif(TURN4, HEART), [], "the Heart is beyond the shimmer — disorientation is allowed there");
  assert.deepEqual(detectStarterZoneLostMotif(TURN4, {}), [], "no location -> no audit");
});
