// T8 — PLAYER-PREFERENCE SLOTS. Appearance (positive) + avoid (negative) feed the sealed
// builder ADDITIVELY and can never override identity/safety. Contract tested on the pure
// helper (the one fenced call site — the image builder — applies it verbatim).
import assert from "node:assert/strict";
import test from "node:test";
import { applyPreferenceSlots, sanitizeSlot } from "../server/solo/portraitPreferences.js";
import { renderOnboardingFlow } from "../src/components/onboardingFlow.js";

test("the creation preview co-locates the Appearance + Avoid boxes", () => {
  const html = renderOnboardingFlow({ step: "character", worldDef: { scenarioId: "babel", artStyle: "anime" }, character: { step: 1, name: "Kae", pronouns: "he/him" } });
  assert.match(html, /data-cw-input="appearancePref"/, "appearance box renders");
  assert.match(html, /data-cw-input="avoidPref"/, "avoid box renders");
  assert.match(html, /Preferences are additive/, "the additive contract is surfaced to the player");
});

// A representative SEALED prompt (weighted identity + wardrobe floor in the positive;
// human-gated monster + wardrobe negatives in the negative).
const SEALED_POS = "character portrait of a human man, (adult man:1.3), rounded human ears, wearing a plain dark shirt";
const SEALED_NEG = "lowres, worst quality, skull, skeleton, monster, shirtless, bare chest, western comic";

test("slots RIDE the prompt: appearance appends to positive, avoid appends to negative", () => {
  const { positive, negative } = applyPreferenceSlots({
    positive: SEALED_POS, negative: SEALED_NEG,
    appearance: "long silver hair, a weathered scar", avoid: "glasses, hat"
  });
  assert.match(positive, /long silver hair, a weathered scar/, "appearance rides the positive");
  assert.match(negative, /glasses, hat/, "avoid rides the negative");
});

test("EMPTY boxes = exact baseline (pure no-op)", () => {
  const r = applyPreferenceSlots({ positive: SEALED_POS, negative: SEALED_NEG, appearance: "", avoid: "" });
  assert.equal(r.positive, SEALED_POS, "positive unchanged");
  assert.equal(r.negative, SEALED_NEG, "negative unchanged");
  const r2 = applyPreferenceSlots({ positive: SEALED_POS, negative: SEALED_NEG });
  assert.equal(r2.positive, SEALED_POS);
  assert.equal(r2.negative, SEALED_NEG);
});

test("OVERRIDE LOSES: identity survives an appearance attempt; the seal negatives remain", () => {
  const { positive, negative } = applyPreferenceSlots({
    positive: SEALED_POS, negative: SEALED_NEG,
    appearance: "make me a skeleton monster", avoid: ""
  });
  // the weighted identity + wardrobe floor are untouched (appearance is only a weak tail)
  assert.match(positive, /\(adult man:1\.3\)/, "weighted identity survives");
  assert.match(positive, /wearing a plain dark shirt/, "wardrobe floor survives");
  // and the human-gated monster negative still fights the 'skeleton' the player asked for
  assert.match(negative, /skull|skeleton|monster/, "seal negatives remain");
  // the appearance is present but as a tail (after the identity), not replacing it
  assert.ok(positive.indexOf("(adult man:1.3)") < positive.indexOf("skeleton"), "identity precedes the appended pref");
});

test("WARDROBE FLOOR beats 'no shirt': avoid safety-floor terms are stripped", () => {
  const { negative } = applyPreferenceSlots({
    positive: SEALED_POS, negative: SEALED_NEG,
    appearance: "", avoid: "shirt, clothing, glasses"
  });
  // wardrobe/identity terms are stripped from the avoid slot (the seal owns those floors)
  assert.doesNotMatch(negative, /,\s*shirt\b/, "player cannot avoid their shirt");
  assert.doesNotMatch(negative, /,\s*clothing\b/, "player cannot avoid clothing");
  // but a benign avoid term still rides
  assert.match(negative, /glasses/, "a benign avoid term still applies");
});

test("cannot avoid your humanity / age (safety floors)", () => {
  const { negative } = applyPreferenceSlots({
    positive: SEALED_POS, negative: SEALED_NEG, avoid: "human, adult, face, child"
  });
  // none of the identity/age floor terms leak into the negative
  for (const term of ["human", "adult", "child"]) {
    assert.doesNotMatch(negative, new RegExp(`,\\s*${term}\\b`), `'${term}' cannot be avoided`);
  }
});

test("PER-PROVIDER: a positive-only provider drops the avoid slot (no negative field)", () => {
  const { positive, negative } = applyPreferenceSlots({
    positive: SEALED_POS, negative: SEALED_NEG,
    appearance: "silver hair", avoid: "glasses", provider: "pollinations"
  });
  assert.match(positive, /silver hair/, "appearance still rides a positive-only provider");
  assert.equal(negative, SEALED_NEG, "avoid is dropped (no negative field to render it)");
});

test("sanitizeSlot strips prompt-control punctuation (no weight injection)", () => {
  assert.equal(sanitizeSlot("(masterpiece:1.5) [extra]"), "masterpiece 1.5 extra");
  assert.equal(sanitizeSlot("  a   b  "), "a b");
});
