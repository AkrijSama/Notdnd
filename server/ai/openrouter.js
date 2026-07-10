import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";
import { recordGmServe } from "../runtimeStatus.js";

// OpenAI-compatible chat-completions endpoint. Defaults to OpenRouter but can
// point at any compatible provider (Gemini AI Studio, Groq, etc.) via env.
// Brand rename (NotDND -> Inkborne): INKBORNE_* is read first, falling back to
// the legacy NOTDND_* so existing deployments keep working. The (?? ) group is
// parenthesized because mixing ?? and || without parens is a JS syntax error.
// Resolved at CALL time (not as a module-level const): index.js imports this
// module before its body runs loadDotenv(), and ES imports are evaluated before
// that body — so a const here would capture process.env BEFORE .env is loaded and
// freeze the openrouter.ai default, ignoring INKBORNE_LLM_BASE_URL. The key and
// model tiers are already read per-call (ensureApiKey/resolveModelTiers); the base
// must be too, or a Groq/other base in .env is silently dropped.
function resolveLlmBaseUrl() {
  return (
    (process.env.INKBORNE_LLM_BASE_URL ?? process.env.NOTDND_LLM_BASE_URL) ||
    "https://openrouter.ai/api/v1/chat/completions"
  );
}

// ZERO-COST defaults (no deposit/credit). The previous defaults pointed at PAID
// models (x-ai/grok-3) and credit-gated/throughput-limited ':free' tiers that 402/429
// on a no-credit account. Verified 2026-06-30: the clean, genuinely-$0-serving free
// pool is Google gemma-4 INSTRUCT (reasoning models like nemotron/gpt-oss/openrouter-
// free leak chain-of-thought into `content`). These rate-limit intermittently, so
// requestWithFallback degrades cleanly to the local inkborne-gm:8b workhorse. .env
// (gitignored) overrides these; a deploy MUST mirror them in its own env.
// THE GM NARRATION MODEL — ONE swappable value, read in ONE place (resolveGmModel).
// Director decision 2026-07-06: DeepSeek V4 is the GM; llama-3.3-70b is retired.
// Both routing regimes resolve the GM model HERE — the mainline narrative tier
// (resolveModelTiers) AND the paid graded-session "openrouter" cloud lane
// (buildCloudLane) — so there is no second hardcoded GM string anywhere. Override
// the model deploy-wide with NOTDND_GM_MODEL (INKBORNE_GM_MODEL alias); the paid
// lane additionally accepts OPENROUTER_LANE_MODEL as a lane-only escape hatch, but
// its DEFAULT now follows this single GM value rather than a private hardcode.
// v4-pro (not v4-flash): the flash variant is a reasoning model that spends hidden
// reasoning_tokens per call; pro follows the structured 80-120w style contract
// directly (verified live 2026-07-06). Its INPUT rate ($0.435/M) undercuts llama
// ($0.59/M) — GM turns are input-heavy — so per-turn cost lands at/below llama.
const GM_MODEL_DEFAULT = "deepseek/deepseek-v4-pro";
export function resolveGmModel() {
  return (process.env.INKBORNE_GM_MODEL ?? process.env.NOTDND_GM_MODEL) || GM_MODEL_DEFAULT;
}

const DEFAULT_MODELS = {
  utility: "google/gemma-4-31b-it:free",
  fallback: "google/gemma-4-31b-it:free"
};

const usageByCampaign = {};

// Per-attempt request timeouts (see requestOpenRouter). LOCAL gets a generous
// window because an 8b on a single consumer GPU under load is legitimately slow;
// CLOUD gets a tight one so a hung/over-quota cloud call fails fast and the chain
// drops to local rather than stalling the player's turn. Read at call time so a
// deploy can tune without a code change.
function gmLocalTimeoutMs() {
  const v = Number(process.env.NOTDND_GM_LOCAL_TIMEOUT_MS || process.env.INKBORNE_GM_LOCAL_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 60000;
}
function gmCloudTimeoutMs() {
  const v = Number(process.env.NOTDND_GM_CLOUD_TIMEOUT_MS || process.env.INKBORNE_GM_CLOUD_TIMEOUT_MS);
  // 35s (was 25s): deepseek-v4-pro legitimately takes 15-30s on a full narrative
  // turn, so a 25s ceiling ABORTED still-working calls mid-quality and dropped
  // them to the gemini fallback (2 of 16 turns in run_b06da13d). The tighter
  // window bought little there — those turns were already ~30s once the abort +
  // gemini retry is counted — while costing prose quality. 35s lets a slow-but-
  // -working deepseek turn finish on the premium model, while still bounding a
  // genuinely hung call. The interpreter no longer rides this window (it moved to
  // the fast lane), so this gates the narration call only. Tunable via env.
  return Number.isFinite(v) && v > 0 ? v : 35000;
}

function resolveModelTiers() {
  return {
    narrative: resolveGmModel(),
    utility: (process.env.INKBORNE_UTILITY_MODEL ?? process.env.NOTDND_UTILITY_MODEL) || DEFAULT_MODELS.utility,
    fallback: (process.env.INKBORNE_FALLBACK_MODEL ?? process.env.NOTDND_FALLBACK_MODEL) || DEFAULT_MODELS.fallback
  };
}

// --- TESTING-ONLY two-lane free cloud chain (Gemini Flash -> Groq -> local) -----
// Purpose: let the owner run a validation playthrough on fast, good-quality free
// cloud prose without paying and without capping to the slow local 8b mid-session.
// Gemini's free tier TRAINS ON PROMPTS and has no SLA — fine for solo validation,
// WRONG for shipped product — so this is strictly behind a flag and is NEVER the
// unconditional default. When the flag is unset/off, requestWithFallback behaves
// byte-for-byte as before (the OpenRouter path). Both providers expose OpenAI-
// compatible chat/completions endpoints, so the existing requestOpenRouter request
// path is reused via a per-lane `provider` override. Each lane's key is optional:
// a missing key SKIPS that lane (logged) and the chain tries the next, then local.
// Endpoints/models are env-overridable so a provider URL/model change needs no code
// edit (CONFIRM current free-tier models at ai.google.dev / console.groq.com).
const CLOUD_LANE_DEFAULTS = {
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-2.5-flash",
    keyEnv: ["GEMINI_API_KEY", "INKBORNE_GEMINI_API_KEY"],
    baseEnv: "GEMINI_BASE_URL",
    modelEnv: "GEMINI_MODEL"
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
    keyEnv: ["GROQ_API_KEY", "INKBORNE_GROQ_API_KEY"],
    baseEnv: "GROQ_BASE_URL",
    modelEnv: "GROQ_MODEL"
  }
};

