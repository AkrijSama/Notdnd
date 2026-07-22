// PORTRAIT AGE + WARDROBE LAWS (owner evidence 04db44…: the anime lane cooked a SHIRTLESS
// ELDERLY man for a neutral character). Two independent recipe defects, both locked here:
//   AGE   — the negative banned "young, youthful" (the exact tokens the positive anchor
//           asserts) with NO elderly ceiling, so JANKU drifted the face old (and a teen
//           the other way). Now: minor floor + a CONDITIONAL elderly ceiling, no young ban.
//   UNDRESS — the specific wardrobe garment was SUPPRESSED because the isekai clause's
//           generic word "clothing" tripped COMMITTED_WARDROBE_RE, leaving only the weak
//           token that loses to JANKU's bare-chest default. Now generics don't count, the
//           garment fires, and a WEIGHTED undress negative rides EVERY lane (was anime-only).
// String-based (no cook), same as the other portrait-*.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { sealPortraitPrompt } from "../server/ai/comfyui.js";
import { buildPlayerPortraitPrompt } from "../server/solo/imageWorker.js";

const BECKONED = { gender: "male", pronouns: "he/him", origin: "The Beckoned", race: "The Beckoned", characterClass: "The Beckoned" };
function sealed(style, character = BECKONED) {
  const world = { tone: "dark fantasy", artStyle: style, artStyleOptions: { default: style }, origin: "The Beckoned" };
  const pos = buildPlayerPortraitPrompt(character, world);
  return sealPortraitPrompt(style, pos, "preset-negative");
}

test("AGE: the negative no longer bans the positive's own 'young/youthful' anchor (the self-canceling law that drove the drift)", () => {
  const { negative } = sealed("anime");
  assert.doesNotMatch(negative.toLowerCase(), /\byouthful\b/, "'youthful' must NOT be negated — the positive anchor is 'youthful adult'");
  assert.doesNotMatch(negative.toLowerCase(), /(^|[,(\s])young(?![-\s]adult)/i, "'young' must NOT be a bare negative token");
});

test("AGE: a DEFAULT adult gets the elderly CEILING + the minor FLOOR in the negative", () => {
  const { negative } = sealed("anime");
  const n = negative.toLowerCase();
  assert.match(n, /elderly/, "default adult must negate elderly (checkpoint bias drifts old)");
  assert.match(n, /wrinkled|wrinkles/, "default adult must negate wrinkles");
  assert.match(n, /\bchild\b/, "the minor floor is non-negotiable");
});

test("AGE: a DECLARED elderly subject KEEPS its age — the ceiling is dropped, the minor floor stays", () => {
  const { negative } = sealed("anime", { ...BECKONED, ageClass: "elderly" });
  const n = negative.toLowerCase();
  assert.doesNotMatch(n, /\(elderly:1\.3\)/, "a declared-elderly subject must NOT have elderly negated");
  assert.match(n, /\bchild\b/, "the minor floor still holds even for elderly");
});

test("WARDROBE: the generic isekai 'casual clothing' no longer suppresses the specific garment floor", () => {
  const { positive } = sealed("anime");
  assert.match(positive.toLowerCase(), /plain dark shirt/, "the specific garment must be injected despite the generic 'clothing' clause");
});

test("WARDROBE: a COMMITTED specific garment still stands alone (no default injected)", () => {
  const withCoat = { ...BECKONED, characterClass: "wearing a heavy red coat" };
  const { positive } = sealed("realistic", withCoat);
  // the committed coat is present; the default plain shirt must NOT be added on top
  assert.doesNotMatch(positive.toLowerCase(), /plain dark shirt/, "committed gear (a coat) suppresses the default garment");
});

test("UNDRESS: a WEIGHTED undress ban rides EVERY lane (previously anime-only)", () => {
  for (const style of ["anime", "realistic", "dark-fantasy", "sketch", "illustrated", "cinematic"]) {
    const n = sealed(style).negative.toLowerCase();
    assert.match(n, /\(shirtless:1\.4\)/, `${style}: weighted shirtless ban`);
    assert.match(n, /\(nude:1\.4\)/, `${style}: weighted nude ban`);
    assert.match(n, /bare torso/, `${style}: bare torso ban`);
  }
});

test("UNDRESS/WARDROBE: a BEAST subject is neither dressed nor undress-banned (a wolf keeps its coat)", () => {
  const { positive, negative } = sealPortraitPrompt("realistic", "character portrait of a wolf, grey fur, dark fantasy", "np");
  assert.doesNotMatch(positive.toLowerCase(), /plain dark shirt/, "a wolf is not dressed");
  assert.doesNotMatch(negative.toLowerCase(), /\(shirtless:1\.4\)/, "a wolf is not undress-banned");
});

test("FRAMING: the light-novel-cover collapse (card/poster/title text) is negated for a character portrait", () => {
  const n = sealed("anime").negative.toLowerCase();
  assert.match(n, /trading card/, "the isekai card-frame collapse must be negated");
  assert.match(n, /title text|caption/, "the garbled title caption must be negated");
});
