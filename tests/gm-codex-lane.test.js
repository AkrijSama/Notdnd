import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveCloudChain,
  buildCloudLane,
  requestViaCloudChain,
  runWithBatteryContext
} from "../server/ai/openrouter.js";
import { createCodexProxy, chatToResponsesPayload, readCodexAuth } from "../server/ai/codex-proxy.mjs";

// TESTING the flag-gated PERSONAL "codex" lane (owner's ChatGPT subscription via
// the codex-proxy sidecar). Hard constraints under proof here:
//   - OFF by default: no chain / default chain => zero codex involvement.
//   - NEVER in batteries: NOTDND_BATTERY env OR the request-scoped battery
//     context skips the lane regardless of chain config.
//   - Fallback discipline: codex failing falls to the NEXT cloud lane, not local.
//   - Attribution: served turns carry model "gpt-5.5 via codex".
//   - 401 contract: the proxy re-reads auth.json and retries ONCE; a second 401
//     passes upstream. Auth material never appears in responses.
// All auth fixtures are synthetic — no real token ever enters this file.

const CHAIN_ENV = [
  "NOTDND_CLOUD_PROVIDER_CHAIN", "INKBORNE_CLOUD_PROVIDER_CHAIN",
  "GEMINI_API_KEY", "INKBORNE_GEMINI_API_KEY", "GROQ_API_KEY", "INKBORNE_GROQ_API_KEY",
  "GEMINI_MODEL", "GROQ_MODEL", "GEMINI_BASE_URL", "GROQ_BASE_URL",
  "CODEX_AUTH_PATH", "CODEX_PROXY_URL", "CODEX_MODEL", "CODEX_BACKEND_URL",
  "NOTDND_GM_CODEX_TIMEOUT_MS", "INKBORNE_GM_CODEX_TIMEOUT_MS",
  "NOTDND_BATTERY", "INKBORNE_BATTERY", "CODEX_PROXY_NO_SPAWN", "CODEX_REASONING_EFFORT",
  "NOTDND_MOCK_OPENROUTER", "INKBORNE_MOCK_OPENROUTER", "INKBORNE_GM_LOCAL_FALLBACK", "NOTDND_GM_LOCAL_FALLBACK"
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

// Synthetic auth fixture (shape-only; nothing here is a real credential).
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-lane-test-"));
const AUTH_FIXTURE = path.join(fixtureDir, "auth.json");
function writeAuthFixture(accessToken) {
  fs.writeFileSync(AUTH_FIXTURE, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: accessToken, account_id: "acct_test_fixture" }
  }));
}
writeAuthFixture("synthetic-token-A");
test.after(() => {
  try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// Routes by served model, mirroring gm-cloud-chain.test.js: "gpt-5.5" = codex
// lane, "versatile" = groq, anything else = local last resort.
function fakeRequestFn(plan) {
  const attempted = [];
  const fn = async (messages, model) => {
    attempted.push(model);
    const key = model.includes("gpt-5.5") ? "codex" : model.includes("versatile") ? "groq" : "local";
    const outcome = plan[key];
    if (outcome === "ok") return { content: `prose from ${key}`, model, tokensUsed: { prompt: 1, completion: 1 }, cost: 0 };
    const err = new Error(`${key} ${outcome}`); err.statusCode = typeof outcome === "number" ? outcome : 500; err.code = "OPENROUTER_ERROR"; throw err;
  };
  return { fn, attempted };
}
const MSGS = [{ role: "user", content: "narrate the ruins" }];

// ── FLAG OFF BY DEFAULT (zero behavior change) ───────────────────────────────
test("FLAG OFF: unset/off chain => null even with a valid codex login present", () => {
  withEnv({ CODEX_AUTH_PATH: AUTH_FIXTURE }, () => assert.equal(resolveCloudChain(), null));
  withEnv({ NOTDND_CLOUD_PROVIDER_CHAIN: "off", CODEX_AUTH_PATH: AUTH_FIXTURE }, () => assert.equal(resolveCloudChain(), null));
});

test('FLAG OFF: "on" default chain is gemini->groq — codex NEVER implied', () => {
  withEnv({ NOTDND_CLOUD_PROVIDER_CHAIN: "on", GEMINI_API_KEY: "g", GROQ_API_KEY: "q", CODEX_AUTH_PATH: AUTH_FIXTURE }, () => {
    const chain = resolveCloudChain();
    assert.deepEqual(chain.map((l) => l.name), ["gemini", "groq"], "codex requires being NAMED explicitly");
  });
});

// ── EXPLICIT OPT-IN resolution ───────────────────────────────────────────────
test('OPT-IN: "codex-groq" => codex lane with proxy baseUrl, keyless, 60s window, attribution label', () => {
  withEnv({ NOTDND_CLOUD_PROVIDER_CHAIN: "codex-groq", GROQ_API_KEY: "q", CODEX_AUTH_PATH: AUTH_FIXTURE }, () => {
    const chain = resolveCloudChain();
    assert.deepEqual(chain.map((l) => l.name), ["codex", "groq"]);
    const codex = chain[0].provider;
    assert.equal(codex.baseUrl, "http://127.0.0.1:8788/v1/chat/completions");
    assert.equal(codex.model, "gpt-5.5");
    assert.equal(codex.keyless, true, "proxy authenticates out-of-band; lane carries NO key");
    assert.equal(codex.key, null);
    assert.equal(codex.local, false);
    assert.equal(codex.timeoutMs, 60000, "reasoning model gets a wider per-attempt window");
    assert.equal(codex.modelLabel, "gpt-5.5 via codex", 'transcript line: narration: cloud (gpt-5.5 via codex)');
  });
});

test("OPT-IN: proxy url / model / timeout overridable via env", () => {
  withEnv({
    NOTDND_CLOUD_PROVIDER_CHAIN: "codex", CODEX_AUTH_PATH: AUTH_FIXTURE,
    CODEX_PROXY_URL: "http://127.0.0.1:9999/v1/chat/completions", CODEX_MODEL: "gpt-5.5-codex", NOTDND_GM_CODEX_TIMEOUT_MS: "90000"
  }, () => {
    const [lane] = resolveCloudChain();
    assert.equal(lane.provider.baseUrl, "http://127.0.0.1:9999/v1/chat/completions");
    assert.equal(lane.provider.model, "gpt-5.5-codex");
    assert.equal(lane.provider.timeoutMs, 90000);
    assert.equal(lane.provider.modelLabel, "gpt-5.5-codex via codex");
  });
});

test("UNAUTHENTICATED: missing/empty auth.json => lane marked skip (returns to next lane)", () => {
  withEnv({ NOTDND_CLOUD_PROVIDER_CHAIN: "codex-groq", GROQ_API_KEY: "q", CODEX_AUTH_PATH: path.join(fixtureDir, "nope.json") }, () => {
    const chain = resolveCloudChain();
    assert.ok(chain[0].skip && /not authenticated/.test(chain[0].skip), "codex lane skipped, not crashed");
    assert.ok(chain[1].provider, "groq still serves");
  });
});

// ── BATTERY GUARD (never touch the subscription window) ─────────────────────
test("BATTERY ENV: NOTDND_BATTERY=1 skips codex regardless of chain config", () => {
  withEnv({ NOTDND_CLOUD_PROVIDER_CHAIN: "codex-groq", GROQ_API_KEY: "q", CODEX_AUTH_PATH: AUTH_FIXTURE, NOTDND_BATTERY: "1" }, () => {
    const chain = resolveCloudChain();
    assert.ok(chain[0].skip && /battery/.test(chain[0].skip), "battery env => codex skipped");
    assert.ok(chain[1].provider, "battery guard skips ONLY codex; groq unaffected");
  });
  // NOTDND_BATTERY=0/false/off means NOT battery.
  withEnv({ NOTDND_CLOUD_PROVIDER_CHAIN: "codex", CODEX_AUTH_PATH: AUTH_FIXTURE, NOTDND_BATTERY: "0" }, () => {
    assert.ok(resolveCloudChain()[0].provider, "falsy battery values do not trip the guard");
  });
});

test("BATTERY CONTEXT: runWithBatteryContext (x-notdnd-battery request) skips codex; outside it, lane is live", () => {
  withEnv({ NOTDND_CLOUD_PROVIDER_CHAIN: "codex", CODEX_AUTH_PATH: AUTH_FIXTURE }, () => {
    const inBattery = runWithBatteryContext(() => buildCloudLane("codex"));
    assert.ok(inBattery.skip && /battery/.test(inBattery.skip), "request-scoped battery flag skips the lane");
    const outside = buildCloudLane("codex");
    assert.ok(outside.provider, "same env, non-battery caller => lane usable");
  });
});

// ── FALLBACK DISCIPLINE + ATTRIBUTION (injected seam) ────────────────────────
test("SERVED: codex serves => model attributed as 'gpt-5.5 via codex' + latency", async () => {
  await withEnv({ NOTDND_CLOUD_PROVIDER_CHAIN: "codex-groq", GROQ_API_KEY: "q", CODEX_AUTH_PATH: AUTH_FIXTURE }, async () => {
    const chain = resolveCloudChain();
    const { fn, attempted } = fakeRequestFn({ codex: "ok", groq: "ok", local: "ok" });
    const res = await requestViaCloudChain(MSGS, chain, { __requestFn: fn });
    assert.equal(res.model, "gpt-5.5 via codex", "transcript attribution label");
    assert.equal(res.providerLabel, "codex");
    assert.equal(typeof res.latencyMs, "number");
    assert.deepEqual(attempted, ["gpt-5.5"], "groq/local untouched when codex serves");
  });
});

test("FALLBACK: codex 429 (window exhausted) falls to GROQ, NOT straight to local", async () => {
  await withEnv({ NOTDND_CLOUD_PROVIDER_CHAIN: "codex-groq", GROQ_API_KEY: "q", CODEX_AUTH_PATH: AUTH_FIXTURE }, async () => {
    const chain = resolveCloudChain();
    const { fn, attempted } = fakeRequestFn({ codex: 429, groq: "ok", local: "ok" });
    const res = await requestViaCloudChain(MSGS, chain, { __requestFn: fn });
    assert.equal(res.providerLabel, "groq");
    assert.deepEqual(attempted, ["gpt-5.5", "llama-3.3-70b-versatile"], "next CLOUD lane, local not reached");
    assert.ok(!attempted.some((m) => m.includes("inkborne")), "local is NOT the fallback for a codex failure");
  });
});

test("BATTERY + CHAIN: battery caller on a codex-groq chain is served by groq without touching codex", async () => {
  await withEnv({ NOTDND_CLOUD_PROVIDER_CHAIN: "codex-groq", GROQ_API_KEY: "q", CODEX_AUTH_PATH: AUTH_FIXTURE }, async () => {
    await runWithBatteryContext(async () => {
      const chain = resolveCloudChain();
      const { fn, attempted } = fakeRequestFn({ codex: "ok", groq: "ok", local: "ok" });
      const res = await requestViaCloudChain(MSGS, chain, { __requestFn: fn });
      assert.equal(res.providerLabel, "groq");
      assert.deepEqual(attempted, ["llama-3.3-70b-versatile"], "codex never attempted for battery traffic");
    });
  });
});

// ── PROXY: payload translation (pure) ────────────────────────────────────────
test("chatToResponsesPayload: system => instructions; user/assistant => input items; SSE forced", () => {
  withEnv({}, () => {
    const payload = chatToResponsesPayload({
      messages: [
        { role: "system", content: "You are the GM." },
        { role: "user", content: "I open the door." },
        { role: "assistant", content: "It creaks." },
        { role: "user", content: "I step through." }
      ]
    }, "gpt-5.5");
    assert.equal(payload.model, "gpt-5.5");
    assert.equal(payload.instructions, "You are the GM.");
    assert.equal(payload.input.length, 3);
    assert.deepEqual(payload.input.map((i) => i.role), ["user", "assistant", "user"]);
    assert.equal(payload.input[1].content[0].type, "output_text", "assistant history uses output_text");
    assert.equal(payload.stream, true, "the codex backend serves SSE only");
    assert.equal(payload.store, false, "GM context is never stored server-side");
    assert.deepEqual(payload.reasoning, { effort: "low" }, "default reasoning effort low");
  });
  withEnv({ CODEX_REASONING_EFFORT: "off" }, () => {
    const payload = chatToResponsesPayload({ messages: [{ role: "user", content: "hi" }] }, "gpt-5.5");
    assert.equal(payload.reasoning, undefined);
  });
});

// ── PROXY: 401 => re-read auth.json => retry ONCE (live-shaped, mock backend) ─
function sseBody(text) {
  return [
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`,
    "",
    `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 12, output_tokens: 4 } } })}`,
    "",
    "data: [DONE]",
    "",
    ""
  ].join("\n");
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function postChat(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}

test("PROXY 401 CONTRACT: expired token => re-read refreshed auth.json => retry once => 200", async () => {
  await withEnv({ CODEX_PROXY_NO_SPAWN: "1" }, async () => {
    const authPath = path.join(fixtureDir, "auth-rotating.json");
    fs.writeFileSync(authPath, JSON.stringify({ tokens: { access_token: "stale-token", account_id: "acct_test_fixture" } }));

    const seenTokens = [];
    const backend = http.createServer((req, res) => {
      const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      seenTokens.push(token);
      if (token === "stale-token") {
        // Simulate the CLI refreshing auth.json out-of-band (what `codex login
        // status` does for real) BEFORE rejecting the stale call.
        fs.writeFileSync(authPath, JSON.stringify({ tokens: { access_token: "fresh-token", account_id: "acct_test_fixture" } }));
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "token expired" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sseBody("The ruins hold their breath."));
    });
    const backendPort = await listen(backend);
    const proxy = createCodexProxy({ backendUrl: `http://127.0.0.1:${backendPort}/responses`, authPath });
    const proxyPort = await listen(proxy);
    try {
      const { status, json } = await postChat(proxyPort, { model: "gpt-5.5", messages: MSGS });
      assert.equal(status, 200, "retry with the refreshed token succeeds");
      assert.deepEqual(seenTokens, ["stale-token", "fresh-token"], "exactly one retry, with the RE-READ token");
      assert.equal(json.choices[0].message.content, "The ruins hold their breath.");
      assert.equal(json.usage.prompt_tokens, 12);
      assert.ok(!JSON.stringify(json).includes("fresh-token"), "auth material never appears in the response");
    } finally {
      proxy.close();
      backend.close();
    }
  });
});

