import { generateWithProvider } from "../ai/providers.js";
import {
  buildGmSceneInput,
  generatePlaceholderGmNarration,
  sanitizeGmNarration,
  validateGmSceneOutput
} from "./gm.js";

const PROVIDER_DISABLED_WARNING = "GM_PROVIDER_DISABLED";
const PROVIDER_UNAVAILABLE_WARNING = "GM_PROVIDER_UNAVAILABLE";
const PROVIDER_OUTPUT_INVALID_WARNING = "GM_PROVIDER_OUTPUT_INVALID";

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function plainText(value) {
  return String(value ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]*>/g, "")
    .trim();
}

function addWarning(gmNarration, warning) {
  return {
    ...gmNarration,
    warnings: Array.from(new Set([...(gmNarration.warnings || []), warning]))
  };
}

function safePlaceholder(scenePayload, warning = null) {
  const placeholder = generatePlaceholderGmNarration(scenePayload);
  return warning ? addWarning(placeholder, warning) : placeholder;
}

function providerEnabledFromEnv(env = process.env) {
  return String(env.NOTDND_GM_PROVIDER_ENABLED || "").trim().toLowerCase() === "true";
}

export function shouldUseRealGmProvider(options = {}) {
  if (options.mode === "placeholder") {
    return false;
  }
  const enabled = options.providerEnabled ?? providerEnabledFromEnv(options.env);
  return options.mode === "provider" ? Boolean(enabled) : Boolean(enabled);
}

export function buildProviderPromptMessages(gmInput, options = {}) {
  const location = gmInput.location || {};
  const activeQuests = gmInput.activeQuests || [];
  const questJustAdvanced = gmInput.questJustAdvanced || null;
  const sceneData = {
    runId: gmInput.runId,
    edition: gmInput.edition,
    policyProfileId: gmInput.policyProfileId,
    location,
    visibleEntities: gmInput.visibleEntities || [],
    availableMoves: gmInput.availableMoves || [],
    availableActions: gmInput.availableActions || [],
    recentTimeline: gmInput.recentTimeline || [],
    relevantMemoryFacts: gmInput.relevantMemoryFacts || [],
    activeQuests,
    questJustAdvanced
  };

  // The current objective drives a "weave the goal in" prompt line; the quest
  // engine — not the GM — owns activation/advancement/completion.
  const objective = activeQuests.map((quest) => quest && quest.objective).find(Boolean) || null;
  const advancedNote =
    questJustAdvanced && questJustAdvanced.objective
      ? `The player just made progress: "${questJustAdvanced.objective}". Acknowledge this in the fiction.`
      : null;

  const system = [
    "You are the GM narrator for NotDND, a persistent solo AI-GM spatial sandbox.",
    "SOURCE OF TRUTH: only use the provided scene input as truth. If data is missing, keep it ambiguous instead of inventing.",
    "Style: clear, immersive tabletop-GM narration in modern readable prose. Write 1-3 concise paragraphs. Mention the current location and visible entities naturally when relevant.",
    "Avoid purple prose, generic chatbot filler, system-summary phrasing, raw JSON, markdown tables, bullet lists, and final IP lore invention.",
    "Strict constraints: do not mutate state, do not create durable canon, and do not invent persisted items, NPCs, quests, rewards, locations, relationships, inventory, hidden exits, or unavailable actions.",
    "Do not change relationship values, do not claim the player chose an action, and do not mention unavailable actions or moves.",
    "Respect the edition and policy profile. Never leak forbidden or blocked content into mainline scenes.",
    objective ? `The player is pursuing: ${objective}. Weave this goal naturally into scene framing and dialogue.` : null,
    advancedNote,
    "Do NOT invent new quests or declare quests complete. Quest progress is decided only by the system.",
    "Return JSON only with this exact shape: {\"ok\":true,\"narration\":{\"title\":\"string\",\"body\":\"string\",\"tone\":\"neutral|tense|mysterious|warm|dangerous|comic|dramatic\",\"sensoryDetails\":[],\"focusEntityIds\":[]},\"suggestedActionLabels\":[],\"warnings\":[],\"stateMutations\":[]}.",
    "stateMutations must always be an empty array.",
    "Use plain text only. Do not include HTML, script tags, markdown tables, or raw JSON dumps in narration."
  ]
    .filter(Boolean)
    .join("\n");

  return [
    {
      role: "system",
      content: system
    },
    {
      role: "user",
      content: JSON.stringify(sceneData, null, options.pretty === false ? 0 : 2)
    }
  ];
}

function messagesToPrompt(messages) {
  return messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n");
}

