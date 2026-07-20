import { comfyuiImage } from "./comfyui.js";
import { recordImageServe } from "../runtimeStatus.js";

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
      gm: (process.env.INKBORNE_LOCAL_GM_MODEL ?? process.env.NOTDND_LOCAL_GM_MODEL) || "local-gm-v1",
      image: (process.env.INKBORNE_LOCAL_IMAGE_MODEL ?? process.env.NOTDND_LOCAL_IMAGE_MODEL) || "local-image-v1",
      voice: (process.env.INKBORNE_LOCAL_VOICE_MODEL ?? process.env.NOTDND_LOCAL_VOICE_MODEL) || "local-voice-v1"
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
      gm: (process.env.INKBORNE_CHATGPT_GM_MODEL ?? process.env.NOTDND_CHATGPT_GM_MODEL) || "gpt-5-mini",
      image: (process.env.INKBORNE_CHATGPT_IMAGE_MODEL ?? process.env.NOTDND_CHATGPT_IMAGE_MODEL) || "gpt-image-1",
      voice: (process.env.INKBORNE_CHATGPT_VOICE_MODEL ?? process.env.NOTDND_CHATGPT_VOICE_MODEL) || "gpt-4o-mini-tts"
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
      gm: (process.env.INKBORNE_GROK_GM_MODEL ?? process.env.NOTDND_GROK_GM_MODEL) || "grok-4-fast-reasoning",
      image: (process.env.INKBORNE_GROK_IMAGE_MODEL ?? process.env.NOTDND_GROK_IMAGE_MODEL) || "grok-2-image",
      voice: (process.env.INKBORNE_GROK_VOICE_MODEL ?? process.env.NOTDND_GROK_VOICE_MODEL) || "grok-voice-preview"
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
      gm: (process.env.INKBORNE_GEMINI_GM_MODEL ?? process.env.NOTDND_GEMINI_GM_MODEL) || "gemini-2.5-flash",
      image: (process.env.INKBORNE_GEMINI_IMAGE_MODEL ?? process.env.NOTDND_GEMINI_IMAGE_MODEL) || "imagen-3.0-generate-002",
      voice: (process.env.INKBORNE_GEMINI_VOICE_MODEL ?? process.env.NOTDND_GEMINI_VOICE_MODEL) || "gemini-2.5-flash-preview-tts"
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
      image: (process.env.INKBORNE_FAL_IMAGE_MODEL ?? process.env.NOTDND_FAL_IMAGE_MODEL) || "fal-ai/flux/dev"
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
const FAL_TEXT_TO_IMAGE_ENDPOINT =
  (process.env.INKBORNE_FAL_ENDPOINT ?? process.env.NOTDND_FAL_ENDPOINT) || "https://fal.run/fal-ai/flux/dev";
const FAL_FACE_TO_IMAGE_ENDPOINT =
  (process.env.INKBORNE_FAL_FACE_ENDPOINT ?? process.env.NOTDND_FAL_FACE_ENDPOINT) || "https://fal.run/fal-ai/ip-adapter-face-id";

