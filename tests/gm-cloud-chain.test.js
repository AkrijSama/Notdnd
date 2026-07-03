import test from "node:test";
import assert from "node:assert/strict";
import { resolveCloudChain, requestViaCloudChain } from "../server/ai/openrouter.js";

// TESTING two-lane free cloud chain: Gemini Flash -> Groq -> local (last resort).
// Routing is exercised via an INJECTED request seam (options.__requestFn) so no
// global state (fetch) is mutated — hermetic under the parallel test runner.

const CHAIN_ENV = [
  "NOTDND_CLOUD_PROVIDER_CHAIN", "INKBORNE_CLOUD_PROVIDER_CHAIN",
  "GEMINI_API_KEY", "INKBORNE_GEMINI_API_KEY", "GROQ_API_KEY", "INKBORNE_GROQ_API_KEY",
  "GEMINI_MODEL", "GROQ_MODEL", "GEMINI_BASE_URL", "GROQ_BASE_URL",
  "NOTDND_MOCK_OPENROUTER", "INKBORNE_MOCK_OPENROUTER", "INKBORNE_GM_LOCAL_FALLBACK", "NOTDND_GM_LOCAL_FALLBACK",
  "INKBORNE_FORBIDDEN_LLM_MODEL", "NOTDND_FORBIDDEN_LLM_MODEL",
  "OPENROUTER_API_KEY", "INKBORNE_LLM_API_KEY", "NOTDND_LLM_API_KEY",
  "OPENROUTER_LANE_MODEL", "OPENROUTER_PROVIDER_ORDER", "OPENROUTER_LANE_BASE_URL",
  "NOTDND_BATTERY", "INKBORNE_BATTERY"
];
function snapshotEnv() { const s = {}; for (const k of CHAIN_ENV) s[k] = process.env[k]; return s; }
function restoreEnv(s) { for (const k of CHAIN_ENV) { if (s[k] === undefined) delete process.env[k]; else process.env[k] = s[k]; } }
function clearEnv() { for (const k of CHAIN_ENV) delete process.env[k]; }
function withEnv(env, fn) {
  const snap = snapshotEnv(); clearEnv();
  Object.assign(process.env, env);
  const done = () => restoreEnv(snap);
  try {
    const r = fn();
    if (r && typeof r.then === "function") return r.finally(done);
    done();
    return r;
  } catch (e) { done(); throw e; }
}

// A fake requestFn that routes by served MODEL. `plan` maps a model substring to
// "ok" or an error status; records the order of models actually attempted.
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
const MSGS = [{ role: "user", content: "narrate the ruins" }];

// ── resolveCloudChain (pure) ─────────────────────────────────────────────────
test("resolveCloudChain: OFF/unset => null (unchanged OpenRouter path)", () => {
  withEnv({}, () => assert.equal(resolveCloudChain(), null));
  withEnv({ NOTDND_CLOUD_PROVIDER_CHAIN: "off" }, () => assert.equal(resolveCloudChain(), null));
  withEnv({ NOTDND_CLOUD_PROVIDER_CHAIN: "false" }, () => assert.equal(resolveCloudChain(), null));
});

test("resolveCloudChain: gemini-groq with keys => two ordered, OpenAI-compat lanes", () => {
  withEnv({ NOTDND_CLOUD_PROVIDER_CHAIN: "gemini-groq", GEMINI_API_KEY: "g", GROQ_API_KEY: "q" }, () => {
    const chain = resolveCloudChain();
    assert.equal(chain.length, 2);
    assert.equal(chain[0].name, "gemini");
    assert.equal(chain[0].provider.model, "gemini-2.5-flash");
    assert.match(chain[0].provider.baseUrl, /generativelanguage\.googleapis\.com/);
    assert.equal(chain[1].name, "groq");
    assert.equal(chain[1].provider.model, "llama-3.3-70b-versatile");
    assert.match(chain[1].provider.baseUrl, /api\.groq\.com/);
  });
});

test("resolveCloudChain: a missing key SKIPS that lane gracefully (no crash)", () => {
  withEnv({ NOTDND_CLOUD_PROVIDER_CHAIN: "gemini-groq", GROQ_API_KEY: "q" }, () => {
    const chain = resolveCloudChain();
    assert.equal(chain[0].name, "gemini");
    assert.ok(chain[0].skip && /GEMINI_API_KEY/.test(chain[0].skip), "gemini lane marked skip");
    assert.ok(chain[1].provider, "groq lane usable");
  });
});

test('resolveCloudChain: "on" => default gemini->groq; model/base overridable via env', () => {
  withEnv({ NOTDND_CLOUD_PROVIDER_CHAIN: "on", GEMINI_API_KEY: "g", GROQ_API_KEY: "q", GROQ_MODEL: "llama-3.1-8b-instant" }, () => {
    const chain = resolveCloudChain();
    assert.deepEqual(chain.map((l) => l.name), ["gemini", "groq"]);
    assert.equal(chain[1].provider.model, "llama-3.1-8b-instant");
  });
});

// ── routing (injected seam, no global mutation) ──────────────────────────────
test("PRIMARY: Gemini serves — model + providerLabel + latency; Groq/local untouched", async () => {
  await withEnv({ NOTDND_CLOUD_PROVIDER_CHAIN: "gemini-groq", GEMINI_API_KEY: "g", GROQ_API_KEY: "q" }, async () => {
    const chain = resolveCloudChain();
    const { fn, attempted } = fakeRequestFn({ gemini: "ok", groq: "ok", local: "ok" });
    const res = await requestViaCloudChain(MSGS, chain, { __requestFn: fn });
    assert.equal(res.model, "gemini-2.5-flash", "transcript attributes the Gemini model");
    assert.equal(res.providerLabel, "gemini");
    assert.equal(typeof res.latencyMs, "number");
    assert.deepEqual(attempted, ["gemini-2.5-flash"], "Groq/local never touched when Gemini serves");
  });
});