// --- PERSONAL-TESTING "codex" lane (owner's ChatGPT subscription) -----------
// Routes GM calls through the local codex-proxy sidecar (server/ai/codex-proxy.mjs)
// to the Codex backend (gpt-5.5) using the Codex CLI's saved login. STRICTLY a
// testing instrument for the owner's prose-ceiling A/B + interpreter-reliability
// comparison: subscription-bound (rolling usage window, no SLA, unofficial
// endpoint) and NEVER for external users. Active only when "codex" is named in
// NOTDND_CLOUD_PROVIDER_CHAIN, and ALWAYS skipped for battery/harness callers.
const CODEX_LANE_DEFAULTS = {
  baseUrl: "http://127.0.0.1:8788/v1/chat/completions",
  model: "gpt-5.5"
};

function codexAuthPath() {
  return process.env.CODEX_AUTH_PATH || path.join(os.homedir(), ".codex", "auth.json");
}

// "Authenticated" = auth.json exists and carries an access token. The proxy does
// the full `codex login status` check at ITS startup; this per-call check must
// stay cheap (tiny file read, no process spawn) because it runs per GM call.
function codexAuthenticated() {
  try {
    const parsed = JSON.parse(fs.readFileSync(codexAuthPath(), "utf8"));
    return Boolean(String(parsed?.tokens?.access_token || "").trim());
  } catch {
    return false;
  }
}

// BATTERY GUARD: the selfplay/e2e/smoke batteries strip-mined the free cloud
// tiers; they must never touch the owner's subscription window. Two signals,
// either one skips the codex lane regardless of chain config:
//   1. NOTDND_BATTERY env (set by harness processes / harness-spawned servers)
//   2. request-scoped AsyncLocalStorage flag (set by the HTTP layer when a
//      request carries the x-notdnd-battery header — covers a harness driving
//      an ALREADY-RUNNING server whose own env has the chain enabled).
const batteryAls = new AsyncLocalStorage();

export function runWithBatteryContext(fn) {
  return batteryAls.run({ battery: true }, fn);
}