function imageMockForced() {
  return String((process.env.INKBORNE_MOCK_IMAGE ?? process.env.NOTDND_MOCK_IMAGE) || "").trim().toLowerCase() === "true";
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
  const configured = String((process.env.INKBORNE_IMAGE_PROVIDER ?? process.env.NOTDND_IMAGE_PROVIDER) || "").trim().toLowerCase();
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
const POLLINATIONS_BASE =
  (process.env.INKBORNE_POLLINATIONS_ENDPOINT ?? process.env.NOTDND_POLLINATIONS_ENDPOINT) || "https://image.pollinations.ai/prompt";
const POLLINATIONS_MODEL =
  (process.env.INKBORNE_POLLINATIONS_MODEL ?? process.env.NOTDND_POLLINATIONS_MODEL) || "flux";

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

// ---------------------------------------------------------------------------
// Image EDIT (kontext / gptimage) — true source-image-preserving edits.
// Experiment (2026-06-29) against the current keyless Pollinations setup:
//   - GET image.pollinations.ai/prompt/<p>?model=kontext  -> 500 "kontext model
//     is only available on enter.pollinations.ai"
//   - GET gen.pollinations.ai/image/<p>?model=kontext&image=… -> 401 UNAUTHORIZED
//     "Authentication required (Bearer token or ?key=)"
//   - ?model=gptimage on the keyless base returns BYTE-IDENTICAL FLUX output
//     (the model param is ignored), so it is NOT a real instruction-following
//     edit and does NOT fix elf-ears.
// Conclusion: true edits need a funded "pollen" key (INKBORNE_POLLINATIONS_KEY).
// editImage() is therefore kontext-FIRST WITH a regenerate FALLBACK so the
// feature ships and works either way (see editImage docstring).
// ---------------------------------------------------------------------------
const POLLINATIONS_EDIT_BASE =
  (process.env.INKBORNE_POLLINATIONS_EDIT_ENDPOINT ?? process.env.NOTDND_POLLINATIONS_EDIT_ENDPOINT) ||
  "https://gen.pollinations.ai/image";
const POLLINATIONS_EDIT_MODEL =
  (process.env.INKBORNE_POLLINATIONS_EDIT_MODEL ?? process.env.NOTDND_POLLINATIONS_EDIT_MODEL) || "kontext";

function pollinationsEditKey() {
  return String(process.env.INKBORNE_POLLINATIONS_KEY ?? process.env.NOTDND_POLLINATIONS_KEY ?? "").trim();
}

// True when a funded Pollinations key is configured, i.e. when editImage can do a
// real source-image-preserving edit instead of the regenerate fallback. The
// client surfaces this so the UI can label edits "consistent" vs "regenerated".
export function pollinationsEditConfigured() {
  return pollinationsEditKey().length > 0;
}

async function pollinationsEdit({ sourceImageUrl, instruction, seed, fetchImpl, width, height, key }) {
  const w = Number(width) > 0 ? Math.trunc(Number(width)) : 512;
  const h = Number(height) > 0 ? Math.trunc(Number(height)) : 768;
  const encoded = encodeURIComponent(String(instruction || "").trim() || "subtle edit");
  const params = new URLSearchParams({
    model: POLLINATIONS_EDIT_MODEL,
    image: String(sourceImageUrl || ""),
    width: String(w),
    height: String(h),
    seed: String(pollinationsSeed(instruction, seed)),
    nologo: "true"
  });
  const url = `${POLLINATIONS_EDIT_BASE}/${encoded}?${params.toString()}`;
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!response.ok) {
    throw makeProviderError("pollinations-edit", `Pollinations edit failed (${response.status})`, "UPSTREAM_AI_ERROR", response.status);
  }
  return {
    provider: "pollinations-edit",
    mock: false,
    bytes: Buffer.from(await response.arrayBuffer()),
    url,
    edited: true
  };
}

/**
 * Apply ONE edit instruction to an existing portrait, keeping the same character.
 * Kontext-FIRST with a regenerate FALLBACK (degrades gracefully):
 *   - When a Pollinations edit key is configured AND a source image is supplied,
 *     call the kontext/gptimage edit endpoint (source image + instruction) for a
 *     true, consistent edit — result.edited === true.
 *   - Otherwise (no key / no source / the edit call errors), fall back to
 *     generateImage with the instruction folded into the prompt: a regenerate
 *     that honours the tweak but does not guarantee the identical face —
 *     result.edited === false.
 * The caller's UI is identical for both paths.
 * @param {{ sourceImageUrl?: string|null, instruction?: string, prompt?: string,
 *   style?: string, seed?: number|null, width?: number|null, height?: number|null,
 *   fetchImpl?: Function, mock?: boolean }} opts
 * @returns {Promise<{ provider, bytes, url, edited: boolean }>}
 */
