import test from "node:test";
import assert from "node:assert/strict";

import { editImage, pollinationsEditConfigured } from "../server/ai/providers.js";
import { computeDraftPortraitId } from "../server/solo/imageWorker.js";

// Env the editor logic reads. Snapshot/restore so tests don't leak into each
// other (and don't depend on the developer's real .env / pollen key).
const ENV_KEYS = [
  "INKBORNE_POLLINATIONS_KEY",
  "NOTDND_POLLINATIONS_KEY",
  "INKBORNE_MOCK_IMAGE",
  "NOTDND_MOCK_IMAGE",
  "INKBORNE_IMAGE_PROVIDER",
  "NOTDND_IMAGE_PROVIDER"
];
function snapshotEnv() {
  const s = {};
  for (const k of ENV_KEYS) {
    s[k] = process.env[k];
  }
  return s;
}
function restoreEnv(s) {
  for (const k of ENV_KEYS) {
    if (s[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = s[k];
    }
  }
}
function clearKey() {
  delete process.env.INKBORNE_POLLINATIONS_KEY;
  delete process.env.NOTDND_POLLINATIONS_KEY;
}
function pngResponse() {
  return {
    ok: true,
    status: 200,
    async arrayBuffer() {
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).buffer; // "‰PNG…"
    }
  };
}

test("pollinationsEditConfigured reflects whether a funded edit key is set", () => {
  const snap = snapshotEnv();
  try {
    clearKey();
    assert.equal(pollinationsEditConfigured(), false);
    process.env.NOTDND_POLLINATIONS_KEY = "pollen_test";
    assert.equal(pollinationsEditConfigured(), true);
  } finally {
    restoreEnv(snap);
  }
});

test("editImage regenerate-fallback runs offline in mock mode (edited=false, no edit call)", async () => {
  const snap = snapshotEnv();
  try {
    clearKey();
    process.env.NOTDND_MOCK_IMAGE = "true"; // force the offline mock provider
    let networkCalls = 0;
    const fetchImpl = async () => {
      networkCalls += 1;
      return pngResponse();
    };
    const result = await editImage({
      sourceImageUrl: "https://host/base.png",
      instruction: "add a scar over the left eye",
      prompt: "human warrior portrait",
      fetchImpl
    });
    assert.equal(result.edited, false, "no key → regenerate fallback, not a true edit");
    assert.ok(result.bytes && result.bytes.length > 0, "fallback still yields image bytes");
    assert.equal(networkCalls, 0, "mock provider never hits the network");
  } finally {
    restoreEnv(snap);
  }
});

test("editImage regenerate-fallback folds the tweak into the regenerated prompt", async () => {
  const snap = snapshotEnv();
  try {
    clearKey();
    delete process.env.NOTDND_MOCK_IMAGE;
    delete process.env.INKBORNE_MOCK_IMAGE;
    process.env.NOTDND_IMAGE_PROVIDER = "pollinations"; // a real (mock-fetch) provider
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(String(url));
      return pngResponse();
    };
    const result = await editImage({
      sourceImageUrl: "https://host/base.png",
      instruction: "longer hair",
      prompt: "human warrior portrait",
      fetchImpl,
      mock: false
    });
    assert.equal(result.edited, false);
    assert.ok(urls.length >= 1, "regenerate calls the txt2img provider");
    assert.match(urls[0], /longer%20hair/, "the tweak is folded into the prompt");
    assert.match(urls[0], /human%20warrior%20portrait/, "the base character prompt is preserved");
  } finally {
    restoreEnv(snap);
  }
});

test("editImage uses the kontext edit endpoint when a key + source image are present (edited=true)", async () => {
  const snap = snapshotEnv();
  try {
    clearKey();
    process.env.NOTDND_POLLINATIONS_KEY = "pollen_test";
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url: String(url), opts: opts || {} });
      return pngResponse();
    };
    const result = await editImage({
      sourceImageUrl: "https://host/base.png",
      instruction: "give a scar",
      prompt: "human warrior portrait",
      fetchImpl,
      mock: false
    });
    assert.equal(result.edited, true, "true source-preserving edit");
    assert.equal(result.provider, "pollinations-edit");
    assert.equal(calls.length, 1, "one call: the edit endpoint (no regenerate)");
    assert.match(calls[0].url, /model=kontext/, "kontext model");
    assert.match(calls[0].url, /image=https%3A/, "source image is passed for the edit");
    assert.match(calls[0].url, /give%20a%20scar/, "instruction drives the edit");
    assert.equal(calls[0].opts.headers.Authorization, "Bearer pollen_test", "funded key sent");
  } finally {
    restoreEnv(snap);
  }
});

test("editImage degrades to regenerate when the edit endpoint errors (e.g. 401)", async () => {
  const snap = snapshotEnv();
  try {
    clearKey();
    process.env.NOTDND_POLLINATIONS_KEY = "pollen_test";
    process.env.NOTDND_IMAGE_PROVIDER = "pollinations";
    delete process.env.NOTDND_MOCK_IMAGE;
    delete process.env.INKBORNE_MOCK_IMAGE;
    let n = 0;
    const fetchImpl = async () => {
      n += 1;
      if (n === 1) {
        // The kontext edit endpoint rejects (mirrors the real keyless 401).
        return { ok: false, status: 401, async arrayBuffer() { return new ArrayBuffer(0); } };
      }
      return pngResponse(); // the regenerate fallback succeeds
    };
    const result = await editImage({
      sourceImageUrl: "https://host/base.png",
      instruction: "scar",
      prompt: "human warrior",
      fetchImpl,
      mock: false
    });
    assert.equal(result.edited, false, "edit failed → graceful regenerate, never a hard error");
    assert.ok(result.bytes && result.bytes.length > 0);
    assert.ok(n >= 2, "tried the edit endpoint, then regenerated");
  } finally {
    restoreEnv(snap);
  }
});

test("computeDraftPortraitId namespaces each tweak as its own version (idempotent per instruction)", () => {
  const char = { name: "Kael", race: "Human", characterClass: "Fighter" };
  const world = { artStyle: "illustrated", tone: "grim" };
  const base = computeDraftPortraitId(char, 1, world, "");
  const scar = computeDraftPortraitId(char, 1, world, "add a scar");
  const hair = computeDraftPortraitId(char, 1, world, "longer hair");
  assert.notEqual(base, scar, "an edit yields a distinct draftId from the base");
  assert.notEqual(scar, hair, "different tweaks yield different draftIds");
  assert.equal(scar, computeDraftPortraitId(char, 1, world, "add a scar"), "same tweak → stable id (cacheable)");
});
