import { providerSupportsReference, resolveImageProvider } from "../ai/providers.js";
import { getAvailableSoloActions } from "./actions.js";
import { getVisibleEntities, validateVisibleEntity } from "./entities.js";
import { generatePlaceholderGmNarration, validateGmSceneOutput } from "./gm.js";
import { getAvailableMoves } from "./movement.js";
import { getQuestPayload } from "./quests.js";
import { buildFallbackSuggestions, sceneSuggestionsKey } from "./suggestions.js";
import { getUsableInventoryItems } from "./useItem.js";
import {
  NPC_EXPRESSIONS,
  createDefaultForbiddenPolicyProfile,
  createDefaultMainlinePolicyProfile,
  normalizeVnState,
  validateEntityAgainstPolicy,
  validateSoloRun
} from "./schema.js";

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

function validateStringArray(value, path, errors) {
  if (!Array.isArray(value)) {
    push(errors, path, "Expected array");
    return;
  }
  value.forEach((entry, index) => {
    if (!isString(entry)) {
      push(errors, `${path}.${index}`, "Expected non-empty string");
    }
  });
}

function policyProfileForRun(run) {
  return run?.edition === "forbidden" ? createDefaultForbiddenPolicyProfile() : createDefaultMainlinePolicyProfile();
}

function policyAllows(entity, policyProfile) {
  return validateEntityAgainstPolicy(entity, policyProfile).ok;
}

function locationPayload(location) {
  return {
    locationId: location.locationId,
    name: location.name,
    description: location.description,
    imageAssetId: location.imageAssetId ?? null,
    state: location.state || {},
    edition: location.edition ?? null,
    policyProfileId: location.policyProfileId ?? null,
    contentTags: location.contentTags || [],
    tags: location.tags || [],
    flags: location.flags || {},
    memoryFactIds: location.memoryFactIds || []
  };
}

function restPayload(location, policyProfile) {
  const rest = location?.rest || {};
  const payload = {
    allowed: rest.allowed !== false,
    safety: rest.safety || "safe",
    availableTypes: Array.isArray(rest.availableTypes) ? rest.availableTypes : ["short"],
    contentTags: rest.contentTags || [],
    edition: rest.edition ?? location?.edition ?? null,
    policyProfileId: rest.policyProfileId ?? location?.policyProfileId ?? null
  };
  if (!policyAllows(payload, policyProfile)) {
    return {
      allowed: false,
      safety: payload.safety,
      availableTypes: [],
      contentTags: [],
      edition: null,
      policyProfileId: null
    };
  }
  return payload;
}

function revealedSearchDetails(location, policyProfile) {
  if (!Array.isArray(location?.searchDetails)) {
    return [];
  }

  return location.searchDetails
    .filter((detail) => detail?.revealed === true && policyAllows(detail, policyProfile))
    .map((detail) => ({
      detailId: detail.detailId,
      label: detail.label,
      description: detail.description,
      contentTags: detail.contentTags || [],
      linkedEntityIds: detail.linkedEntityIds || [],
      linkedMemoryFactIds: detail.linkedMemoryFactIds || [],
      edition: detail.edition ?? location.edition ?? null,
      policyProfileId: detail.policyProfileId ?? location.policyProfileId ?? null
    }));
}

function inventoryPayload(run, policyProfile) {
  return getUsableInventoryItems(run, { policyProfile }).map((item) => ({
    itemId: item.itemId,
    name: item.name,
    description: item.description,
    quantity: item.quantity,
    usable: item.usable,
    consumable: item.consumable,
    imageAssetId: item.imageAssetId,
    availableActions: item.availableActions,
    contentTags: item.contentTags || [],
    edition: item.edition ?? null,
    policyProfileId: item.policyProfileId ?? null
  }));
}

function attemptHistoryPayload(run, policyProfile, limit = 5) {
  if (!Array.isArray(run?.timeline)) {
    return [];
  }
  return run.timeline
    .filter((event) => event?.type === "attempt" && policyAllows(event, policyProfile))
    .slice(-limit)
    .map((event) => ({
      eventId: event.eventId,
      createdAt: event.createdAt,
      locationId: event.locationId || null,
      summary: event.summary || "",
      intent: event.payload?.intent || "",
      targetId: event.payload?.targetId || null,
      success: event.payload?.success === true,
      checkResult: event.payload?.checkResult || null,
      narration: event.payload?.narration || "",
      warnings: event.payload?.warnings || []
    }));
}

