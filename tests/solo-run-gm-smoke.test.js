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
    providerFn: async () => validProviderOutput()
  });

  assert.equal(result.ok, true);
  assert.equal(result.providerAttempted, true);
  assert.equal(result.providerConfigured, true);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.errorCode, null);
});

test("smoke with fake provider evaluates output", async () => {
  const result = await runGmProviderSmoke({
    env: SAFE_ENV,
    providerEnabled: true,
    provider: "fake",
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
    providerFn: async () => {
      throw new Error("Authorization: Bearer secret-token");
    }
  });
  const encoded = JSON.stringify(result);

  assert.equal(result.providerAttempted, true);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.errorCode, "GM_PROVIDER_FALLBACK_USED");
  assert.doesNotMatch(encoded, /secret-token|Authorization|Bearer/i);
});

test("smoke summary does not include raw prompt", () => {
  const summary = summarizeGmSmokeResult({
    ok: true,
    providerAttempted: true,
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
  assert.doesNotMatch(encoded, /private-key|private-model/);
});

test("buildSmokeSoloRun creates a neutral valid scene", () => {
  const run = buildSmokeSoloRun({ runId: "smoke_test_run" });
  const scene = buildSoloScenePayload(run);

  assert.equal(scene.ok, true);
  assert.equal(scene.runId, "smoke_test_run");
  assert.equal(scene.location.locationId, "start_location");
});
