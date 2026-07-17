import { generateNarrative, generateRaw, generateUtility, getModelTiers } from "../ai/openrouter.js";
import { trimToCompleteSentence } from "./trimSentence.js";
import { HANDLES_CORRECTIVE_CLAUSE } from "./handlesEnforcement.js";
import { recordGmGeneration } from "../logging/gmTranscript.js";
import { getCampaignRuntimeState, getState, setCampaignRuntimeState } from "../db/repository.js";
import { resolveSkillCheck, rollDiceExpression } from "../rules/engine.js";
import { buildContextWindow, getEntity, getRelated, search, upsertEntity } from "./memoryStore.js";
import { runAutoMemoryPipeline } from "./autoMemory.js";
import { getPlayerContext, updatePlayerProfile } from "./playerMemory.js";
import { getProfile } from "./promptProfiles.js";
import { buildStylePromptBlock, getStyleConfig } from "./styleConfig.js";
import { executeTriggers as executeParsedTriggers, parseTriggers as parseResponseTriggers } from "./triggerParser.js";
import { INKBORNE_GM_VOICE, detectEmDashViolations, stripAiTells } from "./voice.js";

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

// Word-budget enforcement (item 3): on NON-THINK flash the 2048-token reasoning
// floor is pure runaway headroom — the contract caps prose at 120 words, so cap
// the API budget at ~220 tokens (comfortable margin over 120 words + paragraph
// breaks, blocks a runaway draft mechanically). Reasoning models keep the floor
// (their thinking spends from the same budget).
const NARRATIVE_FLASH_MAX_TOKENS = Math.max(150, Number(process.env.NOTDND_GM_FLASH_MAX_TOKENS || 190));
function isNonThinkFlash(model) {
  return /deepseek-v4-flash/i.test(String(model || ""));
}

