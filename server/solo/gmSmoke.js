import { evaluateGmNarration } from "./gmEval.js";
import { resolveGmNarration } from "./gmProvider.js";
import { buildSoloScenePayload } from "./scene.js";
import { createDefaultSoloRun } from "./schema.js";

const PROVIDER_ENV_NAMES = [
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "GEMINI_API_KEY",
  "NOTDND_CHATGPT_ENDPOINT",
  "NOTDND_CHATGPT_GM_MODEL",
  "NOTDND_GROK_ENDPOINT",
  "NOTDND_GROK_GM_MODEL",
  "NOTDND_GEMINI_ENDPOINT",
  "NOTDND_GEMINI_GM_MODEL",
  "NOTDND_LOCAL_GM_MODEL"
];

function envValue(env, name) {
  return typeof env?.[name] === "string" ? env[name].trim() : "";
}

function providerEnabled(env, options = {}) {
  if (typeof options.providerEnabled === "boolean") {
    return options.providerEnabled;
  }
  return envValue(env, "NOTDND_GM_PROVIDER_ENABLED").toLowerCase() === "true";
}

function providerName(env, options = {}) {
  return options.provider || envValue(env, "NOTDND_GM_PROVIDER") || "placeholder";
}

function modelName(env, options = {}) {
  return options.model || envValue(env, "NOTDND_GM_MODEL") || "";
}

function providerHasConfig(env, provider, options = {}) {
  if (typeof options.providerConfigured === "boolean") {
    return options.providerConfigured;
  }
  if (typeof options.providerFn === "function") {
    return true;
  }
  if (provider === "local" || provider === "placeholder") {
    return true;
  }
  if (provider === "chatgpt") {
    return Boolean(envValue(env, "OPENAI_API_KEY") && envValue(env, "NOTDND_CHATGPT_ENDPOINT"));
  }
  if (provider === "grok") {
    return Boolean(envValue(env, "XAI_API_KEY") && envValue(env, "NOTDND_GROK_ENDPOINT"));
  }
  if (provider === "gemini") {
    return Boolean(envValue(env, "GEMINI_API_KEY") && envValue(env, "NOTDND_GEMINI_ENDPOINT"));
  }
  return Boolean(envValue(env, "NOTDND_GM_PROVIDER"));
}

function modelHasConfig(env, options = {}) {
  if (typeof options.modelConfigured === "boolean") {
    return options.modelConfigured;
  }
  return Boolean(modelName(env, options));
}

function safeWarnings(gmNarration, extra = []) {
  return Array.from(new Set([...(gmNarration?.warnings || []), ...extra].filter(Boolean)));
}

export function buildSmokeSoloRun(options = {}) {
  return createDefaultSoloRun({
    runId: options.runId || "gm_smoke_run",
    userId: options.userId ?? null,
    worldSeed: options.worldSeed || "gm_smoke_seed",
    now: options.now || "2026-01-01T00:00:00.000Z"
  });
}

export function getSafeGmProviderConfigStatus(options = {}) {
  const env = options.env || process.env;
  const provider = providerName(env, options);
  return {
    providerEnabled: providerEnabled(env, options),
    providerConfigured: providerHasConfig(env, provider, options),
    modelConfigured: modelHasConfig(env, options),
    providerName: provider,
    knownConfigNames: [
      "NOTDND_GM_PROVIDER_ENABLED",
      "NOTDND_GM_PROVIDER",
      "NOTDND_GM_MODEL",
      ...PROVIDER_ENV_NAMES
    ]
  };
}

export async function runGmProviderSmoke(options = {}) {
  const env = options.env || process.env;
  const config = getSafeGmProviderConfigStatus(options);
  const run = options.run || buildSmokeSoloRun(options);
  const scene = options.scene || buildSoloScenePayload(run);

  if (!scene.ok) {
    return summarizeGmSmokeResult({
      ok: false,
      providerAttempted: false,
      providerConfigured: config.providerConfigured,
      modelConfigured: config.modelConfigured,
      fallbackUsed: false,
      evaluationScore: null,
      warnings: [],
      errorCode: "GM_SMOKE_SCENE_INVALID"
    });
  }

  if (!config.providerEnabled) {
    const gmNarration = await resolveGmNarration(scene, { mode: "placeholder" });
    const evaluation = evaluateGmNarration(scene, gmNarration);
    return summarizeGmSmokeResult({
      ok: true,
      providerAttempted: false,
      providerConfigured: config.providerConfigured,
      modelConfigured: config.modelConfigured,
      fallbackUsed: true,
      evaluationScore: evaluation.score,
      warnings: safeWarnings(gmNarration, ["GM_PROVIDER_DISABLED"]),
      errorCode: "GM_PROVIDER_DISABLED"
    });
  }

  if (!config.providerConfigured) {
    const gmNarration = await resolveGmNarration(scene, { mode: "placeholder" });
    const evaluation = evaluateGmNarration(scene, gmNarration);
    return summarizeGmSmokeResult({
      ok: true,
      providerAttempted: false,
      providerConfigured: false,
      modelConfigured: config.modelConfigured,
      fallbackUsed: true,
      evaluationScore: evaluation.score,
      warnings: safeWarnings(gmNarration, ["GM_PROVIDER_UNCONFIGURED"]),
      errorCode: "GM_PROVIDER_UNCONFIGURED"
    });
  }

  const gmNarration = await resolveGmNarration(scene, {
    ...options,
    env,
    mode: "provider",
    providerEnabled: true,
    provider: config.providerName,
    model: modelName(env, options)
  });
  const evaluation = evaluateGmNarration(scene, gmNarration);
  const fallbackUsed = safeWarnings(gmNarration).some((warning) => warning.startsWith("GM_PROVIDER_"));

  return summarizeGmSmokeResult({
    ok: evaluation.ok,
    providerAttempted: true,
    providerConfigured: true,
    modelConfigured: config.modelConfigured,
    fallbackUsed,
    evaluationScore: evaluation.score,
    warnings: safeWarnings(gmNarration, evaluation.warnings),
    errorCode: fallbackUsed ? "GM_PROVIDER_FALLBACK_USED" : null
  });
}

export function summarizeGmSmokeResult(result = {}) {
  return {
    ok: Boolean(result.ok),
    providerAttempted: Boolean(result.providerAttempted),
    providerConfigured: Boolean(result.providerConfigured),
    modelConfigured: Boolean(result.modelConfigured),
    fallbackUsed: Boolean(result.fallbackUsed),
    evaluationScore: Number.isFinite(result.evaluationScore) ? result.evaluationScore : null,
    warnings: Array.isArray(result.warnings) ? Array.from(new Set(result.warnings.map(String))) : [],
    errorCode: result.errorCode || null
  };
}