function entityFactIds(entities) {
  const ids = new Set();
  for (const entity of entities) {
    for (const factId of entity.memoryFactIds || []) {
      ids.add(factId);
    }
  }
  return ids;
}

function entityRawIds(entities) {
  const ids = new Set();
  for (const entity of entities) {
    ids.add(entity.entityId);
    const rawId = entity.entityId.split(":").slice(1).join(":");
    if (rawId) {
      ids.add(rawId);
    }
  }
  return ids;
}

function appendNestedErrors(errors, prefix, validation) {
  for (const error of validation.errors) {
    push(errors, `${prefix}.${error.path}`, error.message);
  }
}

export function getRecentTimelineEvents(run, options = {}) {
  if (!Array.isArray(run?.timeline)) {
    return [];
  }

  const limit = Number.isInteger(options.limit) ? options.limit : 5;
  const policyProfile = options.policyProfile || policyProfileForRun(run);
  return run.timeline
    .filter((event) => policyAllows(event, policyProfile))
    .slice(-limit);
}

export function getRelevantMemoryFacts(run, options = {}) {
  if (!Array.isArray(run?.memoryFacts)) {
    return [];
  }

  const limit = Number.isInteger(options.limit) ? options.limit : 10;
  const location = run.locations?.[run.currentLocationId];
  const visibleEntities = options.visibleEntities || getVisibleEntities(run);
  const policyProfile = options.policyProfile || policyProfileForRun(run);
  const directFactIds = new Set(location?.memoryFactIds || []);
  const visibleFactIds = entityFactIds(visibleEntities);
  const visibleIds = entityRawIds(visibleEntities);

  const relevant = run.memoryFacts.filter((fact) => {
    if (!policyAllows(fact, policyProfile)) {
      return false;
    }
    if (directFactIds.has(fact.factId) || visibleFactIds.has(fact.factId)) {
      return true;
    }
    return (fact.entityIds || []).some((entityId) => visibleIds.has(entityId));
  });

  if (relevant.length > 0) {
    return relevant.slice(-limit);
  }

  return run.memoryFacts
    .filter((fact) => policyAllows(fact, policyProfile))
    .slice(-limit);
}