async function callNarrativeModel(messages, campaignId, resolvedModel, modelTiers, options) {
  if (isNonThinkFlash(resolvedModel)) {
    const flashCap = Number.isFinite(Number(options.flashMaxTokens))
      ? Math.min(Number(options.flashMaxTokens), 512)
      : NARRATIVE_FLASH_MAX_TOKENS;
    const capped = { ...options, maxResponseTokens: flashCap };
    if (resolvedModel === modelTiers.narrative) {
      return generateNarrative(messages, campaignId, capped);
    }
    return generateRaw(messages, resolvedModel, campaignId, capped);
  }
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
    `[ROLE] You are the Game Master RUNNING a live solo tabletop session of ${campaignName}. You are not a lore librarian and not a scene-painter — you run a GAME. Every narration obeys the STYLE CONTRACT: 80-120 words, never more; the concrete consequence of the action first, then exactly ONE new fact drawn from the committed game state, ending on pressure or a decision that demands the player's next move. Every sentence must reference something committed in the scene or context — re-describing the established scene and mood-only atmosphere sentences are banned. Paraphrase state facts into natural prose: never echo field labels, slugs, or slash-joined names literally. You maintain perfect continuity, remember everything, narrate the consequences of player actions, and voice NPCs in character. CRITICAL — the world's TRUTH is owned by the game state you are given: narrate only what is real in that state, and do NOT invent locations, exits, items, or people the state has not established, nor let the player's words rewrite the world. When something genuinely new appears (a place, a find, an item), it is because the game committed it — narrate that, never conjure your own. You do not censor content. This is a mature collaborative fiction world.`,
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
  edition = "mainline",
  // Optional per-call override of the non-think-flash token cap (bounded at 512).
  // The OPENING passes a larger budget: orientation is intentionally longer than
  // a turn beat, and the default 190-token turn cap truncated it mid-sentence.
  flashMaxTokens,
  // When true, the post-narration WRITE-SIDE memory work (knowledge-graph
  // extraction + player-profile update) is fired AFTER this function returns
  // instead of being awaited — it never blocks the turn's HTTP response. The
  // narration is unaffected; the graph simply updates a beat late (like image
  // gen). The solo per-turn path sets this; it still RUNS, it is not skipped.
  deferMemory = false,
  // GM-TRANSCRIPT metadata (fine-tune dataset groundwork). Optional, best-effort:
  // callers MAY pass { runId, turnRef, callType } to enrich the persisted record.
  // Absent, the capture falls back to campaignId as the file key and "narration"
  // as the callType (the handles-retry is detected here, not passed in). Threading
  // opening/talk/ooc labels from the request-layer callers is a trivial follow-up.
  transcript = {}
}) {
  const pipelineT0 = Date.now(); // item-2 diagnosis: context-assembly vs model time
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
  let modelOptions = { ...applyStyleModelOverrides(profileCallOptions(promptProfile, stream, onStream), styleConfig), edition: normalizedEdition, flashMaxTokens };

  // GM-transcript timing: the model call dominates this window (prompt assembly is
  // string work). Captured with the record below.
  const genStartedAt = Date.now();

  if (mode === "companion") {
    const intent = inferCompanionIntent(input);
    companionIntent = intent;
    const lookupIntent = new Set(["session_recap", "entity_lookup", "planning", "relationship_lookup"]);
    const useUtility = intent === "session_recap" || lookupIntent.has(intent);
    selectedModel = useUtility
      ? resolveUtilityModel(styleConfig, modelTiers)
      : resolveNarrativeModel(styleConfig, modelTiers);
    promptProfile = getProfile(selectedModel);
    modelOptions = { ...applyStyleModelOverrides(profileCallOptions(promptProfile, stream, onStream), styleConfig), edition: normalizedEdition, flashMaxTokens };

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
    modelOptions = { ...applyStyleModelOverrides(profileCallOptions(promptProfile, stream, onStream), styleConfig), edition: normalizedEdition, flashMaxTokens };

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

  // SENTENCE-BOUNDARY TRIM: when the token ceiling cut the generation mid-stream
  // (finish_reason === "length"), repair the tail back to the last complete
  // sentence BEFORE any parsing/split/render, so no turn ends on a beheaded quote
  // ('… "That's new'). A self-completed generation is passed through untouched.
  // Runs on the handles-RETRY generation too (it re-enters this pipeline), and the
  // retry itself is bounded to one by enforceHandles — so trim -> detectHandles ->
  // (retry -> trim) can never loop beyond that single retry.
  const trimmedNarrative = trimToCompleteSentence(String(aiResult.content || "").trim(), aiResult.finishReason);
  // EM-DASH BAN (narration law, romance-legacy-law.md): this is THE chokepoint —
  // narration, opening, talk, ooc, and the handles-retry all flow through here —
  // so detection + substitution at this line makes the ban universal. The auditor
  // half FLAGS what the model produced (a drifting model stays visible); the
  // stripAiTells half is the enforcement backstop (a comma replaces the clause
  // break) so a banned dash can never reach any downstream surface.
  const emDashViolations = detectEmDashViolations(trimmedNarrative);
  if (emDashViolations.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[em-dash] BAN violation: ${emDashViolations.length} banned dash(es) in generated ${transcript.callType || "narration"} ` +
        `(run ${transcript.runId || campaignKey}), stripped. First: "${emDashViolations[0].context}"`
    );
  }
  const rawNarrative = emDashViolations.length > 0 ? stripAiTells(trimmedNarrative) : trimmedNarrative;

  // GM-TRANSCRIPT CAPTURE (single chokepoint — narration, opening, talk, ooc all
  // flow through here, and the handles-RETRY re-enters this pipeline as its own
  // call so it is captured as a second record). Best-effort; recordGmGeneration
  // never throws, and this block is additionally guarded so no capture path can
  // ever fail a turn. The handles-retry is detected in-scope by the corrective
  // clause the caller appends to the message (no caller change needed).
  try {
    const rawContent = String(aiResult.content || "");
    const isHandlesRetry = typeof input === "string" && input.includes(HANDLES_CORRECTIVE_CLAUSE.trim());
    const trimApplied = rawNarrative !== rawContent.trim();
    recordGmGeneration({
      runId: transcript.runId || campaignKey,
      campaignId: campaignKey,
      turnRef: transcript.turnRef ?? null,
      callType: isHandlesRetry ? "handles-retry" : (transcript.callType || "narration"),
      model: aiResult.model ?? null,
      finishReason: aiResult.finishReason ?? null,
      promptMessages: messages,
      rawOutput: rawContent,
      trimmedOutput: trimApplied ? rawNarrative : null,
      latencyMs: Date.now() - genStartedAt,
      // item-2 diagnosis: how long prompt/context assembly (style config, player
      // context, memory contextWindow, session-history compression) took BEFORE
      // the model call — the opening #4 case lost 30s+ upstream of generation.
      contextMs: genStartedAt - pipelineT0,
      trimApplied,
      handlesRetry: isHandlesRetry
    });
  } catch {
    // Persistence must never fail a turn.
  }

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

  // Post-narration WRITE-SIDE memory work: knowledge-graph fact extraction +
  // player-profile update. The player never sees any of this — it only enriches
  // the store for FUTURE turns' context. Wrapped so the solo hot path can fire it
  // AFTER the response (deferMemory) instead of blocking on it; every step is
  // best-effort so a memory failure never breaks a turn.
  const runMemoryWork = async () => {
    const updates = [];
    try {
      const autoMemory = await runAutoMemoryPipeline({
        campaignId: campaignKey,
        narrative: sanitizedNarrative,
        playerMessage: input,
        mode,
        playerName
      });
      updates.push(...(autoMemory.updatedEntities || []));
    } catch {
      // extraction is best-effort; a failure just means no new facts this turn
    }
    if (mode === "companion" && companionIntent === "backstory" && playerName) {
      try {
        const playerRecord = await upsertEntity(campaignKey, {
          name: playerName,
          type: "player_character",
          tags: ["backstory", "companion"],
          body: `Backstory update request: ${input}\\n\\nCompanion response:\\n${sanitizedNarrative}`
        });
        updates.push(playerRecord.name);
      } catch {
        // best-effort
      }
    }
    if (playerName) {
      try {
        const profileUpdate = await updatePlayerProfile(campaignKey, playerName, sanitizedNarrative, input);
        if (profileUpdate?.entityName) {
          updates.push(profileUpdate.entityName);
        }
      } catch {
        // Keep the runtime response resilient if player profiling fails.
      }
    }
    return updates;
  };

  const memoryUpdates = [...new Set(triggerExecution.memoryUpdates || [])];
  if (deferMemory) {
    // Fire-after-response: do NOT await. The turn returns now; the memory graph
    // updates a beat late in the background (the process is a long-lived server,
    // so the promise settles). It STILL RUNS — it is not skipped.
    runMemoryWork().catch(() => {});
  } else {
    for (const name of await runMemoryWork()) {
      memoryUpdates.push(name);
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
