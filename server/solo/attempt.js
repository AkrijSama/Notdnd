import crypto from "node:crypto";
import { getVisibleEntities } from "./entities.js";
import { getAvailableMoves } from "./movement.js";
import { ABILITIES, SKILLS, SKILL_ABILITY, resolveAbilityCheck } from "./rules.js";
import {
  createDefaultForbiddenPolicyProfile,
  createDefaultMainlinePolicyProfile,
  validateEntityAgainstPolicy,
  validateSoloRun
} from "./schema.js";
import { getUsableInventoryItems } from "./useItem.js";
import { POLICY_VIOLATION_NARRATION, screenPlayerIntent } from "./safety.js";
import { applyDamage, isIncapacitated } from "./death.js";

const PROVIDER_OUTPUT_FIELDS = new Set([
  "summary",
  "recommendedAbility",
  "dc",
  // Whether the action is contested enough to roll. Optional: when the provider
  // supplies it, it overrides the server-side verb heuristic (attemptNeedsCheck).
  "needsCheck",
  "advantage",
  "disadvantage",
  "successNarration",
  "failureNarration",
  "proposedEffects"
]);
const ALLOWED_EFFECT_TYPES = new Set(["timeline_event", "memory_fact", "narration", "damage"]);

// Minimal failure-cost mechanic (not full combat): a failed attempt costs the
// player a small, fixed amount of HP. Kept simple and deterministic on purpose.
const FAILED_ATTEMPT_DAMAGE = 2;

// Fallback heuristics for when the provider omits the ability and/or DC. These
// keep the server from silently auto-succeeding an unjudged attempt: we always
// derive *some* ability + DC from the intent text and roll. Coarse on purpose —
// a rough classifier beats a blind constant, and the provider supplies the
// precise values on the normal path.

// Difficulty buckets: easy (8) / medium (12) / hard (16). Default medium.
const HARD_INTENT_RE = /\b(sneak|stealth|slip past|pick(ing)?|lockpick|disarm|disable|hack|decipher|forge|climb|scale|leap|vault|pry|force|break\s+down|shatter|intimidate|threaten|seduce|outrun|evade|escape|dodge|pickpocket|steal)\b/;
const EASY_INTENT_RE = /\b(open|close|shut|push|pull|lift|carry|walk|step|look|glance|listen|read|grab|drop|sit|stand|greet|ask|talk|enter|exit|wave|nod|point)\b/;
function classifyIntentDc(intent) {
  const text = String(intent || "").toLowerCase();
  if (HARD_INTENT_RE.test(text)) {
    return 16;
  }
  if (EASY_INTENT_RE.test(text)) {
    return 8;
  }
  return 12;
}

// Governing-ability buckets: physical->STR, finesse->DEX, social->CHA,
// knowledge->INT. Default INT (the catch-all "figure it out" check).
const PHYSICAL_INTENT_RE = /\b(force|break|smash|bash|lift|carry|push|pull|shove|wrench|haul|climb|swim|grapple|drag|hold)\b/;
const FINESSE_INTENT_RE = /\b(sneak|stealth|slip|hide|dodge|pick|lockpick|disarm|balance|tumble|aim|throw|juggle|steal|pickpocket|nimble|acrobat)\b/;
const SOCIAL_INTENT_RE = /\b(persuade|convince|talk|deceive|lie|bluff|charm|seduce|intimidate|threaten|negotiate|barter|impress|perform|comfort|flatter)\b/;
const KNOWLEDGE_INTENT_RE = /\b(recall|remember|identify|examine|inspect|analyze|study|research|decipher|read|investigate|search|recognize|understand|recount)\b/;
function abilityFromIntent(intent) {
  const text = String(intent || "").toLowerCase();
  if (PHYSICAL_INTENT_RE.test(text)) {
    return "strength";
  }
  if (FINESSE_INTENT_RE.test(text)) {
    return "dexterity";
  }
  if (SOCIAL_INTENT_RE.test(text)) {
    return "charisma";
  }
  if (KNOWLEDGE_INTENT_RE.test(text)) {
    return "intelligence";
  }
  return "intelligence";
}

