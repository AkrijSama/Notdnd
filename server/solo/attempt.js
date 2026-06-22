import crypto from "node:crypto";
import { getVisibleEntities } from "./entities.js";
import { getAvailableMoves } from "./movement.js";
import { ABILITIES, SKILLS, resolveAbilityCheck } from "./rules.js";
import {
  createDefaultForbiddenPolicyProfile,
  createDefaultMainlinePolicyProfile,
  validateEntityAgainstPolicy,
  validateSoloRun
} from "./schema.js";
import { getUsableInventoryItems } from "./useItem.js";

const PROVIDER_OUTPUT_FIELDS = new Set([
  "summary",
  "recommendedAbility",
  "dc",
  "advantage",
  "disadvantage",
  "successNarration",
  "failureNarration",
  "proposedEffects"
]);
const ALLOWED_EFFECT_TYPES = new Set(["timeline_event", "memory_fact", "narration"]);
const SKILL_TO_ABILITY = {
  investigation: "intelligence",
  perception: "wisdom",
  stealth: "dexterity",
  persuasion: "charisma",
  insight: "wisdom"
};

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

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isIsoTimestamp(value) {
  return isString(value) && Number.isFinite(Date.parse(value));
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

function sanitizeText(value) {
  return String(value ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[{}[\]]/g, "")
    .trim();
}

function policyProfileForRun(run) {
  return run?.edition === "forbidden" ? createDefaultForbiddenPolicyProfile() : createDefaultMainlinePolicyProfile();
}

function policyAllows(entity, policyProfile) {
  return validateEntityAgainstPolicy(entity || {}, policyProfile).ok;
}

function rawEntityId(entityId) {
  if (!isString(entityId)) {
    return null;
  }
  return entityId.includes(":") ? entityId.split(":").slice(1).join(":") : entityId;
}

function compactEntity(entity = {}) {
  return {
    entityId: entity.entityId,
    rawEntityId: rawEntityId(entity.entityId),
    entityType: entity.entityType,
    displayName: entity.displayName,
    summary: entity.summary || "",
    actionTypes: entity.actionTypes || [],
    relationshipId: entity.relationshipId || null,
    memoryFactIds: entity.memoryFactIds || [],
    contentTags: entity.contentTags || []
  };
}

function compactTimeline(event = {}) {
  return {
    eventId: event.eventId,
    type: event.type,
    title: event.title,
    summary: event.summary || "",
    createdAt: event.createdAt,
    locationId: event.locationId || null,
    entityIds: event.entityIds || [],
    memoryFactIds: event.memoryFactIds || []
  };
}

function compactFact(fact = {}) {
  return {
    factId: fact.factId,
    entityIds: fact.entityIds || [],
    type: fact.type,
    text: fact.text || "",
    source: fact.source,
    createdAt: fact.createdAt,
    canonical: fact.canonical === true,
    confidence: fact.confidence
  };
}

function compactItem(item = {}) {
  return {
    itemId: item.itemId,
    name: item.name,
    description: item.description || "",
    quantity: item.quantity,
    usable: item.usable === true,
    consumable: item.consumable === true
  };
}

function abilityFromRecommendation(recommendation) {
  if (!recommendation) {
    return null;
  }
  const value = String(recommendation).trim().toLowerCase();
  if (ABILITIES.includes(value)) {
    return {
      ability: value,
      skill: null
    };
  }
  if (SKILLS.includes(value)) {
    return {
      ability: SKILL_TO_ABILITY[value] || "intelligence",
      skill: value
    };
  }
  return null;
}

function defaultProviderOutput(input) {
  const intent = input.intent || "attempt an action";
  const lowered = intent.toLowerCase();
  let recommendedAbility = "investigation";
  if (/\b(convince|persuade|deceive|talk|offer)\b/.test(lowered)) {
    recommendedAbility = "persuasion";
  } else if (/\b(force|break|push|lift)\b/.test(lowered)) {
    recommendedAbility = "strength";
  } else if (/\b(climb|sneak|slip|dodge)\b/.test(lowered)) {
    recommendedAbility = "stealth";
  } else if (/\b(search|look|inspect|notice|hidden)\b/.test(lowered)) {
    recommendedAbility = "investigation";
  }

  return {
    summary: `You attempt: ${intent}`,
    recommendedAbility,
    dc: 10,
    advantage: false,
    disadvantage: false,
    successNarration: "The attempt works well enough for now.",
    failureNarration: "The attempt does not work right now.",
    proposedEffects: []
  };
}

export function validateAttemptAction(run, action) {
  const errors = [];
  const runValidation = validateSoloRun(run);
  if (!runValidation.ok) {
    appendPrefixedErrors(errors, "run", runValidation);
  }

  if (!isPlainObject(action)) {
    push(errors, "action", "Expected object");
    return result(errors);
  }
  if (action.type !== "attempt") {
    push(errors, "action.type", "Expected attempt");
  }
  if (!isString(action.intent)) {
    push(errors, "action.intent", "Expected non-empty string");
  }
  if (action.targetId !== undefined && action.targetId !== null && !isString(action.targetId)) {
    push(errors, "action.targetId", "Expected non-empty string");
  }

  if (isString(action.targetId)) {
    const visible = getVisibleEntities(run);
    const target = visible.find((entity) => entity.entityId === action.targetId || rawEntityId(entity.entityId) === action.targetId);
    if (!target) {
      push(errors, "action.targetId", "Target must be a visible entity");
    }
  }

  return result(errors);
}

export function buildAttemptContext(run, action, options = {}) {
  const validation = validateAttemptAction(run, action);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors
    };
  }

  const policyProfile = options.policyProfile || policyProfileForRun(run);
  const visibleEntities = getVisibleEntities(run, { policyProfile })
    .filter((entity) => policyAllows(entity, policyProfile))
    .map(compactEntity);
  const targetEntity = isString(action.targetId)
    ? visibleEntities.find((entity) => entity.entityId === action.targetId || entity.rawEntityId === action.targetId) || null
    : null;
  const facts = (run.memoryFacts || []).filter((fact) => policyAllows(fact, policyProfile)).slice(-10);
  const timeline = (run.timeline || []).filter((event) => policyAllows(event, policyProfile)).slice(-5);

  return {
    ok: true,
    runId: run.runId,
    actorId: action.actorId || "player",
    intent: action.intent,
    targetId: action.targetId || null,
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    rulesetId: run.rulesetId || run.player?.rulesetId || "notdnd_basic",
    location: {
      locationId: run.currentLocationId,
      name: run.locations?.[run.currentLocationId]?.name || run.currentLocationId,
      description: run.locations?.[run.currentLocationId]?.description || "",
      contentTags: run.locations?.[run.currentLocationId]?.contentTags || []
    },
    player: {
      playerId: run.player?.playerId,
      displayName: run.player?.displayName,
      resources: run.player?.resources || {},
      abilities: run.player?.abilities || {},
      skills: run.player?.skills || {}
    },
    visibleEntities,
    targetEntity,
    availableMoves: getAvailableMoves(run).filter((move) => policyAllows(move, policyProfile)),
    availableInventory: getUsableInventoryItems(run, { policyProfile }).map(compactItem),
    recentTimeline: timeline.map(compactTimeline),
    relevantMemoryFacts: facts.map(compactFact),
    errors: []
  };
}

