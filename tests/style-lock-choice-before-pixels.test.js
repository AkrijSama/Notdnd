// CHOICE-BEFORE-PIXELS (style-lock law · hard server guard). No portrait/draft image
// job may be generated before a style is committed on the world CONTEXT — enforced
// server-side, not just by UI ordering. A ready-made world card routed straight to
// character creation carries no style until the player picks one in the Identity step;
// generating anyway would render on a guessed default lane (the reported bug: an
// anime-locked Babel run wearing a non-anime default-lane portrait).
import assert from "node:assert/strict";
import test from "node:test";
import { hasCommittedArtStyle } from "../server/solo/artStyle.js";
import { enqueueDraftPortrait, classifyImageFailure } from "../server/solo/imageWorker.js";
import { renderOnboardingFlow } from "../src/components/onboardingFlow.js";

// ── the predicate: a valid, committed style in EITHER vocab ───────────────────
test("hasCommittedArtStyle: true only for a real, committed style (either vocab)", () => {
  // engine vocab
  assert.equal(hasCommittedArtStyle({ artStyle: "illustrated" }), true);
  assert.equal(hasCommittedArtStyle({ artStyle: "anime" }), true);
  assert.equal(hasCommittedArtStyle({ artStyle: "cinematic" }), true);
  // canonical vocab / the new primary field
  assert.equal(hasCommittedArtStyle({ artStyleOptions: { default: "dark-fantasy" } }), true);
  assert.equal(hasCommittedArtStyle({ artStyleOptions: { default: "realistic" } }), true);
  // NOT committed: a ready-made world before the player picks
  assert.equal(hasCommittedArtStyle({}), false, "empty world → no committed style");
  assert.equal(hasCommittedArtStyle({ artStyle: "" }), false, "blank string → not committed");
  assert.equal(hasCommittedArtStyle({ artStyle: "  " }), false, "whitespace → not committed");
  assert.equal(hasCommittedArtStyle({ artStyle: "rococo" }), false, "unrecognized style → not committed");
  assert.equal(hasCommittedArtStyle(null), false);
  assert.equal(hasCommittedArtStyle(undefined), false);
});

// ── the hard guard: enqueue rejects a styleless job (no pixels) ───────────────
test("enqueueDraftPortrait REJECTS a job whose world carries no committed style", () => {
  assert.throws(
    () => enqueueDraftPortrait({ character: { name: "Rowan", race: "The Beckoned" }, world: {} }),
    (err) => {
      assert.equal(err.code, "STYLE_NOT_LOCKED", "typed reject code");
      assert.match(String(err.message), /style is not locked|choose a style/i);
      return true;
    },
    "a ready-made draft with no style must throw, not render"
  );
  // a blank/garbage style is likewise rejected
  assert.throws(() => enqueueDraftPortrait({ character: {}, world: { artStyle: "" } }), /STYLE_NOT_LOCKED|style is not locked/);
});

test("enqueueDraftPortrait ACCEPTS a job once a style is committed (returns a draftId)", () => {
  // A committed style passes the guard; enqueue returns a deterministic draftId string.
  const draftId = enqueueDraftPortrait({
    character: { name: "Rowan", race: "The Beckoned", characterClass: "The Beckoned", pronouns: "he/him" },
    world: { name: "Babel", artStyle: "anime", artStyleOptions: { default: "anime" } }
  });
  assert.equal(typeof draftId, "string");
  assert.ok(draftId.length > 0, "a committed-style job enqueues");
});

// ── the loud reason: classified onto the failReason surface ───────────────────
test("classifyImageFailure maps the style-lock reject to a clear, actionable reason", () => {
  const reason = classifyImageFailure(new Error("art style is not locked — choose a style before the portrait can render"));
  assert.match(reason, /choose an art style/i, "player-facing, actionable — not a scary art-server error");
  assert.doesNotMatch(reason, /art server/i, "not misclassified as an infrastructure failure");
});

// ── the flow half: a ready-made Identity step gates the portrait on the choice ─
test("the ready-made Identity step reaches the wizard with the portrait GATED until a style is chosen", () => {
  const html = renderOnboardingFlow({ step: "character", worldDef: { scenarioId: "babel" }, character: { step: 1 } });
  // the picker is present and required, and the portrait slot shows the gate note
  assert.match(html, /data-onb-art-picker/, "the required style picker is shown");
  assert.match(html, /Choose an art style to generate your portrait/, "portrait is gated — no draft render until a style exists");
});
