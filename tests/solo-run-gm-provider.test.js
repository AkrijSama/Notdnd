import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProviderPromptMessages,
  generateGmNarrationWithProvider,
  parseProviderGmOutput,
  resolveGmNarration,
  shouldUseRealGmProvider
} from "../server/solo/gmProvider.js";
import { buildSoloScenePayload } from "../server/solo/scene.js";
import { createDefaultSoloRun } from "../server/solo/schema.js";

function makeScene() {
  const run = createDefaultSoloRun({
    runId: "run_gm_provider",
    now: "2026-01-01T00:00:00.000Z"
  });
  return buildSoloScenePayload(run);
}

function sceneWithForbiddenLeaks() {
  const scene = makeScene();
  scene.visibleEntities.push({
    entityId: "npc:forbidden_placeholder",
    entityType: "npc",
    displayName: "Forbidden Placeholder",
    summary: "Policy test only.",
    visible: true,
    inspectable: true,
    edition: "forbidden",
    policyProfileId: "forbidden_default",
    contentTags: ["adult_themes"],
    memoryFactIds: [],
    actionTypes: ["inspect"],
    tags: []
  });
  scene.relevantMemoryFacts.push({
    factId: "fact_blocked",
    entityIds: ["start_location"],
    type: "blocked_policy_test",
    text: "Blocked policy test only.",
    source: "system",
    createdAt: "2026-01-01T00:00:00.000Z",
    canonical: true,
    edition: "mainline",
    policyProfileId: "mainline_default",
    contentTags: ["explicit_sexual_content"],
    tags: []
  });
  return scene;
}

function validProviderOutput(body = "Provider narration.") {
  return {
    ok: true,
    narration: {
      title: "Start Location",
      body,
      tone: "mysterious",
      sensoryDetails: ["quiet air"],
      focusEntityIds: ["location:start_location"]
    },
    suggestedActionLabels: ["Inspect area"],
    warnings: [],
    stateMutations: []
  };
}

test("provider disabled returns placeholder narration", async () => {
  const narration = await resolveGmNarration(makeScene(), {
    providerEnabled: false,
    providerFn: async () => validProviderOutput("Should not run.")
  });

  assert.equal(narration.ok, true);
  assert.equal(narration.narration.title, "Start Location");
  assert.match(narration.narration.body, /Neutral placeholder starting location/);
});

test("provider enabled uses fake provider", async () => {
  let called = false;
  const narration = await resolveGmNarration(makeScene(), {
    providerEnabled: true,
    provider: "fake",
    providerFn: async () => {
      called = true;
      return validProviderOutput("Fake provider narration.");
    }
  });

  assert.equal(called, true);
  assert.equal(narration.narration.body, "Fake provider narration.");
  assert.equal(narration.narration.tone, "mysterious");
});

test("valid fake provider JSON output is accepted", async () => {
  const narration = await resolveGmNarration(makeScene(), {
    providerEnabled: true,
    providerFn: async () => JSON.stringify(validProviderOutput("JSON provider narration."))
  });

  assert.equal(narration.ok, true);
  assert.equal(narration.narration.body, "JSON provider narration.");
});

test("valid fake provider plain text is wrapped safely", async () => {
  const narration = await resolveGmNarration(makeScene(), {
    providerEnabled: true,
    providerFn: async () => "Plain provider narration."
  });

  assert.equal(narration.ok, true);
  assert.equal(narration.narration.title, "Start Location");
  assert.equal(narration.narration.body, "Plain provider narration.");
});

test("non-empty stateMutations falls back to placeholder", async () => {
  const narration = await resolveGmNarration(makeScene(), {
    providerEnabled: true,
    providerFn: async () => ({
      ...validProviderOutput("Invalid mutation narration."),
      stateMutations: [{ op: "set", path: "currentLocationId" }]
    })
  });

  assert.match(narration.narration.body, /Neutral placeholder starting location/);
  assert.ok(narration.warnings.includes("GM_PROVIDER_OUTPUT_INVALID"));
});

test("script and html injection is sanitized", async () => {
  const narration = await resolveGmNarration(makeScene(), {
    providerEnabled: true,
    providerFn: async () => validProviderOutput("Plain <em>text</em><script>bad()</script>")
  });

  assert.equal(narration.narration.body, "Plain text");
});

test("provider throw falls back to placeholder with warning", async () => {
  const narration = await resolveGmNarration(makeScene(), {
    providerEnabled: true,
    providerFn: async () => {
      throw new Error("Secret token abc123 leaked upstream");
    }
  });

  assert.match(narration.narration.body, /Neutral placeholder starting location/);
  assert.ok(narration.warnings.includes("GM_PROVIDER_UNAVAILABLE"));
});

