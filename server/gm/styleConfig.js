import fs from "node:fs/promises";
import path from "node:path";

const TONE_VALUES = ["dark_fantasy", "high_fantasy", "horror", "comedic", "noir", "grimdark", "heroic", "custom"];
const VERBOSITY_VALUES = ["terse", "balanced", "verbose", "cinematic"];
const PERSPECTIVE_VALUES = ["second_person", "third_person", "narrator"];
const PERSONALITY_VALUES = ["neutral", "sardonic", "warm", "menacing", "whimsical", "stoic", "custom"];
const STRICTNESS_VALUES = ["strict", "flexible", "narrative"];
const DIFFICULTY_VALUES = ["merciful", "balanced", "brutal", "adversarial"];

const TOP_LEVEL_KEYS = new Set(["narrative", "gmPersonality", "memory", "model"]);
const NARRATIVE_KEYS = new Set(["tone", "verbosity", "perspective", "matureContent", "customTonePrompt"]);
const GM_PERSONALITY_KEYS = new Set([
  "name",
  "personality",
  "customPersonalityPrompt",
  "rulesStrictness",
  "difficultyBias"
]);
const MEMORY_KEYS = new Set([
  "priorityTags",
  "deprioritizedTags",
  "autoSummarizeThreshold",
  "relationshipTracking",
  "playerFocusWeights"
]);
const MODEL_KEYS = new Set(["preferredNarrativeModel", "preferredUtilityModel", "allowFreeModels", "maxTokensPerResponse"]);

function memoryRoot() {
  return process.env.NOTDND_MEMORY_ROOT
    ? path.resolve(process.env.NOTDND_MEMORY_ROOT)
    : path.resolve(process.cwd(), "data/campaigns");
}

function campaignRoot(campaignId) {
  return path.join(memoryRoot(), String(campaignId || "unknown-campaign"));
}

function styleFilePath(campaignId) {
  return path.join(campaignRoot(campaignId), "style.json");
}

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw badRequest(`${fieldName} must be an array of strings.`);
  }
  const normalized = value.map((entry) => String(entry || "").trim()).filter(Boolean);
  if (normalized.length !== value.length) {
    throw badRequest(`${fieldName} must contain only non-empty strings.`);
  }
  return [...new Set(normalized)];
}

function badRequest(message) {
  const error = new Error(message);
  error.code = "BAD_REQUEST";
  error.statusCode = 400;
  return error;
}

function enumError(fieldName, value, allowed) {
  return badRequest(`${fieldName} must be one of: ${allowed.join(", ")}. Received: ${String(value)}`);
}

function assertKnownKeys(input, allowedKeys, scopeLabel) {
  for (const key of Object.keys(input || {})) {
    if (!allowedKeys.has(key)) {
      throw badRequest(`Unknown ${scopeLabel} field "${key}".`);
    }
  }
}

function validateEnum(value, allowed, fieldName) {
  if (value === undefined) {
    return;
  }
  const normalized = String(value || "").trim();
  if (!allowed.includes(normalized)) {
    throw enumError(fieldName, value, allowed);
  }
}

function validateNullableString(value, fieldName) {
  if (value === undefined) {
    return;
  }
  if (value === null) {
    return;
  }
  if (typeof value !== "string") {
    throw badRequest(`${fieldName} must be a string or null.`);
  }
}

function validateNarrative(input = {}) {
  assertKnownKeys(input, NARRATIVE_KEYS, "narrative");
  validateEnum(input.tone, TONE_VALUES, "narrative.tone");
  validateEnum(input.verbosity, VERBOSITY_VALUES, "narrative.verbosity");
  validateEnum(input.perspective, PERSPECTIVE_VALUES, "narrative.perspective");
  if (input.matureContent !== undefined && typeof input.matureContent !== "boolean") {
    throw badRequest("narrative.matureContent must be a boolean.");
  }
  if (input.customTonePrompt !== undefined && typeof input.customTonePrompt !== "string") {
    throw badRequest("narrative.customTonePrompt must be a string.");
  }
}

function validateGmPersonality(input = {}) {
  assertKnownKeys(input, GM_PERSONALITY_KEYS, "gmPersonality");
  if (input.name !== undefined && typeof input.name !== "string") {
    throw badRequest("gmPersonality.name must be a string.");
  }
  validateEnum(input.personality, PERSONALITY_VALUES, "gmPersonality.personality");
  if (input.customPersonalityPrompt !== undefined && typeof input.customPersonalityPrompt !== "string") {
    throw badRequest("gmPersonality.customPersonalityPrompt must be a string.");
  }
  validateEnum(input.rulesStrictness, STRICTNESS_VALUES, "gmPersonality.rulesStrictness");
  validateEnum(input.difficultyBias, DIFFICULTY_VALUES, "gmPersonality.difficultyBias");
}

