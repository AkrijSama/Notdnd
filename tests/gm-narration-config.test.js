import assert from "node:assert/strict";
import test from "node:test";
import { INKBORNE_GM_VOICE } from "../server/gm/voice.js";
import { NARRATIVE_MIN_RESPONSE_TOKENS, withNarrativeTokenFloor } from "../server/gm/prompting.js";

// FIX C — the GM voice defaults the player character to he/him pronouns.
test("INKBORNE_GM_VOICE defaults player pronouns to he/him, not they/them", () => {
  assert.match(INKBORNE_GM_VOICE, /he\/him/);
  // It is a DEFAULT: honor stated pronouns, never fall back to they/them.
  assert.match(INKBORNE_GM_VOICE, /never default to they\/them/i);
});

// FIX M — narrative GM calls get a token budget floor so a reasoning model
// (e.g. gemini-2.5-flash) has room to finish thinking AND narrate, instead of
// burning a tight 400-600 cap on thinking and returning truncated/empty prose.
test("withNarrativeTokenFloor raises a tight profile cap to the floor", () => {
  const out = withNarrativeTokenFloor({ maxResponseTokens: 500, temperature: 0.8 });
  assert.equal(out.maxResponseTokens, NARRATIVE_MIN_RESPONSE_TOKENS);
  // Other options are preserved.
  assert.equal(out.temperature, 0.8);
});

test("withNarrativeTokenFloor never lowers an explicit higher budget", () => {
  const high = NARRATIVE_MIN_RESPONSE_TOKENS + 1000;
  const out = withNarrativeTokenFloor({ maxResponseTokens: high });
  assert.equal(out.maxResponseTokens, high);
});

test("withNarrativeTokenFloor applies the floor when no budget is set", () => {
  assert.equal(withNarrativeTokenFloor({}).maxResponseTokens, NARRATIVE_MIN_RESPONSE_TOKENS);
  assert.equal(withNarrativeTokenFloor().maxResponseTokens, NARRATIVE_MIN_RESPONSE_TOKENS);
});

test("the narrative token floor is generous enough for reasoning + a full beat", () => {
  // Reasoning overhead observed at ~500-1000 thinking tokens plus ~150 of prose;
  // the floor must clear that comfortably.
  assert.ok(NARRATIVE_MIN_RESPONSE_TOKENS >= 1024, "floor should leave room for thinking + narration");
});
