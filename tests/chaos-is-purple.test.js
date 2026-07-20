// T3 — CHAOS IS PURPLE (sealed law). Violet is the world-wide chaos signature. Per-tier
// violet corruption-marker art fragments ride the chaosling mint (creatures only); the
// sight surface accent is violet; violet NEVER leaks onto a human portrait (the inverse
// gate to the human-only species negatives).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { corruptionMarkers, CHAOS_VIOLET_MARKERS, mintChaosling } from "../server/campaign/bestiary.js";
import { buildPlayerPortraitPrompt } from "../server/solo/imageWorker.js";

test("fragments emit per tier, violet, and SCALE (eyes -> markings -> glow -> aura)", () => {
  for (const tier of [1, 2, 3, 4]) {
    const frag = corruptionMarkers(tier);
    assert.ok(typeof frag === "string" && frag.length > 0, `tier ${tier} emits a fragment`);
    assert.match(frag, /violet/, `tier ${tier} fragment is violet`);
  }
  // scaling: eyes at t1; markings by t2; a glow by t3; an aura at t4
  assert.match(corruptionMarkers(1), /eyes/);
  assert.match(corruptionMarkers(2), /markings/);
  assert.match(corruptionMarkers(3), /glow/);
  assert.match(corruptionMarkers(4), /aura/);
  // tier clamps
  assert.equal(corruptionMarkers(9), CHAOS_VIOLET_MARKERS[4]);
  assert.equal(corruptionMarkers(0), CHAOS_VIOLET_MARKERS[1]);
});

test("the chaosling mint carries the per-tier violet corruption art fragment", () => {
  for (const tier of [1, 2, 3, 4]) {
    const c = mintChaosling("grey_wolf", tier, "seed-x");
    assert.ok(c.corruption, `tier ${tier} mint carries corruption`);
    assert.equal(c.corruption.palette, "violet");
    assert.equal(c.corruption.tier, tier);
    assert.equal(c.corruption.artFragment, corruptionMarkers(tier));
    assert.match(c.corruption.artFragment, /violet/);
  }
});

test("the sight surface accent is violet (CSS var)", () => {
  const styles = fs.readFileSync(path.resolve("src/styles.css"), "utf8");
  assert.match(styles, /--sight-accent:\s*#8b5cf6/i, "the violet sight-accent var is defined");
  assert.match(styles, /\.solo-trace-chip\s*\{[^}]*var\(--sight-accent/s, "the trace chip uses the violet accent");
});

test("NO HUMAN LEAKAGE: a human portrait never carries the violet corruption vocabulary", () => {
  const human = { name: "Kael", pronouns: "he/him", race: "Human", characterClass: "Fighter", gender: "male" };
  for (const style of ["illustrated", "anime", "cinematic"]) {
    const p = buildPlayerPortraitPrompt(human, { tone: "dark fantasy", artStyleOptions: { default: style } }).toLowerCase();
    assert.doesNotMatch(p, /violet corruption/, `${style}: no violet corruption on a human`);
    assert.doesNotMatch(p, /corruption markings|corruption aura|corruption veins/, `${style}: no chaosling markers on a human`);
  }
  // structural gate: the fragment source is the CREATURE mint only (never a human path).
  const src = fs.readFileSync(path.resolve("server/campaign/bestiary.js"), "utf8");
  assert.match(src, /corruptionMarkers/, "the marker source lives in the bestiary (creature) module");
});
