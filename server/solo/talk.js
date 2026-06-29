import crypto from "node:crypto";
import { detectSentiment } from "../gm/sentiment.js";
import { getVisibleEntities } from "./entities.js";
import { resolveAbilityCheck } from "./rules.js";
import {
  NPC_EXPRESSIONS,
  createDefaultForbiddenPolicyProfile,
  createDefaultMainlinePolicyProfile,
  createEmptyExpressionVariants,
  validateEntityAgainstPolicy,
  validateSoloRun
} from "./schema.js";

// Maps GM narration tone (gm.js GM_TONES) onto an NPC expression variant.
// For the "neutral" tone (or any unrecognised tone) we fall back to a coarse
// sentiment read of the spoken line so portraits still react to the content.
const TONE_EXPRESSION_MAP = {
  warm: "warm",
  tense: "suspicious",
  dangerous: "fearful",
  dramatic: "surprised",
  comic: "warm",
  mysterious: "suspicious"
};

/**
 * Resolves the expression variant a portrait should display for a line.
 * Pure: no I/O, no mutation.
 * @param {string} tone GM narration tone
 * @param {string} beatText the dialogue line being spoken
 * @returns {"neutral"|"warm"|"suspicious"|"fearful"|"surprised"|"angry"}
 */
export function mapToneToExpression(tone, beatText = "") {
  const normalizedTone = String(tone || "neutral");
  if (normalizedTone !== "neutral" && Object.prototype.hasOwnProperty.call(TONE_EXPRESSION_MAP, normalizedTone)) {
    return TONE_EXPRESSION_MAP[normalizedTone];
  }
  const sentiment = detectSentiment(beatText);
  if (sentiment === "positive") {
    return "warm";
  }
  if (sentiment === "negative") {
    return "suspicious";
  }
  return "neutral";
}

// Resolves an NPC's expression-variant asset ids to served image URIs. Returns
// an all-keys map; a variant is non-null only once its asset is `generated`.
function resolveExpressionVariantUris(run, npc) {
  const variants = createEmptyExpressionVariants();
  const lookup = isPlainObject(npc?.expressionVariants) ? npc.expressionVariants : {};
  const assets = isPlainObject(run?.imageAssets) ? run.imageAssets : {};
  for (const expression of NPC_EXPRESSIONS) {
    const assetId = lookup[expression];
    if (!isString(assetId)) {
      continue;
    }
    const asset = assets[assetId];
    if (asset && asset.status === "generated" && isString(asset.uri)) {
      variants[expression] = asset.uri;
    }
  }
  return variants;
}

function result(errors) {
  return {
    ok: errors.length === 0,
    errors
  };
}