function batteryModeActive() {
  if (batteryAls.getStore()?.battery === true) {
    return true;
  }
  const v = String((process.env.NOTDND_BATTERY ?? process.env.INKBORNE_BATTERY) || "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "off";
}

function envFirst(names) {
  for (const name of names) {
    const v = String(process.env[name] || "").trim();
    if (v) {
      return v;
    }
  }
  return "";
}

// Builds ONE cloud lane: { name, provider } when its key is present, else
// { name, skip } so the chain logs and moves on. Unknown lane names return null.
// Exported for the A/B replay instruments (scripts/prose-ab.mjs).
export function buildCloudLane(name) {
  const key = String(name || "").trim().toLowerCase();
  if (key === "codex") {
    if (batteryModeActive()) {
      return { name: "codex", skip: "battery/harness caller — subscription lane never serves automated traffic" };
    }
    if (!codexAuthenticated()) {
      return { name: "codex", skip: `codex CLI not authenticated (no usable ${codexAuthPath()})` };
    }
    const timeoutMs = Number(process.env.NOTDND_GM_CODEX_TIMEOUT_MS || process.env.INKBORNE_GM_CODEX_TIMEOUT_MS);
    const model = String(process.env.CODEX_MODEL || "").trim() || CODEX_LANE_DEFAULTS.model;
    return {
      name: "codex",
      provider: {
        baseUrl: String(process.env.CODEX_PROXY_URL || "").trim() || CODEX_LANE_DEFAULTS.baseUrl,
        model,
        key: null,
        // The proxy authenticates with the CLI's saved login — the lane itself
        // carries NO key and must not trip ensureApiKey.
        keyless: true,
        local: false,
        // gpt-5.5 is a reasoning model: a narration turn legitimately outlasts
        // the tight cloud window, so it gets a LOCAL-ish per-attempt timeout.
        timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60000,
        // Transcript attribution: "narration: cloud (gpt-5.5 via codex) in Xms".
        modelLabel: `${model} via codex`
      }
    };
  }
  // --- PAID "openrouter" lane (the graded-session lane) ----------------------
  // Free tiers mathematically cannot carry a graded session (Groq 100k TPD dies
  // ~turn 10-15; Gemini free daily dies next — two sessions killed in one day).
  // This lane spends REAL credit: paid model id (never :free), with OpenRouter
  // provider routing preferring Groq for latency (allow_fallbacks keeps other
  // PAID providers as backup — the model id itself is the paid SKU). Battery
  // guard mirrors the codex lane: automated traffic never spends the owner's $10.
  if (key === "openrouter") {
    if (batteryModeActive()) {
      return { name: "openrouter", skip: "battery/harness caller — the PAID lane never serves automated traffic" };
    }
    const paidKey = envFirst(["OPENROUTER_API_KEY", "INKBORNE_LLM_API_KEY", "NOTDND_LLM_API_KEY"]);
    if (!paidKey) {
      return { name: "openrouter", skip: "no OPENROUTER_API_KEY" };
    }
    // GM model: the SINGLE swappable value (resolveGmModel — DeepSeek V4 by default),
    // with OPENROUTER_LANE_MODEL as a lane-only override for pinning the paid lane
    // to a different SKU than mainline. No private hardcode here.
    const model = String(process.env.OPENROUTER_LANE_MODEL || "").trim() || resolveGmModel();
    // Provider-routing preference. The old "groq" default was a llama-3.3-70b latency
    // optimization; DeepSeek V4 is not served by Groq, so forcing that order only adds
    // a dead hop before allow_fallbacks recovers. Default to NO forced order (let
    // OpenRouter pick the best provider of the model); OPENROUTER_PROVIDER_ORDER still
    // overrides when a deploy wants to pin a provider for a groq-served model.
    const order = String(process.env.OPENROUTER_PROVIDER_ORDER || "").trim()
      .split(/[\s,]+/)
      .filter(Boolean);
    return {
      name: "openrouter",
      provider: {
        baseUrl: String(process.env.OPENROUTER_LANE_BASE_URL || "").trim() || "https://openrouter.ai/api/v1/chat/completions",
        model,
        key: paidKey,
        local: false,
        // OpenRouter provider routing (docs: provider.order, lowercase slugs): an
        // explicit order pins preference; when unset, omit `order` entirely and let
        // OpenRouter route to the best provider of the paid model (allow_fallbacks
        // keeps other paid providers as backup).
        extraBody: { provider: order.length ? { order, allow_fallbacks: true } : { allow_fallbacks: true } }
      }
    };
  }
  const spec = CLOUD_LANE_DEFAULTS[key];
  if (!spec) {
    return null;
  }
  const apiKey = envFirst(spec.keyEnv);
  if (!apiKey) {
    return { name: key, skip: `no ${spec.keyEnv[0]}` };
  }
  return {
    name: key,
    provider: {
      baseUrl: String(process.env[spec.baseEnv] || "").trim() || spec.baseUrl,
      model: String(process.env[spec.modelEnv] || "").trim() || spec.model,
      key: apiKey,
      local: false
    }
  };
}

// Resolves the testing cloud chain from NOTDND_CLOUD_PROVIDER_CHAIN (or the
// INKBORNE_ alias). Off/unset/false/0 -> null (unchanged OpenRouter behavior).
// "on"/"true" -> the default gemini->groq order; an explicit ordered list like
// "gemini-groq" or "gemini,groq" is honored. Read at CALL TIME.
export function resolveCloudChain() {
  const raw = String(
    (process.env.NOTDND_CLOUD_PROVIDER_CHAIN ?? process.env.INKBORNE_CLOUD_PROVIDER_CHAIN) || ""
  ).trim().toLowerCase();
  if (!raw || raw === "off" || raw === "0" || raw === "false") {
    return null;
  }
  const order = raw === "on" || raw === "true" || raw === "1" ? ["gemini", "groq"] : raw.split(/[\s,>-]+/).filter(Boolean);
  const lanes = order.map(buildCloudLane).filter(Boolean);
  return lanes.length ? lanes : null;
}

function rawApiKey() {
  // INKBORNE_LLM_API_KEY is the primary name; NOTDND_LLM_API_KEY (legacy brand)
  // and OPENROUTER_API_KEY remain fallbacks so existing setups keep working.
  return String(
    (process.env.INKBORNE_LLM_API_KEY ?? process.env.NOTDND_LLM_API_KEY) || process.env.OPENROUTER_API_KEY || ""
  ).trim();
}

function ensureApiKey() {
  const apiKey = rawApiKey();
  if (!apiKey) {
    const error = new Error("INKBORNE_LLM_API_KEY (or OPENROUTER_API_KEY) is required.");
    error.code = "MISSING_API_KEY";
    error.statusCode = 500;
    throw error;
  }
  return apiKey;
}

// --- Edition-routed GM provider ---------------------------------------------
// Forbidden Mode AND the cloud->local fallback both target a LOCAL OpenAI-
// compatible endpoint (Ollama) serving an uncensored model — no API key, content
// never leaves the box. Resolved at CALL TIME (never a module-level const), like
// the cloud base/model/key, so .env loaded after import is honored.
const LOCAL_GM_DEFAULTS = {
  baseUrl: "http://127.0.0.1:11434/v1/chat/completions",
  // Current 8B uncensored GM (Nous Hermes 3 / Llama 3.1, Q4_K_M) with context
  // capped to 8192 via Modelfile so it stays fully GPU-resident on an 8GB card —
  // stronger structured-output/function-calling than the retired Llama-3.0
  // dolphin-llama3:8b. Overridable via INKBORNE_FORBIDDEN_LLM_MODEL.
  model: "inkborne-gm:8b"
};

function resolveLocalProvider() {
  return {
    baseUrl:
      (process.env.INKBORNE_FORBIDDEN_LLM_BASE_URL ?? process.env.NOTDND_FORBIDDEN_LLM_BASE_URL) ||
      LOCAL_GM_DEFAULTS.baseUrl,
    model:
      (process.env.INKBORNE_FORBIDDEN_LLM_MODEL ?? process.env.NOTDND_FORBIDDEN_LLM_MODEL) ||
      LOCAL_GM_DEFAULTS.model,
    key: null,
    local: true
  };
}

/**
 * ONE resolver: edition (+ fallback flag) -> { baseUrl, model, key, local, edition }.
 *  - 'mainline'          -> cloud (UNCHANGED: LLM base + narrative model + key)
 *  - 'forbidden'         -> local uncensored model (no key)
 *  - { fallback: true }  -> local regardless of edition (the cloud->local recovery)
 * Pure + call-time; never throws (cloud key may be empty — enforced at call time).
 * @param {string} edition
 * @param {{ fallback?: boolean }} [opts]
 * @returns {{ baseUrl: string, model: string, key: string|null, local: boolean, edition: string }}
 */
export function resolveGmProvider(edition = "mainline", { fallback = false } = {}) {
  const ed = String(edition || "mainline").trim().toLowerCase();
  if (ed === "forbidden" || fallback === true) {
    return { ...resolveLocalProvider(), edition: ed };
  }
  return {
    baseUrl: resolveLlmBaseUrl(),
    model: resolveModelTiers().narrative,
    key: rawApiKey() || null,
    local: false,
    edition: ed
  };
}

// Cloud->local fallback is ON by default; disable with INKBORNE_GM_LOCAL_FALLBACK=false.
// Exported: /api/debug/status surfaces this so GPU-safety is visible at a glance.
export function localFallbackEnabled() {
  const v = String((process.env.INKBORNE_GM_LOCAL_FALLBACK ?? process.env.NOTDND_GM_LOCAL_FALLBACK) || "")
    .trim()
    .toLowerCase();
  return v !== "false" && v !== "0" && v !== "off";
}

function normalizeTokens(usage = {}) {
  return {
    prompt: Number(usage.prompt_tokens || usage.input_tokens || 0) || 0,
    completion: Number(usage.completion_tokens || usage.output_tokens || 0) || 0
  };
}

function normalizeCost(usage = {}) {
  const candidates = [usage.total_cost, usage.cost, usage.estimated_cost, usage.usd_cost];
  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function safeMessageContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function mockModeEnabled() {
  return String((process.env.INKBORNE_MOCK_OPENROUTER ?? process.env.NOTDND_MOCK_OPENROUTER) || "").trim().toLowerCase() === "true";
}

function pushUsage(campaignId, tier, model, usage, cost) {
  const key = String(campaignId || "unknown-campaign");
  if (!usageByCampaign[key]) {
    usageByCampaign[key] = {
      campaignId: key,
      promptTokens: 0,
      completionTokens: 0,
      totalCost: 0,
      totalCalls: 0,
      tiers: {
        narrative: { promptTokens: 0, completionTokens: 0, totalCost: 0, calls: 0 },
        utility: { promptTokens: 0, completionTokens: 0, totalCost: 0, calls: 0 },
        fallback: { promptTokens: 0, completionTokens: 0, totalCost: 0, calls: 0 },
        custom: { promptTokens: 0, completionTokens: 0, totalCost: 0, calls: 0 }
      },
      updatedAt: new Date().toISOString()
    };
  }

  const bucketName = usageByCampaign[key].tiers[tier] ? tier : "custom";
  const bucket = usageByCampaign[key].tiers[bucketName];

  usageByCampaign[key].promptTokens += usage.prompt;
  usageByCampaign[key].completionTokens += usage.completion;
  usageByCampaign[key].totalCalls += 1;

  bucket.promptTokens += usage.prompt;
  bucket.completionTokens += usage.completion;
  bucket.calls += 1;

  if (cost !== null) {
    usageByCampaign[key].totalCost += cost;
    bucket.totalCost += cost;
  }

  usageByCampaign[key].lastModel = model;
  usageByCampaign[key].updatedAt = new Date().toISOString();
}

function parseSseData(buffer, onJson) {
  let rest = buffer;
  const events = [];

  while (true) {
    const match = rest.match(/\r?\n\r?\n/);
    if (!match || match.index === undefined) {
      break;
    }
    const splitIdx = match.index;
    const delimiterLength = match[0].length;

    const rawEvent = rest.slice(0, splitIdx);
    rest = rest.slice(splitIdx + delimiterLength);

    const lines = rawEvent.split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith("data:")) {
        continue;
      }
      const data = line.slice(5).trim();
      if (!data) {
        continue;
      }
      if (data === "[DONE]") {
        events.push({ done: true });
        continue;
      }
      try {
        const parsed = JSON.parse(data);
        onJson(parsed);
      } catch {
        // Ignore malformed chunks.
      }
    }
  }

  return { rest, events };
}