test("PROXY 401 CONTRACT: a SECOND 401 passes upstream (chain then falls to next lane)", async () => {
  await withEnv({ CODEX_PROXY_NO_SPAWN: "1" }, async () => {
    const authPath = path.join(fixtureDir, "auth-dead.json");
    fs.writeFileSync(authPath, JSON.stringify({ tokens: { access_token: "dead-token", account_id: "acct_test_fixture" } }));
    let calls = 0;
    const backend = http.createServer((req, res) => {
      calls += 1;
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "token expired" } }));
    });
    const backendPort = await listen(backend);
    const proxy = createCodexProxy({ backendUrl: `http://127.0.0.1:${backendPort}/responses`, authPath });
    const proxyPort = await listen(proxy);
    try {
      const { status, json } = await postChat(proxyPort, { model: "gpt-5.5", messages: MSGS });
      assert.equal(status, 401, "second 401 surfaces upstream — no infinite retry");
      assert.equal(calls, 2, "exactly one retry");
      assert.ok(!JSON.stringify(json).includes("dead-token"), "token never echoed");
    } finally {
      proxy.close();
      backend.close();
    }
  });
});

test("PROXY: no auth.json at all => clean 401 without touching the backend", async () => {
  await withEnv({ CODEX_PROXY_NO_SPAWN: "1" }, async () => {
    const proxy = createCodexProxy({ backendUrl: "http://127.0.0.1:1/responses", authPath: path.join(fixtureDir, "absent.json") });
    const proxyPort = await listen(proxy);
    try {
      const { status } = await postChat(proxyPort, { model: "gpt-5.5", messages: MSGS });
      assert.equal(status, 401);
    } finally {
      proxy.close();
    }
  });
});

test("readCodexAuth: returns token/accountId shape or null; never throws", () => {
  withEnv({}, () => {
    assert.equal(readCodexAuth(path.join(fixtureDir, "absent.json")), null);
    const p = path.join(fixtureDir, "auth-shape.json");
    fs.writeFileSync(p, JSON.stringify({ tokens: { access_token: "tok", account_id: "acct" } }));
    assert.deepEqual(readCodexAuth(p), { token: "tok", accountId: "acct" });
    fs.writeFileSync(p, "not json");
    assert.equal(readCodexAuth(p), null);
  });
});