export function buildAttemptProviderInput(context, options = {}) {
  if (!isPlainObject(context) || context.ok !== true) {
    return {
      ok: false,
      errors: [
        {
          path: "context",
          message: "Expected valid attempt context"
        }
      ]
    };
  }

  return {
    ok: true,
    mode: "attempt_interpretation",
    context: clone({
      runId: context.runId,
      actorId: context.actorId,
      intent: context.intent,
      targetId: context.targetId,
      edition: context.edition,
      policyProfileId: context.policyProfileId,
      rulesetId: context.rulesetId,
      location: context.location,
      player: context.player,
      visibleEntities: context.visibleEntities,
      targetEntity: context.targetEntity,
      availableMoves: context.availableMoves,
      availableInventory: context.availableInventory,
      recentTimeline: context.recentTimeline,
      relevantMemoryFacts: context.relevantMemoryFacts
    }),
    instructions: {
      narrateOnly: true,
      doNotMutateState: true,
      serverRollsChecks: true,
      noCanonInvention: true,
      allowedEffects: [...ALLOWED_EFFECT_TYPES],
      unsupportedEffectsRejected: true
    },
    outputContract: {
      summary: "string",
      recommendedAbility: "strength|dexterity|constitution|intelligence|wisdom|charisma|investigation|perception|stealth|persuasion|insight|null",
      dc: "number|null",
      advantage: "boolean",
      disadvantage: "boolean",
      successNarration: "string",
      failureNarration: "string",
      proposedEffects: []
    }
  };
}

