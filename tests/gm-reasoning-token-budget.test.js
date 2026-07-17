// 2026-07-16 owner-session collapse regression: deepseek-v4-flash is a REASONING
// model (hidden thinking spends from the completion budget). The old 190-token
// "non-think" cap truncated 10/14 calls mid-sentence (finish=length) and finally
// produced EMPTY narrations; the cap also rode the fallback chain into thinking
// gemini-2.5-flash (41 chars of prose). LAW under test: any model classified
// reasoning-class NEVER receives a completion cap below 512.
import assert from "node:assert/strict";
import test from "node:test";
import {
  isReasoningFlash,
  resolveNarrativeTokenBudget,
  REASONING_FLASH_MAX_TOKENS,
  REASONING_MIN_COMPLETION_TOKENS,
  NARRATIVE_MIN_RESPONSE_TOKENS
} from "../server/gm/prompting.js";
import {
  isReasoningModel,
  reasoningSafeMaxTokens
} from "../server/ai/openrouter.js";

test("deepseek-v4-flash is classified reasoning, not non-think", () => {
  assert.equal(isReasoningFlash("deepseek/deepseek-v4-flash"), true);
  assert.equal(isReasoningFlash("deepseek/deepseek-v4-pro"), false);
});

test("reasoning-class narrative budget defaults to >= 600 and never dips below 512", () => {
  assert.ok(REASONING_FLASH_MAX_TOKENS >= REASONING_MIN_COMPLETION_TOKENS);
  // default (env may raise it; 600 is the code default, 512 the hard floor)
  const def = resolveNarrativeTokenBudget("deepseek/deepseek-v4-flash", {});
  assert.ok(def >= 512, `default budget ${def} must be >= 512`);
  // an explicit tighter override is CLAMPED UP, never honored below the floor
  const tight = resolveNarrativeTokenBudget("deepseek/deepseek-v4-flash", { flashMaxTokens: 190 });
  assert.equal(tight, REASONING_MIN_COMPLETION_TOKENS, "the 190-token collapse cap can never return");
  // a generous override passes through
  const roomy = resolveNarrativeTokenBudget("deepseek/deepseek-v4-flash", { flashMaxTokens: 1024 });
  assert.equal(roomy, 1024);
});

test("non-reasoning narrative models keep the generous floor path (unchanged)", () => {
  const pro = resolveNarrativeTokenBudget("deepseek/deepseek-v4-pro", { maxResponseTokens: 400 });
  assert.equal(pro, Math.max(400, NARRATIVE_MIN_RESPONSE_TOKENS), "floor only raises, never lowers");
});

test("request layer: a tiny cap cannot ride the fallback chain into a thinking model (T8 regression)", () => {
  assert.equal(isReasoningModel("gemini-2.5-flash"), true);
  assert.equal(isReasoningModel("deepseek/deepseek-v4-flash"), true);
  // the exact T8 shape: 190-token cap arriving at the gemini lane
  assert.equal(reasoningSafeMaxTokens("gemini-2.5-flash", 190, {}), 512);
  assert.equal(reasoningSafeMaxTokens("deepseek/deepseek-v4-flash", 190, {}), 512);
  // above the floor, caller caps are honored verbatim
  assert.equal(reasoningSafeMaxTokens("gemini-2.5-flash", 800, {}), 800);
});

test("request layer: non-reasoning models and reasoning-disabled calls keep tight budgets", () => {
  // llama-family fallback: no hidden spend, tight caps are intentional
  assert.equal(reasoningSafeMaxTokens("llama-3.3-70b-versatile", 190, {}), 190);
  // utility fast-lane contract: reasoning explicitly off => budget honored
  assert.equal(
    reasoningSafeMaxTokens("deepseek/deepseek-v4-flash", 190, { reasoning: { enabled: false } }),
    190
  );
});
