// SEALED-OR-NOTHING (owner law 2026-07-20). Character/scene kinds carry the sealed
// identity/lane prompt that a fallback provider cannot reproduce. generateImage must
// therefore drop the failover chain for these kinds: the sealed primary is the ONLY
// branch, and its failure is a classified error — NEVER an unsealed fallback image.
// A fallback branch for a sealed kind is the A6 bug; this test fails the suite if one
// is ever re-introduced.
import assert from "node:assert/strict";
import test from "node:test";
import { generateImage, SEALED_ONLY_KINDS } from "../server/ai/providers.js";

// A fetchImpl that makes the comfyui primary fail (any non-2xx / throw is retriable),
// so the ONLY way generateImage can return a result is by falling over to a fallback.
function failingFetch() {
  return async () => {
    throw new Error("primary provider unreachable (test)");
  };
}

test("SEALED_ONLY_KINDS names the identity/scene surfaces", () => {
  for (const k of ["portrait", "fullbody", "scene"]) {
    assert.ok(SEALED_ONLY_KINDS.has(k), `${k} must be sealed-only`);
  }
  // Non-identity surfaces are NOT sealed-only (they may keep failover).
  for (const k of ["item", "world-card", "landscape"]) {
    assert.equal(SEALED_ONLY_KINDS.has(k), false, `${k} is not an identity surface`);
  }
});

test("a sealed kind (portrait) NEVER falls over to a fallback provider — it throws instead", async () => {
  await assert.rejects(
    () => generateImage({
      provider: "comfyui",
      prompt: "character portrait of a human man",
      style: "anime",
      kind: "portrait",
      // A mock fallback is wired + never fails; if the sealed gate leaks, this would
      // SERVE a mock (unsealed) image instead of throwing.
      providerPriority: ["mock"],
      retryDelayMs: 0,
      fetchImpl: failingFetch()
    }),
    (err) => {
      assert.match(String(err.message || err), /All image providers failed|unreachable/i);
      return true;
    },
    "sealed kind must surface a classified failure, not an unsealed fallback image"
  );
});

test("a non-identity kind (item) MAY still fall over to a fallback provider", async () => {
  const result = await generateImage({
    provider: "comfyui",
    prompt: "a warden's short sword on a plain background",
    style: "anime",
    kind: "item",
    providerPriority: ["mock"],
    retryDelayMs: 0,
    fetchImpl: failingFetch()
  });
  // The comfyui primary failed; item is not sealed-only, so the mock fallback served.
  assert.ok(result && result.mock === true, "non-identity kind falls over to the mock fallback");
});