async function parseStreamingResponse(response, options = {}) {
  const decoder = new TextDecoder();
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("OpenRouter streaming response body is unavailable.");
  }

  let textBuffer = "";
  let content = "";
  let usage = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    textBuffer += decoder.decode(value, { stream: true });
    const parsed = parseSseData(textBuffer, (chunk) => {
      if (chunk?.usage) {
        usage = chunk.usage;
      }
      const delta = safeMessageContent(chunk?.choices?.[0]?.delta?.content);
      if (delta) {
        content += delta;
        options.onStream?.(delta);
      }
    });

    textBuffer = parsed.rest;
    if (parsed.events.some((evt) => evt.done)) {
      break;
    }
  }

  return {
    content: String(content || "").trim(),
    usage
  };
}

async function parseJsonResponse(response) {
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const errorMessage = payload?.error?.message || payload?.message || payload?.raw || `HTTP ${response.status}`;
    const error = new Error(`OpenRouter request failed (${response.status}): ${errorMessage}`);
    error.statusCode = response.status;
    error.code = "OPENROUTER_ERROR";
    throw error;
  }

  return {
    content: safeMessageContent(payload?.choices?.[0]?.message?.content).trim(),
    usage: payload?.usage || {}
  };
}

async function requestOpenRouter(messages, model, options = {}) {
  if (mockModeEnabled()) {
    const userText = Array.isArray(messages)
      ? messages
          .filter((entry) => entry?.role === "user")
          .map((entry) => String(entry?.content || ""))
          .join("\n")
      : "";

    let content = "The tavern breathes with rain and smoke as the keeper studies you with careful eyes.";
    if (/pick the lock|lock/i.test(userText)) {
      content = "The keeper lowers their voice and points to a rusted lock on an old ledger box.\n\n[CHECK: Dexterity DC 14]\n\n\"Show me how steady your hands are.\"";
    } else if (/initiative|combat|fight/i.test(userText)) {
      content = "Steel rings from the doorway as a brute shoves through the crowd.\n\n[INITIATIVE]\n\nThe room erupts into motion.";
    } else if (/tavern|flagon|keeper/i.test(userText)) {
      content = "The Shattered Flagon smells of wet wool and lamp oil. The keeper dries a glass without looking away from you.";
    }

    if (options.stream && typeof options.onStream === "function") {
      const chunks = content.match(/.{1,36}/g) || [content];
      for (const chunk of chunks) {
        options.onStream(chunk);
      }
    }

    return {
      content,
      model,
      tokensUsed: {
        prompt: Math.max(1, Math.floor(userText.length / 4)),
        completion: Math.max(1, Math.floor(content.length / 4))
      },
      cost: 0
    };
  }

  // Provider override (edition routing / cloud->local fallback): when present,
  // target its base + key. Local providers carry no key — skip ensureApiKey and
  // the Authorization header. Without an override, behave exactly as before.
  const provider = options.provider || null;
  const isLocal = Boolean(provider?.local);
  const LLM_BASE_URL = provider?.baseUrl || resolveLlmBaseUrl();
  let apiKey = "";
  if (isLocal || provider?.keyless === true) {
    // Local Ollama and the codex-proxy lane authenticate out-of-band (or not at
    // all) — requiring an API key here would wrongly throw MISSING_API_KEY.
    apiKey = String(provider?.key || "").trim();
  } else if (provider) {
    apiKey = String(provider.key || "").trim() || ensureApiKey();
  } else {
    apiKey = ensureApiKey();
  }

  const body = {
    model,
    messages: Array.isArray(messages) ? messages : [],
    stream: Boolean(options.stream)
  };

  if (Number.isFinite(Number(options.temperature))) {
    body.temperature = Number(options.temperature);
  }
  if (Number.isFinite(Number(options.maxResponseTokens))) {
    body.max_tokens = Math.max(1, Number(options.maxResponseTokens));
  }
  // OpenRouter-SPECIFIC body fields (`reasoning`, provider-routing `extraBody`)
  // are rejected with a 400 by strict OpenAI-compatible endpoints like Gemini's
  // (generativelanguage/.../openai) — which silently cost the utility fast-lane a
  // wasted attempt before it fell back to deepseek. Only send them to the actual
  // OpenRouter base; other lanes (gemini, groq) get the plain OpenAI-schema body.
  const isOpenRouterBase = String(LLM_BASE_URL || "").includes("openrouter.ai");
  // Reasoning control (OpenRouter `reasoning` field). Mechanical utility calls
  // (fact extraction, etc.) do NOT need a reasoning model's hidden deliberation —
  // and on a reasoning model an uncapped or tightly-capped call spends the whole
  // token budget on reasoning, leaving ZERO content (empty JSON → dropped write).
  // Passing `{ enabled: false }` turns reasoning off so the budget goes to output.
  if (isOpenRouterBase && options.reasoning && typeof options.reasoning === "object") {
    body.reasoning = options.reasoning;
  }
  if (Array.isArray(options.stopSequences) && options.stopSequences.length > 0) {
    body.stop = options.stopSequences.filter((entry) => String(entry || "").trim());
  }
  // Lane-scoped extra body fields (e.g. the paid OpenRouter lane's provider
  // routing preference). Additive only — never overrides the core fields above.
  if (isOpenRouterBase && provider?.extraBody && typeof provider.extraBody === "object") {
    for (const [extraKey, extraValue] of Object.entries(provider.extraBody)) {
      if (!(extraKey in body)) {
        body[extraKey] = extraValue;
      }
    }
  }

  const headers = {
    "Content-Type": "application/json",
    "HTTP-Referer": "https://inkborne.com",
    "X-Title": "Inkborne"
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  // PER-PROVIDER TIMEOUT (the "GM goes quiet" fix). A LOCAL 8b generation on the
  // owner's RTX 4060 is legitimately slower than a cloud call, so it gets a far
  // larger window; a CLOUD call that exceeds its (tight) window is treated as hung
  // and aborted so requestWithFallback drops to local instead of stalling the turn.
  // This distinguishes "slow-local-but-working" from "dead-cloud" WITHOUT masking:
  // a cloud call can never silently eat the whole budget, and a local call is given
  // the time it genuinely needs. Tunable via NOTDND_GM_{LOCAL,CLOUD}_TIMEOUT_MS.
  // A lane may carry its own window (codex/gpt-5.5 is a reasoning model and
  // legitimately outlasts the tight cloud window); otherwise local vs cloud.
  const laneTimeoutMs = Number(provider?.timeoutMs);
  const perAttemptTimeoutMs = Number.isFinite(laneTimeoutMs) && laneTimeoutMs > 0
    ? laneTimeoutMs
    : isLocal ? gmLocalTimeoutMs() : gmCloudTimeoutMs();
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), perAttemptTimeoutMs) : null;
  // The timeout must cover the WHOLE call — headers AND body read. A reasoning
  // model behind a slow provider can send response headers fast, then stream the
  // body (or its hidden reasoning) for tens of seconds; if the abort timer were
  // cleared right after fetch() resolved (headers), that runaway body would blow
  // straight past the ceiling unbounded. Keeping the timer live until the parse
  // completes means an over-budget generation trips the abort mid-body and falls
  // back, exactly as a hung header would. (This closed the 40s+ single-call tail.)
  try {
    const response = await fetch(LLM_BASE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {})
    });

    if (!response.ok) {
      const rawBody = await response.text();
      // Visible, not silent: this exact line (wrong base / bad key / 429) is what a
      // swallowed GM error otherwise hides — surface the status, base, model + body.
      console.warn(`[GM] LLM ${response.status} from ${LLM_BASE_URL} (model ${model}): ${rawBody.slice(0, 200)}`);
      let payload = {};
      try {
        payload = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        payload = { raw: rawBody };
      }
      const errorMessage = payload?.error?.message || payload?.message || payload?.raw || `HTTP ${response.status}`;
      const error = new Error(`OpenRouter request failed (${response.status}): ${errorMessage}`);
      error.statusCode = response.status;
      error.code = "OPENROUTER_ERROR";
      throw error;
    }

    const parsed = options.stream ? await parseStreamingResponse(response, options) : await parseJsonResponse(response);
    const tokensUsed = normalizeTokens(parsed.usage);
    const cost = normalizeCost(parsed.usage);

    return {
      content: parsed.content || "",
      model,
      tokensUsed,
      cost
    };
  } catch (fetchError) {
    if (fetchError?.name === "AbortError") {
      console.warn(`[GM] ${isLocal ? "LOCAL" : "cloud"} call ABORTED after ${perAttemptTimeoutMs}ms (model ${model}) — ${isLocal ? "local 8b exceeded its window" : "treating as hung/runaway; will fall back"}`);
      const timeoutError = new Error(`GM request timed out after ${perAttemptTimeoutMs}ms (${isLocal ? "local" : "cloud"} model ${model})`);
      timeoutError.code = "GM_TIMEOUT";
      timeoutError.statusCode = 504;
      timeoutError.local = isLocal;
      throw timeoutError;
    }
    throw fetchError;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

// Executes the TESTING cloud chain: each cloud lane in order (Gemini -> Groq),
// then the LOCAL 8b as LAST RESORT. A lane error/cap/timeout falls to the NEXT
// cloud lane (never straight to local); local is reached only after every cloud
// lane fails. Each hop is logged (served-by / skipped / failed + latency + reason)
// so the trail is visible in the server log; the RETURNED response carries the
// real serving model in `.model` (so the per-turn transcript attributes the right
// model, e.g. "cloud (gemini-2.5-flash)") plus providerLabel/latencyMs metadata.
export async function requestViaCloudChain(messages, lanes, options = {}) {
  // Injectable request seam so the routing (order / fallback / local-last-resort)
  // is unit-testable WITHOUT mutating global fetch — a global-fetch stub leaks
  // across the parallel test runner and flakes unrelated (server-spawning) suites.
  // Real calls omit __requestFn and use requestOpenRouter unchanged.
  const requestFn = typeof options.__requestFn === "function" ? options.__requestFn : requestOpenRouter;
  const laneOptions = { ...options };
  delete laneOptions.__requestFn;
  let lastError = null;
  for (const lane of Array.isArray(lanes) ? lanes : []) {
    if (lane.skip) {
      console.warn(`[GM] cloud chain: SKIP ${lane.name} (${lane.skip}) — trying next lane`);
      continue;
    }
    const t0 = Date.now();
    try {
      const res = await requestFn(messages, lane.provider.model, { ...laneOptions, provider: lane.provider });
      const latencyMs = Date.now() - t0;
      // modelLabel (e.g. "gpt-5.5 via codex") overrides the returned model string
      // so the per-turn transcript attributes the LANE, not just the model name.
      const servedModel = lane.provider.modelLabel || res.model;
      console.warn(`[GM] cloud chain: SERVED by ${lane.name} (${servedModel}) in ${latencyMs}ms`);
      return { ...res, model: servedModel, providerLabel: lane.name, latencyMs };
    } catch (laneError) {
      lastError = laneError;
      const latencyMs = Date.now() - t0;
      console.warn(
        `[GM] cloud chain: ${lane.name} (${lane.provider.model}) FAILED ` +
          `(${laneError?.statusCode || laneError?.code || "error"}) in ${latencyMs}ms — falling to next lane`
      );
    }
  }
  // Every cloud lane failed/skipped -> LOCAL 8b as the LAST resort (never before).
  if (localFallbackEnabled() && !mockModeEnabled()) {
    const local = resolveGmProvider("mainline", { fallback: true });
    console.warn(`[GM] cloud chain EXHAUSTED; falling back to LOCAL ${local.baseUrl} (model ${local.model})`);
    const t0 = Date.now();
    try {
      const res = await requestFn(messages, local.model, { ...laneOptions, provider: local, stream: false });
      return { ...res, providerLabel: "local", latencyMs: Date.now() - t0 };
    } catch (localError) {
      console.warn(`[GM] cloud chain: LOCAL last-resort ALSO failed: ${String(localError?.message || localError).slice(0, 160)}`);
    }
  }
  throw lastError || Object.assign(new Error("cloud chain: all providers failed"), { code: "CLOUD_CHAIN_EXHAUSTED", statusCode: 502 });
}

async function requestWithFallback(messages, preferredModel, options = {}) {
  const edition = String(options.edition || "mainline").trim().toLowerCase();

  // Forbidden Mode: route straight to the LOCAL uncensored model — no cloud call,
  // no key, content never leaves the box. Edition resolved per-call (not a const).
  if (edition === "forbidden") {
    const local = resolveGmProvider("forbidden");
    const tf = Date.now();
    const res = await requestOpenRouter(messages, local.model, { ...options, provider: local });
    return { ...res, providerLabel: "local", latencyMs: Date.now() - tf, local: true };
  }

  // INTERPRETER FAST-LANE (latency #49, opt-in). The attempt interpreter is a
  // SEQUENTIAL, roll-gating utility call (~8s on DeepSeek V4, measured) that runs
  // before narration on every contested turn. Routing the whole utility tier to
  // the FREE gemini lane 429-rate-limits (reverted, see below), but pointing JUST
  // the interpreter at a fast RELIABLE model cuts that ~8s with no effect on the
  // narration model or the chain. Opt-in: set NOTDND_INTERPRETER_MODEL to a fast
  // model and pass { model, bypassChain:true } (attemptInterpreter does). A single
  // direct attempt — on failure the interpreter catches and falls back to its
  // heuristic classification, so this can only speed up, never break, a turn.
  if (!mockModeEnabled() && options.bypassChain && typeof options.model === "string" && options.model.trim()) {
    const t0 = Date.now();
    const res = await requestOpenRouter(messages, options.model.trim(), options);
    return { ...res, providerLabel: "openrouter", latencyMs: Date.now() - t0, local: false };
  }

  // TESTING two-lane cloud chain (flagged, off by default). When active it REPLACES
  // the OpenRouter cloud portion with Gemini -> Groq, keeping local as last resort;
  // mock mode skips it so tests stay hermetic. Unset/off => the unchanged path below.
  if (!mockModeEnabled()) {
    const chain = resolveCloudChain();
    if (chain) {
      // NOTE: routing the utility tier (interpreter/suggestions) to the fast
      // gemini lane FIRST was tried and reverted — the free gemini tier 429-rate-
      // limits under per-turn interpreter volume (16/17 calls failed in testing),
      // so it added a wasted attempt AND burned the gemini quota the NARRATION
      // fallback needs. The reliable interpreter-latency win is to SKIP the
      // interpreter for no-check actions instead (see buildLiveAttemptOptions).
      return await requestViaCloudChain(messages, chain, options);
    }
  }

  // Mainline: cloud preferred model -> cloud fallback model -> LOCAL fallback.
  // Each successful path is stamped with its real serving attribution
  // (providerLabel + latencyMs + local) so callers can record what ACTUALLY
  // served — the cloud-chain path already returns the same shape.
  const tiers = resolveModelTiers();
  const t0 = Date.now();
  try {
    const res = await requestOpenRouter(messages, preferredModel, options);
    return { ...res, providerLabel: "openrouter", latencyMs: Date.now() - t0, local: false };
  } catch (primaryError) {
    let cloudError = primaryError;
    if (preferredModel !== tiers.fallback) {
      try {
        const tf = Date.now();
        const res = await requestOpenRouter(messages, tiers.fallback, options);
        return { ...res, providerLabel: "openrouter", latencyMs: Date.now() - tf, local: false };
      } catch (fallbackError) {
        cloudError = fallbackError;
      }
    }

    // Cloud is down (429 / timeout / non-200). Instead of blanking to the canned
    // template, fall back to the LOCAL uncensored model so normal mainline play
    // survives a quota wall or outage. Best-effort; surfaces the cloud cause if
    // local also fails. Skipped in mock mode so tests stay hermetic.
    if (localFallbackEnabled() && !mockModeEnabled()) {
      const local = resolveGmProvider("mainline", { fallback: true });
      console.warn(
        `[GM] cloud GM call failed (${cloudError?.statusCode || cloudError?.code || "error"}); ` +
          `falling back to LOCAL ${local.baseUrl} (model ${local.model})`
      );
      try {
        const tl = Date.now();
        const res = await requestOpenRouter(messages, local.model, { ...options, provider: local, stream: false });
        return { ...res, providerLabel: "local", latencyMs: Date.now() - tl, local: true };
      } catch (localError) {
        console.warn(`[GM] LOCAL fallback also failed: ${String(localError?.message || localError).slice(0, 160)}`);
      }
    }

    throw cloudError;
  }
}

// --- GM-call capture (A/B replay raw material) -------------------------------
// When NOTDND_GM_CAPTURE is truthy, every narrative/utility call's EXACT
// messages are appended to data/logs/gm-capture.jsonl so scripts/prose-ab.mjs
// can replay a specific turn's context against two named lanes verbatim.
// Owner-testing instrument: off by default, best-effort, never throws.
export function gmCapturePath() {
  const root = process.env.NOTDND_LOGS_ROOT
    ? path.resolve(process.env.NOTDND_LOGS_ROOT)
    : path.resolve(process.cwd(), "data/logs");
  return path.join(root, "gm-capture.jsonl");
}

function captureGmCall(campaignId, tier, messages) {
  const flag = String(process.env.NOTDND_GM_CAPTURE || "").trim().toLowerCase();
  if (!flag || flag === "0" || flag === "false" || flag === "off") {
    return;
  }
  try {
    const file = gmCapturePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), campaignId, tier, messages }) + "\n", "utf8");
  } catch {
    // Capture is debugging infra — it must never break a turn.
  }
}

