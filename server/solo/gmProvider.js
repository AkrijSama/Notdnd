import { generateWithProvider } from "../ai/providers.js";
import { INKBORNE_GM_VOICE } from "../gm/voice.js";
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

function stripNpcPrefix(id) {
  const value = String(id || "");
  return value.startsWith("npc:") ? value.slice("npc:".length) : value;
}

/**
 * Classifies a parsed GM output into VN scene state: { active, speakerId }. This
 * is the automatic, GM-driven half of the ambient↔direct classifier (the manual
 * half is the talk action); both converge on the same shape the client reads off
 * the scene payload. Defensive: vnMode must be an explicit boolean true AND, when
 * a set of known NPC ids is supplied, speakerId must name one of them — a
 * hallucinated or absent speaker collapses to ambient. Missing fields (older
 * responses, plain-text/parse fallbacks) default to ambient. Never throws.
 * @param {object} parsed parsed GM output that may carry vnMode/speakerId
 * @param {{ knownNpcIds?: Iterable<string> }} [options]
 * @returns {{ active: boolean, speakerId: string | null }}
 */
export function deriveVnState(parsed, options = {}) {
  const active = Boolean(parsed) && parsed.vnMode === true;
  const speakerId = parsed && typeof parsed.speakerId === "string" ? parsed.speakerId.trim() : "";
  if (!active || !speakerId) {
    return { active: false, speakerId: null };
  }
  if (options.knownNpcIds) {
    const known = new Set(options.knownNpcIds);
    if (!known.has(speakerId) && !known.has(stripNpcPrefix(speakerId))) {
      // Speaker is not a present/known NPC — treat as ambient rather than trust
      // an unanchored focus target.
      return { active: false, speakerId: null };
    }
  }
  return { active: true, speakerId };
}

