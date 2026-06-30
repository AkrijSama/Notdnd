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
  "proposedEffects",
  // MEANINGFUL FAILURE: a STRUCTURED consequence the GM proposes for a failed
  // (or partial) check, which the server makes REAL. See FAILURE_CONSEQUENCE_*.
  "failureConsequence",
  // POSSESSION CLAIM: when an action RELIES ON a specific item the player claims
  // to carry, the interpreter flags it here ({ name, specific }); the SERVER then
  // verifies possession against real inventory. See resolvePossessionClaim.
  "requiredItem"
]);
const ALLOWED_EFFECT_TYPES = new Set(["timeline_event", "memory_fact", "narration", "damage"]);

// ---------------------------------------------------------------------------
// MEANINGFUL FAILURE CONSEQUENCES — the GM adjudicates WHAT happens on a failed
// check (a structured proposal, NOT free text); the server ENFORCES it as real,
// persistent state so narration and mechanics never diverge. "none" is valid and
// EXPECTED: many failures are just a beat (a failed perception in an empty room),
// so we do NOT force a penalty on every failure — the GM decides per-case.
//
// Consequence shape (additive on the attempt provider output):
//   {
//     type:        "none"|"damage"|"condition"|"objectState"|"resource",
//     amount:      <number>      // damage / resource
//     condition:   <id/name>     // condition
//     targetObject:<id/label>    // objectState — what degraded (the map, the lock)
//     objectState: "torn"|"jammed"|"broken"|"degraded"|...  // objectState
//     retryEffect: "none"|"harder"|"blocked"   // objectState retry foreclosure
//     resource:    <name>        // resource (hp/mp/stamina/time)
//     reason:      <short why>   // grounds the prose; agrees with the mutation
//   }
const FAILURE_CONSEQUENCE_TYPES = new Set(["none", "damage", "condition", "objectState", "resource"]);
const OBJECT_RETRY_EFFECTS = new Set(["none", "harder", "blocked"]);
export const FAILURE_CONSEQUENCE_TYPE_VALUES = [...FAILURE_CONSEQUENCE_TYPES];
export const OBJECT_RETRY_EFFECT_VALUES = [...OBJECT_RETRY_EFFECTS];

// Retry foreclosure tuning: a "harder" re-attempt on a degraded object raises the
// DC by this much (and rolls at disadvantage); a "blocked" object can't be
// re-attempted via the same approach at all (auto-fail, no fresh consequence).
const RETRY_DC_BUMP = 5;

// Minimal failure-cost mechanic (not full combat): a failed attempt costs the
// player a small, fixed amount of HP. This is the LEGACY default applied ONLY
// when the provider proposes NO structured consequence (degraded mode / thin
// providers) — when the GM proposes one, the server enforces exactly that
// (including "none" = no mechanical cost). Kept deterministic on purpose.
const FAILED_ATTEMPT_DAMAGE = 2;

// Lowercase slug for object/condition ids: alphanumerics + single dashes.
function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

// Stopwords stripped when deriving an object's match tokens from intent text, so
// "examine the torn map" tokenizes to ["torn","map"], not the verb/article noise.
const OBJECT_STOPWORDS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "with", "at", "to", "on", "in", "of", "for", "and",
  "examine", "inspect", "read", "study", "look", "search", "open", "pry", "force", "pick", "use", "try",
  "again", "more", "my", "your", "his", "her", "their", "it", "into", "from", "over", "under"
]);

