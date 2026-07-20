// STYLE PICKER at run creation (style-lock law · CHOICE-BEFORE-PIXELS). Halves:
//  - CLIENT: a READY-MADE world (authored scenarioId) picks its art style in the
//    IDENTITY step (step 1) — REQUIRED, no default-guess — so the choice precedes the
//    draft portrait. A CUSTOM world keeps the picker on the review step. (Babel used to
//    silently default to anime with no early choice, rendering the draft on a guessed
//    default lane before any style-lock existed.)
//  - SERVER: an explicit player choice is honored over the scenario default, and an
//    out-of-allowed choice is ignored (the scenario default stands) — no regression.
import assert from "node:assert/strict";
import test from "node:test";
import { renderOnboardingFlow } from "../src/components/onboardingFlow.js";
import { lockRunArtStyle, styleForRun } from "../server/solo/artStyle.js";

// ── client: ready-made picker rides the IDENTITY step, required, no default ──────
test("art-style picker appears for a READY-MADE world (Babel) in the IDENTITY step — required, no default", () => {
  const html = renderOnboardingFlow({ step: "character", worldDef: { scenarioId: "babel" }, character: { step: 1 } });
  assert.match(html, /Art style/, "the art-style field is rendered in the Identity step");
  assert.match(html, /data-onb-art-picker/, "the picker grid is present at step 1");
  assert.match(html, /data-world-artstyle="anime"/, "an art-style choice is selectable");
  // no default-guess: no card is pre-active until the player picks (mirrors pronouns)
  assert.doesNotMatch(html, /onb-art-card active/, "no style is pre-selected (required, no default-guess)");
  // and the portrait cannot render yet — a clear 'pick a style' note, not a spinner
  assert.match(html, /Choose an art style to generate your portrait/, "portrait is gated on the style choice");
});

test("a READY-MADE world's Identity picker highlights the committed style once chosen", () => {
  const html = renderOnboardingFlow({ step: "character", worldDef: { scenarioId: "babel", artStyle: "anime" }, character: { step: 1 } });
  assert.match(html, /class="onb-art-card active" data-world-artstyle="anime"/, "the chosen style is highlighted");
  assert.doesNotMatch(html, /Choose an art style to generate/, "the portrait gate lifts once a style is committed");
});

test("the READY-MADE review step carries NO second art picker (it moved to Identity)", () => {
  const html = renderOnboardingFlow({ step: "character", worldDef: { scenarioId: "babel", artStyle: "anime" }, character: { step: 6 } });
  assert.doesNotMatch(html, /data-onb-art-picker/, "no redundant picker on the authored review step");
});

test("art-style picker appears for a CUSTOM world on the REVIEW step, chosen style highlighted", () => {
  const html = renderOnboardingFlow({ step: "character", worldDef: { userWorldId: "uw_x", artStyle: "anime" }, character: { step: 6 } });
  assert.match(html, /Art style/);
  assert.match(html, /class="onb-art-card active" data-world-artstyle="anime"/, "the chosen style is highlighted");
  assert.match(html, /data-onb-art-picker/, "the custom picker stays on review");
});

test("a CUSTOM world's IDENTITY step carries NO art picker (custom picks on review)", () => {
  const html = renderOnboardingFlow({ step: "character", worldDef: { userWorldId: "uw_x", artStyle: "illustrated" }, character: { step: 1 } });
  assert.doesNotMatch(html, /data-onb-art-picker/, "custom identity step has no picker");
});

test("the card-led landing carries NO worldgen inputs (they moved to the wizard)", () => {
  const html = renderOnboardingFlow({ step: "world", worldDef: {}, userWorlds: [] });
  assert.doesNotMatch(html, /World name/, "no name field on the landing");
  assert.doesNotMatch(html, /One sentence of world flavor/, "no flavor field on the landing");
});

// ── server: honor an explicit choice, ignore an out-of-allowed one ───────────
// Mirrors the createWorldOnboardingRun re-lock: the scenario loader stamps the
// DEFAULT; a valid explicit choice re-locks over it (grant), an invalid one throws
// and is caught (default stands).
function babelRunLockedToDefault() {
  // A Babel-like run: allowed [anime, dark-fantasy], default anime already locked.
  const run = {
    edition: "mainline",
    world: { artStyleOptions: { default: "anime", allowed: ["anime", "dark-fantasy"] }, artStyle: "anime" },
    flags: { artStyle: "anime" }
  };
  return run;
}

test("server honor: a valid explicit style (dark-fantasy → 'illustrated') re-locks over the default", () => {
  const run = babelRunLockedToDefault();
  // The client sends engine vocab; "illustrated" maps to canonical "dark-fantasy".
  lockRunArtStyle(run, "illustrated", { grant: true });
  assert.equal(styleForRun(run), "dark-fantasy", "the player's allowed choice wins over the scenario default");
});

test("server honor: an OUT-OF-ALLOWED choice (realistic) throws → the default is kept", () => {
  const run = babelRunLockedToDefault();
  // "cinematic" → canonical "realistic", which is NOT in Babel's allowed list.
  assert.throws(() => lockRunArtStyle(run, "cinematic", { grant: true }), /allowed|not permitted|style/i);
  // The onboarding caller catches this; the run keeps the scenario default.
  assert.equal(styleForRun(run), "anime", "an invalid pick leaves the scenario default intact");
});

test("server honor: NO explicit choice leaves the scenario default (no regression)", () => {
  const run = babelRunLockedToDefault();
  // The caller only re-locks when world.artStyle is present; here it is absent.
  assert.equal(styleForRun(run), "anime");
});
