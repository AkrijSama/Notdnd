const PLACEHOLDER_MEDIA = {
  image: "IMAGE_RESULT_PLACEHOLDER_URL",
  voice: "VOICE_RESULT_PLACEHOLDER_URL"
};

const PROVIDER_SPECS = {
  placeholder: {
    key: "placeholder",
    label: "Placeholder Provider",
    type: "mock",
    status: "ready",
    models: {
      gm: "AI_GM_MODEL_VALUE",
      image: "IMAGE_MODEL_VALUE",
      voice: "VOICE_MODEL_VALUE"
    }
  },
  local: {
    key: "local",
    label: "Local Model",
    type: "mock",
    status: "ready",
    models: {
      gm: process.env.NOTDND_LOCAL_GM_MODEL || "local-gm-v1",
      image: process.env.NOTDND_LOCAL_IMAGE_MODEL || "local-image-v1",
      voice: process.env.NOTDND_LOCAL_VOICE_MODEL || "local-voice-v1"
    }
  },
  chatgpt: {
    key: "chatgpt",
    label: "ChatGPT",
    type: "openai-responses",
    apiKeyEnv: "OPENAI_API_KEY",
    endpointEnv: "NOTDND_CHATGPT_ENDPOINT",
    defaultEndpoint: "https://api.openai.com/v1/responses",
    models: {
      gm: process.env.NOTDND_CHATGPT_GM_MODEL || "gpt-5-mini",
      image: process.env.NOTDND_CHATGPT_IMAGE_MODEL || "gpt-image-1",
      voice: process.env.NOTDND_CHATGPT_VOICE_MODEL || "gpt-4o-mini-tts"
    }
  },
  grok: {
    key: "grok",
    label: "Grok",
    type: "openai-chat-completions",
    apiKeyEnv: "XAI_API_KEY",
    endpointEnv: "NOTDND_GROK_ENDPOINT",
    defaultEndpoint: "https://api.x.ai/v1/chat/completions",
    models: {
      gm: process.env.NOTDND_GROK_GM_MODEL || "grok-4-fast-reasoning",
      image: process.env.NOTDND_GROK_IMAGE_MODEL || "grok-2-image",
      voice: process.env.NOTDND_GROK_VOICE_MODEL || "grok-voice-preview"
    }
  },
  gemini: {
    key: "gemini",
    label: "Gemini",
    type: "gemini-generate-content",
    apiKeyEnv: "GEMINI_API_KEY",
    endpointEnv: "NOTDND_GEMINI_ENDPOINT",
    defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
    models: {
      gm: process.env.NOTDND_GEMINI_GM_MODEL || "gemini-2.5-flash",
      image: process.env.NOTDND_GEMINI_IMAGE_MODEL || "imagen-3.0-generate-002",
      voice: process.env.NOTDND_GEMINI_VOICE_MODEL || "gemini-2.5-flash-preview-tts"
    }
  }
};

function resolveSpec(provider) {
  const spec = PROVIDER_SPECS[provider];
  if (!spec) {
    throw new Error(`Unsupported provider: ${provider}`);
  }
  return spec;
}

function resolveProviderConfig(provider, overrides = {}) {
  const spec = resolveSpec(provider);
  const apiKey = overrides.apiKey ?? (spec.apiKeyEnv ? process.env[spec.apiKeyEnv] : "");
  const endpoint =
    overrides.endpoint ??
    (spec.endpointEnv ? process.env[spec.endpointEnv] || spec.defaultEndpoint || "" : spec.defaultEndpoint || "");

  let status = spec.status || "ready";
  if (spec.type !== "mock") {
    if (!apiKey) {
      status = "missing-api-key";
    } else if (!endpoint) {
      status = "missing-endpoint";
    } else {
      status = "configured";
    }
  }

  return {
    ...spec,
    apiKey,
    endpoint,
    status
  };
}

export function listAiProviders() {
  return Object.keys(PROVIDER_SPECS).map((provider) => {
    const config = resolveProviderConfig(provider);
    return {
      key: config.key,
      label: config.label,
      models: config.models,
      status: config.status,
      apiKeyEnv: config.apiKeyEnv || null,
      endpointEnv: config.endpointEnv || null,
      endpoint: config.type === "mock" ? null : config.endpoint,
      supports: ["gm", "image", "voice"]
    };
  });
}

function localMockResult({ provider, type, prompt, model }) {
  const stamp = new Date().toISOString();
  if (type === "image") {
    return {
      provider,
      model,
      text: `Generated mock image prompt at ${stamp}`,
      imageUrl: `mock://image/${encodeURIComponent(prompt.slice(0, 48))}`
    };
  }
  if (type === "voice") {
    return {
      provider,
      model,
      text: `Generated mock voice line at ${stamp}`,
      audioUrl: `mock://voice/${encodeURIComponent(prompt.slice(0, 48))}`
    };
  }
  return {
    provider,
    model,
    text: `Mock GM response (${stamp}): ${prompt.slice(0, 220)}`
  };
}