export function validateAttemptProviderOutput(output, options = {}) {
  const errors = [];
  if (!isPlainObject(output)) {
    push(errors, "output", "Expected object");
    return result(errors);
  }

  for (const key of Object.keys(output)) {
    if (!PROVIDER_OUTPUT_FIELDS.has(key)) {
      push(errors, key, "Unknown provider output field");
    }
  }
  for (const key of ["summary", "successNarration", "failureNarration"]) {
    if (!isString(output[key])) {
      push(errors, key, "Expected non-empty string");
    }
  }
  if (output.recommendedAbility !== undefined && output.recommendedAbility !== null && !abilityFromRecommendation(output.recommendedAbility)) {
    push(errors, "recommendedAbility", "Expected supported ability or skill");
  }
  if (output.dc !== undefined && output.dc !== null) {
    if (!isNumber(output.dc) || output.dc < 1 || output.dc > 30) {
      push(errors, "dc", "Expected number from 1 to 30");
    }
  }
  for (const key of ["advantage", "disadvantage"]) {
    if (output[key] !== undefined && typeof output[key] !== "boolean") {
      push(errors, key, "Expected boolean");
    }
  }
  if (!Array.isArray(output.proposedEffects)) {
    push(errors, "proposedEffects", "Expected array");
  } else {
    output.proposedEffects.forEach((effect, index) => {
      if (!isPlainObject(effect)) {
        push(errors, `proposedEffects.${index}`, "Expected object");
        return;
      }
      if (!ALLOWED_EFFECT_TYPES.has(effect.type)) {
        push(errors, `proposedEffects.${index}.type`, "Unsupported effect type");
      }
      if (effect.type === "memory_fact" && !isString(effect.text)) {
        push(errors, `proposedEffects.${index}.text`, "Expected non-empty string");
      }
    });
  }

  const text = [output.summary, output.successNarration, output.failureNarration].join(" ");
  if (/\b(SYSTEM|USER):/i.test(text)) {
    push(errors, "output", "Provider output appeared to include a raw prompt dump");
  }
  if (/<[^>]+>/.test(text)) {
    push(errors, "output", "Expected plain text without HTML");
  }
  if (/\|.+\|/.test(text)) {
    push(errors, "output", "Expected plain text without markdown tables");
  }
  if (Array.isArray(output.stateMutations) && output.stateMutations.length > 0) {
    push(errors, "stateMutations", "Attempt provider cannot mutate state");
  }

  return result(errors);
}

export function sanitizeAttemptProviderOutput(output, options = {}) {
  return {
    summary: sanitizeText(output?.summary),
    recommendedAbility: output?.recommendedAbility ? String(output.recommendedAbility).trim().toLowerCase() : null,
    dc: isNumber(output?.dc) ? output.dc : null,
    advantage: output?.advantage === true,
    disadvantage: output?.disadvantage === true,
    successNarration: sanitizeText(output?.successNarration),
    failureNarration: sanitizeText(output?.failureNarration),
    proposedEffects: Array.isArray(output?.proposedEffects)
      ? output.proposedEffects.map((effect) => ({
          type: effect.type,
          text: effect.text ? sanitizeText(effect.text) : undefined
        }))
      : []
  };
}

function parseProviderOutput(rawOutput, context) {
  if (isPlainObject(rawOutput)) {
    return clone(rawOutput);
  }
  if (typeof rawOutput === "string") {
    const trimmed = rawOutput.trim();
    if (!trimmed) {
      return null;
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      return {
        summary: `You attempt: ${context.intent}`,
        recommendedAbility: null,
        dc: null,
        advantage: false,
        disadvantage: false,
        successNarration: sanitizeText(trimmed),
        failureNarration: sanitizeText(trimmed),
        proposedEffects: []
      };
    }
  }
  return null;
}

function resolveProviderOutput(context, providerInput, options = {}) {
  const providerFn = typeof options.attemptProviderFn === "function" ? options.attemptProviderFn : null;
  const rawOutput = providerFn ? providerFn(providerInput) : defaultProviderOutput(context);
  const parsed = parseProviderOutput(rawOutput, context);
  const validation = validateAttemptProviderOutput(parsed);
  if (!validation.ok) {
    const fallback = defaultProviderOutput(context);
    return {
      output: fallback,
      warnings: ["ATTEMPT_PROVIDER_FALLBACK"],
      providerErrors: validation.errors
    };
  }
  return {
    output: sanitizeAttemptProviderOutput(parsed),
    warnings: [],
    providerErrors: []
  };
}