/**
 * Returns per-campaign AI token and cost usage for the current server session.
 * @param {string} campaignId
 * @returns {object}
 */
export function getCampaignUsage(campaignId) {
  const key = String(campaignId || "unknown-campaign");
  return usageByCampaign[key]
    ? JSON.parse(JSON.stringify(usageByCampaign[key]))
    : {
        campaignId: key,
        promptTokens: 0,
        completionTokens: 0,
        totalCost: 0,
        totalCalls: 0,
        tiers: {
          narrative: { promptTokens: 0, completionTokens: 0, totalCost: 0, calls: 0 },
          utility: { promptTokens: 0, completionTokens: 0, totalCost: 0, calls: 0 },
          fallback: { promptTokens: 0, completionTokens: 0, totalCost: 0, calls: 0 },
          custom: { promptTokens: 0, completionTokens: 0, totalCost: 0, calls: 0 }
        },
        updatedAt: new Date().toISOString()
      };
}

/**
 * Returns the configured model tier mapping.
 * @returns {{narrative: string, utility: string, fallback: string}}
 */
export function getModelTiers() {
  return resolveModelTiers();
}

/**
 * Generates narrative output with the narrative tier model.
 * @param {Array<{role: string, content: string}>} messages
 * @param {string} campaignId
 * @param {{stream?: boolean, onStream?: (chunk: string) => void, temperature?: number, maxResponseTokens?: number, stopSequences?: string[]}} [options]
 * @returns {Promise<{content: string, model: string, tokensUsed: {prompt: number, completion: number}, cost: number | null}>}
 */
