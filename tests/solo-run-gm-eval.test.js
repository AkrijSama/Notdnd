import assert from "node:assert/strict";
import test from "node:test";
import { generatePlaceholderGmNarration } from "../server/solo/gm.js";
import {
  evaluateGmNarration,
  evaluateGrounding,
  evaluateMutationSafety,
  evaluatePolicySafety,
  evaluateStyle
} from "../server/solo/gmEval.js";
import { buildGmSceneInput } from "../server/solo/gm.js";
import { buildProviderPromptMessages } from "../server/solo/gmProvider.js";
import {
  defaultMainlineScene,
  sceneWithForbiddenLeakSource,
  sceneWithMovementMemory,
  sceneWithMissingOptionalData,
  sceneWithVisibleNpc
} from "./fixtures/solo-gm-scenes.js";

function providerPrompt(scene = defaultMainlineScene()) {
  const gmInput = buildGmSceneInput(scene);
  return buildProviderPromptMessages(gmInput);
}

function validOutput(overrides = {}) {
  return {
    ok: true,
    narration: {
      title: "Start Location",
      body:
        "Start Location sits quiet around the player, defined by the neutral placeholder starting state. Placeholder NPC is visible nearby, giving the scene a clear point of attention without adding new facts.",
      tone: "neutral",
      sensoryDetails: ["quiet"],
      focusEntityIds: ["location:start_location"],
      ...(overrides.narration || {})
    },
    suggestedActionLabels: ["inspect"],
    warnings: [],
    stateMutations: [],
    ...overrides
  };
}

test("prompt includes source-of-truth instruction", () => {
  const messages = providerPrompt();
  assert.match(messages[0].content, /SOURCE OF TRUTH/i);
  assert.match(messages[0].content, /only use the provided scene input as truth/i);
});

test("prompt includes no-mutation instruction", () => {
  assert.match(providerPrompt()[0].content, /do not mutate state/i);
});

test("prompt includes no-canon-invention instruction", () => {
  assert.match(providerPrompt()[0].content, /do not create durable canon/i);
  assert.match(providerPrompt()[0].content, /final IP lore invention/i);
});

test("prompt includes policy and edition", () => {
  const encoded = JSON.stringify(providerPrompt());
  assert.match(encoded, /mainline/);
  assert.match(encoded, /mainline_default/);
});

test("prompt includes output JSON contract", () => {
  const system = providerPrompt()[0].content;
  assert.match(system, /Return JSON only/);
  assert.match(system, /stateMutations/);
  assert.match(system, /narration/);
});

test("prompt includes current location entities actions and memory", () => {
  const encoded = JSON.stringify(providerPrompt(sceneWithVisibleNpc()));
  assert.match(encoded, /Start Location/);
  assert.match(encoded, /Placeholder NPC/);
  assert.match(encoded, /availableActions/);
  assert.match(encoded, /relevantMemoryFacts/);
});

test("prompt does not include forbidden entity or fact for mainline", () => {
  const encoded = JSON.stringify(providerPrompt(sceneWithForbiddenLeakSource()));
  assert.doesNotMatch(encoded, /Forbidden Placeholder|Blocked policy test|explicit_sexual_content/);
});

test("prompt does not include secrets or env values", () => {
  const encoded = JSON.stringify(providerPrompt(sceneWithMovementMemory()));
  assert.doesNotMatch(encoded, /OPENAI_API_KEY|GEMINI_API_KEY|XAI_API_KEY|secret|Bearer/i);
});

test("valid grounded output scores passing", () => {
  const result = evaluateGmNarration(sceneWithVisibleNpc(), validOutput());
  assert.equal(result.ok, true);
  assert.ok(result.score >= 90);
});

test("output with stateMutations fails mutation safety", () => {
  const result = evaluateMutationSafety(validOutput({ stateMutations: [{ op: "set" }] }));
  assert.equal(result.ok, false);
  assert.ok(result.warnings.includes("mutation_state_mutations_empty"));
});

test("output with script or html fails policy check", () => {
  const result = evaluatePolicySafety(defaultMainlineScene(), validOutput({ narration: { body: "Start Location <script>bad()</script>" } }));
  assert.equal(result.ok, false);
  assert.ok(result.warnings.includes("policy_no_html"));
});

test("output with unknown focusEntityId fails grounding", () => {
  const result = evaluateGrounding(defaultMainlineScene(), validOutput({ narration: { focusEntityIds: ["npc:unknown"] } }));
  assert.equal(result.ok, false);
  assert.ok(result.warnings.includes("grounded_focus_entities"));
});

test("output with unavailable action suggestion fails grounding", () => {
  const result = evaluateGrounding(defaultMainlineScene(), validOutput({ suggestedActionLabels: ["Open hidden door"] }));
  assert.equal(result.ok, false);
  assert.ok(result.warnings.includes("grounded_suggested_actions"));
});

test("output too short fails style", () => {
  const result = evaluateStyle(validOutput({ narration: { body: "Start Location." } }));
  assert.equal(result.ok, false);
  assert.ok(result.warnings.includes("style_not_too_short"));
});

test("output too long fails style", () => {
  const body = `Start Location ${"neutral ".repeat(220)}`;
  const result = evaluateStyle(validOutput({ narration: { body } }));
  assert.equal(result.ok, false);
  assert.ok(result.warnings.includes("style_not_too_long"));
});

test("raw JSON-looking body fails style", () => {
  const result = evaluateStyle(validOutput({ narration: { body: "{\"body\":\"Start Location raw dump\"}" } }));
  assert.equal(result.ok, false);
  assert.ok(result.warnings.includes("style_no_raw_json"));
});

test("markdown table output fails style", () => {
  const result = evaluateStyle(validOutput({ narration: { body: "| Scene | Detail |\n| Start Location | Placeholder |" } }));
  assert.equal(result.ok, false);
  assert.ok(result.warnings.includes("style_no_markdown_table"));
});

test("mainline blocked-content output fails policy check", () => {
  const result = evaluatePolicySafety(defaultMainlineScene(), {
    ...validOutput(),
    contentTags: ["explicit_sexual_content"]
  });
  assert.equal(result.ok, false);
  assert.ok(result.warnings.includes("policy_content_tags"));
});

test("placeholder GM output passes baseline eval", () => {
  const scene = defaultMainlineScene();
  const output = generatePlaceholderGmNarration(scene);
  const result = evaluateGmNarration(scene, output);
  assert.equal(result.ok, true);
  assert.ok(result.score >= 80);
});

test("evaluation returns stable deterministic score", () => {
  const scene = sceneWithMissingOptionalData();
  const output = validOutput({
    narration: {
      body: "Start Location remains described only by the known placeholder details. No extra entities are asserted, and the narration keeps missing data ambiguous rather than inventing it.",
      focusEntityIds: ["location:start_location"]
    },
    suggestedActionLabels: ["inspect"]
  });

  const first = evaluateGmNarration(scene, output);
  const second = evaluateGmNarration(scene, output);
  assert.deepEqual(first, second);
});