export async function editImage({
  sourceImageUrl = null,
  instruction = "",
  prompt = "",
  style = "",
  kind = null,
  seed = null,
  width = null,
  height = null,
  fetchImpl = fetch,
  mock = isMockImageProvider(resolveImageProvider())
} = {}) {
  const key = pollinationsEditKey();
  const hasSource = typeof sourceImageUrl === "string" && sourceImageUrl.trim().length > 0;
  // LANE-INVARIANCE (owner ruling 2026-07-20): kontext image-to-image is a PARALLEL
  // provider — it renders a DIFFERENT model from the source image and cannot carry the
  // sealed builder + the validated per-lane recipe (checkpoint/negatives). It produced
  // pre-kitchen output the validated recipe forbids (the "mustard" western-comic bust).
  // It is now OFF unless explicitly opted in (NOTDND_ALLOW_UNSEALED_EDIT=true); the
  // default edit path is a SEALED regenerate through the ONE portrait path
  // (generateImage → comfyui recipe), which preserves identity via the rebuilt-from-
  // state weighted prompt. Mock mode also never hits the network.
  const allowUnsealedEdit =
    String(process.env.INKBORNE_ALLOW_UNSEALED_EDIT ?? process.env.NOTDND_ALLOW_UNSEALED_EDIT ?? "")
      .trim().toLowerCase() === "true";
  if (allowUnsealedEdit && key && hasSource && !mock) {
    try {
      return await pollinationsEdit({ sourceImageUrl, instruction, seed, fetchImpl, width, height, key });
    } catch {
      // Never hard-fail a player's edit — degrade to the regenerate fallback below.
    }
  }
  // The FREEFORM tweak folds onto the (identity-correct, rebuilt-from-state) base
  // prompt — gender is already a WEIGHTED token in `prompt`, so tail detail text
  // no longer fights it. `kind` forwards the validated per-lane recipe routing so
  // the regenerate fallback shares the ONE portrait path (not the generic graph).
  const tweak = String(instruction || "").trim();
  const editedPrompt = tweak ? `${prompt}, ${tweak}` : prompt;
  const result = await generateImage({ prompt: editedPrompt, style, kind, seed, width, height, fetchImpl });
  return { ...result, edited: false };
}

// Cloudflare Workers AI — FLUX-1-schnell. Failover provider #2: keyed
// (CF_ACCOUNT_ID + CF_API_TOKEN), a single POST that returns the generated image
// bytes directly (not a URL). flux-1-schnell accepts num_steps but NOT
// width/height — it generates at a fixed resolution, so those args are ignored.
const CLOUDFLARE_FLUX_MODEL = "@cf/black-forest-labs/flux-1-schnell";