// --- Roll gate: does this attempt need a d20 check at all? -------------------
// The old behavior rolled a check for EVERY freeform attempt, so trivial
// no-stakes intents like "head toward the market" rolled vs a DC. That's noise:
// walking somewhere unobstructed, or simply looking around, has no uncertainty.
// These two regexes classify the intent when the provider doesn't supply an
// explicit needsCheck. Contested verbs WIN over movement (so "sneak toward the
// gate" still rolls), and anything ambiguous defaults to rolling — preserving
// the old behavior for genuinely uncertain actions (the brief: don't break the
// cases that SHOULD roll).

// Contested / uncertain intents that ALWAYS roll: physical feats, stealth and
// finesse, social pressure, and risky skill use. Checked FIRST so a contested
// verb is never suppressed by an incidental movement word.
const CONTESTED_INTENT_RE = /\b(sneak|stealth|hide|hiding|slip|pick|lockpick|picklock|disarm|disable|hack|decipher|forge|climb|scale|leap|vault|pry|force|forcing|break|breaking|smash|bash|shatter|wrench|intimidate|threaten|menace|coerce|persuade|convince|deceive|lie|bluff|charm|seduce|negotiate|barter|haggle|bribe|outrun|evade|escape|dodge|pickpocket|steal|swipe|snatch|search|investigate|fight|attack|strike|punch|kick|shove|grapple|wrestle|tackle|swim|balance|jump|throw|hurl|aim|shoot|fire|cast|sabotage|trick|con|disguise|track|forage)\b/;

// No-stakes intents that resolve NARRATIVELY with no roll: pure movement /
// travel / navigation, and simple observation. Deliberately narrow — it does NOT
// include manipulation verbs like "open/push/pull/grab" (those can carry stakes
// and the engine still rolls them); only frictionless travel and looking.
const NO_ROLL_INTENT_RE = /\b(head|heading|headed|go|going|goes|went|walk|walking|walked|travel|traveling|travelling|travelled|journey|journeying|wander|wandering|stroll|strolling|march|marching|proceed|proceeding|continue|advance|advancing|approach|approaching|enter|entering|exit|exiting|leave|leaving|depart|departing|return|returning|navigate|cross|crossing|move|moves|moved|moving|venture|venturing|look|looking|looked|glance|glancing|observe|observing|survey|surveying|gaze|gazing|watch|watching|scan|scanning|peer|peering|gander)\b/;

/**
 * Decides whether an attempt needs a d20 check. A provider-supplied `needsCheck`
 * boolean wins (the GM/provider classified it); otherwise a verb heuristic:
 * contested/uncertain intents roll, pure movement/observation resolve
 * narratively, and anything ambiguous defaults to rolling. Pure; never throws.
 * @param {string} intent the player's freeform intent text
 * @param {object|null} providerOutput sanitized attempt provider output (may carry needsCheck)
 * @returns {boolean}
 */
export function attemptNeedsCheck(intent, providerOutput = null) {
  if (providerOutput && typeof providerOutput.needsCheck === "boolean") {
    return providerOutput.needsCheck;
  }
  const text = String(intent || "").toLowerCase();
  if (CONTESTED_INTENT_RE.test(text)) {
    return true;
  }
  if (NO_ROLL_INTENT_RE.test(text)) {
    return false;
  }
  return true;
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
      ability: SKILL_ABILITY[value] || "intelligence",
      skill: value
    };
  }
  return null;
}

