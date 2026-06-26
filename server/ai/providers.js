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
  },
  fal: {
    key: "fal",
    label: "fal.ai",
    type: "fal-image",
    apiKeyEnv: "FAL_API_KEY",
    endpointEnv: "NOTDND_FAL_ENDPOINT",
    defaultEndpoint: "https://fal.run/fal-ai/flux/dev",
    supports: ["image"],
    models: {
      image: process.env.NOTDND_FAL_IMAGE_MODEL || "fal-ai/flux/dev"
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
      supports: config.supports || ["gm", "image", "voice"]
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

// ---------------------------------------------------------------------------
// Image generation path.
//
// Unlike generateWithProvider() (which returns text/url stubs for the GM/voice
// flows), this returns real image *bytes* so callers can persist them to disk.
// The image worker uses this exclusively — no provider endpoints are hardcoded
// outside this module. Mock mode returns a tiny valid PNG so the pipeline is
// exercisable offline and in tests without network or cost.
// ---------------------------------------------------------------------------

// 1x1 transparent PNG — a valid placeholder for mock/offline image generation.
const MOCK_IMAGE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

// fal.ai routes: base portraits use text-to-image; expression/reference variants
// use the IP-Adapter face endpoint (image-to-image anchored on a reference).
const FAL_TEXT_TO_IMAGE_ENDPOINT = process.env.NOTDND_FAL_ENDPOINT || "https://fal.run/fal-ai/flux/dev";
const FAL_FACE_TO_IMAGE_ENDPOINT = process.env.NOTDND_FAL_FACE_ENDPOINT || "https://fal.run/fal-ai/ip-adapter-face-id";

function imageMockForced() {
  return String(process.env.NOTDND_MOCK_IMAGE || "").trim().toLowerCase() === "true";
}

function isMockImageProvider(provider) {
  return provider === "mock" || provider === "placeholder" || provider === "local";
}

// Gate for expression-variant generation: providers listed here SKIP variants
// entirely (the worker falls back to the base portrait for every expression).
// Pollinations used to be here because it is txt2img-only (no IP-Adapter), but
// it now generates variants via seed-locked prompt variation: the same per-NPC
// identitySeed across every expression slot plus a prompt delta (", angry
// expression") yields recognizably the same character with a different
// expression — not IP-Adapter quality, but far better than a frozen face. The
// set is empty for now; fal (true img2img) and the mock provider produce
// variants too. (Name kept for back-compat; "reference" here means "generates
// expression variants", whether via a reference image or seed-locked prompts.)
const TXT2IMG_ONLY_IMAGE_PROVIDERS = new Set();
export function providerSupportsReference(provider) {
  return !TXT2IMG_ONLY_IMAGE_PROVIDERS.has(String(provider || "").trim().toLowerCase());
}

/**
 * Resolves which image provider to use when a caller does not specify one.
 * Honours NOTDND_MOCK_IMAGE, then NOTDND_IMAGE_PROVIDER, then falls back to
 * fal when FAL_API_KEY is present, otherwise mock.
 * @returns {string}
 */
export function resolveImageProvider() {
  if (imageMockForced()) {
    return "mock";
  }
  // Recognized image providers: "pollinations" (keyless, free txt2img),
  // "fal" (keyed), "mock"/"placeholder"/"local". An explicit env value wins.
  const configured = String(process.env.NOTDND_IMAGE_PROVIDER || "").trim().toLowerCase();
  if (configured) {
    return configured;
  }
  return String(process.env.FAL_API_KEY || "").trim() ? "fal" : "mock";
}

async function falImage({ prompt, referenceImageUrl, fetchImpl }) {
  const config = resolveProviderConfig("fal");
  if (!config.apiKey) {
    throw makeProviderError("fal", "fal.ai is not configured. Missing FAL_API_KEY.", "MISSING_API_KEY", 400);
  }

  const endpoint = referenceImageUrl ? FAL_FACE_TO_IMAGE_ENDPOINT : FAL_TEXT_TO_IMAGE_ENDPOINT;
  const body = referenceImageUrl ? { prompt, image_url: referenceImageUrl } : { prompt };

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Key ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw makeProviderError("fal", `fal.ai request failed (${response.status})`, "UPSTREAM_AI_ERROR", response.status);
  }

  const payload = await response.json();
  const imageUrl = payload?.images?.[0]?.url || payload?.image?.url || payload?.url || null;
  if (!imageUrl) {
    throw makeProviderError("fal", "fal.ai response did not include an image url", "UPSTREAM_AI_ERROR", 502);
  }

  const imageResponse = await fetchImpl(imageUrl);
  if (!imageResponse.ok) {
    throw makeProviderError("fal", `fal.ai image download failed (${imageResponse.status})`, "UPSTREAM_AI_ERROR", imageResponse.status);
  }

  return {
    provider: "fal",
    mock: false,
    bytes: Buffer.from(await imageResponse.arrayBuffer()),
    url: imageUrl
  };
}

// Pollinations.ai — keyless, free, text-to-image (FLUX). Zero auth: a GET
// returns image bytes directly. No reference/IP-Adapter support, so it is a
// base-portrait source only; expression variants fall back to fresh txt2img.
const POLLINATIONS_BASE = process.env.NOTDND_POLLINATIONS_ENDPOINT || "https://image.pollinations.ai/prompt";
const POLLINATIONS_MODEL = process.env.NOTDND_POLLINATIONS_MODEL || "flux";

// Deterministic seed so a given prompt yields a stable image (cache-forever
// friendly). Uses the caller's seed when provided, else a hash of the prompt.
function pollinationsSeed(prompt, seed) {
  if (Number.isFinite(Number(seed))) {
    return Math.abs(Math.trunc(Number(seed)));
  }
  let hash = 0;
  const text = String(prompt || "");
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

async function pollinationsImage({ prompt, seed, fetchImpl, width, height }) {
  // Default to portrait (512x768) for faces; callers pass landscape (768x512)
  // for location establishing shots via generateImage's width/height params.
  // (Number(null) === 0, so guard on > 0 — not just isFinite — to keep defaults.)
  const w = Number(width) > 0 ? Math.trunc(Number(width)) : 512;
  const h = Number(height) > 0 ? Math.trunc(Number(height)) : 768;
  const encoded = encodeURIComponent(String(prompt || "").trim() || "portrait");
  const params = new URLSearchParams({
    model: POLLINATIONS_MODEL,
    width: String(w),
    height: String(h),
    seed: String(pollinationsSeed(prompt, seed)),
    nologo: "true",
    // Server-side LLM prompt enhancement: Pollinations expands the terse prompt
    // into a richer, art-directed one before generation. Free quality lift on
    // every image the app produces.
    enhance: "true"
  });
  const url = `${POLLINATIONS_BASE}/${encoded}?${params.toString()}`;

  const response = await fetchImpl(url);
  if (!response.ok) {
    throw makeProviderError("pollinations", `Pollinations request failed (${response.status})`, "UPSTREAM_AI_ERROR", response.status);
  }

  return {
    provider: "pollinations",
    mock: false,
    bytes: Buffer.from(await response.arrayBuffer()),
    url
  };
}

/**
 * Generates a single image and returns its bytes. The base portrait (no
 * referenceImageUrl) is produced via text-to-image; expression/reference
 * variants (with referenceImageUrl) via image-to-image / IP-Adapter where the
 * provider supports it (Pollinations is txt2img only).
 * @param {{ provider?: string, prompt?: string, referenceImageUrl?: string|null, style?: string, seed?: number|null, width?: number|null, height?: number|null, fetchImpl?: typeof fetch }} [args]
 * @returns {Promise<{ provider: string, mock: boolean, bytes: Buffer, url: string|null }>}
 */
export async function generateImage({
  provider = resolveImageProvider(),
  prompt = "",
  referenceImageUrl = null,
  style = "",
  seed = null,
  width = null,
  height = null,
  fetchImpl = fetch
} = {}) {
  const resolvedProvider = provider || resolveImageProvider();
  const styledPrompt = String(style || "").trim() ? `${prompt}, ${String(style).trim()} style` : prompt;

  if (isMockImageProvider(resolvedProvider)) {
    return { provider: "mock", mock: true, bytes: MOCK_IMAGE_PNG, url: null };
  }

  if (resolvedProvider === "pollinations") {
    return pollinationsImage({ prompt: styledPrompt, seed, fetchImpl, width, height });
  }

  if (resolvedProvider === "fal") {
    return falImage({ prompt: styledPrompt, referenceImageUrl, fetchImpl });
  }

  throw makeProviderError(resolvedProvider, `Unsupported image provider: ${resolvedProvider}`, "UNSUPPORTED_IMAGE_PROVIDER", 400);
}
