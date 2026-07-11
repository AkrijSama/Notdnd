import test from "node:test";
import assert from "node:assert/strict";
import {
  localFallbackEnabled,
  resolveGmProvider,
  resolveCloudChain,
  requestViaCloudChain
} from "../server/ai/openrouter.js";

// FALLBACK GATE (owner 2026-07-10, fallback-gate-breach). The cloud->local 8b
// recovery is the GPU-freeze hazard class. The gate is fail-safe: OFF unless
// EXPLICITLY enabled. No GM path may degrade to the local model while it is off —
// a failed cloud call must RAISE, never silently serve 8b.
//
// Root cause of the breach: the .env override (=false) is loaded only by
// server/index.js, so an entry point that skips index.js inherited the OLD
// default-ON and fell back. These tests lock the fail-safe default + the single
// lowest-level enforcement point (resolveGmProvider) + the live serving path.

const FLAG_KEYS = ["INKBORNE_GM_LOCAL_FALLBACK", "NOTDND_GM_LOCAL_FALLBACK"];
function withFlag(value, fn) {
  const saved = {};
  for (const k of FLAG_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  if (value !== undefined) process.env.INKBORNE_GM_LOCAL_FALLBACK = value;
  try {
    return fn();
  } finally {
    for (const k of FLAG_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

// ── the gate itself is fail-safe ─────────────────────────────────────────────
test("localFallbackEnabled: OFF unless explicitly enabled (unset/false/0/off => false)", () => {
  for (const v of [undefined, "", "false", "0", "off", "FALSE", "nonsense"]) {
    withFlag(v, () => assert.equal(localFallbackEnabled(), false, `flag=${JSON.stringify(v)} must be OFF`));
  }
  for (const v of ["true", "1", "on", "TRUE", "On"]) {
    withFlag(v, () => assert.equal(localFallbackEnabled(), true, `flag=${JSON.stringify(v)} must be ON`));
  }
});

// ── single lowest-level enforcement: resolveGmProvider ───────────────────────
test("resolveGmProvider(fallback:true) THROWS when disabled/unset — never returns a local provider", () => {
  for (const v of [undefined, "false", "0", "off"]) {
    withFlag(v, () => {
      assert.throws(
        () => resolveGmProvider("mainline", { fallback: true }),
        (e) => e.code === "GM_LOCAL_FALLBACK_DISABLED" && e.statusCode === 503,
        `flag=${JSON.stringify(v)} must refuse the fallback-local provider`
      );
    });
  }
});

test("resolveGmProvider(fallback:true) returns local ONLY when explicitly enabled", () => {
  withFlag("true", () => {
    const p = resolveGmProvider("mainline", { fallback: true });
    assert.equal(p.local, true);
    assert.equal(p.model, "inkborne-gm:8b");
  });
});

test("Forbidden Mode is INTENTIONAL local and is NEVER gated (works with fallback off)", () => {
  withFlag(undefined, () => {
    const p = resolveGmProvider("forbidden");
    assert.equal(p.local, true);
    assert.equal(p.model, "inkborne-gm:8b");
  });
});

// ── the live serving path (both OOC and narration flow through the cloud chain
//    under the launch config NOTDND_CLOUD_PROVIDER_CHAIN=openrouter-gemini) ────
function fakeRequestFn(plan) {
  const attempted = [];
  const fn = async (messages, model) => {
    attempted.push(model);
    const key = model.includes("gemini") ? "gemini" : model.includes("versatile") || model.includes("llama-3") ? "groq" : "local";
    const outcome = plan[key];
    if (outcome === "ok") return { content: `prose from ${key}`, model, tokensUsed: { prompt: 1, completion: 1 }, cost: 0 };
    const err = new Error(`${key} ${outcome}`); err.statusCode = typeof outcome === "number" ? outcome : 500; err.code = "OPENROUTER_ERROR"; throw err;
  };
  return { fn, attempted };
}
const MSGS = [{ role: "user", content: "answer the OOC question" }];

test("SERVING PATH: all cloud lanes fail + fallback UNSET (default) => RAISES, local never attempted", async () => {
  const CHAIN_ENV = {
    NOTDND_CLOUD_PROVIDER_CHAIN: "gemini-groq", GEMINI_API_KEY: "g", GROQ_API_KEY: "q",
    INKBORNE_GM_LOCAL_FALLBACK: undefined, NOTDND_GM_LOCAL_FALLBACK: undefined
  };
  const saved = {};
  for (const k of Object.keys(CHAIN_ENV)) { saved[k] = process.env[k]; if (CHAIN_ENV[k] === undefined) delete process.env[k]; else process.env[k] = CHAIN_ENV[k]; }
  try {
    const chain = resolveCloudChain();
    const { fn, attempted } = fakeRequestFn({ gemini: 500, groq: 500, local: "ok" });
    await assert.rejects(
      requestViaCloudChain(MSGS, chain, { __requestFn: fn }),
      "a failed cloud chain must raise when the local fallback is disabled by default"
    );
    assert.ok(!attempted.some((m) => m.includes("inkborne")), "the local 8b must NOT be attempted");
    assert.deepEqual(attempted, ["gemini-2.5-flash", "llama-3.3-70b-versatile"], "only the cloud lanes were tried");
  } finally {
    for (const k of Object.keys(CHAIN_ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});