// Lowercases the first character so an imperative intent ("Search the room")
// reads naturally mid-sentence ("You search the room…"). Strips characters that
// would trip provider-output validation (HTML/table/brace markers) since the
// intent is player-supplied.
function intentPhrase(intent) {
  const cleaned = String(intent || "").replace(/[<>|{}[\]]/g, "").trim();
  if (!cleaned) {
    return "act";
  }
  return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
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

  // Intent-aware fallback narration. This is the deterministic line shown when
  // the GM provider is unavailable (e.g. the request layer's bounded GM call
  // times out or the LLM is misconfigured). Echoing what the player actually
  // did keeps a resolved action from reading as "nothing happened" in degraded
  // mode — the live GM narration replaces it on the normal path.
  const phrase = intentPhrase(intent);
  return {
    summary: `You attempt: ${intent}`,
    recommendedAbility,
    dc: classifyIntentDc(intent),
    advantage: false,
    disadvantage: false,
    successNarration: `You ${phrase}, and it goes well enough.`,
    failureNarration: `You try to ${phrase}, but it doesn't come together this time.`,
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
      recommendedAbility: `${[...ABILITIES, ...SKILLS].join("|")}|null`,
      dc: "number|null",
      // true only for genuinely uncertain/contested actions (sneak, persuade,
      // fight, pick a lock, climb, search for something hidden…). Pure movement,
      // travel, or simple observation is no-stakes: set false and the server
      // resolves it narratively with no dice roll.
      needsCheck: "boolean|null",
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
  if (output.needsCheck !== undefined && output.needsCheck !== null && typeof output.needsCheck !== "boolean") {
    push(errors, "needsCheck", "Expected boolean");
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
    needsCheck: typeof output?.needsCheck === "boolean" ? output.needsCheck : null,
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
      warnings: attemptResult.warnings || [],
      damage: attemptResult.damage || null
    }
  };
}

// Applies a failed-attempt HP cost through the 5e lethality core (death.js).
// Mutates the (already-cloned) run in place: clamps HP at 0 (never negative) and,
// crucially, reaching 0 HP now sets the player 'dying' (NOT a consequence-free
// "downed") — the first step of the real death spine. The canonical HP store is
// player.resources.hitPoints, mirrored to resources.hp + player.health. Returns
// the structured damage record (back-compatible: amount/hpBefore/hpAfter/max/
// downed, plus dying/dead/instantDeath/revived), or null when no HP gauge exists.
export function applyFailureDamage(run, amount = FAILED_ATTEMPT_DAMAGE) {
  return applyDamage(run, amount);
}