function push(errors, path, message) {
  errors.push({ path, message });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoTimestamp(value) {
  if (!isString(value)) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function nowIso() {
  return new Date().toISOString();
}

function isoFromOption(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" && isIsoTimestamp(value)) {
    return value;
  }
  return nowIso();
}

function defaultIdFactory(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function appendPrefixedErrors(errors, prefix, validation) {
  for (const error of validation.errors) {
    push(errors, `${prefix}.${error.path}`, error.message);
  }
}

function policyProfileForRun(run) {
  return run?.edition === "forbidden" ? createDefaultForbiddenPolicyProfile() : createDefaultMainlinePolicyProfile();
}

function policyAllows(entity, policyProfile) {
  return validateEntityAgainstPolicy(entity, policyProfile).ok;
}

function rawNpcId(targetEntityId) {
  if (!isString(targetEntityId)) {
    return null;
  }
  return targetEntityId.startsWith("npc:") ? targetEntityId.slice("npc:".length) : targetEntityId;
}

function normalizeBeat(beat, npc, index) {
  return {
    beatId: beat.beatId,
    label: beat.label,
    text: beat.text,
    revealed: beat.revealed === true,
    repeatable: beat.repeatable === true,
    contentTags: beat.contentTags || [],
    linkedMemoryFactIds: beat.linkedMemoryFactIds || [],
    linkedQuestIds: beat.linkedQuestIds || [],
    check: beat.check || null,
    edition: beat.edition ?? npc.edition ?? null,
    policyProfileId: beat.policyProfileId ?? npc.policyProfileId ?? null,
    index
  };
}

function beatFactExists(run, npcId, beatId) {
  return (run.memoryFacts || []).some((fact) => {
    return fact.type === "dialogue_beat" && fact.payload?.npcId === npcId && fact.payload?.beatId === beatId;
  });
}

export function getTalkableNpcs(run, options = {}) {
  if (!isPlainObject(run) || !isPlainObject(run.npcs)) {
    return [];
  }

  const visible = getVisibleEntities(run, options).filter((entity) => {
    return entity.entityType === "npc" && (entity.actionTypes || []).includes("talk");
  });
  const visibleNpcIds = new Set(visible.map((entity) => rawNpcId(entity.entityId)));

  return Object.values(run.npcs)
    .filter((npc) => visibleNpcIds.has(npc.npcId))
    .map((npc) => ({
      npc,
      entity: visible.find((entry) => rawNpcId(entry.entityId) === npc.npcId)
    }));
}

export function validateTalkAction(run, action) {
  const errors = [];
  const runValidation = validateSoloRun(run);
  if (!runValidation.ok) {
    appendPrefixedErrors(errors, "run", runValidation);
  }

  if (!isPlainObject(action)) {
    push(errors, "action", "Expected object");
    return result(errors);
  }

  if (action.type !== "talk") {
    push(errors, "action.type", "Expected talk");
  }
  if (!isString(action.targetEntityId)) {
    push(errors, "action.targetEntityId", "Expected non-empty string");
    return result(errors);
  }
  if (action.beatId !== undefined && action.beatId !== null && !isString(action.beatId)) {
    push(errors, "action.beatId", "Expected non-empty string");
  }

  if (!isPlainObject(run) || !isPlainObject(run.npcs)) {
    return result(errors);
  }

  const visibleEntity = getVisibleEntities(run).find((entity) => entity.entityId === action.targetEntityId);
  if (!visibleEntity) {
    push(errors, "action.targetEntityId", "Target NPC is not visible");
    return result(errors);
  }
  if (visibleEntity.entityType !== "npc") {
    push(errors, "action.targetEntityId", "Target must be a visible NPC");
    return result(errors);
  }

  const npcId = rawNpcId(action.targetEntityId);
  const npc = run.npcs[npcId];
  if (!isPlainObject(npc)) {
    push(errors, "action.targetEntityId", "Target NPC does not exist");
    return result(errors);
  }
  if (npc.currentLocationId !== run.currentLocationId) {
    push(errors, "action.targetEntityId", "Target NPC is not in the current location");
  }

  const policyProfile = policyProfileForRun(run);
  const npcPolicy = validateEntityAgainstPolicy(npc, policyProfile);
  for (const error of npcPolicy.errors) {
    push(errors, `npc.${error.path}`, error.message);
  }

  if (action.beatId !== undefined && action.beatId !== null) {
    const allowedBeats = (npc.dialogueBeats || [])
      .map((beat, index) => normalizeBeat(beat, npc, index))
      .filter((beat) => policyAllows(beat, policyProfile));
    if (!allowedBeats.some((beat) => beat.beatId === action.beatId)) {
      push(errors, "action.beatId", "Dialogue beat is not available");
    }
  }

  return result(errors);
}

export function createTalkMemoryFact(run, action, npc, beat, options = {}) {
  const now = isoFromOption(options.now ?? action.createdAt);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;

  return {
    factId: idFactory("fact_talk"),
    entityIds: [...new Set([run.runId, action.actorId ?? "player", run.currentLocationId, npc.npcId, `npc:${npc.npcId}`])],
    type: "dialogue_beat",
    text: beat.text,
    source: "system",
    createdAt: now,
    tags: ["system", "talk"],
    edition: beat.edition ?? npc.edition ?? run.edition,
    policyProfileId: beat.policyProfileId ?? npc.policyProfileId ?? run.policyProfileId,
    contentTags: beat.contentTags || [],
    canonical: true,
    confidence: 1,
    supersedesFactIds: [],
    payload: {
      npcId: npc.npcId,
      beatId: beat.beatId,
      linkedQuestIds: beat.linkedQuestIds || []
    }
  };
}

export function createTalkTimelineEvent(run, action, talkResult, memoryFact, options = {}) {
  const now = isoFromOption(options.now ?? action.createdAt);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;

  return {
    eventId: idFactory("event_talk"),
    type: "talk",
    title: talkResult.found ? "Conversation" : "Talk Attempted",
    summary: talkResult.summary,
    createdAt: now,
    locationId: run.currentLocationId,
    entityIds: [...new Set([run.runId, action.actorId ?? "player", run.currentLocationId, talkResult.npcId, `npc:${talkResult.npcId}`])],
    memoryFactIds: memoryFact ? [memoryFact.factId] : [],
    tags: ["system", "talk"],
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    contentTags: talkResult.contentTags || [],
    payload: {
      actorId: action.actorId ?? "player",
      npcId: talkResult.npcId,
      beatId: talkResult.beatId,
      revealed: talkResult.revealed,
      checkResult: talkResult.checkResult || null
    }
  };
}

export function resolveTalkAction(run, action, options = {}) {
  const validation = validateTalkAction(run, action);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors
    };
  }

  const updatedRun = clone(run);
  const now = isoFromOption(options.now ?? action.createdAt);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;
  const npcId = rawNpcId(action.targetEntityId);
  const npc = updatedRun.npcs[npcId];
  const policyProfile = policyProfileForRun(updatedRun);
  const allowedBeats = (npc.dialogueBeats || [])
    .map((beat, index) => normalizeBeat(beat, npc, index))
    .filter((beat) => policyAllows(beat, policyProfile));
  const selectedBeat = action.beatId
    ? allowedBeats.find((beat) => beat.beatId === action.beatId && (beat.revealed !== true || beat.repeatable === true))
    : allowedBeats.find((beat) => beat.revealed !== true) || allowedBeats.find((beat) => beat.repeatable === true);

  let checkResult = null;
  if (selectedBeat?.check) {
    checkResult = resolveAbilityCheck(updatedRun, {
      checkId: selectedBeat.check.checkId || `check_${selectedBeat.beatId}`,
      rulesetId: selectedBeat.check.rulesetId || updatedRun.rulesetId || updatedRun.player?.rulesetId || "notdnd_basic",
      ability: selectedBeat.check.ability,
      skill: selectedBeat.check.skill ?? null,
      dc: selectedBeat.check.dc,
      advantage: selectedBeat.check.advantage === true,
      disadvantage: selectedBeat.check.disadvantage === true
    }, options);
    if (!checkResult.ok) {
      return {
        ok: false,
        errors: checkResult.errors.map((error) => ({
          path: `beat.check.${error.path}`,
          message: error.message
        }))
      };
    }
  }

  const canReveal = Boolean(selectedBeat) && (!checkResult || checkResult.success === true) && selectedBeat.revealed !== true;
  const canRepeat = Boolean(selectedBeat) && selectedBeat.repeatable === true && selectedBeat.revealed === true && (!checkResult || checkResult.success === true);
  // Tone is supplied by the scene/GM layer when available; absent it, the
  // expression mapper falls back to sentiment of the spoken line.
  const currentTone = isString(options.currentTone) ? options.currentTone : "neutral";
  const spokenLine = isString(selectedBeat?.text) ? selectedBeat.text : "";
  const expression = mapToneToExpression(currentTone, spokenLine);
  const expressionVariants = resolveExpressionVariantUris(updatedRun, npc);
  let memoryFact = null;
  // Graceful no-beat fallback. Every NPC speaks via the GM (server/index.js
  // replaces talkResult.line with GM-generated dialogue on both the opening and
  // each reply). This line is the DEGRADED path shown only when the GM is
  // unavailable (timeout / provider 4xx-5xx) — so a procedurally-generated NPC
  // with no authored beats still acknowledges the player in character instead of
  // the old dead "There is not much new to say right now." dead-end.
  const who = isString(npc.displayName) ? npc.displayName : "The figure";
  const talkResult = canReveal || canRepeat
    ? {
        npcId,
        beatId: selectedBeat.beatId,
        found: true,
        speakerName: npc.displayName,
        line: selectedBeat.text,
        summary: `${npc.displayName}: ${selectedBeat.label}`,
        revealed: canReveal,
        checkResult,
        expression,
        expressionVariants,
        contentTags: selectedBeat.contentTags || [],
        linkedMemoryFactIds: selectedBeat.linkedMemoryFactIds || [],
        linkedQuestIds: selectedBeat.linkedQuestIds || [],
        warningCodes: []
      }
    : {
        npcId,
        beatId: selectedBeat?.beatId || null,
        found: false,
        speakerName: npc.displayName,
        line:
          selectedBeat && checkResult
            ? `${who} holds something back, unwilling to say more just now.`
            : `${who} turns to regard you, ready to hear what you have to say.`,
        summary: selectedBeat && checkResult ? "The conversation does not reveal anything new." : "No new dialogue is available.",
        revealed: false,
        checkResult,
        expression,
        expressionVariants,
        contentTags: [],
        linkedMemoryFactIds: [],
        linkedQuestIds: [],
        warningCodes: selectedBeat && checkResult ? ["TALK_CHECK_FAILED"] : ["TALK_NOTHING_NEW"]
      };

  if (canReveal) {
    npc.dialogueBeats[selectedBeat.index] = {
      ...npc.dialogueBeats[selectedBeat.index],
      revealed: true
    };
    if (!beatFactExists(updatedRun, npcId, selectedBeat.beatId)) {
      memoryFact = createTalkMemoryFact(updatedRun, action, npc, selectedBeat, { now, idFactory });
    }
  }

  const timelineEvent = createTalkTimelineEvent(updatedRun, action, talkResult, memoryFact, { now, idFactory });

  updatedRun.updatedAt = now;
  updatedRun.timeline = [...updatedRun.timeline, timelineEvent];
  if (memoryFact) {
    updatedRun.memoryFacts = [...updatedRun.memoryFacts, memoryFact];
    npc.memoryFactIds = [...new Set([...(npc.memoryFactIds || []), memoryFact.factId])];
  }

  const updatedValidation = validateSoloRun(updatedRun);
  if (!updatedValidation.ok) {
    return {
      ok: false,
      errors: updatedValidation.errors
    };
  }

  return {
    ok: true,
    run: updatedRun,
    event: timelineEvent,
    memoryFact,
    talkResult,
    errors: []
  };
}
