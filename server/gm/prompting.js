import { generateNarrative, generateRaw, generateUtility, getModelTiers } from "../ai/openrouter.js";
import { getCampaignRuntimeState, getState, setCampaignRuntimeState } from "../db/repository.js";
import { resolveSkillCheck, rollDiceExpression } from "../rules/engine.js";
import { buildContextWindow, getEntity, getRelated, search, upsertEntity } from "./memoryStore.js";
import { runAutoMemoryPipeline } from "./autoMemory.js";
import { getPlayerContext, updatePlayerProfile } from "./playerMemory.js";
import { getProfile } from "./promptProfiles.js";
import { buildStylePromptBlock, getStyleConfig } from "./styleConfig.js";
import { executeTriggers as executeParsedTriggers, parseTriggers as parseResponseTriggers } from "./triggerParser.js";
import { INKBORNE_GM_VOICE } from "./voice.js";

const CONTEXT_BUDGET = Number(process.env.NOTDND_CONTEXT_BUDGET || 1500);

// Minimum response-token budget for NARRATIVE GM calls. Reasoning models (e.g.
// gemini-2.5-flash, the current default) spend a large, variable share of the
// response budget on internal thinking before emitting any prose. The per-model
// prompt profiles cap responses at ~400-600 tokens, which the thinking can
// consume entirely — the model then returns truncated or EMPTY narration
// (finish_reason "length"), so a resolved action (e.g. a rolled success) shows
// no narrated outcome. max_tokens is a ceiling, not a target: the model stops
// when done, so a generous floor adds no cost on a short answer but leaves room
// for thinking + a full beat. Tunable via env for operators on non-reasoning
// models. Only RAISES the budget (never lowers an explicit higher override).
export const NARRATIVE_MIN_RESPONSE_TOKENS = Math.max(
  256,
  Number(process.env.INKBORNE_GM_MIN_RESPONSE_TOKENS ?? process.env.NOTDND_GM_MIN_RESPONSE_TOKENS ?? 2048)
);

// Returns call options with maxResponseTokens floored to NARRATIVE_MIN_RESPONSE_TOKENS
// (never lowered). Applied only to narrative calls — utility/summarization calls
// keep their tighter budgets.
export function withNarrativeTokenFloor(options = {}) {
  const current = Number(options?.maxResponseTokens);
  const floored = Number.isFinite(current) ? Math.max(current, NARRATIVE_MIN_RESPONSE_TOKENS) : NARRATIVE_MIN_RESPONSE_TOKENS;
  return { ...options, maxResponseTokens: floored };
}

function summarizeCharacters(characters = []) {
  return characters
    .map((character) => {
      const stats = character.stats || {};
      return `${character.name} (${character.className} ${character.level}) HP ${character.hp}, AC ${character.ac}, STR ${stats.str || 10}, DEX ${stats.dex || 10}, CON ${stats.con || 10}, INT ${stats.int || 10}, WIS ${stats.wis || 10}, CHA ${stats.cha || 10}`;
    })
    .join("\n");
}

function stringifyActivePlayers(activePlayers = []) {
  return activePlayers
    .map((player) => {
      if (typeof player === "string") {
        return player;
      }
      const name = String(player?.name || player?.displayName || player?.playerName || "Unknown Player");
      const character = String(player?.characterSummary || player?.character || "").trim();
      return character ? `${name}: ${character}` : name;
    })
    .join("\n");
}

function extractJsonArray(text = "") {
  const source = String(text || "").trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : source;
  const bracketStart = candidate.indexOf("[");
  const bracketEnd = candidate.lastIndexOf("]");
  if (bracketStart !== -1 && bracketEnd !== -1 && bracketEnd > bracketStart) {
    return candidate.slice(bracketStart, bracketEnd + 1);
  }
  return candidate;
}

async function compressSessionHistory(chatLines = [], campaignId) {
  const recent = chatLines.slice(-20);
  if (recent.length === 0) {
    return "None";
  }

  if (recent.length <= 8) {
    return recent.map((line) => `${line.speaker}: ${line.text}`).join(" | ");
  }

  try {
    const joined = recent.map((line) => `${line.speaker}: ${line.text}`).join("\n");
    const response = await generateUtility(
      [
        { role: "system", content: "Summarize RPG chat logs for a GM in concise bullet points." },
        { role: "user", content: `Compress this session history into at most 8 bullet points:\n\n${joined}` }
      ],
      campaignId
    );
    return String(response.content || "").trim() || joined;
  } catch {
    return recent.slice(-8).map((line) => `${line.speaker}: ${line.text}`).join(" | ");
  }
}