// A flagged intent (prompt injection / explicit / empty-after-sanitize) never
// reaches the AI: it resolves to a no-op, in-character refusal. Nothing is rolled
// or damaged, and the raw offending text is neither echoed nor persisted. The
// `policyViolation` flag lets the client style it as a subtle in-character beat
// rather than a hard error; buildActionGmMessage skips the GM call when it sees it.
function buildPolicyViolationAttempt(run, action, reason) {
  return {
    ok: true,
    run, // unchanged clone — still schema-valid
    event: null,
    memoryFact: null,
    attemptResult: {
      intent: "", // redacted — do not echo the flagged input
      targetId: action.targetId || null,
      success: false,
      summary: POLICY_VIOLATION_NARRATION,
      checkResult: null,
      narration: POLICY_VIOLATION_NARRATION,
      warnings: ["ATTEMPT_POLICY_VIOLATION"],
      proposedEffects: [],
      damage: null,
      policyViolation: true,
      policyReason: reason || "policy"
    },
    attemptContext: null,
    providerInput: null,
    providerErrors: [],
    errors: []
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

  // Safety screen on the player's freeform intent BEFORE it can reach any AI
  // prompt. A flag short-circuits to an in-character refusal; otherwise we use
  // the sanitized intent (injection-shaped text stripped) for the rest of the flow.
  const screen = screenPlayerIntent(action.intent);
  if (!screen.ok) {
    return buildPolicyViolationAttempt(updatedRun, action, screen.reason);
  }
  const safeAction = screen.cleanIntent === action.intent ? action : { ...action, intent: screen.cleanIntent };

  const context = buildAttemptContext(updatedRun, safeAction, options);
  if (!context.ok) {
    return {
      ok: false,
      errors: context.errors
    };
  }
  const providerInput = buildAttemptProviderInput(context, options);
  const providerResult = resolveProviderOutput(context, providerInput, options);
  const providerOutput = providerResult.output;

  // Roll gate (FIX H): only genuinely uncertain/contested actions roll a d20.
  // Pure movement/travel/observation resolves narratively — no dice, no "vs DC".
  const needsCheck = attemptNeedsCheck(context.intent, providerOutput);

  let checkResult = null;
  let success;
  let damage = null;
  if (needsCheck) {
    // Never silently auto-succeed an unjudged contested attempt. When the
    // provider omits the ability/skill, fall back to an intent-derived ability
    // (skill-less); when it omits the DC, fall back to an intent-derived DC.
    // Either way we roll a real check, so an attempt can fail even on a thin
    // provider response.
    const recommendation = abilityFromRecommendation(providerOutput.recommendedAbility)
      || { ability: abilityFromIntent(context.intent), skill: null };
    const checkDc = (providerOutput.dc !== null && providerOutput.dc !== undefined)
      ? providerOutput.dc
      : classifyIntentDc(context.intent);
    checkResult = resolveAbilityCheck(updatedRun, {
      checkId: "attempt_check",
      rulesetId: context.rulesetId,
      ability: recommendation.ability,
      skill: recommendation.skill,
      dc: checkDc,
      advantage: providerOutput.advantage === true,
      disadvantage: providerOutput.disadvantage === true
    }, options);
    success = checkResult.ok === true && checkResult.success === true;
    // Failure has teeth: a failed contested attempt drains HP, and reaching 0
    // drops the player into 'dying' (death saves begin). When the player is
    // ALREADY incapacitated (0 HP / dying), the dying-turn death save rolled by
    // the action dispatcher is the sole consequence — we don't also stack a
    // damage-at-0 failure here, which would double-punish the same turn.
    damage = (success || isIncapacitated(updatedRun))
      ? null
      : applyFailureDamage(updatedRun, FAILED_ATTEMPT_DAMAGE);
  } else {
    // No-stakes action: it simply happens. No roll, no failure cost — the GM
    // still narrates the outcome (the request layer replaces the line below with
    // real GM prose), it just isn't gated on a dice result.
    success = true;
  }

  const baseNarration = success ? providerOutput.successNarration : providerOutput.failureNarration;
  // Never leave a turn silent (FIX K, code half): if the provider narration is
  // empty, fall back to an intent-aware outcome line. The live attempt provider
  // always fills these, but a thin custom provider might not — and a no-roll
  // action must still narrate. Echoing the intent keeps the line from reading as
  // "nothing happened" in degraded mode.
  const phrase = intentPhrase(context.intent);
  const narration = isString(baseNarration)
    ? baseNarration
    : (success ? `You ${phrase}.` : `You try to ${phrase}, but it doesn't come together this time.`);
  const attemptResult = {
    intent: safeAction.intent,
    targetId: safeAction.targetId || null,
    success,
    summary: providerOutput.summary,
    checkResult,
    // Whether a d20 was rolled this turn. The client uses this to show the
    // "vs DC" result only for contested actions (null checkResult == narrative).
    needsCheck,
    narration,
    warnings: providerResult.warnings,
    proposedEffects: providerOutput.proposedEffects || [],
    damage
  };

  const memoryEffect = (providerOutput.proposedEffects || []).find((effect) => effect.type === "memory_fact" && isString(effect.text));
  const memoryFact = memoryEffect ? createAttemptMemoryFact(updatedRun, safeAction, attemptResult, memoryEffect, options) : null;
  if (memoryFact) {
    updatedRun.memoryFacts.push(memoryFact);
  }

  const event = createAttemptTimelineEvent(updatedRun, safeAction, attemptResult, memoryFact, options);
  updatedRun.timeline.push(event);
  updatedRun.updatedAt = isoFromOption(options.now ?? safeAction.createdAt);

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