test("FALLBACK: Gemini 429 (cap) falls to GROQ, NOT to local", async () => {
  await withEnv({ NOTDND_CLOUD_PROVIDER_CHAIN: "gemini-groq", GEMINI_API_KEY: "g", GROQ_API_KEY: "q" }, async () => {
    const chain = resolveCloudChain();
    const { fn, attempted } = fakeRequestFn({ gemini: 429, groq: "ok", local: "ok" });
    const res = await requestViaCloudChain(MSGS, chain, { __requestFn: fn });
    assert.equal(res.model, "llama-3.3-70b-versatile");
    assert.equal(res.providerLabel, "groq");
    assert.deepEqual(attempted, ["gemini-2.5-flash", "llama-3.3-70b-versatile"], "cap -> Groq; local NOT reached");
    assert.ok(!attempted.some((m) => m.includes("inkborne")), "local is NOT the fallback for a cloud cap");
  });
});

test("LAST RESORT: both cloud lanes fail => local 8b (only then)", async () => {
  await withEnv({ NOTDND_CLOUD_PROVIDER_CHAIN: "gemini-groq", GEMINI_API_KEY: "g", GROQ_API_KEY: "q" }, async () => {
    const chain = resolveCloudChain();
    const { fn, attempted } = fakeRequestFn({ gemini: 429, groq: 500, local: "ok" });
    const res = await requestViaCloudChain(MSGS, chain, { __requestFn: fn });
    assert.equal(res.providerLabel, "local");
    assert.equal(res.model, "inkborne-gm:8b");
    assert.deepEqual(attempted, ["gemini-2.5-flash", "llama-3.3-70b-versatile", "inkborne-gm:8b"], "local ONLY after both cloud lanes");
  });
});

test("MISSING KEY: gemini skipped (no key) => Groq serves without a call attempt", async () => {
  await withEnv({ NOTDND_CLOUD_PROVIDER_CHAIN: "gemini-groq", GROQ_API_KEY: "q" }, async () => {
    const chain = resolveCloudChain();
    const { fn, attempted } = fakeRequestFn({ groq: "ok", local: "ok" });
    const res = await requestViaCloudChain(MSGS, chain, { __requestFn: fn });
    assert.equal(res.providerLabel, "groq");
    assert.deepEqual(attempted, ["llama-3.3-70b-versatile"], "no-key gemini lane skipped without a request");
  });
});

test("ALL cloud fail + local fallback disabled => throws (no silent blank)", async () => {
  await withEnv({ NOTDND_CLOUD_PROVIDER_CHAIN: "gemini-groq", GEMINI_API_KEY: "g", GROQ_API_KEY: "q", INKBORNE_GM_LOCAL_FALLBACK: "false" }, async () => {
    const chain = resolveCloudChain();
    const { fn } = fakeRequestFn({ gemini: 429, groq: 500 });
    await assert.rejects(() => requestViaCloudChain(MSGS, chain, { __requestFn: fn }), /groq|500|cloud chain/i);
  });
});


// ── PAID "openrouter" lane (the graded-session lane) ─────────────────────────
import { buildCloudLane } from "../server/ai/openrouter.js";

test("openrouter lane: paid model (never :free), Groq-preferred provider routing", () => {
  withEnv({ OPENROUTER_API_KEY: "sk-or-test" }, () => {
    const lane = buildCloudLane("openrouter");
    assert.ok(lane.provider, "lane builds with a key");
    assert.equal(lane.provider.model, "meta-llama/llama-3.3-70b-instruct");
    assert.ok(!lane.provider.model.includes(":free"), "the paid SKU, never :free");
    assert.deepEqual(lane.provider.extraBody, { provider: { order: ["groq"], allow_fallbacks: true } });
    assert.match(lane.provider.baseUrl, /openrouter\.ai/);
  });
});

test("openrouter lane: model + provider order are env-overridable", () => {
  withEnv({ OPENROUTER_API_KEY: "sk-or-test", OPENROUTER_LANE_MODEL: "meta-llama/llama-3.1-70b-instruct", OPENROUTER_PROVIDER_ORDER: "groq, deepinfra" }, () => {
    const lane = buildCloudLane("openrouter");
    assert.equal(lane.provider.model, "meta-llama/llama-3.1-70b-instruct");
    assert.deepEqual(lane.provider.extraBody.provider.order, ["groq", "deepinfra"]);
  });
});

test("openrouter lane: BATTERY GUARD — automated traffic never spends credit", () => {
  withEnv({ OPENROUTER_API_KEY: "sk-or-test", NOTDND_BATTERY: "1" }, () => {
    const lane = buildCloudLane("openrouter");
    assert.ok(lane.skip && /PAID lane/.test(lane.skip), `expected battery skip, got ${JSON.stringify(lane)}`);
  });
});

test("openrouter lane: missing key skips gracefully; chain composes openrouter-gemini", () => {
  withEnv({}, () => {
    const lane = buildCloudLane("openrouter");
    assert.ok(lane.skip && /OPENROUTER_API_KEY/.test(lane.skip));
  });
  withEnv({ OPENROUTER_API_KEY: "sk-or-test", GEMINI_API_KEY: "g-test", NOTDND_CLOUD_PROVIDER_CHAIN: "openrouter-gemini" }, () => {
    const chain = resolveCloudChain();
    assert.equal(chain.length, 2);
    assert.equal(chain[0].name, "openrouter");
    assert.equal(chain[1].name, "gemini");
  });
});
