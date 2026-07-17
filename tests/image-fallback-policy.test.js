// FALLBACK POLICY (2026-07-17): pollinations must NOT be a silent failover default.
// It served off-canon flux art whenever a keyed provider was absent/failed. It now
// runs ONLY when explicitly selected as the primary provider (an opt-in). With
// nothing explicit, a failing chain throws (asset stays "failed" → clean empty
// state), never silently lands on pollinations.
import assert from "node:assert/strict";
import test from "node:test";
import { generateImage, imageFailoverPriority } from "../server/ai/providers.js";

test("pollinations is NOT in the automatic failover order (opt-in only, no silent default)", () => {
  // Deterministic + parallel-safe: no env mutation. The automatic failover order is
  // what a call uses when the primary isn't pollinations; it must exclude pollinations.
  assert.ok(!imageFailoverPriority().includes("pollinations"), "pollinations is not a silent failover");
});

test("a failing primary throws (clean empty state) rather than silently using pollinations", async () => {
  // comfyui is a keyless primary; force it to fail via an override fetch and assert
  // the chain never lands on pollinations (which would succeed if it were consulted).
  let pollinationsHit = false;
  const fetchImpl = async (url) => {
    if (String(url).includes("pollinations")) {
      pollinationsHit = true;
      return { ok: true, arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer };
    }
    throw new Error("connect ECONNREFUSED"); // comfyui + any other lane fails
  };
  await assert.rejects(
    () => generateImage({ provider: "comfyui", prompt: "x", fetchImpl, retryDelayMs: 0 }),
    /image providers? failed|ECONNREFUSED|no image/i,
    "a failing primary throws instead of silently falling to pollinations"
  );
  assert.equal(pollinationsHit, false, "pollinations was NEVER fetched as a silent failover");
});

test("pollinations STILL serves when explicitly selected as the primary (opt-in preserved)", async () => {
  const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 13, 10]).buffer });
  const result = await generateImage({ provider: "pollinations", prompt: "x", fetchImpl, retryDelayMs: 0 });
  assert.equal(result.provider, "pollinations", "an explicit pollinations opt-in is honored");
});