export function validateSoloScenePayload(payload) {
  const errors = [];
  if (!isPlainObject(payload)) {
    push(errors, "payload", "Expected object");
    return result(errors);
  }

  if (payload.ok !== true) {
    push(errors, "ok", "Expected true");
  }
  if (!isString(payload.runId)) {
    push(errors, "runId", "Expected non-empty string");
  }
  if (!isString(payload.edition)) {
    push(errors, "edition", "Expected non-empty string");
  }
  if (!isString(payload.policyProfileId)) {
    push(errors, "policyProfileId", "Expected non-empty string");
  }
  // VN signal (optional so hand-built/partial payloads stay valid): when present,
  // vnMode is a boolean and speakerId is a string or null.
  if (payload.vnMode !== undefined && typeof payload.vnMode !== "boolean") {
    push(errors, "vnMode", "Expected boolean");
  }
  if (payload.speakerId !== undefined && payload.speakerId !== null && !isString(payload.speakerId)) {
    push(errors, "speakerId", "Expected string or null");
  }

  if (!isPlainObject(payload.location)) {
    push(errors, "location", "Expected object");
  } else {
    if (!isString(payload.location.locationId)) {
      push(errors, "location.locationId", "Expected non-empty string");
    }
    if (!isString(payload.location.name)) {
      push(errors, "location.name", "Expected non-empty string");
    }
    if (typeof payload.location.description !== "string") {
      push(errors, "location.description", "Expected string");
    }
    validateStringArray(payload.location.tags, "location.tags", errors);
    validateStringArray(payload.location.contentTags, "location.contentTags", errors);
    validateStringArray(payload.location.memoryFactIds, "location.memoryFactIds", errors);
  }

  if (!Array.isArray(payload.visibleEntities)) {
    push(errors, "visibleEntities", "Expected array");
  } else {
    payload.visibleEntities.forEach((entity, index) => appendNestedErrors(errors, `visibleEntities.${index}`, validateVisibleEntity(entity)));
  }
  if (payload.player !== undefined) {
    if (!isPlainObject(payload.player)) {
      push(errors, "player", "Expected object");
    } else if (!isString(payload.player.displayName)) {
      push(errors, "player.displayName", "Expected non-empty string");
    }
  }
  if (payload.cast !== undefined) {
    if (!Array.isArray(payload.cast)) {
      push(errors, "cast", "Expected array");
    } else {
      payload.cast.forEach((entry, index) => {
        if (!isPlainObject(entry)) {
          push(errors, `cast.${index}`, "Expected object");
          return;
        }
        if (!isString(entry.npcId)) {
          push(errors, `cast.${index}.npcId`, "Expected non-empty string");
        }
        if (!isString(entry.displayName)) {
          push(errors, `cast.${index}.displayName`, "Expected non-empty string");
        }
      });
    }
  }
  if (!Array.isArray(payload.availableMoves)) {
    push(errors, "availableMoves", "Expected array");
  }
  if (!Array.isArray(payload.availableActions)) {
    push(errors, "availableActions", "Expected array");
  }
  if (payload.discoveredDetails !== undefined) {
    if (!Array.isArray(payload.discoveredDetails)) {
      push(errors, "discoveredDetails", "Expected array");
    } else {
      payload.discoveredDetails.forEach((detail, index) => {
        if (!isPlainObject(detail)) {
          push(errors, `discoveredDetails.${index}`, "Expected object");
          return;
        }
        if (!isString(detail.detailId)) {
          push(errors, `discoveredDetails.${index}.detailId`, "Expected non-empty string");
        }
        if (!isString(detail.label)) {
          push(errors, `discoveredDetails.${index}.label`, "Expected non-empty string");
        }
        if (!isString(detail.description)) {
          push(errors, `discoveredDetails.${index}.description`, "Expected non-empty string");
        }
        validateStringArray(detail.contentTags || [], `discoveredDetails.${index}.contentTags`, errors);
      });
    }
  }
  if (payload.rest !== undefined) {
    if (!isPlainObject(payload.rest)) {
      push(errors, "rest", "Expected object");
    } else {
      if (typeof payload.rest.allowed !== "boolean") {
        push(errors, "rest.allowed", "Expected boolean");
      }
      if (!isString(payload.rest.safety)) {
        push(errors, "rest.safety", "Expected non-empty string");
      }
      validateStringArray(payload.rest.availableTypes, "rest.availableTypes", errors);
      validateStringArray(payload.rest.contentTags || [], "rest.contentTags", errors);
    }
  }
  if (payload.playerInventory !== undefined) {
    if (!Array.isArray(payload.playerInventory)) {
      push(errors, "playerInventory", "Expected array");
    } else {
      payload.playerInventory.forEach((item, index) => {
        if (!isPlainObject(item)) {
          push(errors, `playerInventory.${index}`, "Expected object");
          return;
        }
        if (!isString(item.itemId)) {
          push(errors, `playerInventory.${index}.itemId`, "Expected non-empty string");
        }
        if (!isString(item.name)) {
          push(errors, `playerInventory.${index}.name`, "Expected non-empty string");
        }
        if (typeof item.quantity !== "number") {
          push(errors, `playerInventory.${index}.quantity`, "Expected number");
        }
        if (typeof item.usable !== "boolean") {
          push(errors, `playerInventory.${index}.usable`, "Expected boolean");
        }
        validateStringArray(item.availableActions || [], `playerInventory.${index}.availableActions`, errors);
        validateStringArray(item.contentTags || [], `playerInventory.${index}.contentTags`, errors);
      });
    }
  }
  if (payload.attemptHistory !== undefined) {
    if (!Array.isArray(payload.attemptHistory)) {
      push(errors, "attemptHistory", "Expected array");
    } else {
      payload.attemptHistory.forEach((entry, index) => {
        if (!isPlainObject(entry)) {
          push(errors, `attemptHistory.${index}`, "Expected object");
          return;
        }
        if (!isString(entry.eventId)) {
          push(errors, `attemptHistory.${index}.eventId`, "Expected non-empty string");
        }
        if (!isString(entry.intent)) {
          push(errors, `attemptHistory.${index}.intent`, "Expected non-empty string");
        }
        if (typeof entry.success !== "boolean") {
          push(errors, `attemptHistory.${index}.success`, "Expected boolean");
        }
        validateStringArray(entry.warnings || [], `attemptHistory.${index}.warnings`, errors);
      });
    }
  }
  if (!Array.isArray(payload.recentTimeline)) {
    push(errors, "recentTimeline", "Expected array");
  }
  if (!Array.isArray(payload.relevantMemoryFacts)) {
    push(errors, "relevantMemoryFacts", "Expected array");
  }

  if (!isPlainObject(payload.uiHints)) {
    push(errors, "uiHints", "Expected object");
  } else {
    if (payload.uiHints.layout !== "spatial_scene") {
      push(errors, "uiHints.layout", "Expected spatial_scene");
    }
    for (const key of ["showLocationImage", "showActionBar", "showEntityPanel", "showTimeline"]) {
      if (typeof payload.uiHints[key] !== "boolean") {
        push(errors, `uiHints.${key}`, "Expected boolean");
      }
    }
  }

  if (!Array.isArray(payload.errors)) {
    push(errors, "errors", "Expected array");
  }

  if (payload.gmNarration !== undefined) {
    appendNestedErrors(errors, "gmNarration", validateGmSceneOutput(payload.gmNarration));
  }

  return result(errors);
}

