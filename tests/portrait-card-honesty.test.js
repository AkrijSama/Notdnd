// CARD HONESTY (owner incident item, 2026-07-20). A player must NEVER see an eternal
// "Regenerating…" spinner over a dead/finished job. The draft-portrait card must render
// the TRUTH for every status: a failure shows the classified reason + a Retry (Redo)
// control; a completed cook shows the image; an in-flight cook shows the spinner. Proven
// both ways (forced failure + normal cook) at the render layer — the string surface the
// client actually paints.
import assert from "node:assert/strict";
import test from "node:test";
import { renderOnboardingFlow } from "../src/components/onboardingFlow.js";

// A ready-made world with a COMMITTED style, so the portrait area renders (not the
// choice-before-pixels gate), at the Identity step with race/class chosen.
function card(portraitPatch) {
  return renderOnboardingFlow({
    step: "character",
    worldDef: { scenarioId: "babel", artStyle: "anime" },
    character: { step: 1, name: "Rowan", pronouns: "he/him", race: "Human", characterClass: "Fighter" },
    ...portraitPatch
  });
}

test("FORCED FAILURE: the card shows the classified reason + a Retry, never a spinner", () => {
  const html = card({ draftPortraitStatus: "failed", portraitFailReason: "The art server took too long. Try again in a moment." });
  assert.match(html, /The art server took too long/, "the classified failure reason is shown");
  assert.match(html, /onb-portrait-failreason/, "reason uses the failure surface");
  assert.match(html, /data-cw-portrait-redo/, "a Retry (Redo) control is offered on failure");
  assert.doesNotMatch(html, /Regenerating…|Crafting your portrait/, "a failed card is NOT a spinner");
});

test("NORMAL COOK (generated): the card shows the image, no spinner", () => {
  const html = card({ draftPortraitStatus: "generated", draftPortraitUri: "/data/assets/draft_x/player/base.png" });
  assert.match(html, /onb-portrait-img/, "the finished image is shown");
  assert.match(html, /base\.png/, "the served uri is rendered");
  assert.doesNotMatch(html, /Regenerating…/, "a generated card shows no regenerating overlay");
  assert.doesNotMatch(html, /Crafting your portrait/, "a generated card shows no crafting spinner");
});

test("TRUTHFUL COOK TIME: a live elapsed counter + honest range, never a fixed promise", () => {
  const started = Date.now() - 47000; // 47s into the cook
  const html = card({ draftPortraitStatus: "generating", draftPortraitStartedAt: started });
  assert.match(html, /Cooking your portrait — \d+s…/, "a live elapsed counter renders (same idiom as the turn lifecycle)");
  assert.match(html, /4[5-9]s/, "the counter reflects the real elapsed time (~47s), i.e. it ticks");
  assert.match(html, /usually 1–3 minutes/, "an honest MEASURED range, not a fixed promise");
  assert.doesNotMatch(html, /\(~20s\)|within 30 seconds/, "no surface states a fixed expected time");
});

test("cook counter with no startedAt shows the verb but NO invented number", () => {
  const html = card({ draftPortraitStatus: "generating" });
  assert.match(html, /Cooking your portrait…/, "verb without a guessed number");
  assert.doesNotMatch(html, /Cooking your portrait — \d/, "no fabricated elapsed when start is unknown");
});

test("IN-FLIGHT (regenerating, prior image held): the overlay is shown OVER the old image", () => {
  const html = card({ draftPortraitStatus: "generating", draftPortraitUri: "/data/assets/draft_x/player/base.png" });
  assert.match(html, /Regenerating…/, "a redo/edit shows the regenerating overlay");
  assert.match(html, /onb-portrait-img/, "the prior image stays visible under the overlay");
});