export function createAttemptMemoryFact(run, action, attemptResult, effect, options = {}) {
  const now = isoFromOption(options.now ?? action.createdAt);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;
  return {
    factId: idFactory("fact_attempt"),
    entityIds: [...new Set([run.runId, action.actorId ?? "player", run.currentLocationId, action.targetId].filter(Boolean))],
    type: "attempt_memory",
    text: effect.text,
    source: "system",
    createdAt: now,
    tags: ["system", "attempt"],
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    contentTags: [],
    canonical: true,
    confidence: 0.7,
    supersedesFactIds: [],
    payload: {
      intent: action.intent,
      success: attemptResult.success
    }
  };
}

export function createAttemptTimelineEvent(run, action, attemptResult, memoryFact, options = {}) {
  const now = isoFromOption(options.now ?? action.createdAt);
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;
  return {
    eventId: idFactory("event_attempt"),
    type: "attempt",
    title: attemptResult.success ? "Attempt Succeeded" : "Attempt Failed",
    summary: attemptResult.summary,
    createdAt: now,
    locationId: run.currentLocationId,
    entityIds: [...new Set([run.runId, action.actorId ?? "player", run.currentLocationId, action.targetId].filter(Boolean))],
    memoryFactIds: memoryFact ? [memoryFact.factId] : [],
    tags: ["system", "attempt"],
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    contentTags: [],
    payload: {
      intent: action.intent,
      targetId: action.targetId || null,
      success: attemptResult.success,
      checkResult: attemptResult.checkResult || null,
      narration: attemptResult.narration,
      warnings: attemptResult.warnings || []
    }
  };
}

export function resolveAttemptAction(run, action, options = {}) {
  const validation = validateAttemptAction(run, action);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors
    };
  }

  const updatedRun = clone(run);
  const context = buildAttemptContext(updatedRun, action, options);
  if (!context.ok) {
    return {
      ok: false,
      errors: context.errors
    };
  }
  const providerInput = buildAttemptProviderInput(context, options);
  const providerResult = resolveProviderOutput(context, providerInput, options);
  const providerOutput = providerResult.output;
  const recommendation = abilityFromRecommendation(providerOutput.recommendedAbility);
  let checkResult = null;
  let success = true;

  if (recommendation && providerOutput.dc !== null && providerOutput.dc !== undefined) {
    checkResult = resolveAbilityCheck(updatedRun, {
      checkId: "attempt_check",
      rulesetId: context.rulesetId,
      ability: recommendation.ability,
      skill: recommendation.skill,
      dc: providerOutput.dc,
      advantage: providerOutput.advantage === true,
      disadvantage: providerOutput.disadvantage === true
    }, options);
    success = checkResult.ok === true && checkResult.success === true;
  }

  const narration = success ? providerOutput.successNarration : providerOutput.failureNarration;
  const attemptResult = {
    intent: action.intent,
    targetId: action.targetId || null,
    success,
    summary: providerOutput.summary,
    checkResult,
    narration,
    warnings: providerResult.warnings,
    proposedEffects: providerOutput.proposedEffects || []
  };

  const memoryEffect = (providerOutput.proposedEffects || []).find((effect) => effect.type === "memory_fact" && isString(effect.text));
  const memoryFact = memoryEffect ? createAttemptMemoryFact(updatedRun, action, attemptResult, memoryEffect, options) : null;
  if (memoryFact) {
    updatedRun.memoryFacts.push(memoryFact);
  }

  const event = createAttemptTimelineEvent(updatedRun, action, attemptResult, memoryFact, options);
  updatedRun.timeline.push(event);
  updatedRun.updatedAt = isoFromOption(options.now ?? action.createdAt);

  const finalValidation = validateSoloRun(updatedRun);
  if (!finalValidation.ok) {
    return {
      ok: false,
      errors: finalValidation.errors.map((error) => ({
        path: `run.${error.path}`,
        message: error.message
      }))
    };
  }

  return {
    ok: true,
    run: updatedRun,
    event,
    memoryFact,
    attemptResult,
    attemptContext: context,
    providerInput,
    providerErrors: providerResult.providerErrors,
    errors: []
  };
}
