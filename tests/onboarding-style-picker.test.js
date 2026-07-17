// STYLE PICKER at run creation (style-lock law). Two halves:
//  - CLIENT: the art-style picker is offered at creation for EVERY world, including
//    authored ones (Babel used to silently default to anime with no choice shown).
//  - SERVER: an explicit player choice is honored over the scenario default, and an
//    out-of-allowed choice is ignored (the scenario default stands) — no regression.
import assert from "node:assert/strict";
import test from "node:test";
import { renderOnboardingFlow } from "../src/components/onboardingFlow.js";
import { lockRunArtStyle, styleForRun } from "../server/solo/artStyle.js";

// ── client: picker appears ───────────────────────────────────────────────────
test("art-style picker appears for an AUTHORED world (Babel) at creation", () => {
  const html = renderOnboardingFlow({ step: "world", worldDef: { scenarioId: "babel" } });
  assert.match(html, /Art style/, "the art-style field is rendered for authored worlds");
  assert.match(html, /data-onb-art-picker/, "the picker grid is present");
  assert.match(html, /data-world-artstyle="anime"/, "an art-style choice is selectable");
});

test("art-style picker still appears for a worldgen (non-authored) world", () => {
  const html = renderOnboardingFlow({ step: "world", worldDef: { tone: "grimdark", artStyle: "anime" } });
  assert.match(html, /Art style/);
  assert.match(html, /class="onb-art-card active" data-world-artstyle="anime"/, "the chosen style is highlighted");
});

test("authored worlds still suppress the worldgen-only inputs (tone/name/flavor)", () => {
  const html = renderOnboardingFlow({ step: "world", worldDef: { scenarioId: "babel" } });
  assert.doesNotMatch(html, /World name/, "authored worlds own their setting — no name field");
  assert.doesNotMatch(html, /One sentence of world flavor/, "no flavor field for authored worlds");
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
