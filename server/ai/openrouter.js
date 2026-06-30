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
const DEFAULT_MODELS = {
  narrative: "google/gemma-4-26b-a4b-it:free",
  utility: "google/gemma-4-31b-it:free",
  fallback: "google/gemma-4-31b-it:free"
};

const usageByCampaign = {};

function resolveModelTiers() {
  return {
    narrative: (process.env.INKBORNE_GM_MODEL ?? process.env.NOTDND_GM_MODEL) || DEFAULT_MODELS.narrative,
    utility: (process.env.INKBORNE_UTILITY_MODEL ?? process.env.NOTDND_UTILITY_MODEL) || DEFAULT_MODELS.utility,
    fallback: (process.env.INKBORNE_FALLBACK_MODEL ?? process.env.NOTDND_FALLBACK_MODEL) || DEFAULT_MODELS.fallback
  };
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
function localFallbackEnabled() {
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
  if (isLocal) {
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
  if (Array.isArray(options.stopSequences) && options.stopSequences.length > 0) {
    body.stop = options.stopSequences.filter((entry) => String(entry || "").trim());
  }

  const headers = {
    "Content-Type": "application/json",
    "HTTP-Referer": "https://inkborne.com",
    "X-Title": "Inkborne"
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const response = await fetch(LLM_BASE_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
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
}

async function requestWithFallback(messages, preferredModel, options = {}) {
  const edition = String(options.edition || "mainline").trim().toLowerCase();

  // Forbidden Mode: route straight to the LOCAL uncensored model — no cloud call,
  // no key, content never leaves the box. Edition resolved per-call (not a const).
  if (edition === "forbidden") {
    const local = resolveGmProvider("forbidden");
    return requestOpenRouter(messages, local.model, { ...options, provider: local });
  }

  // Mainline: cloud preferred model -> cloud fallback model -> LOCAL fallback.
  const tiers = resolveModelTiers();
  try {
    return await requestOpenRouter(messages, preferredModel, options);
  } catch (primaryError) {
    let cloudError = primaryError;
    if (preferredModel !== tiers.fallback) {
      try {
        return await requestOpenRouter(messages, tiers.fallback, options);
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
        return await requestOpenRouter(messages, local.model, { ...options, provider: local, stream: false });
      } catch (localError) {
        console.warn(`[GM] LOCAL fallback also failed: ${String(localError?.message || localError).slice(0, 160)}`);
      }
    }

    throw cloudError;
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
  const response = await requestWithFallback(messages, tiers.narrative, options);
  pushUsage(campaignId, response.model === tiers.fallback ? "fallback" : "narrative", response.model, response.tokensUsed, response.cost);
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