export function summarizeSceneForUi(payload) {
  return {
    locationName: payload.location?.name || null,
    visibleEntityCount: Array.isArray(payload.visibleEntities) ? payload.visibleEntities.length : 0,
    availableMoveCount: Array.isArray(payload.availableMoves) ? payload.availableMoves.length : 0,
    availableActionCount: Array.isArray(payload.availableActions) ? payload.availableActions.length : 0
  };
}

// Returns the raw ids of visible NPCs whose portrait art is incomplete. Used by
// the scene route to decide which image jobs to enqueue. Expression variants
// only count toward "incomplete" when the active provider can actually generate
// consistent ones (img2img / IP-Adapter); under a txt2img-only provider
// (Pollinations) only the base portrait is required, which avoids a perpetual
// re-enqueue loop for variants that will never be generated there.
export function collectNpcsNeedingArt(run, visibleEntities = null) {
  if (!isPlainObject(run) || !isPlainObject(run.npcs)) {
    return [];
  }
  const entities = Array.isArray(visibleEntities) ? visibleEntities : getVisibleEntities(run);
  const assets = isPlainObject(run.imageAssets) ? run.imageAssets : {};
  const needing = [];

  for (const entity of entities) {
    if (entity?.entityType !== "npc" || !isString(entity.entityId)) {
      continue;
    }
    const npcId = entity.entityId.split(":").slice(1).join(":") || entity.entityId;
    const npc = run.npcs[npcId];
    if (!npc) {
      continue;
    }

    // Only a missing BASE portrait makes an NPC "need art" on encounter.
    // Expression variants are generated lazily per talk beat (runVariantImageJob),
    // not eagerly here — most NPCs are only ever seen in 1-2 expressions.
    const generated = (assetId) => isString(assetId) && assets[assetId]?.status === "generated";
    if (!generated(npc.imageAssetId)) {
      needing.push(npcId);
    }
  }

  return needing;
}

// Pure. Returns the raw ids of visible NPCs that still lack a generated
// identity (generatedName missing). Used by the scene route to enqueue async
// identity generation on first encounter.
export function collectNpcsNeedingIdentity(run, visibleEntities = null) {
  if (!isPlainObject(run) || !isPlainObject(run.npcs)) {
    return [];
  }
  const entities = Array.isArray(visibleEntities) ? visibleEntities : getVisibleEntities(run);
  const needing = [];

  for (const entity of entities) {
    if (entity?.entityType !== "npc" || !isString(entity.entityId)) {
      continue;
    }
    const npcId = entity.entityId.split(":").slice(1).join(":") || entity.entityId;
    const npc = run.npcs[npcId];
    if (!npc) {
      continue;
    }
    if (!isString(npc.generatedName)) {
      needing.push(npcId);
    }
  }

  return needing;
}

// Pure. Returns the npcIds of NPCs that still have unconsumed intro
// instructions (a user directive on how the GM should introduce them).
export function collectNpcsWithPendingIntro(run) {
  if (!isPlainObject(run) || !isPlainObject(run.npcs)) {
    return [];
  }
  return Object.values(run.npcs)
    .filter((npc) => isPlainObject(npc) && isString(npc.introInstructions))
    .map((npc) => npc.npcId)
    .filter((npcId) => isString(npcId));
}

