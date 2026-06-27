// OpenAI-compatible chat-completions endpoint. Defaults to OpenRouter but can
// point at any compatible provider (Gemini AI Studio, Groq, etc.) via env.
const LLM_BASE_URL = process.env.NOTDND_LLM_BASE_URL || "https://openrouter.ai/api/v1/chat/completions";

const DEFAULT_MODELS = {
  narrative: "x-ai/grok-3",
  utility: "venice/uncensored:free",
  fallback: "meta-llama/llama-3.3-70b-instruct:free"
};

const usageByCampaign = {};

function resolveModelTiers() {
  return {
    narrative: process.env.NOTDND_GM_MODEL || DEFAULT_MODELS.narrative,
    utility: process.env.NOTDND_UTILITY_MODEL || DEFAULT_MODELS.utility,
    fallback: process.env.NOTDND_FALLBACK_MODEL || DEFAULT_MODELS.fallback
  };
}

function ensureApiKey() {
  // NOTDND_LLM_API_KEY is the provider-agnostic name; OPENROUTER_API_KEY stays
  // a fallback so existing setups keep working unchanged.
  const apiKey = String(process.env.NOTDND_LLM_API_KEY || process.env.OPENROUTER_API_KEY || "").trim();
  if (!apiKey) {
    const error = new Error("NOTDND_LLM_API_KEY (or OPENROUTER_API_KEY) is required.");
    error.code = "MISSING_API_KEY";
    error.statusCode = 500;
    throw error;
  }
  return apiKey;
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
  return String(process.env.NOTDND_MOCK_OPENROUTER || "").trim().toLowerCase() === "true";
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

  const apiKey = ensureApiKey();
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

  const response = await fetch(LLM_BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://inkborne.com",
      "X-Title": "Inkborne"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const rawBody = await response.text();
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
  const tiers = resolveModelTiers();
  try {
    return await requestOpenRouter(messages, preferredModel, options);
  } catch (error) {
    const fallbackModel = tiers.fallback;
    if (preferredModel === fallbackModel) {
      throw error;
    }
    return requestOpenRouter(messages, fallbackModel, options);
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
