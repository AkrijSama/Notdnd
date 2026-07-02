import {
  createDefaultForbiddenPolicyProfile,
  createDefaultMainlinePolicyProfile,
  validateEntityAgainstPolicy
} from "./schema.js";

const GM_TONES = new Set(["neutral", "tense", "mysterious", "warm", "dangerous", "comic", "dramatic"]);

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

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function policyProfileForEdition(edition) {
  return edition === "forbidden" ? createDefaultForbiddenPolicyProfile() : createDefaultMainlinePolicyProfile();
}

function allowedByPolicy(entity, policyProfile) {
  return validateEntityAgainstPolicy(entity || {}, policyProfile).ok;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizeText(value) {
  return String(value ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[{}[\]]/g, "")
    .trim();
}

function sanitizeStringArray(value) {
  return asArray(value)
    .map((entry) => sanitizeText(entry))
    .filter(Boolean);
}

function compactLocation(location = {}) {
  return {
    locationId: location.locationId,
    name: location.name,
    description: location.description || "",
    state: location.state || {},
    contentTags: location.contentTags || []
  };
}

function compactEntity(entity = {}) {
  return {
    entityId: entity.entityId,
    entityType: entity.entityType,
    displayName: entity.displayName,
    summary: entity.summary || "",
    visible: entity.visible !== false,
    inspectable: entity.inspectable !== false,
    relationshipId: entity.relationshipId || null,
    memoryFactIds: entity.memoryFactIds || [],
    actionTypes: entity.actionTypes || [],
    edition: entity.edition ?? null,
    policyProfileId: entity.policyProfileId ?? null,
    contentTags: entity.contentTags || [],
    tags: entity.tags || []
  };
}

function compactMove(move = {}) {
  return {
    locationId: move.locationId || move.toLocationId,
    name: move.name || move.locationId || move.toLocationId,
    direction: move.direction || null,
    edition: move.edition ?? null,
    policyProfileId: move.policyProfileId ?? null
  };
}

function compactAction(action = {}) {
  return {
    type: action.type,
    label: action.label || null,
    enabled: action.enabled !== false,
    reason: action.reason || null,
    entityId: action.entityId || null,
    toLocationId: action.toLocationId || null
  };
}

function compactTimelineEvent(event = {}) {
  return {
    eventId: event.eventId,
    type: event.type,
    title: event.title,
    summary: event.summary || "",
    createdAt: event.createdAt,
    locationId: event.locationId || null,
    entityIds: event.entityIds || [],
    memoryFactIds: event.memoryFactIds || [],
    edition: event.edition ?? null,
    policyProfileId: event.policyProfileId ?? null,
    contentTags: event.contentTags || [],
    tags: event.tags || []
  };
}

function compactMemoryFact(fact = {}) {
  return {
    factId: fact.factId,
    entityIds: fact.entityIds || [],
    type: fact.type,
    text: fact.text || "",
    source: fact.source,
    createdAt: fact.createdAt,
    canonical: fact.canonical === true,
    confidence: fact.confidence,
    edition: fact.edition ?? null,
    policyProfileId: fact.policyProfileId ?? null,
    contentTags: fact.contentTags || [],
    tags: fact.tags || []
  };
}

export function buildGmSceneInput(scenePayload, options = {}) {
  if (!isPlainObject(scenePayload) || scenePayload.ok !== true) {
    return {
      ok: false,
      errors: [
        {
          path: "scenePayload",
          message: "Expected valid scene payload"
        }
      ]
    };
  }

  const edition = scenePayload.edition || "mainline";
  const policyProfile = options.policyProfile || policyProfileForEdition(edition);
  const visibleEntities = asArray(scenePayload.visibleEntities)
    .filter((entity) => allowedByPolicy(entity, policyProfile))
    .map(compactEntity);
  const recentTimeline = asArray(scenePayload.recentTimeline)
    .filter((event) => allowedByPolicy(event, policyProfile))
    .map(compactTimelineEvent);
  const relevantMemoryFacts = asArray(scenePayload.relevantMemoryFacts)
    .filter((fact) => allowedByPolicy(fact, policyProfile))
    .map(compactMemoryFact);

  // Quest context (MVP quest engine): the player's active objectives (title +
  // objective only) so the GM can weave the goal into narration/dialogue, plus
  // an optional note about a quest that just advanced this turn (passed by the
  // action path). Truth still lives in the deterministic quest engine — the GM
  // only narrates it.
  const quests = isPlainObject(scenePayload.quests) ? scenePayload.quests : {};
  const activeQuests = asArray(quests.activeQuests)
    .filter((quest) => isPlainObject(quest))
    .map((quest) => ({ title: quest.title || "", objective: quest.objective || "" }));
  const questJustAdvanced = isPlainObject(options.questJustAdvanced) ? options.questJustAdvanced : null;

  // Open, un-accepted job offers held by PRESENT NPCs (scene.buildOpenJobOffers):
  // real, server-authored work the GM may voice. Accepting one is a committed
  // transition (resolveQuestAccept) — surfacing it is grounded, not invention.
  const openJobOffers = asArray(scenePayload.openJobOffers)
    .filter((offer) => isPlainObject(offer) && typeof offer.offerText === "string" && offer.offerText.trim())
    .map((offer) => ({ npcName: offer.npcName || "a figure", offerText: offer.offerText }));

  return {
    ok: true,
    runId: scenePayload.runId,
    edition,
    policyProfileId: scenePayload.policyProfileId || policyProfile.policyProfileId,
    location: compactLocation(scenePayload.location || {}),
    visibleEntities,
    availableMoves: asArray(scenePayload.availableMoves)
      .filter((move) => allowedByPolicy(move, policyProfile))
      .map(compactMove),
    availableActions: asArray(scenePayload.availableActions).map(compactAction),
    recentTimeline,
    relevantMemoryFacts,
    activeQuests,
    questJustAdvanced,
    openJobOffers,
    gmInstructions: {
      mode: "scene_framing",
      doNotMutateState: true,
      respectPolicy: true,
      noCanonInvention: true,
      noQuestInvention: true
    },
    errors: []
  };
}

export function validateGmSceneOutput(output, options = {}) {
  const errors = [];
  if (!isPlainObject(output)) {
    push(errors, "output", "Expected object");
    return result(errors);
  }

  if (output.ok !== true) {
    push(errors, "ok", "Expected true");
  }
  if (!isPlainObject(output.narration)) {
    push(errors, "narration", "Expected object");
  } else {
    if (!isString(output.narration.title)) {
      push(errors, "narration.title", "Expected non-empty string");
    }
    if (!isString(output.narration.body)) {
      push(errors, "narration.body", "Expected non-empty string");
    }
    if (!GM_TONES.has(output.narration.tone)) {
      push(errors, "narration.tone", "Expected supported tone");
    }
    if (!Array.isArray(output.narration.sensoryDetails)) {
      push(errors, "narration.sensoryDetails", "Expected array");
    }
    if (!Array.isArray(output.narration.focusEntityIds)) {
      push(errors, "narration.focusEntityIds", "Expected array");
    }
  }

  for (const path of ["suggestedActionLabels", "warnings", "stateMutations"]) {
    if (!Array.isArray(output[path])) {
      push(errors, path, "Expected array");
    }
  }
  if (Array.isArray(output.stateMutations) && output.stateMutations.length > 0) {
    push(errors, "stateMutations", "AI GM scene framing cannot mutate state");
  }

  if (options.disallowHtml !== false && isPlainObject(output.narration)) {
    for (const key of ["title", "body"]) {
      if (typeof output.narration[key] === "string" && /<[^>]+>/.test(output.narration[key])) {
        push(errors, `narration.${key}`, "Expected plain text");
      }
    }
  }

  return result(errors);
}

export function sanitizeGmNarration(output, options = {}) {
  const sanitized = {
    ok: true,
    narration: {
      title: sanitizeText(output?.narration?.title || "Current Scene"),
      body: sanitizeText(output?.narration?.body || ""),
      tone: GM_TONES.has(output?.narration?.tone) ? output.narration.tone : "neutral",
      sensoryDetails: sanitizeStringArray(output?.narration?.sensoryDetails),
      focusEntityIds: sanitizeStringArray(output?.narration?.focusEntityIds)
    },
    suggestedActionLabels: sanitizeStringArray(output?.suggestedActionLabels),
    warnings: sanitizeStringArray(output?.warnings),
    stateMutations: []
  };

  const validation = validateGmSceneOutput(sanitized, { ...options, disallowHtml: true });
  if (!validation.ok) {
    return {
      ...sanitized,
      ok: false,
      errors: validation.errors
    };
  }

  return sanitized;
}

export function generatePlaceholderGmNarration(scenePayload, options = {}) {
  const input = buildGmSceneInput(scenePayload, options);
  if (!input.ok) {
    return input;
  }

  const locationName = input.location.name || "Current Location";
  const description = input.location.description || "No location description is available.";
  const entityNames = input.visibleEntities
    .map((entity) => entity.displayName)
    .filter(Boolean)
    .slice(0, 4);
  const moveNames = input.availableMoves
    .map((move) => move.name)
    .filter(Boolean)
    .slice(0, 4);

  const bodyParts = [`${description}`];
  if (entityNames.length > 0) {
    bodyParts.push(`Visible entities: ${entityNames.join(", ")}.`);
  } else {
    bodyParts.push("No visible entities are immediately apparent.");
  }
  if (moveNames.length > 0) {
    bodyParts.push(`Available exits: ${moveNames.join(", ")}.`);
  }

  const output = {
    ok: true,
    narration: {
      title: locationName,
      body: bodyParts.join(" "),
      tone: "neutral",
      sensoryDetails: [],
      focusEntityIds: input.visibleEntities.map((entity) => entity.entityId).filter(Boolean).slice(0, 3)
    },
    suggestedActionLabels: input.availableActions
      .filter((action) => action.enabled !== false)
      .map((action) => action.label || action.type)
      .filter(Boolean)
      .slice(0, 5),
    warnings: [],
    stateMutations: []
  };

  return sanitizeGmNarration(cloneJson(output));
}