// Pure. Builds a one-time GM directive describing how to introduce any NPCs
// that carry user-supplied intro instructions. Returns "" when there are none.
export function buildNpcIntroDirective(run) {
  if (!isPlainObject(run) || !isPlainObject(run.npcs)) {
    return "";
  }
  const pending = Object.values(run.npcs).filter(
    (npc) => isPlainObject(npc) && isString(npc.introInstructions)
  );
  if (pending.length === 0) {
    return "";
  }
  const lines = pending.map((npc) => {
    const name = isString(npc.generatedName)
      ? npc.generatedName
      : isString(npc.displayName)
        ? npc.displayName
        : npc.role;
    return `- ${name} (${npc.role}): ${String(npc.introInstructions).trim()}`;
  });
  return `Introduce the following custom NPC(s) naturally into the scene, following each directive:\n${lines.join("\n")}`;
}

// Pure. Builds the full NPC roster (every NPC in run.npcs, policy-filtered) with
// resolved portrait/expression URIs, so the client cast list isn't limited to
// the current location. A URI is included only when its asset is generated.
export function buildCastRoster(run, policyProfile) {
  if (!isPlainObject(run) || !isPlainObject(run.npcs)) {
    return [];
  }
  const assets = isPlainObject(run.imageAssets) ? run.imageAssets : {};
  const uriFor = (assetId) => {
    const asset = assetId ? assets[assetId] : null;
    return asset && asset.status === "generated" && isString(asset.uri) ? asset.uri : null;
  };

  return Object.values(run.npcs)
    .filter((npc) => isPlainObject(npc) && policyAllows(npc, policyProfile))
    .map((npc) => {
      const variants = isPlainObject(npc.expressionVariants) ? npc.expressionVariants : {};
      const expressionVariants = {};
      for (const [expression, assetId] of Object.entries(variants)) {
        const uri = uriFor(assetId);
        if (uri) {
          expressionVariants[expression] = uri;
        }
      }
      return {
        npcId: npc.npcId,
        displayName: npc.generatedName || npc.displayName || npc.role || npc.npcId,
        role: npc.role || "",
        origin: npc.origin || null,
        known: npc.known !== false,
        currentLocationId: npc.currentLocationId || null,
        present: npc.currentLocationId === run.currentLocationId,
        portraitUri: uriFor(npc.imageAssetId),
        expressionVariants
      };
    });
}

// Pure. Projects run.player into the fields the character sidebar needs.
// run.player tracks HP via resources.hitPoints and the six D&D abilities; it
// does not track AC/speed, so those come back null and the client defaults them.
export function buildPlayerPayload(run) {
  const player = isPlainObject(run?.player) ? run.player : {};
  const hp = isPlainObject(player.resources?.hitPoints) ? player.resources.hitPoints : null;
  const character = isPlainObject(player.character) ? player.character : null;
  const derived = isPlainObject(character?.derivedStats) ? character.derivedStats : null;
  return {
    displayName: isString(player.displayName) ? player.displayName : "Adventurer",
    className: isString(player.className) ? player.className : "Adventurer",
    race: isString(player.race) ? player.race : (character?.race ?? null),
    background: isString(player.background) ? player.background : (character?.background ?? null),
    level: typeof player.level === "number" ? player.level : 1,
    hitPoints: {
      current: hp && typeof hp.current === "number" ? hp.current : (typeof player.health === "number" ? player.health : 0),
      max: hp && typeof hp.max === "number" ? hp.max : (typeof player.maxHealth === "number" ? player.maxHealth : 0)
    },
    // Prefer the 5e derived stats when a full character is present.
    armorClass: typeof derived?.armorClass === "number" ? derived.armorClass : (typeof player.ac === "number" ? player.ac : null),
    speed: typeof derived?.speed === "number" ? derived.speed : (typeof player.speed === "number" ? player.speed : null),
    abilities: isPlainObject(player.abilities) ? { ...player.abilities } : {},
    stats: isPlainObject(player.stats) ? { ...player.stats } : {},
    skills: isPlainObject(player.skills) ? { ...player.skills } : {},
    portraitUri: isString(player.portraitUri) ? player.portraitUri : null,
    // Lifecycle status (e.g. "downed" at 0 HP); drives the run-conclusion /
    // death-screen flow on the client. Null when the run carries no status.
    status: isString(player.status) ? player.status : null,
    // Full 5e record (or null) for the character sheet tab.
    character
  };
}