export async function generateNarrative(messages, campaignId, options = {}) {
  const tiers = resolveModelTiers();
  captureGmCall(campaignId, "narrative", messages);
  // V4 FLASH NON-THINK PIN (flash-trial Jul 10): deepseek-v4-flash is a reasoning
  // model (Non-Think / Think-High / Think-Max); un-pinned it spends hidden
  // reasoning_tokens per narration — added latency AND billed tokens for prose
  // that the style contract fully specifies. Pin reasoning OFF for flash
  // narration unless the caller explicitly set a reasoning option. No effect on
  // non-flash models (pro ignores it server-side either way).
  const narrativeOptions =
    /deepseek-v4-flash/i.test(tiers.narrative) && !options.reasoning
      ? { ...options, reasoning: { enabled: false } }
      : options;
  const response = await requestWithFallback(messages, tiers.narrative, narrativeOptions);
  pushUsage(campaignId, response.model === tiers.fallback ? "fallback" : "narrative", response.model, response.tokensUsed, response.cost);
  // Live attribution for the debug panel: the model that ACTUALLY served this
  // GM turn (narrative is the headline "GM MODEL"), not the configured value.
  recordGmServe({
    tier: "narrative",
    model: response.model,
    provider: response.providerLabel || "openrouter",
    latencyMs: response.latencyMs,
    local: response.local === true || response.providerLabel === "local",
    fallback: response.model !== tiers.narrative,
    configuredModel: tiers.narrative
  });
  return response;
}