async function safeReadBody(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function makeProviderError(provider, message, code = "AI_PROVIDER_ERROR", statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function assertProviderReady(config) {
  if (config.type === "mock") {
    return;
  }
  if (!config.apiKey) {
    throw makeProviderError(config.key, `${config.label} is not configured. Missing ${config.apiKeyEnv}.`, "MISSING_API_KEY", 400);
  }
  if (!config.endpoint) {
    throw makeProviderError(config.key, `${config.label} is not configured. Missing endpoint.`, "MISSING_ENDPOINT", 400);
  }
}

function extractTextFromResponse(provider, payload) {
  if (provider === "chatgpt") {
    if (typeof payload.output_text === "string" && payload.output_text.trim()) {
      return payload.output_text.trim();
    }
    const content = Array.isArray(payload.output) ? payload.output : [];
    for (const item of content) {
      for (const part of item?.content || []) {
        if (part?.type === "output_text" && part.text) {
          return String(part.text).trim();
        }
      }
    }
  }

  if (provider === "grok") {
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    const text = choice?.message?.content;
    if (typeof text === "string" && text.trim()) {
      return text.trim();
    }
  }

  if (provider === "gemini") {
    const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part?.text || "").join(" ").trim();
    if (text) {
      return text;
    }
  }

  return payload?.text || "";
}

async function remoteProviderResult({ provider, type, prompt, model, fetchImpl = fetch, configOverride = {} }) {
  const config = resolveProviderConfig(provider, configOverride);
  assertProviderReady(config);

  const resolvedModel = model || config.models[type] || config.models.gm;
  let endpoint = config.endpoint;
  let body;
  const headers = {};

  if (provider === "chatgpt") {
    headers.Authorization = `Bearer ${config.apiKey}`;
    headers["Content-Type"] = "application/json";
    body = {
      model: resolvedModel,
      input: prompt
    };
  } else if (provider === "grok") {
    headers.Authorization = `Bearer ${config.apiKey}`;
    headers["Content-Type"] = "application/json";
    body = {
      model: resolvedModel,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    };
  } else if (provider === "gemini") {
    endpoint = endpoint.replace("{model}", encodeURIComponent(resolvedModel));
    const separator = endpoint.includes("?") ? "&" : "?";
    endpoint = `${endpoint}${separator}key=${encodeURIComponent(config.apiKey)}`;
    headers["Content-Type"] = "application/json";
    body = {
      contents: [
        {
          parts: [
            {
              text: prompt
            }
          ]
        }
      ]
    };
  }

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const rawBody = await safeReadBody(response);
  let payload = {};
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    payload = { text: rawBody };
  }

  if (!response.ok) {
    const upstreamMessage = payload?.error?.message || payload?.message || rawBody || `HTTP ${response.status}`;
    const normalized = response.status === 401 || response.status === 403
      ? `${config.label} API key rejected. ${upstreamMessage}`
      : `${config.label} request failed (${response.status}). ${upstreamMessage}`;
    throw makeProviderError(provider, normalized.trim(), response.status === 401 || response.status === 403 ? "BAD_API_KEY" : "UPSTREAM_AI_ERROR", response.status);
  }

  const text = extractTextFromResponse(provider, payload) || `${config.label} completed ${type} generation.`;
  if (type === "image") {
    return {
      provider,
      model: resolvedModel,
      text,
      imageUrl: payload.imageUrl || PLACEHOLDER_MEDIA.image
    };
  }
  if (type === "voice") {
    return {
      provider,
      model: resolvedModel,
      text,
      audioUrl: payload.audioUrl || PLACEHOLDER_MEDIA.voice
    };
  }
  return {
    provider,
    model: resolvedModel,
    text
  };
}

export async function generateWithProvider({ provider = "placeholder", type = "gm", prompt = "", model = "", fetchImpl, configOverride } = {}) {
  const resolvedProvider = provider || "placeholder";
  const spec = resolveProviderConfig(resolvedProvider, configOverride);
  const resolvedModel = model || spec.models[type] || spec.models.gm;

  if (resolvedProvider === "placeholder") {
    if (type === "image") {
      return {
        provider: "placeholder",
        model: resolvedModel,
        text: "Placeholder image job complete.",
        imageUrl: PLACEHOLDER_MEDIA.image
      };
    }
    if (type === "voice") {
      return {
        provider: "placeholder",
        model: resolvedModel,
        text: "Placeholder voice job complete.",
        audioUrl: PLACEHOLDER_MEDIA.voice
      };
    }
    return {
      provider: "placeholder",
      model: resolvedModel,
      text: `Placeholder GM output: ${prompt.slice(0, 220)}`
    };
  }

  if (resolvedProvider === "local") {
    return localMockResult({ provider: "local", type, prompt, model: resolvedModel });
  }

  return remoteProviderResult({
    provider: resolvedProvider,
    type,
    prompt,
    model: resolvedModel,
    fetchImpl,
    configOverride
  });
}
