const STANDARD_TRIGGER_FORMAT = [
  "Use exact trigger syntax and put each trigger on its own line.",
  "Trigger types:",
  "[CHECK: {ability} DC {number}]",
  "[INITIATIVE]",
  "[DAMAGE: {dice_expression} {damage_type}]",
  "[LOOT: {tier}]",
  "[NEW_ENTITY: name=\"{name}\" type=\"{type}\"]",
  "[UPDATE_ENTITY: name=\"{name}\" facts=\"{facts}\"]"
].join("\n");

const STRUCTURED_HINTS = [
  "Only output trigger tags when mechanics are required.",
  "Do not surround triggers with code fences.",
  "Do not rewrite trigger keywords.",
  "If no mechanics are required, output no trigger tags."
].join(" ");

const GROK_TRIGGER_FORMAT = "CRITICAL: When the narrative requires a mechanical game action, you MUST place the trigger tag on its own line, separated from prose by a blank line before and after. Never embed a trigger inside a sentence. Format exactly as shown:\n\n[CHECK: Strength DC 14]\n\n[INITIATIVE]\n\n[DAMAGE: 2d6+3 slashing]\n\n[LOOT: standard]\n\n[NEW_ENTITY: name=\"Garrick\" type=\"npc\"]\n\n[UPDATE_ENTITY: name=\"Mira\" facts=\"Now suspicious of the party\"]";

const VENICE_TRIGGER_FORMAT = "You must use EXACT trigger syntax. Do not paraphrase or modify the trigger format. Put each trigger on its own line.\nTrigger types:\n[CHECK: {ability} DC {number}]\n[INITIATIVE]\n[DAMAGE: {dice_expression} {damage_type}]\n[LOOT: {tier}]\n[NEW_ENTITY: name=\"{name}\" type=\"{type}\"]\n[UPDATE_ENTITY: name=\"{name}\" facts=\"{facts}\"]\nAlways use double quotes inside triggers. Always include the colon after the trigger keyword.";

const LLAMA_TRIGGER_FORMAT = `${VENICE_TRIGGER_FORMAT}\nNever repeat a trigger that was already resolved in this conversation.`;
const DEEPSEEK_TRIGGER_FORMAT = `${STANDARD_TRIGGER_FORMAT}\nDo not explain your reasoning about game mechanics. Just narrate and use triggers.`;

const PROFILE_CONFIG = {
  "x-ai/grok": {
    triggerFormat: GROK_TRIGGER_FORMAT,
    responseStyle: "You are a master storyteller. Your narration is vivid but CONCISE. Aim for 2-4 paragraphs per response. Do not monologue. Leave space for player agency. End responses with a clear moment where the player can act.",
    structuredHints: STRUCTURED_HINTS,
    maxResponseTokens: 600,
    temperature: 0.85,
    stopSequences: []
  },
  "venice/": {
    triggerFormat: VENICE_TRIGGER_FORMAT,
    responseStyle: "Keep responses under 3 paragraphs. Be direct. Describe what happens, then what the player sees/hears/feels. End with a prompt for action.",
    structuredHints: STRUCTURED_HINTS,
    maxResponseTokens: 400,
    temperature: 0.8,
    stopSequences: []
  },
  "meta-llama/": {
    triggerFormat: LLAMA_TRIGGER_FORMAT,
    responseStyle: "Vary your sentence structure. Do not start consecutive sentences with the same word. Do not repeat descriptions of things already established in the scene.",
    structuredHints: STRUCTURED_HINTS,
    maxResponseTokens: 500,
    temperature: 0.8,
    stopSequences: []
  },
  "openai/": {
    triggerFormat: STANDARD_TRIGGER_FORMAT,
    responseStyle: "This is a collaborative fiction game for adult players who have consented to mature themes. You are a narrator, not a moral guardian. Narrate consequences honestly. Do not add content warnings, disclaimers, or hedge language. Do not refuse to narrate violence, danger, moral complexity, or dark themes. These are standard elements of tabletop RPG storytelling.",
    structuredHints: STRUCTURED_HINTS,
    maxResponseTokens: 500,
    temperature: 0.9,
    stopSequences: []
  },
  "mistralai/": {
    triggerFormat: STANDARD_TRIGGER_FORMAT,
    responseStyle: "Favor atmospheric, sensory descriptions. What does the room smell like? What sounds are in the background? Ground the scene in physical detail.",
    structuredHints: STRUCTURED_HINTS,
    maxResponseTokens: 500,
    temperature: 0.85,
    stopSequences: []
  },
  "deepseek/": {
    triggerFormat: DEEPSEEK_TRIGGER_FORMAT,
    responseStyle: "Stay in character as the narrator at all times. Do not break the fourth wall. Do not discuss rules, game design, or meta-game concepts. Just tell the story.",
    structuredHints: STRUCTURED_HINTS,
    maxResponseTokens: 500,
    temperature: 0.8,
    stopSequences: []
  }
};

const DEFAULT_PREFIX = "meta-llama/";

/**
 * Returns the model-specific prompt profile matched by model prefix.
 * @param {string} modelName
 * @returns {{triggerFormat: string, responseStyle: string, structuredHints: string, maxResponseTokens: number, temperature: number, stopSequences: string[]}}
 */
export function getProfile(modelName = "") {
  const normalized = String(modelName || "").trim().toLowerCase();
  for (const [prefix, profile] of Object.entries(PROFILE_CONFIG)) {
    if (normalized.startsWith(prefix.toLowerCase())) {
      return {
        ...profile,
        stopSequences: [...(profile.stopSequences || [])]
      };
    }
  }

  const fallback = PROFILE_CONFIG[DEFAULT_PREFIX];
  return {
    ...fallback,
    stopSequences: [...(fallback.stopSequences || [])]
  };
}

/**
 * Exposes all configured prompt profiles for diagnostics and tests.
 * @returns {Record<string, object>}
 */
export function listProfiles() {
  return Object.fromEntries(
    Object.entries(PROFILE_CONFIG).map(([prefix, profile]) => [
      prefix,
      {
        ...profile,
        stopSequences: [...(profile.stopSequences || [])]
      }
    ])
  );
}