function validateMemory(input = {}) {
  assertKnownKeys(input, MEMORY_KEYS, "memory");
  if (input.priorityTags !== undefined) {
    asStringArray(input.priorityTags, "memory.priorityTags");
  }
  if (input.deprioritizedTags !== undefined) {
    asStringArray(input.deprioritizedTags, "memory.deprioritizedTags");
  }
  if (input.autoSummarizeThreshold !== undefined) {
    const value = Number(input.autoSummarizeThreshold);
    if (!Number.isFinite(value) || value < 300 || value > 20_000) {
      throw badRequest("memory.autoSummarizeThreshold must be a number between 300 and 20000.");
    }
  }
  if (input.relationshipTracking !== undefined && typeof input.relationshipTracking !== "boolean") {
    throw badRequest("memory.relationshipTracking must be a boolean.");
  }
  if (input.playerFocusWeights !== undefined) {
    if (!ensureObject(input.playerFocusWeights)) {
      throw badRequest("memory.playerFocusWeights must be an object keyed by playerName.");
    }
    for (const [playerName, weight] of Object.entries(input.playerFocusWeights)) {
      if (!String(playerName || "").trim()) {
        throw badRequest("memory.playerFocusWeights keys must be non-empty player names.");
      }
      const numeric = Number(weight);
      if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) {
        throw badRequest(`memory.playerFocusWeights.${playerName} must be a number between 0 and 1.`);
      }
    }
  }
}

function validateModel(input = {}) {
  assertKnownKeys(input, MODEL_KEYS, "model");
  validateNullableString(input.preferredNarrativeModel, "model.preferredNarrativeModel");
  validateNullableString(input.preferredUtilityModel, "model.preferredUtilityModel");
  if (input.allowFreeModels !== undefined && typeof input.allowFreeModels !== "boolean") {
    throw badRequest("model.allowFreeModels must be a boolean.");
  }
  if (input.maxTokensPerResponse !== undefined && input.maxTokensPerResponse !== null) {
    const value = Number(input.maxTokensPerResponse);
    if (!Number.isFinite(value) || value < 64 || value > 8192) {
      throw badRequest("model.maxTokensPerResponse must be null or a number between 64 and 8192.");
    }
  }
}

function validateStyleConfigUpdate(partialUpdate = {}) {
  if (!ensureObject(partialUpdate)) {
    throw badRequest("Style update payload must be an object.");
  }
  assertKnownKeys(partialUpdate, TOP_LEVEL_KEYS, "style");

  if (partialUpdate.narrative !== undefined) {
    if (!ensureObject(partialUpdate.narrative)) {
      throw badRequest("narrative must be an object.");
    }
    validateNarrative(partialUpdate.narrative);
  }
  if (partialUpdate.gmPersonality !== undefined) {
    if (!ensureObject(partialUpdate.gmPersonality)) {
      throw badRequest("gmPersonality must be an object.");
    }
    validateGmPersonality(partialUpdate.gmPersonality);
  }
  if (partialUpdate.memory !== undefined) {
    if (!ensureObject(partialUpdate.memory)) {
      throw badRequest("memory must be an object.");
    }
    validateMemory(partialUpdate.memory);
  }
  if (partialUpdate.model !== undefined) {
    if (!ensureObject(partialUpdate.model)) {
      throw badRequest("model must be an object.");
    }
    validateModel(partialUpdate.model);
  }
}