function inferCompanionIntent(message = "") {
  const lower = String(message || "").toLowerCase();
  if (/what happened last session/.test(lower)) {
    return "session_recap";
  }
  if (/tell me about\s+/.test(lower)) {
    return "entity_lookup";
  }
  if (/write backstory/.test(lower) || /backstory/.test(lower)) {
    return "backstory";
  }
  if (/help me plan/.test(lower) || /plan for next session/.test(lower)) {
    return "planning";
  }
  if (/what does .* think of me/.test(lower)) {
    return "relationship_lookup";
  }
  return "chat";
}

async function buildCompanionPlayerContext(campaignId, message, playerName, state) {
  const playerCharacter = (state.characters || []).find(
    (character) => normalizeCase(character.name) === normalizeCase(playerName)
  );

  const relationshipResults = await search(campaignId, `${playerName} relationship`, {
    type: "relationship",
    limit: 4
  });

  return {
    playerSummary: playerCharacter
      ? `${playerCharacter.name} (${playerCharacter.className} ${playerCharacter.level}) HP ${playerCharacter.hp}, AC ${playerCharacter.ac}`
      : `Player: ${playerName || "Unknown"}`,
    relationships: relationshipResults.map((entry) => `${entry.name}: ${entry.body}`).join("\n") || "No known relationship history.",
    query: message
  };
}