export function createGmProviderAdapter(options = {}) {
  if (typeof options.providerFn === "function") {
    return {
      async generate({ gmInput, messages, prompt, provider, model }) {
        return options.providerFn({ gmInput, messages, prompt, provider, model });
      }
    };
  }

  return {
    async generate({ prompt, provider, model }) {
      return generateWithProvider({
        provider,
        type: "gm",
        prompt,
        model,
        fetchImpl: options.fetchImpl,
        configOverride: options.configOverride
      });
    }
  };
}

function extractRawText(rawOutput) {
  if (typeof rawOutput === "string") {
    return rawOutput;
  }
  if (rawOutput && typeof rawOutput.text === "string") {
    return rawOutput.text;
  }
  if (rawOutput && typeof rawOutput.content === "string") {
    return rawOutput.content;
  }
  if (rawOutput && typeof rawOutput.output_text === "string") {
    return rawOutput.output_text;
  }
  return "";
}

export function parseProviderGmOutput(rawOutput, options = {}) {
  if (rawOutput && typeof rawOutput === "object" && rawOutput.narration) {
    return cloneJson(rawOutput);
  }

  const rawText = extractRawText(rawOutput);
  const trimmed = rawText.trim();
  if (!trimmed) {
    return {
      ok: false,
      errors: [
        {
          path: "providerOutput",
          message: "Provider output was empty"
        }
      ]
    };
  }
  if (rawOutput?.provider === "local" && /^Mock GM response\b/i.test(trimmed)) {
    return {
      ok: true,
      narration: {
        title: options.title || "Current Scene",
        body: `${options.title || "Current Scene"} is ready for local mock GM narration. The scene remains grounded in the server payload, with available movement, visible entities, and memory context preserved for evaluation.`,
        tone: "neutral",
        sensoryDetails: [],
        focusEntityIds: []
      },
      suggestedActionLabels: [],
      warnings: ["GM_LOCAL_MOCK_PROVIDER"],
      stateMutations: []
    };
  }
  if (/\b(SYSTEM|USER):/i.test(trimmed)) {
    return {
      ok: false,
      errors: [
        {
          path: "providerOutput",
          message: "Provider output appeared to include a raw prompt dump"
        }
      ]
    };
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    // Plain text output is accepted below and wrapped into the GM contract.
  }

  return {
    ok: true,
    narration: {
      title: options.title || "Current Scene",
      body: plainText(trimmed),
      tone: "neutral",
      sensoryDetails: [],
      focusEntityIds: []
    },
    suggestedActionLabels: [],
    warnings: [],
    stateMutations: []
  };
}

export async function generateGmNarrationWithProvider(scenePayload, options = {}) {
  const gmInput = buildGmSceneInput(scenePayload, options);
  if (!gmInput.ok) {
    return {
      ...gmInput,
      warnings: [PROVIDER_OUTPUT_INVALID_WARNING]
    };
  }

  const messages = buildProviderPromptMessages(gmInput, options);
  const prompt = messagesToPrompt(messages);
  const provider = options.provider || options.env?.NOTDND_GM_PROVIDER || process.env.NOTDND_GM_PROVIDER || "placeholder";
  const model = options.model || options.env?.NOTDND_GM_MODEL || process.env.NOTDND_GM_MODEL || "";
  const adapter = createGmProviderAdapter(options);
  const rawOutput = await adapter.generate({ gmInput, messages, prompt, provider, model });
  const parsed = parseProviderGmOutput(rawOutput, { title: gmInput.location?.name || "Current Scene" });

  const validation = validateGmSceneOutput(parsed, { disallowHtml: false });
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors,
      warnings: [PROVIDER_OUTPUT_INVALID_WARNING]
    };
  }

  const sanitized = sanitizeGmNarration(parsed);
  if (!sanitized.ok) {
    return {
      ...sanitized,
      warnings: [PROVIDER_OUTPUT_INVALID_WARNING]
    };
  }

  return sanitized;
}

export async function resolveGmNarration(scenePayload, options = {}) {
  const before = JSON.stringify(scenePayload);

  if (!shouldUseRealGmProvider(options)) {
    const warning = options.mode === "provider" ? PROVIDER_DISABLED_WARNING : null;
    return safePlaceholder(scenePayload, warning);
  }

  try {
    const providerNarration = await generateGmNarrationWithProvider(scenePayload, options);
    if (providerNarration.ok) {
      if (JSON.stringify(scenePayload) !== before) {
        return safePlaceholder(scenePayload, PROVIDER_OUTPUT_INVALID_WARNING);
      }
      return providerNarration;
    }
    return safePlaceholder(scenePayload, PROVIDER_OUTPUT_INVALID_WARNING);
  } catch {
    return safePlaceholder(scenePayload, PROVIDER_UNAVAILABLE_WARNING);
  }
}

export const GM_PROVIDER_WARNINGS = {
  PROVIDER_DISABLED_WARNING,
  PROVIDER_UNAVAILABLE_WARNING,
  PROVIDER_OUTPUT_INVALID_WARNING
};