// Pure. True when the player has a full 5e character but no generated portrait
// yet — used by the scene route to enqueue a one-off player-portrait job.
export function playerNeedsPortrait(run) {
  const player = isPlainObject(run?.player) ? run.player : null;
  if (!player || !isPlainObject(player.character)) {
    return false;
  }
  return !isString(player.portraitUri);
}

// Pure. The deterministic imageAsset id for a location's background image.
function locationImageAssetId(location) {
  return location?.imageAssetId || (location?.locationId ? `img_location_${location.locationId}` : null);
}

// Pure. Resolves a location's generated background-image URI from run.imageAssets,
// or null when it has not been generated yet.
export function resolveLocationImageUri(run, location) {
  const assets = isPlainObject(run?.imageAssets) ? run.imageAssets : {};
  const assetId = locationImageAssetId(location);
  const asset = assetId ? assets[assetId] : null;
  return asset && asset.status === "generated" && isString(asset.uri) ? asset.uri : null;
}

// Pure. True when the player has locked the current location's background image
// (Save), so it is final and must never regenerate.
export function resolveLocationImageLocked(run, location) {
  const assets = isPlainObject(run?.imageAssets) ? run.imageAssets : {};
  const assetId = locationImageAssetId(location);
  const asset = assetId ? assets[assetId] : null;
  return Boolean(asset && asset.locked);
}

// Pure. True before the player has taken any action this run — the run still
// carries only the seed "run_created" timeline event. Used to gate the world-
// entry opening narration so it shows on arrival and disappears once play starts.
export function isOpeningMoment(run) {
  const timeline = Array.isArray(run?.timeline) ? run.timeline : [];
  return timeline.every((event) => event && event.type === "run_created");
}

// Pure. True when the current location still lacks a generated background image —
// used by the scene route to enqueue a one-off location-image job on entry/move.
// A generated image (locked or not) is never regenerated: resolveLocationImageUri
// returns it, so this is false on revisit.
export function locationNeedsImage(run, location) {
  if (!isPlainObject(run) || !isPlainObject(location)) {
    return false;
  }
  return !resolveLocationImageUri(run, location);
}

