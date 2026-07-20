// T9 — CREATION-FLOW VALIDATION COHERENCE. Required fields gate THEIR OWN step's
// Continue (disabled + inline cue), so a player can never REACH Review incomplete.
// Review keeps the full gate as a backstop. No regression on choice-before-pixels
// (the ready-made art style is required at Identity).
import assert from "node:assert/strict";
import test from "node:test";
import { renderOnboardingFlow, stepRequirements } from "../src/components/onboardingFlow.js";

// ── the per-step requirement function ─────────────────────────────────────
test("Identity (step 1) requires name + pronouns; ready-made also requires art style", () => {
  // custom (non-authored): name + pronouns only at Identity
  assert.deepEqual(stepRequirements(1, {}, {}, false), ["Enter a character name", "Choose pronouns"]);
  assert.deepEqual(stepRequirements(1, { name: "Kae", pronouns: "he/him" }, {}, false), []);
  // ready-made (authored): art style is required at Identity (choice before pixels)
  const authoredMissing = stepRequirements(1, { name: "Kae", pronouns: "he/him" }, {}, true);
  assert.deepEqual(authoredMissing, ["Choose an art style"]);
  assert.deepEqual(stepRequirements(1, { name: "Kae", pronouns: "he/him" }, { artStyle: "anime" }, true), []);
});

test("Race (2) requires race; Class (3) requires class (non-authored 5e steps)", () => {
  assert.deepEqual(stepRequirements(2, {}, {}, false), ["Choose a race"]);
  assert.deepEqual(stepRequirements(2, { race: "Human" }, {}, false), []);
  assert.deepEqual(stepRequirements(3, {}, {}, false), ["Choose a class"]);
  assert.deepEqual(stepRequirements(3, { characterClass: "Fighter" }, {}, false), []);
  // authored worlds skip the 5e race/class steps → step 2 (Origin) has no requirements
  assert.deepEqual(stepRequirements(2, {}, {}, true), []);
});

test("Review (6) is the FULL backstop: name, pronouns, race, class, art style", () => {
  assert.deepEqual(stepRequirements(6, {}, {}, false).sort(), [
    "Choose a class", "Choose a race", "Choose an art style", "Choose pronouns", "Enter a character name"
  ].sort());
  const complete = { name: "Kae", pronouns: "he/him", race: "Human", characterClass: "Fighter" };
  assert.deepEqual(stepRequirements(6, complete, { artStyle: "anime" }, false), []);
});

// ── the Next button is disabled + a cue shows until the step is complete ───
test("the Identity Next is DISABLED with a cue when name/pronouns/style are missing (ready-made)", () => {
  const html = renderOnboardingFlow({ step: "character", worldDef: { scenarioId: "babel" }, character: { step: 1 } });
  assert.match(html, /data-cw-next disabled/, "Next is gated at Identity");
  assert.match(html, /class="cw-validation"[^>]*>To continue:/, "an inline cue tells the player what's missing");
  assert.match(html, /Choose an art style/, "the ready-made style requirement is surfaced at Identity (choice before pixels)");
});

test("a complete Identity step ENABLES Next", () => {
  const html = renderOnboardingFlow({
    step: "character",
    worldDef: { scenarioId: "babel", artStyle: "anime" },
    character: { step: 1, name: "Kael", pronouns: "he/him" }
  });
  assert.match(html, /data-cw-next (?!disabled)>Next<|data-cw-next >Next</, "Next is enabled once the step is complete");
  assert.doesNotMatch(html, /data-cw-next disabled/, "not disabled when complete");
});

test("Review still gates Enter as a backstop (no regression)", () => {
  const incomplete = renderOnboardingFlow({ step: "character", worldDef: { scenarioId: "babel" }, character: { step: 6, name: "", pronouns: "" } });
  assert.match(incomplete, /data-cw-enter disabled/, "Enter is gated at Review when incomplete");
});