function deepMerge(base, patch) {
  if (Array.isArray(base) && Array.isArray(patch)) {
    return [...patch];
  }
  if (!ensureObject(base) || !ensureObject(patch)) {
    return patch === undefined ? base : patch;
  }

  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (Array.isArray(value)) {
      merged[key] = [...value];
      continue;
    }
    if (ensureObject(value)) {
      merged[key] = deepMerge(ensureObject(base[key]) ? base[key] : {}, value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function normalizedConfig(input = {}) {
  const defaults = getDefaultStyleConfig();
  const merged = deepMerge(defaults, input || {});
  return {
    narrative: {
      tone: String(merged.narrative.tone || defaults.narrative.tone),
      verbosity: String(merged.narrative.verbosity || defaults.narrative.verbosity),
      perspective: String(merged.narrative.perspective || defaults.narrative.perspective),
      matureContent: Boolean(merged.narrative.matureContent),
      customTonePrompt: String(merged.narrative.customTonePrompt || "")
    },
    gmPersonality: {
      name: String(merged.gmPersonality.name || defaults.gmPersonality.name),
      personality: String(merged.gmPersonality.personality || defaults.gmPersonality.personality),
      customPersonalityPrompt: String(merged.gmPersonality.customPersonalityPrompt || ""),
      rulesStrictness: String(merged.gmPersonality.rulesStrictness || defaults.gmPersonality.rulesStrictness),
      difficultyBias: String(merged.gmPersonality.difficultyBias || defaults.gmPersonality.difficultyBias)
    },
    memory: {
      priorityTags: asStringArray(merged.memory.priorityTags || [], "memory.priorityTags"),
      deprioritizedTags: asStringArray(merged.memory.deprioritizedTags || [], "memory.deprioritizedTags"),
      autoSummarizeThreshold: Number(merged.memory.autoSummarizeThreshold || defaults.memory.autoSummarizeThreshold),
      relationshipTracking: Boolean(merged.memory.relationshipTracking),
      playerFocusWeights: Object.fromEntries(
        Object.entries(ensureObject(merged.memory.playerFocusWeights) ? merged.memory.playerFocusWeights : {}).map(([k, v]) => [
          String(k).trim(),
          Math.max(0, Math.min(1, Number(v || 0)))
        ])
      )
    },
    model: {
      preferredNarrativeModel:
        merged.model.preferredNarrativeModel === null
          ? null
          : String(merged.model.preferredNarrativeModel || "").trim() || null,
      preferredUtilityModel:
        merged.model.preferredUtilityModel === null
          ? null
          : String(merged.model.preferredUtilityModel || "").trim() || null,
      allowFreeModels: Boolean(merged.model.allowFreeModels),
      maxTokensPerResponse:
        merged.model.maxTokensPerResponse === null || merged.model.maxTokensPerResponse === undefined
          ? null
          : Number(merged.model.maxTokensPerResponse)
    }
  };
}

function toneDescription(config) {
  const toneMap = {
    dark_fantasy: "gritty, atmospheric, and morally gray dark fantasy",
    high_fantasy: "epic high fantasy with wonder, myth, and heroic scale",
    horror: "dread-heavy horror with mounting unease and psychological pressure",
    comedic: "playful and comedic fantasy with sharp timing and levity",
    noir: "shadowed noir where secrets, rain, and betrayal shape every scene",
    grimdark: "bleak grimdark where survival is costly and victory is never clean",
    heroic: "heroic adventure with bold stakes, rising hope, and triumphant turns",
    custom: String(config.narrative.customTonePrompt || "").trim() || "a custom narrative tone"
  };
  return toneMap[config.narrative.tone] || toneMap.dark_fantasy;
}

function verbosityDescription(verbosity) {
  const map = {
    terse: "1-2 compact paragraphs per response, focused on immediate action",
    balanced: "2-4 paragraphs per response, vivid but efficient",
    verbose: "3-5 detailed paragraphs with rich scene texture",
    cinematic: "cinematic pacing with sensory detail and dramatic framing"
  };
  return map[verbosity] || map.balanced;
}

function perspectiveDescription(perspective) {
  const map = {
    second_person: "second person present tense",
    third_person: "third person centered on player characters by name",
    narrator: "omniscient narrator perspective"
  };
  return map[perspective] || map.second_person;
}

function personalityDescription(config) {
  const personalityMap = {
    neutral: "measured, fair, and observant",
    sardonic: "dryly sardonic with occasional dark humor",
    warm: "warm, supportive, and emotionally attentive",
    menacing: "calmly menacing with controlled intensity",
    whimsical: "whimsical, playful, and unexpectedly imaginative",
    stoic: "stoic, restrained, and deliberate",
    custom: String(config.gmPersonality.customPersonalityPrompt || "").trim() || "custom personality guidance"
  };
  return personalityMap[config.gmPersonality.personality] || personalityMap.neutral;
}

function strictnessDescription(strictness) {
  const map = {
    strict: "Rules are strict: follow rules-as-written with minimal deviation.",
    flexible: "Rules are flexible: prioritize rule-of-cool for creative dramatic play.",
    narrative: "Rules are narrative-first: mechanics serve emotional and story momentum."
  };
  return map[strictness] || map.flexible;
}

function difficultyDescription(difficulty) {
  const map = {
    merciful: "Difficulty is merciful: failure still carries momentum and safety nets.",
    balanced: "Difficulty is balanced: fair stakes with meaningful consequences.",
    brutal: "Difficulty is brutal: tactical mistakes are punished hard and often.",
    adversarial: "Difficulty is adversarial: relentless opposition and high lethality."
  };
  return map[difficulty] || map.balanced;
}

/**
 * Returns the default campaign style configuration.
 * @returns {object}
 */
export function getDefaultStyleConfig() {
  return {
    narrative: {
      tone: "dark_fantasy",
      verbosity: "balanced",
      perspective: "second_person",
      matureContent: true,
      customTonePrompt: ""
    },
    gmPersonality: {
      name: "The GM",
      personality: "neutral",
      customPersonalityPrompt: "",
      rulesStrictness: "flexible",
      difficultyBias: "balanced"
    },
    memory: {
      priorityTags: [],
      deprioritizedTags: [],
      autoSummarizeThreshold: 2000,
      relationshipTracking: true,
      playerFocusWeights: {}
    },
    model: {
      preferredNarrativeModel: null,
      preferredUtilityModel: null,
      allowFreeModels: true,
      maxTokensPerResponse: null
    }
  };
}

/**
 * Loads the style configuration for a campaign and merges it with defaults.
 * @param {string} campaignId
 * @returns {Promise<object>}
 */
export async function getStyleConfig(campaignId) {
  const campaignKey = String(campaignId || "unknown-campaign");
  const targetPath = styleFilePath(campaignKey);

  try {
    const raw = await fs.readFile(targetPath, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    const merged = normalizedConfig(parsed || {});
    validateStyleConfigUpdate(merged);
    return merged;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return getDefaultStyleConfig();
    }
    return getDefaultStyleConfig();
  }
}

/**
 * Deep-merges a partial style configuration update and persists it to disk.
 * @param {string} campaignId
 * @param {object} partialUpdate
 * @returns {Promise<object>}
 */
export async function updateStyleConfig(campaignId, partialUpdate) {
  validateStyleConfigUpdate(partialUpdate);

  const campaignKey = String(campaignId || "unknown-campaign");
  const current = await getStyleConfig(campaignKey);
  const merged = normalizedConfig(deepMerge(current, partialUpdate || {}));
  validateStyleConfigUpdate(merged);

  const targetPath = styleFilePath(campaignKey);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return merged;
}

/**
 * Validates a style partial update payload.
 * @param {object} partialUpdate
 * @returns {void}
 */
export function validateStyleUpdate(partialUpdate) {
  validateStyleConfigUpdate(partialUpdate);
}

/**
 * Builds the style-specific prompt block injected into GM system prompts.
 * @param {object} config
 * @returns {string}
 */
export function buildStylePromptBlock(config = {}) {
  const merged = normalizedConfig(config);
  const priority = merged.memory.priorityTags.length > 0 ? merged.memory.priorityTags.join(", ") : "none";
  const deprioritized =
    merged.memory.deprioritizedTags.length > 0 ? merged.memory.deprioritizedTags.join(", ") : "none";
  const playerFocusKeys = Object.keys(merged.memory.playerFocusWeights || {});
  const playerFocusText =
    playerFocusKeys.length > 0
      ? playerFocusKeys.map((player) => `${player}=${Number(merged.memory.playerFocusWeights[player]).toFixed(2)}`).join(", ")
      : "equal";

  const matureLine = merged.narrative.matureContent
    ? "Mature content is enabled: do not censor violence, horror, sexuality, dark themes, or moral complexity in this adult collaborative fiction experience."
    : "Mature content is disabled: avoid explicit sexual content and extreme gore while preserving dramatic intensity.";

  return [
    `NARRATIVE STYLE: Narrate in ${perspectiveDescription(merged.narrative.perspective)}. Tone is ${toneDescription(merged)}. Verbosity is ${verbosityDescription(merged.narrative.verbosity)}. ${matureLine}`,
    `GM PERSONALITY: You are ${personalityDescription(merged)}. ${strictnessDescription(merged.gmPersonality.rulesStrictness)} ${difficultyDescription(merged.gmPersonality.difficultyBias)}`,
    `FOCUS: Prioritize tags: ${priority}. Deprioritize tags: ${deprioritized}. Player focus weights: ${playerFocusText}.`
  ].join("\n\n");
}

export const STYLE_ENUMS = {
  tone: [...TONE_VALUES],
  verbosity: [...VERBOSITY_VALUES],
  perspective: [...PERSPECTIVE_VALUES],
  personality: [...PERSONALITY_VALUES],
  rulesStrictness: [...STRICTNESS_VALUES],
  difficultyBias: [...DIFFICULTY_VALUES]
};