test("provider error does not leak raw secret details", async () => {
  const narration = await resolveGmNarration(makeScene(), {
    providerEnabled: true,
    providerFn: async () => {
      throw new Error("OPENAI_API_KEY=secret-value");
    }
  });

  assert.doesNotMatch(JSON.stringify(narration), /secret-value|OPENAI_API_KEY/);
});

test("mainline GM input excludes forbidden entity before provider call", async () => {
  let prompt = "";
  await resolveGmNarration(sceneWithForbiddenLeaks(), {
    providerEnabled: true,
    providerFn: async ({ prompt: providerPrompt }) => {
      prompt = providerPrompt;
      return validProviderOutput();
    }
  });

  assert.doesNotMatch(prompt, /Forbidden Placeholder|forbidden_default/);
});

test("blocked contentTags do not reach provider prompt", async () => {
  let prompt = "";
  await resolveGmNarration(sceneWithForbiddenLeaks(), {
    providerEnabled: true,
    providerFn: async ({ prompt: providerPrompt }) => {
      prompt = providerPrompt;
      return validProviderOutput();
    }
  });

  assert.doesNotMatch(prompt, /explicit_sexual_content|Blocked policy test/);
});

test("buildProviderPromptMessages includes location entities actions and memory", () => {
  const scene = makeScene();
  const messages = buildProviderPromptMessages({
    runId: scene.runId,
    edition: scene.edition,
    policyProfileId: scene.policyProfileId,
    location: scene.location,
    visibleEntities: scene.visibleEntities,
    availableMoves: scene.availableMoves,
    availableActions: scene.availableActions,
    recentTimeline: scene.recentTimeline,
    relevantMemoryFacts: scene.relevantMemoryFacts
  });
  const encoded = JSON.stringify(messages);

  assert.match(encoded, /Start Location/);
  assert.match(encoded, /visibleEntities/);
  assert.match(encoded, /availableActions/);
  assert.match(encoded, /relevantMemoryFacts/);
});

test("buildProviderPromptMessages includes no-mutation and no-canon instructions", () => {
  const messages = buildProviderPromptMessages({
    runId: "run",
    edition: "mainline",
    policyProfileId: "mainline_default",
    location: { name: "Start Location" }
  });
  const system = messages[0].content;

  assert.match(system, /Do not mutate state/);
  assert.match(system, /do not create durable canon/i);
  assert.match(system, /stateMutations must always be an empty array/);
});

test("resolveGmNarration does not mutate scenePayload", async () => {
  const scene = makeScene();
  const before = JSON.stringify(scene);

  await resolveGmNarration(scene, {
    providerEnabled: true,
    providerFn: async () => validProviderOutput()
  });

  assert.equal(JSON.stringify(scene), before);
});

test("mode placeholder forces placeholder behavior", async () => {
  let called = false;
  const narration = await resolveGmNarration(makeScene(), {
    mode: "placeholder",
    providerEnabled: true,
    providerFn: async () => {
      called = true;
      return validProviderOutput();
    }
  });

  assert.equal(called, false);
  assert.match(narration.narration.body, /Neutral placeholder starting location/);
});

test("mode provider does not run unless feature flag enabled", async () => {
  let called = false;
  const narration = await resolveGmNarration(makeScene(), {
    mode: "provider",
    providerEnabled: false,
    providerFn: async () => {
      called = true;
      return validProviderOutput();
    }
  });

  assert.equal(called, false);
  assert.ok(narration.warnings.includes("GM_PROVIDER_DISABLED"));
});

test("shouldUseRealGmProvider respects feature flag", () => {
  assert.equal(shouldUseRealGmProvider({ providerEnabled: false }), false);
  assert.equal(shouldUseRealGmProvider({ providerEnabled: true }), true);
  assert.equal(shouldUseRealGmProvider({ mode: "placeholder", providerEnabled: true }), false);
});

test("parseProviderGmOutput accepts direct objects and plain text", () => {
  assert.equal(parseProviderGmOutput(validProviderOutput("Direct object.")).narration.body, "Direct object.");
  assert.equal(parseProviderGmOutput("Plain text.", { title: "Scene" }).narration.body, "Plain text.");
});

test("generateGmNarrationWithProvider exposes invalid provider output without raw fallback", async () => {
  const result = await generateGmNarrationWithProvider(makeScene(), {
    providerFn: async () => ({
      ...validProviderOutput("Invalid."),
      stateMutations: [{ op: "bad" }]
    })
  });

  assert.equal(result.ok, false);
  assert.ok(result.warnings.includes("GM_PROVIDER_OUTPUT_INVALID"));
});