// Collects the candidate NPC ids (full entity id + the raw id after an "npc:"
// prefix) the GM may legitimately name as a VN speaker, from a scene's visible
// entities. Used to ground deriveVnState against present NPCs.
function knownNpcIdsFromGmInput(gmInput) {
  const ids = [];
  for (const entity of (gmInput && gmInput.visibleEntities) || []) {
    const entityId = entity && typeof entity.entityId === "string" ? entity.entityId : "";
    if (entityId) {
      ids.push(entityId);
      const raw = stripNpcPrefix(entityId);
      if (raw && raw !== entityId) {
        ids.push(raw);
      }
    }
    if (entity && typeof entity.npcId === "string" && entity.npcId) {
      ids.push(entity.npcId);
    }
  }
  return ids;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Evidence of spoken dialogue in narration: at least one pair of double-quote
// family marks (straight or typographic). A lone quote (e.g. an apostrophe or a
// measurement) is not enough — we require a quoted span.
function hasQuotedSpeech(text) {
  const marks = String(text || "").match(/["“”„«»]/g);
  return Boolean(marks) && marks.length >= 2;
}

// The most specific name to look for in narration: the minted name when present,
// else the display name.
function vnNpcName(npc) {
  if (!npc || typeof npc !== "object") {
    return "";
  }
  if (isNonEmptyString(npc.generatedName)) {
    return npc.generatedName.trim();
  }
  return isNonEmptyString(npc.displayName) ? npc.displayName.trim() : "";
}

function npcNamedInText(npc, text) {
  const name = vnNpcName(npc);
  if (name.length < 3) {
    return false;
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

/**
 * Heuristic, GM-driven classifier for free-text narration — the automatic
 * ambient→direct trigger. Detects when a narration has shifted into direct,
 * sustained dialogue with a SINGLE present NPC. Deliberately conservative (the
 * brief: never falsely trigger VN): it activates only when the narration both
 * contains quoted speech AND names exactly one present NPC. No quoted speech, or
 * zero / multiple named speakers (ambiguous), stays ambient. The result is
 * grounded through deriveVnState, so only a present NPC can become the speaker.
 * Pure; never throws. Pairs with deriveVnState (which classifies the structured
 * GM contract) and produces the same { active, speakerId } shape the manual talk
 * path and the scene payload use.
 * @param {string} narrationText the GM's free-text narration for this turn
 * @param {Array<{npcId: string, displayName?: string, generatedName?: string}>} presentNpcs NPCs at the current location
 * @returns {{ active: boolean, speakerId: string | null }}
 */
export function classifyNarrationVn(narrationText, presentNpcs = []) {
  const text = typeof narrationText === "string" ? narrationText : "";
  const npcs = Array.isArray(presentNpcs) ? presentNpcs : [];
  if (!text.trim() || !hasQuotedSpeech(text)) {
    return { active: false, speakerId: null };
  }
  const named = npcs.filter((npc) => npc && isNonEmptyString(npc.npcId) && npcNamedInText(npc, text));
  if (named.length !== 1) {
    // Zero named speakers, or several at once — too ambiguous to attribute a
    // single VN speaker. Stay ambient rather than guess.
    return { active: false, speakerId: null };
  }
  const knownNpcIds = npcs.map((npc) => npc && npc.npcId).filter(isNonEmptyString);
  return deriveVnState({ vnMode: true, speakerId: named[0].npcId }, { knownNpcIds });
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
  const withWarning = warning ? addWarning(placeholder, warning) : placeholder;
  // Placeholder narration is never a direct VN exchange — surface ambient VN
  // state so every resolveGmNarration return carries a consistent signal.
  return { ...withWarning, vnMode: false, speakerId: null };
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
    questJustAdvanced,
    openJobOffers: Array.isArray(gmInput.openJobOffers) ? gmInput.openJobOffers : [],
    recentDevelopment: gmInput.recentDevelopment || null
  };

  // The current objective drives a "weave the goal in" prompt line; the quest
  // engine — not the GM — owns activation/advancement/completion.
  const objective = activeQuests.map((quest) => quest && quest.objective).find(Boolean) || null;
  const advancedNote =
    questJustAdvanced && questJustAdvanced.objective
      ? `The player just made progress: "${questJustAdvanced.objective}". Acknowledge this in the fiction.`
      : null;
  // Open, un-accepted job offers (server-authored; gm.js openJobOffers): the GM
  // may voice these — they are REAL, and accepting one is a committed transition.
  const openOffers = Array.isArray(gmInput.openJobOffers) ? gmInput.openJobOffers : [];
  const offerNote = openOffers.length
    ? `REAL work is on offer here — ${openOffers
        .map((offer) => `${offer.npcName} offers: ${offer.offerText}`)
        .join(" | ")} If talk turns to work, jobs, pay, or purpose, surface this offer naturally; it is real and accepting it matters. Do NOT invent any other job or reward.`
    : null;
  // Momentum development (already COMMITTED to state by the server): keep it
  // present in the scene while fresh; the GM narrates it, never invents peers.
  const development = gmInput.recentDevelopment && gmInput.recentDevelopment.brief ? gmInput.recentDevelopment : null;
  const developmentNote = development
    ? `A REAL development has just occurred in this scene (it is already committed to the game state): ${development.title} — ${development.brief} Keep it present and pressing in the narration, and keep the choice it poses in front of the player: ${development.decision} Do NOT invent any additional arrivals, changes, or events beyond this one.`
    : null;

  const system = [
    INKBORNE_GM_VOICE,
    "SOURCE OF TRUTH: only use the provided scene input as truth. If data is missing, keep it ambiguous instead of inventing.",
    "Mention the current location and visible entities naturally when relevant.",
    "Avoid final IP lore invention: do not invent or reference established franchise/IP lore.",
    "Strict constraints: do not mutate state, do not create durable canon, and do not invent persisted items, NPCs, quests, rewards, locations, relationships, inventory, hidden exits, or unavailable actions.",
    "Do not change relationship values, do not claim the player chose an action, and do not mention unavailable actions or moves.",
    "Respect the edition and policy profile. Never leak forbidden or blocked content into mainline scenes.",
    objective ? `The player is pursuing: ${objective}. Weave this goal naturally into scene framing and dialogue.` : null,
    advancedNote,
    offerNote,
    developmentNote,
    "Do NOT invent new quests or declare quests complete. Quest progress is decided only by the system.",
    // Visual-novel mode signal. The classifier that consumes this (deriveVnState)
    // discards a speakerId that is not a present/visible NPC, so the model is held
    // to grounded, named interlocutors only.
    "Visual-novel mode: set vnMode=true ONLY when this narration is a direct, sustained exchange with ONE specific, named NPC that is present in visibleEntities — the player addressing them, or that NPC addressing the player directly. Set speakerId to that NPC's id from visibleEntities.",
    "Set vnMode=false and speakerId=null for ambient theatre-of-the-mind: overheard chatter, crowd noise, background or environmental conversation, or any narration not anchored to one direct interlocutor.",
    "Return JSON only with this exact shape: {\"ok\":true,\"narration\":{\"title\":\"string\",\"body\":\"string\",\"tone\":\"neutral|tense|mysterious|warm|dangerous|comic|dramatic\",\"sensoryDetails\":[],\"focusEntityIds\":[]},\"suggestedActionLabels\":[],\"warnings\":[],\"stateMutations\":[],\"vnMode\":false,\"speakerId\":null}.",
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

  // Surface the GM-driven VN signal alongside the sanitized narration. Derived
  // from the raw parsed output (sanitizeGmNarration drops unknown fields) and
  // grounded against the scene's present NPCs so an unanchored speaker is
  // demoted to ambient.
  const vn = deriveVnState(parsed, { knownNpcIds: knownNpcIdsFromGmInput(gmInput) });
  return { ...sanitized, vnMode: vn.active, speakerId: vn.speakerId };
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