// Meaningful word-tokens (len>=3, not stopwords) used to recognize a later
// attempt as targeting the SAME degraded object (retry foreclosure matching).
function objectTokens(text) {
  return [...new Set(
    String(text || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !OBJECT_STOPWORDS.has(word))
  )];
}

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
      proposedEffects: [],
      // MEANINGFUL FAILURE: on a failed (or partial) check, propose the SINGLE
      // structured consequence that best FITS the fiction — the server makes it
      // real and persistent. type "none" is valid and expected: many failures
      // should have NO mechanical cost (a missed perception in an empty room is
      // just a beat). Only propose damage/condition/objectState/resource when the
      // fiction earns it. Set objectState + retryEffect when failure should
      // FORECLOSE retrying the same object (a torn map, a jammed lock); leave it
      // off when re-attempting should stay open. `reason` must agree with your
      // failureNarration so prose and mechanics never diverge.
      failureConsequence: {
        type: FAILURE_CONSEQUENCE_TYPE_VALUES.join("|"),
        amount: "number|null",
        condition: "string|null",
        targetObject: "string|null",
        objectState: "string|null",
        retryEffect: OBJECT_RETRY_EFFECT_VALUES.join("|"),
        reason: "string|null"
      },
      // POSSESSION: if (and only if) the action RELIES ON the player already
      // carrying a SPECIFIC item they claim to have (a named key, a particular
      // vial, a specific document), name it here with specific:true — the SERVER
      // verifies they truly hold it and fails the action if they do not. For
      // generic/improvised gear the fiction plausibly provides (a rock, a torch
      // from a rag, a stick) set requiredItem null. When unsure, set null — do NOT
      // flag ordinary improvisation.
      requiredItem: { name: "string", specific: "boolean" }
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

  if (output.failureConsequence !== undefined && output.failureConsequence !== null) {
    const fc = output.failureConsequence;
    if (!isPlainObject(fc)) {
      push(errors, "failureConsequence", "Expected object");
    } else {
      if (!FAILURE_CONSEQUENCE_TYPES.has(fc.type)) {
        push(errors, "failureConsequence.type", "Unsupported consequence type");
      }
      if ((fc.type === "damage" || fc.type === "resource") && fc.amount !== undefined && fc.amount !== null) {
        if (!isNumber(fc.amount) || fc.amount < 0 || fc.amount > 999) {
          push(errors, "failureConsequence.amount", "Expected number from 0 to 999");
        }
      }
      if (fc.type === "condition" && !isString(fc.condition)) {
        push(errors, "failureConsequence.condition", "Expected non-empty condition id/name");
      }
      if (fc.type === "objectState" && !isString(fc.objectState)) {
        push(errors, "failureConsequence.objectState", "Expected non-empty objectState");
      }
      if (fc.type === "resource" && !isString(fc.resource)) {
        push(errors, "failureConsequence.resource", "Expected non-empty resource name");
      }
      if (fc.retryEffect !== undefined && fc.retryEffect !== null && !OBJECT_RETRY_EFFECTS.has(fc.retryEffect)) {
        push(errors, "failureConsequence.retryEffect", "Expected none|harder|blocked");
      }
    }
  }

  if (output.requiredItem !== undefined && output.requiredItem !== null) {
    const ri = output.requiredItem;
    if (!isPlainObject(ri)) {
      push(errors, "requiredItem", "Expected object");
    } else {
      if (!isString(ri.name)) {
        push(errors, "requiredItem.name", "Expected non-empty item name");
      }
      if (ri.specific !== undefined && typeof ri.specific !== "boolean") {
        push(errors, "requiredItem.specific", "Expected boolean");
      }
    }
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

// Normalizes a GM-proposed failure consequence to its canonical, sanitized shape.
// null/undefined → null (caller distinguishes "omitted" from "explicit none" by
// whether the key is present on the raw output). Unknown type collapses to "none".
function normalizeFailureConsequence(fc) {
  if (!isPlainObject(fc) || !FAILURE_CONSEQUENCE_TYPES.has(fc.type)) {
    return { type: "none" };
  }
  const reason = isString(fc.reason) ? sanitizeText(fc.reason) : "";
  if (fc.type === "damage") {
    return { type: "damage", amount: isNumber(fc.amount) && fc.amount >= 0 ? Math.round(fc.amount) : null, reason };
  }
  if (fc.type === "condition") {
    return { type: "condition", condition: isString(fc.condition) ? sanitizeText(fc.condition) : "", reason };
  }
  if (fc.type === "objectState") {
    return {
      type: "objectState",
      targetObject: isString(fc.targetObject) ? sanitizeText(fc.targetObject) : "",
      objectState: isString(fc.objectState) ? sanitizeText(fc.objectState) : "degraded",
      retryEffect: OBJECT_RETRY_EFFECTS.has(fc.retryEffect) ? fc.retryEffect : "none",
      reason
    };
  }
  if (fc.type === "resource") {
    return {
      type: "resource",
      resource: isString(fc.resource) ? sanitizeText(fc.resource).toLowerCase() : "",
      amount: isNumber(fc.amount) && fc.amount >= 0 ? Math.round(fc.amount) : 1,
      reason
    };
  }
  return { type: "none", reason };
}

export function sanitizeAttemptProviderOutput(output, options = {}) {
  const sanitized = {
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
  // Preserve the distinction between "provider omitted a consequence" (legacy
  // default fixed damage applies) and "provider explicitly proposed one"
  // (server enforces exactly that, including an explicit "none" = no cost).
  if (output && typeof output === "object" && "failureConsequence" in output) {
    sanitized.failureConsequence = normalizeFailureConsequence(output.failureConsequence);
  }
  // Possession claim: normalize to { name, specific } or null. Default specific to
  // FALSE (fail open) so an under-specified flag never blocks — only an explicit
  // specific:true claim of a named item can be refused for absence.
  if (output && typeof output === "object" && "requiredItem" in output) {
    const ri = output.requiredItem;
    sanitized.requiredItem = isPlainObject(ri) && isString(ri.name)
      ? { name: sanitizeText(ri.name), specific: ri.specific === true }
      : null;
  }
  return sanitized;
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
      damage: attemptResult.damage || null,
      consequence: attemptResult.consequence || null,
      foreclosed: attemptResult.foreclosed === true
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

// --- Structured consequence enforcement ------------------------------------
// The server turns the GM's proposed consequence into REAL, persistent state.
// All helpers mutate the (already-cloned) run in place and return a record that
// is surfaced on attemptResult.consequence so narration + UI agree with state.

function currentLocation(run) {
  const locations = isPlainObject(run?.locations) ? run.locations : {};
  return locations[run?.currentLocationId] || null;
}

// Resolves the stable object key + human label + match tokens for the object a
// consequence acts on: the GM's targetObject when given, else the salient nouns
// of the player's intent. The key is what we persist degraded state under; the
// tokens are how a later attempt is recognized as targeting the SAME object.
function deriveObjectIdentity(context, spec) {
  const labelSource = isString(spec?.targetObject) ? spec.targetObject : "";
  const tokensFromLabel = objectTokens(labelSource);
  const tokensFromIntent = objectTokens(context?.intent);
  const tokens = (tokensFromLabel.length ? tokensFromLabel : tokensFromIntent).slice(0, 6);
  const label = labelSource || tokens.join(" ") || "it";
  const objectId = slugify(labelSource || tokens.join("-") || context?.intent || "object") || "object";
  return { objectId, label, matchTokens: tokens };
}

// Marks the acted-on object/feature with its degraded state on the current
// location's free-form flags.objectStates map (an EXISTING persisted, validated
// contract field — location.flags is validated as a plain object with free
// contents; see schema.validateLocation). Persisted ⇒ remembered across reloads.
function markObjectDegraded(run, context, spec, now) {
  const location = currentLocation(run);
  if (!location) {
    return null;
  }
  if (!isPlainObject(location.flags)) {
    location.flags = {};
  }
  if (!isPlainObject(location.flags.objectStates)) {
    location.flags.objectStates = {};
  }
  const identity = deriveObjectIdentity(context, spec);
  const retryEffect = OBJECT_RETRY_EFFECTS.has(spec.retryEffect) ? spec.retryEffect : "none";
  const entry = {
    objectId: identity.objectId,
    label: identity.label,
    state: isString(spec.objectState) ? spec.objectState : "degraded",
    retryEffect,
    reason: isString(spec.reason) ? spec.reason : "",
    matchTokens: identity.matchTokens,
    sourceIntent: isString(context?.intent) ? context.intent : "",
    since: now
  };
  location.flags.objectStates[identity.objectId] = entry;
  return entry;
}

// Pre-roll retry foreclosure: scans the current location's degraded objects for
// one this attempt re-targets (any match token present as a word in the intent)
// that carries a retry penalty. "blocked" wins over "harder". Returns the matched
// entry + effect, or { effect:"none" } when this attempt forecloses nothing — so
// a failed check with no degraded object stays freely retryable.
export function resolveRetryForeclosure(run, context) {
  const location = currentLocation(run);
  const states = location && isPlainObject(location.flags?.objectStates) ? location.flags.objectStates : null;
  if (!states) {
    return { effect: "none", object: null };
  }
  const words = new Set(objectTokens(context?.intent));
  let harderMatch = null;
  for (const entry of Object.values(states)) {
    if (!isPlainObject(entry) || !Array.isArray(entry.matchTokens) || entry.retryEffect === "none" || !entry.retryEffect) {
      continue;
    }
    const hit = entry.matchTokens.some((token) => words.has(token));
    if (!hit) {
      continue;
    }
    if (entry.retryEffect === "blocked") {
      return { effect: "blocked", object: entry };
    }
    if (entry.retryEffect === "harder" && !harderMatch) {
      harderMatch = entry;
    }
  }
  return harderMatch ? { effect: "harder", object: harderMatch } : { effect: "none", object: null };
}

// Adds a condition to player.conditions (contract array of { id, name }), idempotent
// by id so the same failed check can't stack duplicates. Returns the entry or null.
function addPlayerCondition(run, name) {
  const player = run?.player;
  if (!isPlainObject(player)) {
    return null;
  }
  if (!Array.isArray(player.conditions)) {
    player.conditions = [];
  }
  const id = slugify(name) || "condition";
  const displayName = isString(name) ? name : id;
  const existing = player.conditions.find((entry) => isPlainObject(entry) && entry.id === id);
  if (existing) {
    return existing;
  }
  const entry = { id, name: displayName };
  player.conditions.push(entry);
  return entry;
}

// Spends a named resource as a real cost: hp routes through the lethality core;
// mp/mana/stamina drain their gauge; time advances the world clock. Returns a
// record of what was spent (best-effort — an absent gauge spends nothing).
function spendResource(run, resource, amount) {
  const name = String(resource || "").toLowerCase();
  const spend = isNumber(amount) && amount > 0 ? Math.round(amount) : 1;
  if (name === "hp" || name === "health" || name === "hitpoints") {
    const dmg = applyDamage(run, spend);
    return { resource: "hp", amount: dmg ? dmg.amount : 0, damage: dmg };
  }
  if (name === "time" || name === "turn" || name === "turns") {
    if (!isPlainObject(run.world)) {
      run.world = {};
    }
    if (!isPlainObject(run.world.time)) {
      run.world.time = { tick: 0 };
    }
    if (!isNumber(run.world.time.tick)) {
      run.world.time.tick = 0;
    }
    run.world.time.tick += spend;
    return { resource: "time", amount: spend };
  }
  const player = run?.player;
  const gauge = isPlainObject(player?.resources?.[name]) ? player.resources[name] : null;
  if (gauge && isNumber(gauge.current)) {
    const before = gauge.current;
    gauge.current = Math.max(0, before - spend);
    return { resource: name, amount: before - gauge.current };
  }
  return { resource: name, amount: 0 };
}

/**
 * Enforces a GM-proposed structured failure consequence as real state. Mutates
 * the (cloned) run; returns the enforced record surfaced on attemptResult so the
 * narration is grounded in the same mutation. `spec === undefined` means the
 * provider proposed nothing → the LEGACY fixed-damage default keeps failure's
 * teeth in degraded mode. `{ type:"none" }` is an EXPLICIT no-op (consequence-free
 * failure — a beat, not a punishment).
 */
export function enforceFailureConsequence(run, spec, context, now) {
  if (spec === undefined) {
    const damage = applyFailureDamage(run, FAILED_ATTEMPT_DAMAGE);
    return damage
      ? { type: "damage", applied: true, amount: damage.amount, reason: "", damage }
      : { type: "none", applied: false, reason: "" };
  }
  const consequence = isPlainObject(spec) ? spec : { type: "none" };
  const reason = isString(consequence.reason) ? consequence.reason : "";
  switch (consequence.type) {
    case "damage": {
      const amount = isNumber(consequence.amount) && consequence.amount > 0 ? consequence.amount : FAILED_ATTEMPT_DAMAGE;
      const damage = applyDamage(run, amount);
      return { type: "damage", applied: Boolean(damage), amount: damage ? damage.amount : 0, reason, damage };
    }
    case "condition": {
      const entry = addPlayerCondition(run, consequence.condition);
      return { type: "condition", applied: Boolean(entry), condition: entry ? entry.name : consequence.condition, conditionId: entry ? entry.id : null, reason };
    }
    case "objectState": {
      const entry = markObjectDegraded(run, context, consequence, now);
      return entry
        ? { type: "objectState", applied: true, object: entry.objectId, label: entry.label, objectState: entry.state, retryEffect: entry.retryEffect, reason: reason || entry.reason }
        : { type: "objectState", applied: false, reason };
    }
    case "resource": {
      const spent = spendResource(run, consequence.resource, consequence.amount);
      return { type: "resource", applied: spent.amount > 0, resource: spent.resource, amount: spent.amount, reason, damage: spent.damage || null };
    }
    default:
      return { type: "none", applied: false, reason };
  }
}

// ---------------------------------------------------------------------------
// IMPOSSIBILITY / AUTHORITY GATE — the coherence moat.
//
// A player's stated INTENT is classified BEFORE any d20. Most intents are
// LEGITIMATE and roll normally — including audacious, reckless, doomed ones (a
// suicidal climb, a desperate bluff, attacking something far stronger). Those
// MUST still roll and be allowed to fail, lethally; gating them would build the
// tyrant GM, which is as bad as the pushover. Only a narrow class is REFUSED
// pre-roll: reality-breaking / authority-by-fiat / summon-from-nothing /
// retconned-ownership / power one does not have. For those the world simply does
// NOT comply — no roll, no success (a forced nat-20 can't make it land), no state
// change. Server-OWNED and FAILS OPEN: anything not clearly impossible defaults
// to "legitimate", so an edge case is allowed rather than tyrannized.
//
// The distinction is impossible-in-principle vs audacious-but-possible:
//   gated    : "command reality to obey", "I am a god", "summon an army from
//              nothing", "my legendary sword I've always owned", "all kneel to me"
//   allowed  : "climb the deadly cliff", "bluff the guard I'm a noble", "pick the
//              lock", "intimidate the king", "tell the guard I am a god" (a LIE —
//              a deception attempt that can fail; the NPC need not believe it)
const GATED_CATEGORIES = new Set([
  "reality_command", "self_deification", "summon_from_nothing", "retcon_possession", "self_authority",
  // Added classes (close the 18 documented moat leaks):
  "time_manipulation",     // (A) stopping/reversing time, commanding natural forces
  "retcon_history",        // (B) asserting past world events as already-true by fiat
  "npc_relationship_fiat"  // (C) declaring an NPC bond/promise/debt to compel compliance
  // (D) self-granted identity/authority commanding mass obedience reuses self_authority.
]);
// Physics-impossible categories: refused REGARDLESS of framing — you cannot
// "deceive" reality (or time) or roll a check to bend it.
const PHYSICS_GATED = new Set(["reality_command", "summon_from_nothing", "time_manipulation"]);

// Commanding/bending reality, the world, time, the universe, the laws of nature.
const REALITY_COMMAND_RE = /\b(reality|the world|the universe|time itself|the laws of (?:nature|physics)|the fabric of (?:reality|the world|space))\b[\s\S]{0,45}\b(obey|obeys|bend|bends|bow|comply|complies|rewrite|rewrites|reshape|reshapes|warp|warps|kneel|stop|stops|freeze|freezes|unmake|unmakes|to my will|to my command)\b/i;
const REALITY_COMMAND_RE2 = /\b(command|will|order|force|make|compel|bend)\b[\s\S]{0,30}\b(reality|the world|the universe|time|nature|existence)\b[\s\S]{0,25}\b(to\s+)?(obey|bend|comply|kneel|change|stop|freeze|submit|yield)\b/i;
// Summoning matter / allies from nothing, or at flatly impossible scale.
const SUMMON_FROM_NOTHING_RE = /\b(summon|conjure|materialize|manifest|spawn|create|will into existence|pull|wish)\b[\s\S]{0,45}\b(army|armies|legion|legions|horde|navy|fleet|dragon|dragons|out of (?:thin air|nothing)|from (?:thin air|nothing|the void|nowhere)|into existence|into being)\b/i;
// Declaring oneself a god / omnipotent (claiming the POWER, not lying about it).
const SELF_DEIFICATION_RE = /\b(declare|proclaim|crown|make|become|turn)\b[\s\S]{0,25}\b(myself|me|into)\b[\s\S]{0,18}\b(a\s+|the\s+)?(god|goddess|deity|divine being|god-?king|god-?queen|omnipotent|all-?powerful|immortal (?:god|sovereign|ruler))\b/i;
const I_AM_GOD_RE = /\bi\s+am\s+(?:now\s+)?(?:a\s+|the\s+)?(god|goddess|deity|divine being|god-?king|omnipotent|all-?powerful|immortal god)\b/i;
const ASCEND_GODHOOD_RE = /\bascend(?:ing|s)?\b[\s\S]{0,25}\b(godhood|divinity|to\s+(?:a\s+)?god|to\s+a\s+higher\s+plane)\b/i;
// Retconned legendary loot: a powerful item asserted as already-owned.
const LEGENDARY_ITEM_RE = /\b(legendary|fabled|ancient|mythic|mythical|divine|godly|holy|cursed|enchanted|magical|named)\b[\s\S]{0,28}\b([a-z]*sword|blade|weapon|axe|spear|bow|staff|wand|armou?r|shield|amulet|ring|artifact|relic|crown|gauntlet|warhammer|hammer|dagger|mace|glaive|halberd)\b/i;
const ALWAYS_OWNED_RE = /\b(always\s+(?:owned|had|carried|possessed|kept)|i'?ve\s+always|that\s+i\s+(?:have\s+)?always|i\s+have\s+always|that\s+i\s+(?:secretly\s+)?own|hidden\s+(?:in|under)\s+my|from\s+my\s+(?:pack|cloak|belt)|my\s+own\s+(?:trusty|faithful)?)\b/i;
// Granting oneself rulership and mass obedience by fiat.
const SELF_AUTHORITY_RE = /\b(declare|proclaim|crown|name|appoint)\b[\s\S]{0,20}\b(myself|me)\b[\s\S]{0,28}\b(king|queen|emperor|empress|ruler|overlord|sovereign|lord|master|god-?king|chosen one|the law|in charge)\b/i;
const MASS_OBEY_RE = /\b(everyone|everybody|all|they all|the (?:world|land|realm|kingdom|city|town|guards?|guardsmen|people|crowd|army|masses|garrison|soldiers?|men)|all who hear)\b[\s\S]{0,26}\b(must\s+)?(obey|obeys|bow|bows|kneel|kneels|serve|serves|submit|submits|worship|worships|wave\s+me|let\s+me\s+(?:in|through|pass)|fall\s+in\s+line|falls\s+in\s+line|stand\s+(?:down|aside)|make\s+way|defer)\b/i;
const AUTHORITY_OVER_RE = /\b(of|over)\b[\s\S]{0,16}\b(the\s+(?:world|land|realm|kingdom|city|town|people|nation)|all\b|everything|reality|creation)\b/i;

// ── Class A — time / natural-force manipulation (PHYSICS; gated regardless of
// speech: you cannot stop time or command the sun by talking about it). The
// matched legal near-neighbor ("stop the bleeding", "halt the soldiers") names no
// temporal/celestial object, so it never matches.
const TIME_MANIP_RE = /\b(stop|stops|stopping|freeze|freezes|freezing|halt|halts|halting|rewind|rewinds|reverse|reverses|reversing|turn\s+back|turning\s+back|wind\s+back|pause|pauses)\b[\s\S]{0,20}\b(time|the\s+clock|the\s+hands\s+of\s+time|the\s+flow\s+of\s+time)\b/i;
const TIME_MANIP_RE2 = /\b(time|the\s+clock)\b[\s\S]{0,15}\b(stops?|stand(?:s|ing)?\s+still|freezes?|halts?|rewinds?|reverses?)\b/i;
const GRAVITY_RE = /\bgravity\b[\s\S]{0,20}\b(revers\w+|stop\w*|fail\w*|ceas\w*|lets?\s+go|releases?|no\s+longer|disappear\w*|vanish\w*|invert\w*)\b/i;
const NATURAL_FORCE_RE = /\b(the\s+sun|the\s+moon|the\s+stars?|the\s+sky|the\s+tide|the\s+tides|the\s+wind|the\s+winds|the\s+storm|the\s+storms|the\s+rain|the\s+river|the\s+rivers|the\s+sea|the\s+seas|the\s+ocean|the\s+earth|the\s+ground|the\s+flames?|the\s+fire|the\s+mountains?|the\s+clouds?|the\s+waters?)\b[\s\S]{0,25}\b(halt\w*|stops?|stand\s+still|stills?|freez\w*|parts?|splits?|revers\w*|bends?|obeys?|ceas\w*|calms?|bows?|kneels?|rises?|falls?|opens?)\b/i;
const PLAYER_WILL_RE = /\b(at\s+my\s+(?:word|will|command|behest|bidding)|because\s+i\s+(?:command|will|say|wish|order)|by\s+my\s+(?:will|command|word)|i\s+(?:command|will|order|bid)\b)/i;

// ── Class B — retconning world history / past events as already-true by fiat.
const HISTORY_REWRITE_RE = /\b(rewrit\w+|rewrote|eras\w+|undo\w*|undid|alter\w*|chang\w+|unmak\w+)\b[\s\S]{0,20}\b(history|the\s+past|past\s+events|the\s+timeline|what\s+(?:happened|came\s+before))\b/i;
const NEVER_HAPPENED_RE = /\b(never\s+(?:happened|occurred|took\s+place|existed|was\s+real)|did(?:\s+not|n'?t)\s+happen|was\s+never\s+(?:destroyed|built|barred|killed|broken|sealed|locked|lost|fought|waged|raised)|were\s+never\s+(?:barred|sealed|locked|broken|built|destroyed|raised))\b/i;
const PAST_DEED_BROADCAST_RE = /\b(as\s+everyone\s+knows|everyone\s+knows|as\s+you\s+(?:all\s+)?know|it\s+is\s+known|history\s+records|the\s+legends?\s+(?:say|tell)|famously|as\s+is\s+well\s+known)\b[\s\S]{0,40}\bi\b[\s\S]{0,15}\b(already\s+)?(slew|slayed|slain|killed|defeated|vanquished|conquered|destroyed|saved|founded|built|won|ended)\b/i;
const EPIC_PAST_DEED_RE = /\bi\s+(?:have\s+)?already\s+(slew|slayed|slain|vanquished|conquered)\b/i;

// ── Class C — declaring an NPC relationship / promise / debt to COMPEL compliance.
// Requires BOTH a fiat bond assertion AND a compliance/entitlement clause, so a
// bare mention ("the merchant promised me a discount") or a request ("ask the
// guard to let me through") never gates.
const RELATIONSHIP_IS_RE = /\b(the\s+(?:king|queen|captain|guard|guards|lord|lady|duke|duchess|baron|count|countess|priest|priestess|mayor|general|chief|warden|commander|prince|princess|emperor|empress|knight|sergeant|innkeeper|merchant|magistrate)|he|she|they)\b[\s\S]{0,12}\b(?:is|are)\s+my\s+(brother|sister|father|mother|son|daughter|kin|family|cousin|uncle|aunt|friend|ally|servant|liege|vassal|debtor|sworn\s+\w+)\b/i;
const PROMISE_FIAT_RE = /\b(?:the\s+\w+|he|she|they)\b[\s\S]{0,25}\b(promised|owes?|owe|granted|grants|vowed|pledged|guaranteed|assured)\b[\s\S]{0,15}\b(me|us)\b/i;
const OATH_FIAT_RE = /\b(you\s+and\s+i|we\s+two|we)\b[\s\S]{0,20}\b(swore|sworn|made|sealed|took|share)\b[\s\S]{0,20}\b(oath|blood-?oath|pact|vow|deal|pledge|bargain|bond)\b/i;
const COMPLIANCE_RE = /\b(so\s+(?:you|i|they|he|she)\s+(?:must|will|shall|can|take|get)|you\s+must\s+(?:help|let|give|aid|obey|serve|stand)|will\s+let\s+me|let\s+me\s+(?:through|in|pass)|has\s+granted\s+me|have\s+granted\s+me|so\s+i\s+take|i\s+take\s+(?:the|what|my)|wave\s+me\s+(?:in|through)|stand\s+aside|step\s+aside|hand\s+(?:it|them|the)\s+over)\b/i;

// ── Class D — self-granted identity / title commanding mass obedience (extends
// self_authority). IDENTITY_CLAIM + (mass obedience | commanding a body of troops).
const IDENTITY_CLAIM_RE = /\b(i\s+am|i'?m|i\s+have\s+always\s+been|i'?ve\s+always\s+been|i\s+was\s+always|i\s+reveal\s+(?:that\s+)?i\s+am|i\s+am\s+secretly|as\s+the\s+(?:rightful\s+|true\s+)?|(?:everyone|they)\s+(?:all\s+)?(?:recognizes?|recognize|knows?|hails?|accepts?)\s+me\s+as|they\s+call\s+me)\b[\s\S]{0,20}\b(the\s+)?(rightful\s+|true\s+|long-?lost\s+)?(heir|king|queen|emperor|empress|baron|baroness|duke|duchess|count|countess|lord|lady|ruler|sovereign|monarch|prince|princess|chosen\s+one|high\s+priest|priestess|guildmaster|chieftain|warlord|messiah|prophet)\b/i;
const COMMAND_FORCE_RE = /\bi\s+command\b[\s\S]{0,15}\b(the\s+)?(garrison|guards?|army|armies|soldiers?|men|troops|watch|militia|legion|knights?|guardsmen)\b/i;
// Obeisance to the player, distance-independent (the subject may be far upstream).
const OBEISANCE_RE = /\b(kneels?|bows?|grovels?|bow\s+down|kneel\s+down)\s+(?:down\s+)?(?:before|to)\s+me\b/i;
// Speech framing — the player is COMMUNICATING a claim (a lie/bluff/boast) to
// someone. Then a fiat power/authority/possession claim becomes a legitimate
// DECEPTION attempt that can fail, and the NPC-canon guard keeps the listener
// from believing it. Physics-impossibilities are NOT downgraded by speech.
const SPEECH_FRAME_RE = /\b(tell|telling|told|say|saying|said|claim|claiming|claimed|insist|insisting|lie|lying|bluff|bluffing|boast|boasting|brag|bragging|convince|convincing|persuade|persuading|deceive|deceiving|pretend|pretending|announce to|inform)\b/i;

const GATE_REFUSAL = {
  reality_command: "Reality does not bend to your words. The world holds its shape, wholly indifferent to the command — nothing stirs, nothing obeys.",
  self_deification: "You are no god, and the saying of it does not make it so. The words ring out, die in the still air, and nothing answers them.",
  summon_from_nothing: "Nothing answers the call. No blade, no ally, no host steps out of the empty air — there is only you, and what you truly carry.",
  retcon_possession: "Your hand closes on nothing. You have never owned such a thing, and wishing it into your grip does not put it there.",
  self_authority: "You claim a power no one granted you. The world owes you no obedience, and gives none — your words land on deaf stone.",
  time_manipulation: "Time does not heed you. The clock runs on and the world keeps its motion — nothing freezes, nothing rewinds, no force halts at your word.",
  retcon_history: "What is done is done. The past does not rearrange itself to suit your telling — it stands as it happened, indifferent to the claim.",
  npc_relationship_fiat: "No such bond answers for you. They owe you nothing they have not truly given, and your say-so binds no one — the claim hangs unproven in the air.",
  default: "The world does not yield to the claim. Nothing rearranges itself to agree with you — it was never yours to declare."
};

function gateRefusal(category) {
  return GATE_REFUSAL[category] || GATE_REFUSAL.default;
}

/**
 * Classifies a player intent BEFORE any roll. Returns
 * { verdict: "legitimate"|"impossible", category, reason }. Pure + deterministic
 * (the server owns the decision); fails OPEN — anything not clearly impossible is
 * "legitimate". An optional advisory classifier (options.intentGateFn) may add a
 * verdict, but the server re-validates it against the same rubric (a known gated
 * category, and — for fiat categories — no speech framing) before honoring it, so
 * the model never unilaterally tyrannizes a legitimate action.
 */
export function classifyIntentAuthority(intent, options = {}) {
  const text = String(intent || "").toLowerCase();
  if (!text.trim()) {
    return { verdict: "legitimate", category: null, reason: "" };
  }
  const impossible = (category) => ({ verdict: "impossible", category, reason: gateRefusal(category) });

  // Physics-impossible: refused regardless of framing.
  if (REALITY_COMMAND_RE.test(text) || REALITY_COMMAND_RE2.test(text)) {
    return impossible("reality_command");
  }
  if (SUMMON_FROM_NOTHING_RE.test(text)) {
    return impossible("summon_from_nothing");
  }
  // (A) Time / natural-force manipulation — also physics, gated regardless of
  // framing. Commanding a natural force gates only WITH a player-will marker, so
  // "I wait for the rain to stop" stays legitimate.
  if (TIME_MANIP_RE.test(text) || TIME_MANIP_RE2.test(text) || GRAVITY_RE.test(text) || (NATURAL_FORCE_RE.test(text) && PLAYER_WILL_RE.test(text))) {
    return impossible("time_manipulation");
  }

  // Fiat claims of power / authority / possession / history / relationships:
  // refused UNLESS framed as speech to someone (then it's a bluff → a legitimate
  // deception attempt that can fail, and the NPC-canon guard handles belief).
  const speech = SPEECH_FRAME_RE.test(text);
  if (!speech) {
    if (I_AM_GOD_RE.test(text) || ASCEND_GODHOOD_RE.test(text) || SELF_DEIFICATION_RE.test(text)) {
      return impossible("self_deification");
    }
    if (LEGENDARY_ITEM_RE.test(text) && ALWAYS_OWNED_RE.test(text)) {
      return impossible("retcon_possession");
    }
    // (D) self-granted identity/title OR an explicit self-authority declaration,
    // when it commands mass obedience or a body of troops.
    if (
      (SELF_AUTHORITY_RE.test(text) || IDENTITY_CLAIM_RE.test(text)) &&
      (MASS_OBEY_RE.test(text) || AUTHORITY_OVER_RE.test(text) || COMMAND_FORCE_RE.test(text) || OBEISANCE_RE.test(text))
    ) {
      return impossible("self_authority");
    }
    // (B) retconning world history / past events as already-true by fiat.
    if (HISTORY_REWRITE_RE.test(text) || NEVER_HAPPENED_RE.test(text) || PAST_DEED_BROADCAST_RE.test(text) || EPIC_PAST_DEED_RE.test(text)) {
      return impossible("retcon_history");
    }
    // (C) declaring an NPC relationship/promise/debt to COMPEL compliance.
    if ((RELATIONSHIP_IS_RE.test(text) || PROMISE_FIAT_RE.test(text) || OATH_FIAT_RE.test(text)) && COMPLIANCE_RE.test(text)) {
      return impossible("npc_relationship_fiat");
    }
  }

  // Advisory model classifier — re-validated by the server; fails open.
  if (typeof options.intentGateFn === "function") {
    try {
      const verdict = options.intentGateFn({ intent: text });
      if (verdict && verdict.verdict === "impossible" && GATED_CATEGORIES.has(verdict.category)) {
        const physics = PHYSICS_GATED.has(verdict.category);
        if (physics || !speech) {
          return { verdict: "impossible", category: verdict.category, reason: isString(verdict.reason) ? verdict.reason : gateRefusal(verdict.category) };
        }
      }
    } catch {
      // Classifier failure → fail open (allow the action).
    }
  }

  return { verdict: "legitimate", category: null, reason: "" };
}

// Builds the refused-attempt result for a gated intent: NO roll, NO success, NO
// state mutation — only a grounded in-fiction refusal and a timeline beat. The run
// is unchanged but for the event (no HP, no item, no canon shift).
function buildGatedAttempt(run, action, context, authority, options = {}) {
  const now = isoFromOption(options.now ?? action.createdAt);
  const attemptResult = {
    intent: action.intent,
    targetId: action.targetId || null,
    success: false,
    summary: `You attempt: ${context.intent}`,
    checkResult: null,
    // No dice were rolled — the world refused before any check.
    needsCheck: false,
    narration: isString(authority.reason) ? authority.reason : gateRefusal(authority.category),
    warnings: ["ATTEMPT_GATED"],
    proposedEffects: [],
    damage: null,
    // A "refused" consequence: nothing was enforced on the run; it documents WHY
    // the world did not comply so the GM prose can be grounded in the refusal.
    consequence: { type: "refused", applied: false, category: authority.category, reason: authority.reason || "" },
    foreclosed: false,
    // Pre-roll gate flags — the request layer keys grounded-refusal narration off
    // these, and the client can style the beat as the world not complying.
    gated: true,
    gateCategory: authority.category
  };
  const event = createAttemptTimelineEvent(run, action, attemptResult, null, options);
  run.timeline.push(event);
  run.updatedAt = now;
  const finalValidation = validateSoloRun(run);
  if (!finalValidation.ok) {
    return {
      ok: false,
      errors: finalValidation.errors.map((error) => ({ path: `run.${error.path}`, message: error.message }))
    };
  }
  return {
    ok: true,
    run,
    event,
    memoryFact: null,
    attemptResult,
    attemptContext: context,
    providerInput: null,
    providerErrors: [],
    errors: []
  };
}

// ---------------------------------------------------------------------------
// POSSESSION STATE-CHECK — the ambiguous-possession class the authority gate
// deliberately leaves fail-open. The classifier cannot tell "the brass key I
// found" (legitimate) from "the brass key I've always carried" (retconned) by
// TEXT — it depends on whether the player ACTUALLY HOLDS the item. So the model
// (attempt interpreter) FLAGS that an action relies on a specific claimed item
// (providerOutput.requiredItem), and the SERVER verifies possession against real
// inventory + run-state. Possessed → proceed; specifically claimed-but-absent →
// the claim fails (no roll, no success, the item does not materialize). Fails
// OPEN: only an explicit specific claim that matches NOTHING the player holds is
// refused; generic/improvised gear and any plausible match proceed.

// Stopwords stripped when reducing a claimed item to its salient content words,
// so "the brass key I've always carried" → ["brass","key"].
const ITEM_STOPWORDS = new Set([
  "the", "a", "an", "my", "mine", "his", "her", "their", "your", "our", "with", "from", "of", "in",
  "on", "to", "i", "ive", "i've", "have", "always", "carried", "carry", "kept", "keep", "owned",
  "own", "that", "this", "it", "some", "any", "and", "out", "use", "using", "used", "pull", "draw",
  "produce", "show", "present", "old", "trusty", "faithful", "spare", "little", "small", "good",
  "for", "at", "by", "as", "into", "up", "down", "here", "there", "still", "earlier", "before",
  "secretly", "hidden", "tucked", "pocket", "boot", "cloak", "pack", "belt", "bag", "pouch"
]);
// Generic/improvised gear that should NEVER be refused for absence — the fiction
// plausibly furnishes these, so a claim resting on one stays legitimate.
const GENERIC_ITEM_WORDS = new Set([
  "rock", "stone", "stick", "branch", "rag", "cloth", "rope", "torch", "dirt", "sand", "mud",
  "water", "fire", "wood", "log", "plank", "board", "nail", "string", "twig", "leaf", "ash",
  "snow", "ice", "gravel", "pebble", "debris", "rubble", "bone", "thorn", "vine", "reed", "weed"
]);
// Category nouns name a KIND of item; the DISTINCTIVE qualifier ("brass", "silver
// skeleton") is what identifies the specific one. So a claim with a distinctive
// word must match THAT (holding a brass key doesn't satisfy a "silver skeleton
// key" claim); a bare category claim ("my key") matches any held item of the kind.
const ITEM_CATEGORY_NOUNS = new Set([
  "key", "sword", "blade", "dagger", "knife", "axe", "spear", "bow", "staff", "wand", "vial",
  "potion", "flask", "bottle", "elixir", "draught", "rope", "torch", "lantern", "document",
  "paper", "papers", "letter", "scroll", "map", "deed", "writ", "pass", "token", "coin", "gold",
  "ring", "amulet", "necklace", "cloak", "armor", "shield", "gem", "stone", "crystal", "powder",
  "poison", "antidote", "salve", "herb", "herbs", "tool", "tools", "lockpick", "lockpicks", "pick",
  "picks", "kit", "gloves", "boots", "hat", "mask", "charm", "talisman", "seal", "badge", "medallion"
]);

function itemContentWords(text) {
  return [...new Set(
    String(text || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !ITEM_STOPWORDS.has(word))
  )];
}

// All item names/ids the player demonstrably holds: the persisted run.inventory
// (quantity > 0), the state-contract player.inventory[] mirror, and player assets.
function playerHeldItemTokens(run) {
  const tokens = new Set();
  const add = (text) => {
    for (const word of itemContentWords(text)) {
      tokens.add(word);
    }
  };
  const inv = isPlainObject(run?.inventory) ? Object.values(run.inventory) : [];
  for (const item of inv) {
    if (isPlainObject(item) && (typeof item.quantity !== "number" || item.quantity > 0)) {
      add(item.name);
      add(item.itemId);
    }
  }
  const arr = Array.isArray(run?.player?.inventory) ? run.player.inventory : [];
  for (const entry of arr) {
    if (isPlainObject(entry) && (typeof entry.qty !== "number" || entry.qty > 0)) {
      add(entry.name);
      add(entry.id || entry.itemId);
    }
  }
  const assets = isPlainObject(run?.playerAssets) ? Object.values(run.playerAssets) : [];
  for (const asset of assets) {
    if (isPlainObject(asset)) {
      add(asset.name);
      add(asset.assetId);
    }
  }
  return tokens;
}

/**
 * Verifies a claimed-required item against what the player actually holds.
 * Returns { possessed, refuse, claimWords }. FAIL-OPEN:
 *   - no claim / not flagged specific → refuse:false (proceed).
 *   - the claim is purely generic gear (a rock, a rag) → refuse:false (proceed).
 *   - any salient word of the claim matches a held item → possessed:true (proceed).
 *   - ONLY a specific named item whose every salient word is absent from inventory
 *     → refuse:true (the player does not have it).
 */
export function resolvePossessionClaim(run, requiredItem) {
  if (!isPlainObject(requiredItem) || requiredItem.specific !== true || !isString(requiredItem.name)) {
    return { possessed: false, refuse: false, claimWords: [] };
  }
  const claimWords = itemContentWords(requiredItem.name);
  if (!claimWords.length) {
    return { possessed: false, refuse: false, claimWords };
  }
  // Generic/improvised gear is never refused for absence (anti-tyranny): if the
  // claim names ANY generic/environmental item, the fiction can furnish it.
  if (claimWords.some((word) => GENERIC_ITEM_WORDS.has(word))) {
    return { possessed: false, refuse: false, claimWords };
  }
  const held = playerHeldItemTokens(run);
  // Match on the DISTINCTIVE descriptor when the claim has one (so "silver skeleton
  // key" is NOT satisfied by a held "brass key"); fall back to the category noun
  // only for a bare claim ("my key" matches any held key). Fail-open: any match
  // proceeds; refuse only when nothing the player holds answers the claim.
  const distinctive = claimWords.filter((word) => !ITEM_CATEGORY_NOUNS.has(word));
  const matchWords = distinctive.length ? distinctive : claimWords;
  const possessed = matchWords.some((word) => held.has(word));
  return { possessed, refuse: !possessed, claimWords };
}

// Composes a grounded, in-fiction absence line for a specifically-claimed item the
// player does not hold (never a system error). Pure.
function unpossessedNarration(itemName) {
  const name = isString(itemName) ? itemName.trim() : "the item";
  return `You reach for ${/^(the|a|an|my|your|his|her|their)\b/i.test(name) ? name : `the ${name}`} — and find nothing of the kind on you. It was never in your pack; wishing it there does not make it so.`;
}

// Builds the refused-attempt result when an action depends on a specific item the
// player does NOT possess: NO roll, NO success, NO item materializes — only a
// grounded absence beat. Mirrors buildGatedAttempt (pre-roll, no state mutation).
function buildUnpossessedAttempt(run, action, context, claim, options = {}) {
  const now = isoFromOption(options.now ?? action.createdAt);
  const itemName = isString(claim?.name) ? claim.name : "the item";
  const narration = unpossessedNarration(itemName);
  const attemptResult = {
    intent: action.intent,
    targetId: action.targetId || null,
    success: false,
    summary: `You attempt: ${context.intent}`,
    checkResult: null,
    needsCheck: false,
    narration,
    warnings: ["ATTEMPT_ITEM_UNPOSSESSED"],
    proposedEffects: [],
    damage: null,
    consequence: { type: "refused", applied: false, category: "unpossessed_item", reason: narration, claimedItem: itemName },
    foreclosed: false,
    // Possession-check flags (parallel to the gate's `gated`): the request layer
    // grounds the live narration in the absence, and the client can style it.
    unpossessed: true,
    claimedItem: itemName
  };
  const event = createAttemptTimelineEvent(run, action, attemptResult, null, options);
  run.timeline.push(event);
  run.updatedAt = now;
  const finalValidation = validateSoloRun(run);
  if (!finalValidation.ok) {
    return {
      ok: false,
      errors: finalValidation.errors.map((error) => ({ path: `run.${error.path}`, message: error.message }))
    };
  }
  return {
    ok: true,
    run,
    event,
    memoryFact: null,
    attemptResult,
    attemptContext: context,
    providerInput: null,
    providerErrors: [],
    errors: []
  };
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

  // IMPOSSIBILITY / AUTHORITY GATE (pre-roll). Runs BEFORE the provider call and
  // the d20: reality-breaking, godhood/authority-by-fiat, summon-from-nothing, and
  // retconned-ownership intents are REFUSED outright — no roll, no success (a
  // forced nat-20 can't make them land), no state mutation. Audacious-but-possible
  // actions fall through to a normal, fail-able roll. Fails OPEN (uncertainty →
  // legitimate), so it never tyrannizes bold-but-legal play. This is the seam
  // BEFORE the roll; the failure-consequence engine runs AFTER a failed roll.
  const authority = classifyIntentAuthority(context.intent, options);
  if (authority.verdict === "impossible") {
    return buildGatedAttempt(updatedRun, safeAction, context, authority, options);
  }

  const providerInput = buildAttemptProviderInput(context, options);
  const providerResult = resolveProviderOutput(context, providerInput, options);
  const providerOutput = providerResult.output;

  // POSSESSION STATE-CHECK (pre-roll). When the interpreter flags that the action
  // RELIES ON a specific claimed item, the server verifies possession against real
  // inventory. A specifically-claimed item the player does NOT hold fails outright
  // (no roll, no success, nothing materializes) — closing the possession-retcon
  // leak via STATE, not text. Fails OPEN: generic gear and any plausible match
  // proceed to a normal roll, so legitimate improvisation is never blocked. Runs
  // AFTER the authority gate, BEFORE the roll.
  const possession = resolvePossessionClaim(updatedRun, providerOutput.requiredItem);
  if (possession.refuse) {
    return buildUnpossessedAttempt(updatedRun, safeAction, context, providerOutput.requiredItem, options);
  }

  // Roll gate (FIX H): only genuinely uncertain/contested actions roll a d20.
  // Pure movement/travel/observation resolves narratively — no dice, no "vs DC".
  const needsCheck = attemptNeedsCheck(context.intent, providerOutput);

  const now = isoFromOption(options.now ?? safeAction.createdAt);
  let checkResult = null;
  let success;
  let damage = null;
  let consequence = null;
  let foreclosed = false;
  let blockNarration = null;
  if (needsCheck) {
    // RETRY FORECLOSURE (pre-roll): if this attempt re-targets an object the GM
    // previously degraded with a retry penalty, apply it BEFORE rolling. "blocked"
    // → no roll, auto-fail (the same approach is foreclosed — the map is too torn
    // to read more); "harder" → raise the DC and roll at disadvantage. This fires
    // ONLY for objects the GM marked, so an ordinary failed check (empty-room
    // perception) stays freely retryable, and it closes the spam-retry hole.
    const foreclosure = resolveRetryForeclosure(updatedRun, context);

    if (foreclosure.effect === "blocked") {
      foreclosed = true;
      success = false;
      checkResult = null;
      const obj = foreclosure.object || {};
      blockNarration = isString(obj.reason)
        ? `${obj.reason} — there is no use trying that approach again.`
        : `The ${isString(obj.label) ? obj.label : "way"} is too ${isString(obj.state) ? obj.state : "damaged"} to attempt again.`;
      // A foreclosed retry is a dead end, NOT a fresh wound: no new consequence is
      // enforced (the object is already degraded), so spamming it costs nothing
      // new and gains nothing.
      consequence = {
        type: "retry_foreclosed",
        applied: false,
        object: obj.objectId || null,
        label: obj.label || null,
        objectState: obj.state || null,
        retryEffect: "blocked",
        reason: isString(obj.reason) ? obj.reason : ""
      };
    } else {
      // Never silently auto-succeed an unjudged contested attempt. When the
      // provider omits the ability/skill, fall back to an intent-derived ability
      // (skill-less); when it omits the DC, fall back to an intent-derived DC.
      // Either way we roll a real check, so an attempt can fail even on a thin
      // provider response.
      const recommendation = abilityFromRecommendation(providerOutput.recommendedAbility)
        || { ability: abilityFromIntent(context.intent), skill: null };
      const baseDc = (providerOutput.dc !== null && providerOutput.dc !== undefined)
        ? providerOutput.dc
        : classifyIntentDc(context.intent);
      const harder = foreclosure.effect === "harder";
      const checkDc = harder ? baseDc + RETRY_DC_BUMP : baseDc;
      checkResult = resolveAbilityCheck(updatedRun, {
        checkId: "attempt_check",
        rulesetId: context.rulesetId,
        ability: recommendation.ability,
        skill: recommendation.skill,
        dc: checkDc,
        advantage: providerOutput.advantage === true && !harder,
        disadvantage: providerOutput.disadvantage === true || harder
      }, options);
      success = checkResult.ok === true && checkResult.success === true;
      if (harder) {
        foreclosed = true;
      }
      // Failure has teeth, but the GM decides HOW MUCH: the server enforces the
      // proposed structured consequence (damage/condition/objectState/resource, or
      // an explicit consequence-free "none"). When the provider proposes nothing,
      // the legacy fixed HP cost applies so degraded mode still bites. When the
      // player is ALREADY incapacitated (0 HP / dying), the dying-turn death save
      // is the sole consequence — we don't stack a fresh one here.
      if (!success && !isIncapacitated(updatedRun)) {
        consequence = enforceFailureConsequence(updatedRun, providerOutput.failureConsequence, context, now);
        damage = consequence && consequence.damage ? consequence.damage : null;
      } else if (!success) {
        consequence = { type: "none", applied: false, reason: "" };
      }
    }
  } else {
    // No-stakes action: it simply happens. No roll, no failure cost — the GM
    // still narrates the outcome (the request layer replaces the line below with
    // real GM prose), it just isn't gated on a dice result.
    success = true;
  }

  // A foreclosed (blocked) retry narrates the closed door, not a fresh attempt —
  // grounding the prose in the object's persisted degraded state. Otherwise the
  // provider's success/failure line stands (with the intent-aware safety net).
  const baseNarration = blockNarration
    ? blockNarration
    : (success ? providerOutput.successNarration : providerOutput.failureNarration);
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
    damage,
    // The enforced structured consequence (null on success / no-roll). Drives both
    // the state mutation above and grounds the GM prose so they never diverge.
    consequence: consequence || null,
    // True when this attempt hit a retry penalty (blocked auto-fail, or a harder
    // re-roll) on a GM-degraded object — the client can surface "no use retrying".
    foreclosed
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