/**
 * Generates utility output with the utility tier model.
 * @param {Array<{role: string, content: string}>} messages
 * @param {string} campaignId
 * @param {{stream?: boolean, onStream?: (chunk: string) => void, temperature?: number, maxResponseTokens?: number, stopSequences?: string[]}} [options]
 * @returns {Promise<{content: string, model: string, tokensUsed: {prompt: number, completion: number}, cost: number | null}>}
 */
export async function generateUtility(messages, campaignId, options = {}) {
  const tiers = resolveModelTiers();
  captureGmCall(campaignId, "utility", messages);
  const response = await requestWithFallback(messages, tiers.utility, options);
  pushUsage(campaignId, response.model === tiers.fallback ? "fallback" : "utility", response.model, response.tokensUsed, response.cost);
  return response;
}

/**
 * Generates output using an explicit model name.
 * @param {Array<{role: string, content: string}>} messages
 * @param {string} model
 * @param {string} campaignId
 * @param {{stream?: boolean, onStream?: (chunk: string) => void, temperature?: number, maxResponseTokens?: number, stopSequences?: string[]}} [options]
 * @returns {Promise<{content: string, model: string, tokensUsed: {prompt: number, completion: number}, cost: number | null}>}
 */
export async function generateRaw(messages, model, campaignId, options = {}) {
  const resolvedModel = String(model || "").trim() || resolveModelTiers().narrative;
  const response = await requestWithFallback(messages, resolvedModel, options);
  const tiers = resolveModelTiers();
  const tier = response.model === tiers.fallback ? "fallback" : "custom";
  pushUsage(campaignId, tier, response.model, response.tokensUsed, response.cost);
  return response;
}
