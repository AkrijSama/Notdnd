// GM KEY TRAP + PREFLIGHT (audit 5d548ac #1). The .env.example placeholder, empty, and
// whitespace are all NO KEY — never a bogus Authorization header, never a silent
// 401→template degrade. gmKeyState classifies; verifyGmKey does ONE models-list ping
// (mock-injected here — zero real calls); renderGmKeyBanner surfaces it.
import assert from "node:assert/strict";
import test from "node:test";

// Own the env for this file (each test file runs in its own process).
delete process.env.NOTDND_MOCK_OPENROUTER;
delete process.env.INKBORNE_MOCK_OPENROUTER;
function setKey(v) {
  if (v === undefined) { delete process.env.INKBORNE_LLM_API_KEY; delete process.env.NOTDND_LLM_API_KEY; delete process.env.OPENROUTER_API_KEY; }
  else process.env.INKBORNE_LLM_API_KEY = v;
}

const { gmKeyState, verifyGmKey } = await import("../server/ai/openrouter.js");
const { renderGmKeyBanner } = await import("../src/components/debugPanel.js");

test("gmKeyState: missing / placeholder / whitespace are all NO KEY (red)", () => {
  setKey(undefined);
  assert.equal(gmKeyState().state, "missing");
  assert.equal(gmKeyState().ok, false);
  setKey("your_api_key_here");
  assert.equal(gmKeyState().state, "placeholder");
  assert.equal(gmKeyState().ok, false);
  setKey("   ");
  assert.equal(gmKeyState().ok, false, "whitespace-only is no key");
  setKey("CHANGEME");
  assert.equal(gmKeyState().state, "placeholder", "common paste placeholders are caught case-insensitively");
});

test("gmKeyState: a real-looking key is PRESENT (green)", () => {
  setKey("sk-or-v1-realbutfake0000000000000000");
  const s = gmKeyState();
  assert.equal(s.state, "present");
  assert.equal(s.ok, true);
});

test("verifyGmKey: no real key → red WITHOUT any network call", async () => {
  setKey("your_api_key_here");
  let called = false;
  const r = await verifyGmKey({ fetchImpl: async () => { called = true; return { ok: true }; } });
  assert.equal(r.ok, false);
  assert.equal(r.state, "placeholder");
  assert.equal(called, false, "a placeholder key never pings the API");
});

test("verifyGmKey: real key + 200 models list → verified green (one call)", async () => {
  setKey("sk-or-v1-realbutfake0000000000000000");
  let calls = 0;
  const r = await verifyGmKey({ fetchImpl: async (url) => { calls += 1; assert.match(url, /\/models$/, "hits the models LIST, not a generation"); return { ok: true, status: 200 }; } });
  assert.equal(r.ok, true);
  assert.equal(r.verified, true);
  assert.equal(calls, 1, "exactly one verification ping");
});

test("verifyGmKey: real key + 401 → invalid (red)", async () => {
  setKey("sk-or-v1-realbutfake0000000000000000");
  const r = await verifyGmKey({ fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.equal(r.ok, false);
  assert.equal(r.state, "invalid");
});

test("verifyGmKey: real key + network error → unverified but NOT red (amber, no false alarm)", async () => {
  setKey("sk-or-v1-realbutfake0000000000000000");
  const r = await verifyGmKey({ fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(r.ok, true, "a transient boot network blip doesn't declare the key dead");
  assert.equal(r.verified, false);
  assert.equal(r.state, "unreachable");
});

test("verifyGmKey: mock mode skips the ping entirely", async () => {
  setKey("your_api_key_here");
  process.env.NOTDND_MOCK_OPENROUTER = "true";
  let called = false;
  const r = await verifyGmKey({ fetchImpl: async () => { called = true; return { ok: true }; } });
  assert.equal(r.ok, true);
  assert.equal(r.state, "mock");
  assert.equal(called, false);
  delete process.env.NOTDND_MOCK_OPENROUTER;
});

test("renderGmKeyBanner: red status → visible alert; ok status → nothing", () => {
  const red = renderGmKeyBanner({ preflight: { gmKey: { ok: false, reason: "No GM key set." } } });
  assert.match(red, /class="gmkey-banner"/);
  assert.match(red, /AI GM offline/i);
  assert.match(red, /openrouter\.ai/);
  assert.match(red, /No GM key set\./);
  assert.equal(renderGmKeyBanner({ preflight: { gmKey: { ok: true } } }), "", "green key → no banner");
  assert.equal(renderGmKeyBanner(null), "", "no status → no banner");
  assert.equal(renderGmKeyBanner({}), "", "no preflight → no banner");
});
