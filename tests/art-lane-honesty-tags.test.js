// HONESTY TAGS on the art-style cards (owner ruling 2026-07-20). Each lane carries an
// honest maturity flag so a first-timer doesn't grade the game on an untuned lane:
//   "polished" — owner-validated (kitchen sealed): anime + realistic(cinematic)
//   "early"    — pending kitchen: dark-fantasy(illustrated)
// The canonical flag lives in artStyle.LANE_MATURITY; the client cards mirror it
// (engine-keyed). This test pins the values, the drift between the two, and the render.
import assert from "node:assert/strict";
import test from "node:test";
import { LANE_MATURITY, laneMaturity, toCanonicalStyle } from "../server/solo/artStyle.js";
import { ART_STYLE_OPTIONS, renderOnboardingFlow } from "../src/components/onboardingFlow.js";

test("LANE_MATURITY: anime + realistic are polished; dark-fantasy is early", () => {
  assert.equal(LANE_MATURITY.anime, "polished");
  assert.equal(LANE_MATURITY.realistic, "polished");
  assert.equal(LANE_MATURITY["dark-fantasy"], "early");
});

test("laneMaturity accepts either vocab and defaults unknown → early (never over-promise)", () => {
  assert.equal(laneMaturity("anime"), "polished");
  assert.equal(laneMaturity("cinematic"), "polished", "engine 'cinematic' → realistic → polished");
  assert.equal(laneMaturity("illustrated"), "early", "engine 'illustrated' → dark-fantasy → early");
  assert.equal(laneMaturity("realistic"), "polished");
  assert.equal(laneMaturity("nonsense"), "early", "unknown lane → early, never falsely polished");
  assert.equal(laneMaturity(""), "early");
});

test("drift guard: every style card's tier matches the canonical LANE_MATURITY", () => {
  for (const opt of ART_STYLE_OPTIONS) {
    const canonical = toCanonicalStyle(opt.id);
    assert.ok(canonical, `card '${opt.id}' maps to a canonical style`);
    assert.equal(opt.tier, LANE_MATURITY[canonical], `card '${opt.id}' tier matches canonical maturity`);
  }
  // and the specific owner ruling, spelled out on the engine ids:
  const byId = Object.fromEntries(ART_STYLE_OPTIONS.map((o) => [o.id, o.tier]));
  assert.equal(byId.anime, "polished");
  assert.equal(byId.cinematic, "polished");
  assert.equal(byId.illustrated, "early");
});

test("the picker renders honest tags: Polished on validated lanes, Early + a warning on DF", () => {
  // ready-made Identity-step picker (required) carries the tags
  const html = renderOnboardingFlow({ step: "character", worldDef: { scenarioId: "babel" }, character: { step: 1 } });
  assert.match(html, /onb-art-tag-polished"[^>]*>Polished</, "a Polished tag renders");
  assert.match(html, /onb-art-tag-early"[^>]*>Early</, "an Early tag renders");
  // the DF/illustrated card warns first-timers rather than letting a rough render set the tone
  assert.match(html, /Still tuning this lane/, "the early lane carries a plain-language warning");
  // exactly the two validated lanes are polished, exactly one is early (3 cards total)
  assert.equal((html.match(/onb-art-tag-polished/g) || []).length, 2, "two polished lanes");
  assert.equal((html.match(/onb-art-tag-early/g) || []).length, 1, "one early lane");
});