export function buildSoloScenePayload(run, options = {}) {
  const runValidation = validateSoloRun(run);
  if (!runValidation.ok) {
    return {
      ok: false,
      errors: runValidation.errors
    };
  }

  const currentLocation = run.locations[run.currentLocationId];
  if (!currentLocation) {
    return {
      ok: false,
      errors: [
        {
          path: "currentLocationId",
          message: "Location does not exist in locations"
        }
      ]
    };
  }

  const policyProfile = options.policyProfile || policyProfileForRun(run);
  if (!policyAllows(currentLocation, policyProfile)) {
    return {
      ok: false,
      errors: [
        {
          path: "location",
          message: "Current location is not allowed by policy profile"
        }
      ]
    };
  }

  const visibleEntities = getVisibleEntities(run, { policyProfile });
  const attemptHistory = attemptHistoryPayload(run, policyProfile, options.attemptHistoryLimit);
  // VN (visual-novel) scene signal. vnMode=true with a speakerId names a direct,
  // sustained exchange with that NPC (the client may surface the dialogue
  // overlay); false = ambient theatre-of-the-mind prose. Normalized so runs that
  // predate the field default to ambient. The UI consumption is a separate task —
  // this only exposes the signal. Written by actions.finalizeQuestProgress (the
  // manual talk trigger) and, in future, the GM-driven gmProvider.deriveVnState.
  const vnState = normalizeVnState(run.vn);
  const payload = {
    ok: true,
    runId: run.runId,
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    vnMode: vnState.active,
    speakerId: vnState.speakerId,
    location: locationPayload(currentLocation),
    // Generated location background image (null until the worker produces it;
    // the client shows a "Generating scene art…" placeholder meanwhile).
    locationImageUri: resolveLocationImageUri(run, currentLocation),
    // Whether the player has locked this location's image (hides Redo/Save).
    locationImageLocked: resolveLocationImageLocked(run, currentLocation),
    // AI-generated world-entry opening (stored on the run, generated once).
    // Surfaced only at the "first begins" moment — before the player has taken
    // any action — so it reads as a GM welcome at the top of the scene, then
    // steps aside once play starts.
    openingNarration: isOpeningMoment(run) && isString(run.openingNarration) ? run.openingNarration : null,
    rest: restPayload(currentLocation, policyProfile),
    player: buildPlayerPayload(run),
    visibleEntities,
    cast: buildCastRoster(run, policyProfile),
    // Phase 2 battle map: persisted token positions (null until the player
    // moves a token). The client falls back to deterministic placement.
    battleMap: isPlainObject(run.battleMap) ? run.battleMap : null,
    // MVP quest engine: active quests + the main quest (or null) for this run.
    quests: getQuestPayload(run),
    availableMoves: getAvailableMoves(run).filter((move) => {
      const destination = run.locations[move.locationId];
      return destination ? policyAllows(destination, policyProfile) : false;
    }),
    availableActions: getAvailableSoloActions(run).filter((action) => {
      if (action.toLocationId) {
        const destination = run.locations[action.toLocationId];
        return destination ? policyAllows(destination, policyProfile) : false;
      }
      return true;
    }),
    playerInventory: inventoryPayload(run, policyProfile),
    latestAttemptResult: attemptHistory.length ? attemptHistory.at(-1) : null,
    attemptHistory,
    discoveredDetails: revealedSearchDetails(currentLocation, policyProfile),
    recentTimeline: getRecentTimelineEvents(run, { policyProfile, limit: options.timelineLimit }),
    relevantMemoryFacts: getRelevantMemoryFacts(run, {
      policyProfile,
      visibleEntities,
      limit: options.memoryLimit
    }),
    uiHints: {
      layout: "spatial_scene",
      showLocationImage: true,
      showActionBar: true,
      showEntityPanel: true,
      showTimeline: true
    },
    errors: []
  };

  // Contextual suggested actions: 3 short, editable next-move prompts so the
  // player never faces a blank box. Served from cache when fresh, else a
  // deterministic scene-aware fallback; the route's enqueuer refreshes a stale
  // scene's set in the background (LLM upgrade on the next poll). Pure scaffolding
  // — the client always also offers a free-text "type your own" input.
  const suggestionsKey = sceneSuggestionsKey(run);
  const cachedSuggestions =
    run.suggestedActionsKey === suggestionsKey &&
    Array.isArray(run.suggestedActions) &&
    run.suggestedActions.length >= 3
      ? run.suggestedActions.slice(0, 3)
      : null;
  payload.suggestedActions = cachedSuggestions || buildFallbackSuggestions(run);
  if (!cachedSuggestions && typeof options.enqueueSuggestions === "function") {
    try {
      options.enqueueSuggestions(suggestionsKey);
    } catch {
      // Best-effort only.
    }
  }

  if (options.includePlaceholderGm === true) {
    payload.gmNarration = generatePlaceholderGmNarration(payload, options.gmOptions || {});
  }

  // Opt-in, fire-and-forget image generation trigger. Off by default so the
  // builder stays pure for tests; the live scene route injects the enqueuer.
  // Must never block scene delivery or throw.
  if (typeof options.enqueueImages === "function") {
    try {
      const npcIds = collectNpcsNeedingArt(run, visibleEntities);
      if (npcIds.length > 0) {
        options.enqueueImages(npcIds);
      }
    } catch {
      // Best-effort only.
    }
  }

  // Opt-in, fire-and-forget location background image. Generated once per
  // location, on entry or when the player moves here. Never blocks delivery.
  if (typeof options.enqueueLocationImage === "function") {
    try {
      if (locationNeedsImage(run, currentLocation)) {
        options.enqueueLocationImage(currentLocation.locationId);
      }
    } catch {
      // Best-effort only.
    }
  }

  // Opt-in, fire-and-forget player-portrait generation. Never blocks delivery.
  if (typeof options.enqueuePlayerPortrait === "function") {
    try {
      if (playerNeedsPortrait(run)) {
        options.enqueuePlayerPortrait();
      }
    } catch {
      // Best-effort only.
    }
  }

  // Opt-in, fire-and-forget identity generation for any visible NPC that still
  // lacks a generated name (first-encounter path). Never blocks scene delivery.
  if (typeof options.enqueueIdentities === "function") {
    try {
      const npcIds = collectNpcsNeedingIdentity(run, visibleEntities);
      if (npcIds.length > 0) {
        options.enqueueIdentities(npcIds);
      }
    } catch {
      // Best-effort only.
    }
  }

  const payloadValidation = validateSoloScenePayload(payload);
  if (!payloadValidation.ok) {
    return {
      ok: false,
      errors: payloadValidation.errors
    };
  }

  return payload;
}
