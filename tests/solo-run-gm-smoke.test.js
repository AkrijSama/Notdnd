import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSmokeSoloRun,
  getSafeGmProviderConfigStatus,
  runGmProviderSmoke,
  summarizeGmSmokeResult
} from "../server/solo/gmSmoke.js";
import { buildSoloScenePayload } from "../server/solo/scene.js";

const SAFE_ENV = Object.freeze({});

function validProviderOutput(body = null) {
  return {
    ok: true,
    narration: {
      title: "Start Location",
      body:
        body ||
        "Start Location holds steady around the player, its neutral details clear enough to read without inventing new lore. The visible exits and entities remain exactly as the scene presents them.",
      tone: "neutral",
      sensoryDetails: ["still air"],
      focusEntityIds: ["location:start_location"]
    },
    suggestedActionLabels: [],
    warnings: [],
    stateMutations: []
  };
}

test("smoke skipped safely when provider disabled", async () => {
  const result = await runGmProviderSmoke({
    env: SAFE_ENV,
    providerEnabled: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.providerAttempted, false);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.errorCode, "GM_PROVIDER_DISABLED");
});

test("smoke reports providerConfigured false safely without secrets", async () => {
  const result = await runGmProviderSmoke({
    env: {
      NOTDND_GM_PROVIDER_ENABLED: "true",
      NOTDND_GM_PROVIDER: "chatgpt"
    }
  });
  const encoded = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.providerAttempted, false);
  assert.equal(result.providerConfigured, false);
  assert.equal(result.errorCode, "GM_PROVIDER_UNCONFIGURED");
  assert.doesNotMatch(encoded, /OPENAI_API_KEY|secret|Bearer|token|sk-/i);
});

test("smoke with fake provider succeeds", async () => {
  const result = await runGmProviderSmoke({
    env: SAFE_ENV,
    providerEnabled: true,
    provider: "fake",
    model: "fake-gm-model",
    providerFn: async () => validProviderOutput()
  });

  assert.equal(result.ok, true);
  assert.equal(result.providerAttempted, true);
  assert.equal(result.providerConfigured, true);
  assert.equal(result.providerName, "fake");
  assert.equal(result.providerKind, "mock");
  assert.equal(result.providerSucceeded, true);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.errorCode, null);
});

test("safe local mock provider smoke path succeeds", async () => {
  const result = await runGmProviderSmoke({
    env: SAFE_ENV,
    providerEnabled: true,
    provider: "local",
    model: "local-gm-v1"
  });
  const encoded = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.providerAttempted, true);
  assert.equal(result.providerConfigured, true);
  assert.equal(result.modelConfigured, true);
  assert.equal(result.providerName, "local");
  assert.equal(result.providerKind, "local");
  assert.equal(result.providerSucceeded, true);
  assert.equal(result.fallbackUsed, false);
  assert.equal(typeof result.evaluationScore, "number");
  assert.equal(typeof result.narrationLength, "number");
  assert.ok(result.warnings.includes("GM_LOCAL_MOCK_PROVIDER"));
  assert.doesNotMatch(encoded, /SYSTEM:|USER:|OPENAI_API_KEY|secret|Bearer|token|prompt/i);
});

test("smoke with fake provider evaluates output", async () => {
  const result = await runGmProviderSmoke({
    env: SAFE_ENV,
    providerEnabled: true,
    provider: "fake",
    model: "fake-gm-model",
    providerFn: async () => validProviderOutput()
  });

  assert.equal(typeof result.evaluationScore, "number");
  assert.ok(result.evaluationScore >= 80);
});

test("smoke with malformed provider output falls back", async () => {
  const result = await runGmProviderSmoke({
    env: SAFE_ENV,
    providerEnabled: true,
    provider: "fake",
    model: "fake-gm-model",
    providerFn: async () => ({
      ok: true,
      narration: {
        title: "Start Location",
        body: "Start Location has changed and your inventory now contains a new item.",
        tone: "neutral",
        sensoryDetails: [],
        focusEntityIds: []
      },
      suggestedActionLabels: [],
      warnings: [],
      stateMutations: [{ op: "add_item" }]
    })
  });

  assert.equal(result.providerAttempted, true);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.errorCode, "GM_PROVIDER_FALLBACK_USED");
  assert.ok(result.warnings.includes("GM_PROVIDER_OUTPUT_INVALID"));
});

test("smoke with fake provider throw returns safe error code", async () => {
  const result = await runGmProviderSmoke({
    env: SAFE_ENV,
    providerEnabled: true,
    provider: "fake",
    model: "fake-gm-model",
    providerFn: async () => {
      throw new Error("Authorization: Bearer secret-token");
    }
  });
  const encoded = JSON.stringify(result);

  assert.equal(result.providerAttempted, true);
  assert.equal(result.providerSucceeded, false);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.errorCode, "GM_PROVIDER_FALLBACK_USED");
  assert.doesNotMatch(encoded, /secret-token|Authorization|Bearer/i);
});

test("provider enabled but model missing reports safe fallback", async () => {
  const result = await runGmProviderSmoke({
    env: SAFE_ENV,
    providerEnabled: true,
    provider: "local"
  });

  assert.equal(result.ok, true);
  assert.equal(result.providerAttempted, false);
  assert.equal(result.providerConfigured, true);
  assert.equal(result.modelConfigured, false);
  assert.equal(result.providerSucceeded, false);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.errorCode, "GM_PROVIDER_MODEL_UNCONFIGURED");
});

test("smoke summary does not include raw prompt", () => {
  const summary = summarizeGmSmokeResult({
    ok: true,
    providerAttempted: true,
    providerName: "local",
    providerKind: "local",
    providerSucceeded: true,
    providerConfigured: true,
    modelConfigured: true,
    fallbackUsed: false,
    evaluationScore: 90,
    warnings: [],
    errorCode: null,
    prompt: "SYSTEM: hidden prompt"
  });

  assert.doesNotMatch(JSON.stringify(summary), /SYSTEM:|hidden prompt|prompt/i);
});

test("smoke summary does not include raw provider response", () => {
  const summary = summarizeGmSmokeResult({
    ok: true,
    providerAttempted: true,
    providerName: "local",
    providerKind: "local",
    providerSucceeded: true,
    providerConfigured: true,
    modelConfigured: true,
    fallbackUsed: false,
    evaluationScore: 90,
    warnings: [],
    providerResponse: "raw model response"
  });

  assert.doesNotMatch(JSON.stringify(summary), /raw model response|providerResponse/i);
});

test("smoke summary does not include env values", () => {
  const status = getSafeGmProviderConfigStatus({
    env: {
      NOTDND_GM_PROVIDER_ENABLED: "true",
      NOTDND_GM_PROVIDER: "chatgpt",
      NOTDND_GM_MODEL: "private-model",
      OPENAI_API_KEY: "private-key"
    }
  });
  const encoded = JSON.stringify(status);

  assert.equal(status.providerEnabled, true);
  assert.equal(status.providerConfigured, false);
  assert.equal(status.modelConfigured, true);
  assert.equal(status.providerName, "chatgpt");
  assert.equal(status.providerKind, "external");
  assert.doesNotMatch(encoded, /private-key|private-model/);
});

test("buildSmokeSoloRun creates a neutral valid scene", () => {
  const run = buildSmokeSoloRun({ runId: "smoke_test_run" });
  const scene = buildSoloScenePayload(run);

  assert.equal(scene.ok, true);
  assert.equal(scene.runId, "smoke_test_run");
  assert.equal(scene.location.locationId, "start_location");
});
