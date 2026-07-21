// T8 PREFERENCE SLOTS — the orphaned handoff, wired (2026-07-20). The appearance/avoid
// boxes ride BOTH the Identity (creation preview) AND the Review screen; the slots feed
// the sealed builder ADDITIVELY (appearance → positive, avoid → negative) and identity +
// the safety floor always win.
import assert from "node:assert/strict";
import test from "node:test";
import { renderOnboardingFlow } from "../src/components/onboardingFlow.js";
import { applyPreferenceSlots } from "../server/solo/portraitPreferences.js";

function screen(step, patch = {}) {
  return renderOnboardingFlow({
    step: "character",
    worldDef: { scenarioId: "babel", artStyle: "anime" },
    character: { step, name: "Rowan", pronouns: "he/him", race: "Human", characterClass: "Fighter", ...patch }
  });
}

test("the appearance + avoid boxes ride BOTH the Identity step AND the Review step", () => {
  for (const [label, step] of [["Identity", 1], ["Review", 6]]) {
    const html = screen(step);
    assert.match(html, /data-cw-input="appearancePref"/, `${label}: appearance box present`);
    assert.match(html, /data-cw-input="avoidPref"/, `${label}: avoid box present`);
  }
});

test("slots are ADDITIVE and identity/safety win", () => {
  const sealed = {
    positive: "character portrait of a human man, (adult man:1.3), rounded human ears",
    negative: "(1girl:1.4), (skull:1.4)"
  };
  const out = applyPreferenceSlots({ ...sealed, appearance: "green cloak, a weathered scar", avoid: "glasses, hat", provider: "comfyui" });
  assert.match(out.positive, /green cloak/, "appearance rides the positive");
  assert.match(out.positive, /\(adult man:1\.3\)/, "the sealed identity is preserved (wins)");
  assert.match(out.negative, /glasses/, "avoid rides the negative");
  assert.match(out.negative, /\(skull:1\.4\)/, "the sealed safety/monster floor is preserved");
});

test("an avoid term that breaches the safety floor is stripped", () => {
  const out = applyPreferenceSlots({
    positive: "character portrait of a human man",
    negative: "(skull:1.4)",
    // a term that would try to undo the clothing/safety floor
    avoid: "clothing, shirt",
    provider: "comfyui"
  });
  // AVOID_SAFETY_DENY strips wardrobe-removal terms so a slot can't unclothe a subject.
  assert.doesNotMatch(out.negative, /(?:^|,\s*)clothing(?:,|$)/, "a safety-breaching avoid term is dropped");
});
