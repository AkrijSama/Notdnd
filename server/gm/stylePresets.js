import { updateStyleConfig } from "./styleConfig.js";

const PRESETS = {
  classic_fantasy: {
    narrative: {
      tone: "high_fantasy",
      verbosity: "verbose",
      perspective: "second_person",
      matureContent: false,
      customTonePrompt: ""
    },
    gmPersonality: {
      name: "The GM",
      personality: "warm",
      customPersonalityPrompt: "",
      rulesStrictness: "flexible",
      difficultyBias: "balanced"
    }
  },
  grimdark: {
    narrative: {
      tone: "grimdark",
      verbosity: "terse",
      perspective: "second_person",
      matureContent: true,
      customTonePrompt: ""
    },
    gmPersonality: {
      name: "The GM",
      personality: "menacing",
      customPersonalityPrompt: "",
      rulesStrictness: "strict",
      difficultyBias: "brutal"
    }
  },
  horror: {
    narrative: {
      tone: "horror",
      verbosity: "cinematic",
      perspective: "second_person",
      matureContent: true,
      customTonePrompt: ""
    },
    gmPersonality: {
      name: "The GM",
      personality: "stoic",
      customPersonalityPrompt: "",
      rulesStrictness: "strict",
      difficultyBias: "adversarial"
    }
  },
  comedy: {
    narrative: {
      tone: "comedic",
      verbosity: "verbose",
      perspective: "second_person",
      matureContent: false,
      customTonePrompt: ""
    },
    gmPersonality: {
      name: "The GM",
      personality: "whimsical",
      customPersonalityPrompt: "",
      rulesStrictness: "flexible",
      difficultyBias: "merciful"
    }
  },
  noir: {
    narrative: {
      tone: "custom",
      verbosity: "balanced",
      perspective: "narrator",
      matureContent: true,
      customTonePrompt:
        "Narrate like a hardboiled detective novel. Every room has shadows. Every NPC has secrets. Rain is always implied."
    },
    gmPersonality: {
      name: "The GM",
      personality: "sardonic",
      customPersonalityPrompt: "",
      rulesStrictness: "strict",
      difficultyBias: "balanced"
    }
  },
  sword_and_sorcery: {
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
    }
  }
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Returns all built-in style presets.
 * @returns {Record<string, object>}
 */
export function getPresets() {
  return deepClone(PRESETS);
}

/**
 * Applies a named style preset to a campaign.
 * @param {string} campaignId
 * @param {string} presetName
 * @returns {Promise<object>}
 */
export async function applyPreset(campaignId, presetName) {
  const key = String(presetName || "").trim();
  if (!PRESETS[key]) {
    const error = new Error(`Unknown style preset "${key}".`);
    error.code = "BAD_REQUEST";
    error.statusCode = 400;
    throw error;
  }

  return updateStyleConfig(campaignId, PRESETS[key]);
}