function normalizeCase(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function withProfileSections(basePrompt, profile = {}) {
  const triggerFormat = String(profile.triggerFormat || "").trim();
  const responseStyle = String(profile.responseStyle || "").trim();
  const structuredHints = String(profile.structuredHints || "").trim();

  return [
    basePrompt,
    triggerFormat ? `[TRIGGER FORMAT] ${triggerFormat}` : "",
    responseStyle ? `[RESPONSE STYLE] ${responseStyle}` : "",
    structuredHints ? `[STRUCTURED HINTS] ${structuredHints}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

function profileCallOptions(profile, stream, onStream) {
  const options = {};
  if (stream) {
    options.stream = true;
    if (typeof onStream === "function") {
      options.onStream = onStream;
    }
  }

  if (Number.isFinite(Number(profile?.temperature))) {
    options.temperature = Number(profile.temperature);
  }
  if (Number.isFinite(Number(profile?.maxResponseTokens))) {
    options.maxResponseTokens = Number(profile.maxResponseTokens);
  }
  if (Array.isArray(profile?.stopSequences) && profile.stopSequences.length > 0) {
    options.stopSequences = profile.stopSequences;
  }

  return options;
}

function resolveNarrativeModel(styleConfig, modelTiers) {
  return String(styleConfig?.model?.preferredNarrativeModel || "").trim() || modelTiers.narrative;
}

function resolveUtilityModel(styleConfig, modelTiers) {
  let model = String(styleConfig?.model?.preferredUtilityModel || "").trim() || modelTiers.utility;
  const allowFree = styleConfig?.model?.allowFreeModels !== false;
  if (!allowFree && /:free$/i.test(model)) {
    const fallback = String(styleConfig?.model?.preferredNarrativeModel || "").trim() || modelTiers.narrative;
    model = fallback;
  }
  return model;
}

function applyStyleModelOverrides(options, styleConfig) {
  const next = { ...(options || {}) };
  const override = styleConfig?.model?.maxTokensPerResponse;
  if (override !== null && override !== undefined && Number.isFinite(Number(override))) {
    next.maxResponseTokens = Math.max(64, Math.floor(Number(override)));
  }
  return next;
}

async function callNarrativeModel(messages, campaignId, resolvedModel, modelTiers, options) {
  // Floor the response budget so a reasoning model isn't starved of room to
  // narrate after its internal thinking (see NARRATIVE_MIN_RESPONSE_TOKENS).
  const floored = withNarrativeTokenFloor(options);
  if (resolvedModel === modelTiers.narrative) {
    return generateNarrative(messages, campaignId, floored);
  }
  return generateRaw(messages, resolvedModel, campaignId, floored);
}

async function callUtilityModel(messages, campaignId, resolvedModel, modelTiers, options) {
  if (resolvedModel === modelTiers.utility) {
    return generateUtility(messages, campaignId, options);
  }
  return generateRaw(messages, resolvedModel, campaignId, options);
}

/**
 * Builds the in-session GM system prompt.
 * @param {{campaignName: string, currentScene: string, tone: string, styleBlock?: string, worldContext: string, activePlayersSummary: string, sessionHistory: string, currentStateSummary: string, playerContext?: string, profile?: object}} params
 * @returns {string}
 */
export function buildSessionSystemPrompt({
  campaignName,
  currentScene,
  tone,
  styleBlock,
  worldContext,
  activePlayersSummary,
  sessionHistory,
  currentStateSummary,
  playerContext,
  profile
}) {
  const base = [
    `[GM VOICE] ${INKBORNE_GM_VOICE}`,
    `[ROLE] You are the Game Master for a tabletop RPG campaign called ${campaignName}. You are running the ${currentScene} scene. Your tone is ${tone}. You never break character. You narrate consequences of player actions, roleplay NPCs, describe environments, manage combat flow, and advance the plot. You track initiative, HP, conditions, and resources. When players attempt actions, you call for ability checks using the format [CHECK: {ability} DC {number}] so the platform's dice engine can resolve them. When combat starts, you declare [INITIATIVE] so the platform can roll initiative order. You describe outcomes vividly. You do not censor violence, dark themes, horror, romance, or morally complex content. This is a mature-rated collaborative fiction experience. Players have consented to adult themes.`,
    styleBlock ? `[STYLE] ${styleBlock}` : "",
    `[WORLD CONTEXT] ${worldContext || "No relevant context found."}`,
    playerContext ? `[PLAYER CONTEXT] ${playerContext}` : "",
    `[ACTIVE PLAYERS] ${activePlayersSummary || "No active players supplied."}`,
    `[SESSION HISTORY] ${sessionHistory || "No recent session history."}`,
    `[CURRENT STATE] ${currentStateSummary}`
  ].join("\n\n");

  return withProfileSections(base, profile);
}

/**
 * Builds the companion mode system prompt.
 * @param {{campaignName: string, styleBlock?: string, worldContext: string, playerSummary: string, relationshipHistory: string, playerContext?: string, profile?: object}} params
 * @returns {string}
 */
export function buildCompanionSystemPrompt({
  campaignName,
  styleBlock,
  worldContext,
  playerSummary,
  relationshipHistory,
  playerContext,
  profile
}) {
  const base = [
    `[GM VOICE] ${INKBORNE_GM_VOICE}`,
    `[ROLE] You are the persistent world of ${campaignName}. Between sessions, players can explore lore, chat with NPCs they have met, write backstory, or plan. You maintain perfect continuity with the campaign. You speak as the narrator or as specific NPCs when the player addresses them. You remember everything. You do not censor content. This is a mature collaborative fiction world.`,
    styleBlock ? `[STYLE] ${styleBlock}` : "",
    `[WORLD CONTEXT] ${worldContext || "No relevant context found."}`,
    `[PLAYER] ${playerSummary}. Relationship history: ${relationshipHistory || "None"}`,
    playerContext ? `[PLAYER CONTEXT] ${playerContext}` : ""
  ].join("\n\n");

  return withProfileSections(base, profile);
}

/**
 * Executes the full GM runtime pipeline for session or companion mode.
 * @param {{campaignId: string, message: string, mode: "session" | "companion", playerName?: string, actorUserId: string, activePlayers?: Array<object>, stream?: boolean, onStream?: (chunk: string) => void}} params
 * @returns {Promise<{narrative: string, mechanical: {rolls: any[], stateChanges: any[]}, memoryUpdates: string[], meta: object}>}
 */
export async function runGmPipeline({
  campaignId,
  message,
  mode = "session",
  playerName = "",
  actorUserId,
  activePlayers = [],
  stream = false,
  onStream,
  // Edition routing (Track A → Track C): "forbidden" routes the GM call to the
  // local uncensored model; "mainline" (default) stays on cloud. The AI layer
  // (openrouter.requestWithFallback) honors options.edition — we just thread it.
  edition = "mainline"
}) {
  const campaignKey = String(campaignId || "").trim();
  const input = String(message || "").trim();
  const normalizedEdition = String(edition || "mainline").trim().toLowerCase() || "mainline";
  if (!campaignKey || !input) {
    const error = new Error("campaignId and message are required.");
    error.code = "BAD_REQUEST";
    error.statusCode = 400;
    throw error;
  }

  const state = getState({ userId: actorUserId });
  const campaign = (state.campaigns || []).find((entry) => entry.id === campaignKey);
  const runtime = getCampaignRuntimeState(campaignKey, { internal: true });
  const currentScene = campaign?.activeScene || campaign?.status || "Current Scene";
  const tone = campaign?.setting || "Cinematic";

  const styleConfig = await getStyleConfig(campaignKey);
  const stylePromptBlock = buildStylePromptBlock(styleConfig);
  const playerPromptContext = await getPlayerContext(campaignKey, playerName);
  const worldContext = await buildContextWindow(campaignKey, input, CONTEXT_BUDGET, styleConfig);
  const sessionHistory = await compressSessionHistory(
    (state.chatLog || []).filter((line) => line.campaignId === campaignKey),
    campaignKey
  );

  const activePlayerSummary = activePlayers.length > 0
    ? stringifyActivePlayers(activePlayers)
    : summarizeCharacters((state.characters || []).filter((character) => character.campaignId === campaignKey).slice(0, 4));

  const currentStateSummary = `Scene: ${currentScene}, Initiative: ${runtime.initiativeOrder?.length ? runtime.initiativeOrder.map((entry) => `${entry.name}:${entry.initiative}`).join(", ") : "none"}, Active conditions: none`;

  const modelTiers = getModelTiers();
  let systemPrompt = "";
  let messages = [];
  let aiResult;
  let companionIntent = "chat";
  let selectedModel = resolveNarrativeModel(styleConfig, modelTiers);
  let promptProfile = getProfile(selectedModel);
  let modelOptions = { ...applyStyleModelOverrides(profileCallOptions(promptProfile, stream, onStream), styleConfig), edition: normalizedEdition };

  if (mode === "companion") {
    const intent = inferCompanionIntent(input);
    companionIntent = intent;
    const lookupIntent = new Set(["session_recap", "entity_lookup", "planning", "relationship_lookup"]);
    const useUtility = intent === "session_recap" || lookupIntent.has(intent);
    selectedModel = useUtility
      ? resolveUtilityModel(styleConfig, modelTiers)
      : resolveNarrativeModel(styleConfig, modelTiers);
    promptProfile = getProfile(selectedModel);
    modelOptions = { ...applyStyleModelOverrides(profileCallOptions(promptProfile, stream, onStream), styleConfig), edition: normalizedEdition };

    const companionContext = await buildCompanionPlayerContext(campaignKey, input, playerName, state);
    systemPrompt = buildCompanionSystemPrompt({
      campaignName: campaign?.name || campaignKey,
      styleBlock: stylePromptBlock,
      worldContext,
      playerSummary: companionContext.playerSummary,
      relationshipHistory: companionContext.relationships,
      playerContext: playerPromptContext,
      profile: promptProfile
    });

    messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: input }
    ];

    if (intent === "session_recap") {
      const logs = await search(campaignKey, "session log", { type: "session_log", limit: 5 });
      const compiled = logs.map((log) => `${log.name}: ${log.body}`).join("\n\n");
      aiResult = await callUtilityModel(
        [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `What happened last session? Summarize these session logs with continuity preserved:\n\n${compiled || "No session logs available."}`
          }
        ],
        campaignKey,
        selectedModel,
        modelTiers,
        modelOptions
      );
    } else if (lookupIntent.has(intent)) {
      if (intent === "entity_lookup") {
        const candidateName = input.replace(/.*tell me about\s+/i, "").trim();
        const entity = candidateName ? await getEntity(campaignKey, candidateName) : null;
        const related = entity ? await getRelated(campaignKey, entity.name, 1) : { entities: [] };
        const context = [entity ? `${entity.name}: ${entity.body}` : "Entity not found.", ...(related.entities || []).map((entry) => `${entry.name}: ${entry.body}`)].join("\n\n");
        aiResult = await callUtilityModel(
          [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Answer this lookup with continuity and concise detail:\n\n${context}\n\nPlayer query: ${input}` }
          ],
          campaignKey,
          selectedModel,
          modelTiers,
          modelOptions
        );
      } else {
        aiResult = await callUtilityModel(messages, campaignKey, selectedModel, modelTiers, modelOptions);
      }
    } else {
      aiResult = await callNarrativeModel(messages, campaignKey, selectedModel, modelTiers, modelOptions);
    }
  } else {
    selectedModel = resolveNarrativeModel(styleConfig, modelTiers);
    promptProfile = getProfile(selectedModel);
    modelOptions = { ...applyStyleModelOverrides(profileCallOptions(promptProfile, stream, onStream), styleConfig), edition: normalizedEdition };

    systemPrompt = buildSessionSystemPrompt({
      campaignName: campaign?.name || campaignKey,
      currentScene,
      tone,
      styleBlock: stylePromptBlock,
      worldContext,
      activePlayersSummary: activePlayerSummary,
      sessionHistory,
      currentStateSummary,
      playerContext: playerPromptContext,
      profile: promptProfile
    });

    messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: input }
    ];

    aiResult = await callNarrativeModel(messages, campaignKey, selectedModel, modelTiers, modelOptions);
  }

  const rawNarrative = String(aiResult.content || "").trim();
  const parsed = parseResponseTriggers(rawNarrative);
  const triggerExecution = await executeParsedTriggers(
    parsed.triggers,
    campaignKey,
    playerName,
    {
      getState,
      setCampaignRuntimeState
    },
    {
      resolveSkillCheck,
      rollDiceExpression
    },
    {
      upsertEntity,
      getEntity
    }
  );
  const sanitizedNarrative = String(parsed.narrative || rawNarrative).trim() || rawNarrative;

  const autoMemory = await runAutoMemoryPipeline({
    campaignId: campaignKey,
    narrative: sanitizedNarrative,
    playerMessage: input,
    mode,
    playerName
  });

  const memoryUpdates = [...new Set([...(triggerExecution.memoryUpdates || []), ...(autoMemory.updatedEntities || [])])];
  if (mode === "companion" && companionIntent === "backstory" && playerName) {
    const playerRecord = await upsertEntity(campaignKey, {
      name: playerName,
      type: "player_character",
      tags: ["backstory", "companion"],
      body: `Backstory update request: ${input}\\n\\nCompanion response:\\n${sanitizedNarrative}`
    });
    memoryUpdates.push(playerRecord.name);
  }

  if (playerName) {
    try {
      const profileUpdate = await updatePlayerProfile(campaignKey, playerName, sanitizedNarrative, input);
      if (profileUpdate?.entityName) {
        memoryUpdates.push(profileUpdate.entityName);
      }
    } catch {
      // Keep the runtime response resilient if player profiling fails.
    }
  }

  return {
    narrative: sanitizedNarrative,
    mechanical: triggerExecution.mechanical,
    memoryUpdates: [...new Set(memoryUpdates)],
    meta: {
      mode,
      model: aiResult.model,
      requestedModel: selectedModel,
      tokensUsed: aiResult.tokensUsed,
      cost: aiResult.cost,
      profile: {
        temperature: promptProfile.temperature,
        maxResponseTokens: promptProfile.maxResponseTokens
      },
      style: styleConfig,
      triggerCount: parsed.triggers.length,
      systemPrompt,
      // Free-text narration carries no structured VN classification, so it
      // defaults to ambient. The authoritative ambient↔direct signal is the
      // run's VN scene state (set by the solo action dispatcher for the manual
      // talk trigger, and by gmProvider.deriveVnState for the GM-driven trigger)
      // and is surfaced on the scene payload — not derived here.
      vnMode: false,
      speakerId: null
    }
  };
}

/**
 * Attempts to parse extracted entity arrays from model responses.
 * @param {string} responseText
 * @returns {Array<object>}
 */
export function parseExtractedEntities(responseText) {
  try {
    const parsed = JSON.parse(extractJsonArray(responseText));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
