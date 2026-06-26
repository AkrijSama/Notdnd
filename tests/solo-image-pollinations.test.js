import assert from "node:assert/strict";
import test from "node:test";
import { generateImage, providerSupportsReference } from "../server/ai/providers.js";

test("providerSupportsReference: all current providers generate expression variants", () => {
  // Pollinations now generates variants via seed-locked prompt variation, so it
  // is no longer gated out (TXT2IMG_ONLY_IMAGE_PROVIDERS is empty).
  assert.equal(providerSupportsReference("pollinations"), true);
  assert.equal(providerSupportsReference("fal"), true);
  assert.equal(providerSupportsReference("local"), true);
  assert.equal(providerSupportsReference("mock"), true);
});

test("pollinations builds the expected URL and returns image bytes", async () => {
  let calledUrl = "";
  const fetchImpl = async (url) => {
    calledUrl = url;
    return { ok: true, async arrayBuffer() { return Uint8Array.from([137, 80, 78, 71]).buffer; } };
  };
  const result = await generateImage({
    provider: "pollinations",
    prompt: "a grim knight",
    style: "dark fantasy",
    seed: 42,
    fetchImpl
  });

  assert.equal(result.provider, "pollinations");
  assert.equal(result.mock, false);
  assert.ok(Buffer.isBuffer(result.bytes) && result.bytes.length === 4);
  assert.match(calledUrl, /^https:\/\/image\.pollinations\.ai\/prompt\//);
  assert.match(calledUrl, /model=flux/);
  assert.match(calledUrl, /width=512/);
  assert.match(calledUrl, /height=768/);
  assert.match(calledUrl, /seed=42/);
  assert.match(calledUrl, /nologo=true/);
  assert.match(decodeURIComponent(calledUrl), /a grim knight, dark fantasy style/);

  // Per-type dimensions: callers (location jobs) can override the portrait
  // default with an explicit landscape aspect.
  let landscapeUrl = "";
  await generateImage({
    provider: "pollinations",
    prompt: "a wide vista",
    width: 768,
    height: 512,
    fetchImpl: async (url) => {
      landscapeUrl = url;
      return { ok: true, async arrayBuffer() { return new ArrayBuffer(4); } };
    }
  });
  assert.match(landscapeUrl, /width=768/);
  assert.match(landscapeUrl, /height=512/);
});

test("pollinations derives a deterministic seed from the prompt when none given", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: true, async arrayBuffer() { return new ArrayBuffer(2); } };
  };
  await generateImage({ provider: "pollinations", prompt: "same prompt", fetchImpl });
  await generateImage({ provider: "pollinations", prompt: "same prompt", fetchImpl });
  const seedOf = (u) => new URL(u).searchParams.get("seed");
  assert.equal(seedOf(urls[0]), seedOf(urls[1]));
  assert.match(seedOf(urls[0]), /^\d+$/);
});

test("pollinations throws on a non-ok response", async () => {
  const fetchImpl = async () => ({ ok: false, status: 503 });
  await assert.rejects(
    () => generateImage({ provider: "pollinations", prompt: "x", fetchImpl }),
    /Pollinations request failed \(503\)/
  );
});