async function cloudflareImage({ prompt, seed, width, height, fetchImpl }) {
  const accountId = String(process.env.CF_ACCOUNT_ID || "").trim();
  const apiToken = String(process.env.CF_API_TOKEN || "").trim();
  if (!accountId || !apiToken) {
    throw makeProviderError(
      "cloudflare",
      "Cloudflare Workers AI is not configured. Missing CF_ACCOUNT_ID or CF_API_TOKEN.",
      "MISSING_API_KEY",
      400
    );
  }
  // width/height are intentionally ignored — flux-1-schnell has a fixed output
  // size and rejects/ignores dimension params.
  void width;
  void height;

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${CLOUDFLARE_FLUX_MODEL}`;
  // Reuse the deterministic prompt-seed so an NPC's identitySeed keeps the same
  // character consistent here too (and so failover from Pollinations is stable).
  const body = { prompt: String(prompt || "").trim() || "portrait", num_steps: 8, seed: pollinationsSeed(prompt, seed) };

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw makeProviderError("cloudflare", `Cloudflare request failed (${response.status})`, "UPSTREAM_AI_ERROR", response.status);
  }

  // flux-1-schnell returns the image bytes directly. Defensive: some Workers AI
  // image responses instead wrap a base64 image in JSON ({"result":{"image":"…"}});
  // decode that so we always persist real image bytes, never JSON text.
  const buf = Buffer.from(await response.arrayBuffer());
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    try {
      const json = JSON.parse(buf.toString("utf8"));
      const b64 = json?.result?.image || json?.image || null;
      if (b64) {
        return { provider: "cloudflare", mock: false, bytes: Buffer.from(b64, "base64"), url: null };
      }
    } catch {
      // not JSON after all — fall through to the raw bytes below
    }
  }

  return {
    provider: "cloudflare",
    mock: false,
    bytes: buf,
    url: null
  };
}

// Failover order tried after the primary/resolved provider (deduped against it).
// "cloudflare" is wired below; the loop only attempts it when its keys are set
// (isWiredImageProvider), otherwise it is skipped with no attempt/delay.
//
// FALLBACK POLICY (2026-07-17). Pollinations is NO LONGER a silent failover — it
// served off-canon flux art (biplanes, elf ears) as the de-facto default whenever a
// keyed provider was absent or failed. It now runs ONLY when explicitly selected as
// the primary provider (NOTDND_IMAGE_PROVIDER=pollinations / INKBORNE_IMAGE_PROVIDER),
// i.e. behind an explicit opt-in, never a silent default. With nothing configured the
// primary resolves to mock (a clean placeholder empty state) and the curated
// library/ComfyUI path serves owner-rated keeps; that is the intended default.
// Mock is deliberately NOT in this chain: it never fails, so including it would cache
// a 1x1 placeholder forever on a real outage. When every real provider fails the loop
// throws, the asset stays "failed", and the scene poll retries it later.
const IMAGE_PROVIDER_PRIORITY = ["cloudflare"];

// SEALED-OR-NOTHING kinds (owner law 2026-07-20): identity/scene surfaces whose prompt
// is sealed in comfyui and cannot be reproduced by a fallback provider. generateImage
// drops the failover chain for these — sealed provider only, else a classified failure.
export const SEALED_ONLY_KINDS = new Set(["portrait", "fullbody", "scene"]);

// Exported for the fallback-policy test: the AUTOMATIC failover order. Pollinations
// must never appear here — it runs only as an explicit primary (opt-in).
export function imageFailoverPriority() {
  return [...IMAGE_PROVIDER_PRIORITY];
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// True for providers dispatchImageProvider knows how to call. Cloudflare is only
// "wired" once both of its keys are present, so the failover loop skips it (no
// attempt/delay) when it is unconfigured.
function isWiredImageProvider(provider) {
  const p = String(provider || "").trim().toLowerCase();
  if (p === "cloudflare") {
    return Boolean(String(process.env.CF_ACCOUNT_ID || "").trim() && String(process.env.CF_API_TOKEN || "").trim());
  }
  // comfyui is keyless (a URL with a default), so it is always "wired" — but it
  // is deliberately NOT in IMAGE_PROVIDER_PRIORITY: it only runs when explicitly
  // selected as the primary provider, and reachability is checked at call time
  // (a down ComfyUI fails fast into the rest of the chain).
  return p === "pollinations" || p === "fal" || p === "comfyui" || isMockImageProvider(p);
}

// Dispatches one generation to a single, concrete provider. Throws for providers
// that are not wired yet so the failover loop can skip past them.
async function dispatchImageProvider(provider, args) {
  const p = String(provider || "").trim().toLowerCase();
  if (isMockImageProvider(p)) {
    return { provider: "mock", mock: true, bytes: MOCK_IMAGE_PNG, url: null };
  }
  if (p === "pollinations") {
    return pollinationsImage({
      prompt: args.prompt,
      seed: args.seed,
      fetchImpl: args.fetchImpl,
      width: args.width,
      height: args.height
    });
  }
  if (p === "fal") {
    return falImage({ prompt: args.prompt, referenceImageUrl: args.referenceImageUrl, fetchImpl: args.fetchImpl });
  }
  if (p === "comfyui") {
    return comfyuiImage({
      prompt: args.prompt,
      // The RAW style key (not the prompt suffix) — with the library KIND it
      // selects the VALIDATED per-lane workflow export (portrait/scene/fullbody/
      // item); the prompt already carries the styled text. referenceImageUrl
      // drives the face-ref tailor for a fullbody with a committed portrait.
      style: args.style,
      kind: args.kind,
      referenceImageUrl: args.referenceImageUrl,
      seed: args.seed,
      width: args.width,
      height: args.height,
      fetchImpl: args.fetchImpl
    });
  }
  if (p === "cloudflare") {
    return cloudflareImage({
      prompt: args.prompt,
      seed: args.seed,
      width: args.width,
      height: args.height,
      fetchImpl: args.fetchImpl
    });
  }
  throw makeProviderError(p, `Image provider not wired yet: ${p}`, "PROVIDER_NOT_WIRED", 501);
}

/**
 * Generates a single image and returns its bytes, with provider failover.
 *
 * The primary/resolved provider is tried first; on any error it is retried once
 * (after retryDelayMs), and if that also fails the loop moves down the priority
 * list. Unwired providers are skipped. The first success returns immediately; if
 * nothing succeeds the call throws, listing what was tried. Transparent to
 * callers — the return shape is unchanged.
 *
 * The base portrait (no referenceImageUrl) is produced via text-to-image;
 * expression/reference variants (with referenceImageUrl) via image-to-image /
 * IP-Adapter where the provider supports it.
 * @param {{ provider?: string, prompt?: string, referenceImageUrl?: string|null, style?: string, seed?: number|null, width?: number|null, height?: number|null, fetchImpl?: typeof fetch, retryDelayMs?: number, providerPriority?: string[] }} [args]
 * @returns {Promise<{ provider: string, mock: boolean, bytes: Buffer, url: string|null }>}
 */
export async function generateImage({
  provider = resolveImageProvider(),
  prompt = "",
  referenceImageUrl = null,
  style = "",
  kind = null,
  seed = null,
  width = null,
  height = null,
  fetchImpl = fetch,
  retryDelayMs = 1000,
  providerPriority = IMAGE_PROVIDER_PRIORITY
} = {}) {
  const styledPrompt = String(style || "").trim() ? `${prompt}, ${String(style).trim()} style` : prompt;
  // The raw style key + the library KIND ride along for providers that select a
  // validated per-lane workflow by (style, kind) — comfyui; prompt-only providers
  // ignore both.
  const args = { prompt: styledPrompt, style, kind, referenceImageUrl, seed, width, height, fetchImpl };

  const primary = String(provider || resolveImageProvider() || "mock").trim().toLowerCase();

  // Mock short-circuits: no network, never fails — skip the failover machinery
  // (and its retry delay) entirely so mock/test runs stay instant.
  if (isMockImageProvider(primary)) {
    const mockResult = await dispatchImageProvider("mock", args);
    recordImageServe({ provider: mockResult.provider, model: "mock", mock: true });
    return mockResult;
  }

  // SEALED-OR-NOTHING (owner law 2026-07-20): character/scene kinds carry the sealed
  // identity/lane prompt (comfyui.sealPortraitPrompt) that the fallback providers
  // (cloudflare/pollinations) CANNOT reproduce — a fallback would serve UNSEALED junk
  // (the A6 gap). For these kinds the failover priority list is dropped: the chain is the
  // sealed primary ONLY, and its failure surfaces as a classified error the caller shows
  // the player — never an unsealed image. Non-identity surfaces (item/world-card/
  // landscape) keep failover. Provider policy is now part of the seal.
  const sealedOnly = SEALED_ONLY_KINDS.has(String(kind || "").trim().toLowerCase());
  const failoverList = sealedOnly ? [] : (Array.isArray(providerPriority) ? providerPriority : []);
  // Build the failover chain: primary first, then the priority list, deduped.
  const chain = [];
  for (const candidate of [primary, ...failoverList]) {
    const key = String(candidate || "").trim().toLowerCase();
    if (key && !chain.includes(key)) {
      chain.push(key);
    }
  }

  const tried = [];
  let lastError = null;

  for (const candidate of chain) {
    if (!isWiredImageProvider(candidate)) {
      continue; // not implemented yet (e.g. cloudflare) — skip with no attempt/delay
    }
    // Two tries per provider: the initial attempt, then one retry after a short
    // delay. Any error (throw, non-200, timeout) is treated as retriable.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await dispatchImageProvider(candidate, args);
        // Live attribution for the debug panel: what ACTUALLY rendered (provider
        // + checkpoint/model), not the configured env value. For comfyui the
        // checkpoint rides along; other providers surface their model where known.
        recordImageServe({
          provider: result.provider,
          model: result.model || (result.provider === "pollinations" ? POLLINATIONS_MODEL : null),
          checkpoint: result.checkpoint || null,
          mock: Boolean(result.mock)
        });
        return result;
      } catch (error) {
        lastError = error;
        tried.push(`${candidate} (attempt ${attempt})`);
        if (attempt === 1 && retryDelayMs > 0) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(retryDelayMs);
        }
      }
    }
  }

  throw makeProviderError(
    primary,
    `All image providers failed. Tried: ${tried.join(", ") || "none"}.` +
      (lastError ? ` Last error: ${String(lastError.message || lastError)}.` : ""),
    "ALL_IMAGE_PROVIDERS_FAILED",
    502
  );
}
