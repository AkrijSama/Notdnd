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
  if (payload.vnBodyUri !== undefined && payload.vnBodyUri !== null && !isString(payload.vnBodyUri)) {
    push(errors, "vnBodyUri", "Expected string or null");
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
// State contract: normalize a gauge from a source object (or fallbacks) into
// { current, max } numbers. Returns the supplied defaults when nothing is found.
function gaugePayload(source, fallbackCurrent = 0, fallbackMax = 0) {
  const current = isPlainObject(source) && typeof source.current === "number" ? source.current : fallbackCurrent;
  const max = isPlainObject(source) && typeof source.max === "number" ? source.max : fallbackMax;
  return { current, max };
}

// State contract: the player's carried inventory as an ARRAY of { id, name, qty }.
// Prefers an explicit player.inventory array (a resolver may write it directly);
// otherwise projects the persisted run.inventory object (keyed by itemId) into the
// contract array so a resolver can append and the UI can render uniformly.
function playerInventoryArray(run) {
  const player = isPlainObject(run?.player) ? run.player : {};
  // A non-empty explicit player.inventory wins (a resolver populated it); an
  // empty/absent one falls through to the persisted run.inventory projection so
  // today's real items still surface before any resolver writes player.inventory.
  if (Array.isArray(player.inventory) && player.inventory.length > 0) {
    return player.inventory.map((item) => ({
      id: isString(item?.id) ? item.id : (isString(item?.itemId) ? item.itemId : ""),
      name: isString(item?.name) ? item.name : "",
      qty: typeof item?.qty === "number" ? item.qty : (typeof item?.quantity === "number" ? item.quantity : 1),
      ...item
    }));
  }
  const bag = isPlainObject(run?.inventory) ? run.inventory : {};
  return Object.entries(bag).map(([key, item]) => ({
    id: isString(item?.itemId) ? item.itemId : key,
    name: isString(item?.name) ? item.name : key,
    qty: typeof item?.quantity === "number" ? item.quantity : 1,
    description: isString(item?.description) ? item.description : null,
    usable: item?.usable === true,
    consumable: item?.consumable === true
  }));
}

export function buildPlayerPayload(run) {
  const player = isPlainObject(run?.player) ? run.player : {};
  const hp = isPlainObject(player.resources?.hitPoints) ? player.resources.hitPoints : null;
  const character = isPlainObject(player.character) ? player.character : null;
  const derived = isPlainObject(character?.derivedStats) ? character.derivedStats : null;
  // State contract: resources.{hp,mp}. HP mirrors the persisted gauge that
  // applyFailureDamage mutates (resources.hitPoints, falling back to health);
  // MP prefers an explicit resources.mp/mana, else the stamina gauge, else zero.
  const hpGauge = gaugePayload(
    isPlainObject(player.resources?.hp) ? player.resources.hp : hp,
    typeof player.health === "number" ? player.health : 0,
    typeof player.maxHealth === "number" ? player.maxHealth : 0
  );
  const mpSource = player.resources?.mp ?? player.resources?.mana ?? player.resources?.stamina ?? null;
  const mpGauge = gaugePayload(isPlainObject(mpSource) ? mpSource : null, 0, 0);
  return {
    displayName: isString(player.displayName) ? player.displayName : "Adventurer",
    className: isString(player.className) ? player.className : "Adventurer",
    race: isString(player.race) ? player.race : (character?.race ?? null),
    background: isString(player.background) ? player.background : (character?.background ?? null),
    level: typeof player.level === "number" ? player.level : 1,
    // State contract fields:
    xp: typeof player.xp === "number" ? player.xp : 0,
    resources: { hp: hpGauge, mp: mpGauge },
    inventory: playerInventoryArray(run),
    conditions: Array.isArray(player.conditions) ? player.conditions : [],
    // Death state (STEP 0.5): 5e death-save tally, defaulted for legacy runs.
    deathSaves: {
      successes: typeof player.deathSaves?.successes === "number" ? player.deathSaves.successes : 0,
      failures: typeof player.deathSaves?.failures === "number" ? player.deathSaves.failures : 0
    },
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
    // Lifecycle status: alive | dying | stable | dead (legacy: active | downed).
    // Drives the death-screen flow on the client. Defaults to "alive" (STEP 0.5).
    status: isString(player.status) ? player.status : "alive",
    // Full 5e record (or null) for the character sheet tab.
    character
  };
}

// State contract: a per-scene battle map carrying a token for the PLAYER and
// every NPC / player-asset co-located in the CURRENT location — for EVERY scene,
// not just combat. Token shape: { entityId, kind: 'player'|'npc'|'item', x, y }.
// Placement is deterministic scaffolding (NOT tactical logic): persisted token
// positions on run.battleMap.tokens win; otherwise tokens are laid out on a fixed
// grid (player centered, others spiralling out) so the data is always populated.
const BATTLE_MAP_SIZE = 12;
// Fixed outward ring of offsets from the player's centre cell; deterministic so
// the same scene always lays out identically. Resolver tracks own real movement.
const BATTLE_MAP_RING = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1],
  [2, 0], [-2, 0], [0, 2], [0, -2], [2, 1], [-2, -1], [1, 2], [-1, -2]
];
function clampCell(value) {
  return Math.max(0, Math.min(BATTLE_MAP_SIZE - 1, value));
}
export function buildBattleMapPayload(run) {
  const persisted = isPlainObject(run?.battleMap) ? run.battleMap : {};
  const savedPositions = new Map();
  if (Array.isArray(persisted.tokens)) {
    for (const token of persisted.tokens) {
      if (isPlainObject(token) && isString(token.entityId)) {
        savedPositions.set(token.entityId, token);
      }
    }
  }

  const player = isPlainObject(run?.player) ? run.player : {};
  const currentLocationId = run?.currentLocationId;
  const centre = Math.floor(BATTLE_MAP_SIZE / 2);

  // The player anchors the centre; co-located NPCs then items fill the ring.
  const members = [{ entityId: `player:${player.playerId ?? "player"}`, kind: "player" }];
  for (const npc of Object.values(run?.npcs || {})) {
    if (npc && npc.currentLocationId === currentLocationId) {
      members.push({ entityId: `npc:${npc.npcId}`, kind: "npc" });
    }
  }
  for (const asset of Object.values(run?.playerAssets || {})) {
    if (asset && asset.locationId === currentLocationId) {
      members.push({ entityId: `player_asset:${asset.assetId}`, kind: "item" });
    }
  }

  const tokens = members.map((member, index) => {
    const saved = savedPositions.get(member.entityId);
    if (saved && typeof saved.x === "number" && typeof saved.y === "number") {
      return { entityId: member.entityId, kind: member.kind, x: saved.x, y: saved.y };
    }
    if (index === 0) {
      return { entityId: member.entityId, kind: member.kind, x: centre, y: centre };
    }
    const [dx, dy] = BATTLE_MAP_RING[(index - 1) % BATTLE_MAP_RING.length];
    return { entityId: member.entityId, kind: member.kind, x: clampCell(centre + dx), y: clampCell(centre + dy) };
  });

  return {
    width: typeof persisted.width === "number" ? persisted.width : BATTLE_MAP_SIZE,
    height: typeof persisted.height === "number" ? persisted.height : BATTLE_MAP_SIZE,
    tokens
  };
}

// ---------------------------------------------------------------------------
// Area map (Part 2): a procedural LOCAL-AREA map — the ruins (home base), the
// forest, and discovered POIs — laid out around the home base. Positions are
// generated DETERMINISTICALLY from the run's worldSeed + locationId, so the same
// run always lays the area out identically without storing coordinates. Discovery
// memory rides on the ALREADY-PERSISTED `location.state.discovered` flag (set by
// movement.applyMove), so a place stays remembered on map reopen / run reload —
// NO new persisted field is required. Designed to zoom out later: this emits a
// single "local" region; a future world layer can nest regions around the same
// home anchor (see the `region` / `scale` fields, reserved now).
const AREA_MAP_SIZE = 16;
const AREA_HOME_LOCATION_ID = "start_location";

// Deterministic 0..1 hash (FNV-1a, normalized). Pure.
function areaHash01(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 100000) / 100000;
}

// Pure. Classifies a location into a coarse POI kind for the area-map marker,
// from its tags/name. Home base (the ruins) is tagged separately by the caller.
function areaPoiKind(location) {
  const hay = [
    ...(Array.isArray(location?.tags) ? location.tags : []),
    ...(Array.isArray(location?.contentTags) ? location.contentTags : []),
    isString(location?.name) ? location.name : ""
  ]
    .join(" ")
    .toLowerCase();
  if (/ruin|crypt|tomb|temple|dungeon/.test(hay)) return "ruins";
  if (/forest|wood|grove|wild|thicket|jungle/.test(hay)) return "forest";
  if (/town|village|city|market|tavern|port|gate|camp/.test(hay)) return "settlement";
  if (/water|river|sea|lake|coast|dock|marsh/.test(hay)) return "water";
  return "site";
}

// Pure. Deterministic (x,y) on the area grid for a location. Home anchors the
// centre; every other POI is placed on a ring whose angle + radius come from the
// seed+id hash, then nudged off any already-taken cell by a deterministic walk so
// two POIs never stack. `taken` is a Set of "x,y" keys mutated as we place.
function areaPlace(seed, locationId, isHome, taken) {
  const centre = Math.floor(AREA_MAP_SIZE / 2);
  if (isHome) {
    taken.add(`${centre},${centre}`);
    return { x: centre, y: centre };
  }
  const a = areaHash01(`${seed}:${locationId}:angle`) * Math.PI * 2;
  // Ring radius in the mid-band so POIs sit around (not on top of) the home base.
  const r = 2 + areaHash01(`${seed}:${locationId}:radius`) * (centre - 2);
  let x = Math.max(0, Math.min(AREA_MAP_SIZE - 1, Math.round(centre + Math.cos(a) * r)));
  let y = Math.max(0, Math.min(AREA_MAP_SIZE - 1, Math.round(centre + Math.sin(a) * r)));
  let guard = 0;
  while ((taken.has(`${x},${y}`) || (x === centre && y === centre)) && guard < AREA_MAP_SIZE * AREA_MAP_SIZE) {
    x = (x + 1) % AREA_MAP_SIZE;
    if (x === 0) {
      y = (y + 1) % AREA_MAP_SIZE;
    }
    guard += 1;
  }
  taken.add(`${x},${y}`);
  return { x, y };
}

// Pure. Builds the local-area map payload: every DISCOVERED location as a POI in
// its remembered (deterministic) position, plus a count of places not yet found
// (rendered as fog by the UI — undiscovered POIs leak no name/position). The home
// base (ruins) is always discovered.
export function buildAreaMapPayload(run) {
  const locations = isPlainObject(run?.locations) ? run.locations : {};
  const seed = isString(run?.worldSeed) ? run.worldSeed : (isString(run?.runId) ? run.runId : "seed");
  const currentId = isString(run?.currentLocationId) ? run.currentLocationId : null;
  const taken = new Set();
  // Place the home base first so it always owns the centre cell.
  const ids = Object.keys(locations).sort((a, b) => {
    if (a === AREA_HOME_LOCATION_ID) return -1;
    if (b === AREA_HOME_LOCATION_ID) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const pois = [];
  let undiscoveredCount = 0;
  for (const id of ids) {
    const location = locations[id];
    if (!isPlainObject(location)) {
      continue;
    }
    const isHome = id === AREA_HOME_LOCATION_ID;
    const state = isPlainObject(location.state) ? location.state : {};
    const discovered = isHome || id === currentId || state.discovered === true || state.visited === true;
    const pos = areaPlace(seed, id, isHome, taken);
    if (!discovered) {
      undiscoveredCount += 1;
      continue;
    }
    pois.push({
      locationId: id,
      name: isString(location.name) ? location.name : id,
      kind: isHome ? "home" : areaPoiKind(location),
      x: pos.x,
      y: pos.y,
      isHome,
      isCurrent: id === currentId,
      discovered: true
    });
  }

  return {
    // Reserved for the future world-map zoom: this map is the "local" region
    // anchored on the home base. A world layer can add scale: "world" + regions.
    scale: "local",
    region: "home",
    width: AREA_MAP_SIZE,
    height: AREA_MAP_SIZE,
    homeLocationId: AREA_HOME_LOCATION_ID,
    currentLocationId: currentId,
    undiscoveredCount,
    pois
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

// Pure. The active VN speaker's full-body sprite URI from run.imageAssets, or
// null (ambient, or the sprite has not been lazily generated yet). Keyed by the
// deterministic vnBody asset id; speakerId is the raw npcId (any "npc:" prefix
// is stripped defensively).
export function resolveVnBodyUri(run, vnState) {
  if (!vnState || vnState.active !== true || !isString(vnState.speakerId)) {
    return null;
  }
  const speakerId = vnState.speakerId;
  const npcId = speakerId.includes(":") ? speakerId.split(":").slice(1).join(":") : speakerId;
  const assets = isPlainObject(run?.imageAssets) ? run.imageAssets : {};
  const asset = assets[`img_${npcId}_vnBody`];
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
    // State contract: campaign (default) vs sandbox. Legacy runs without the
    // field default to "campaign" so consumers always see a concrete mode.
    mode: run.mode === "sandbox" ? "sandbox" : "campaign",
    // Death state (STEP 0.5): the run's lifecycle status surfaced so the client
    // can render a death/review screen. "dead" is TERMINAL — the run is not
    // resumable; "resumable" is false for any concluded run (dead/completed/abandoned).
    runStatus: isString(run.status) ? run.status : "active",
    resumable: run.status === "active" || run.status === undefined || run.status === null,
    isDead: run.status === "dead" || run.player?.status === "dead",
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    vnMode: vnState.active,
    speakerId: vnState.speakerId,
    // Full-body VN sprite for the active speaker (null until lazily generated by
    // runVnBodyImageJob). Distinct from the bust portraitUri on the cast roster;
    // the VN overlay (separate task) consumes this. Null when ambient.
    vnBodyUri: resolveVnBodyUri(run, vnState),
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
    // State contract: per-scene battle map, ALWAYS populated with a token for the
    // player and every co-located NPC / item in the current location (not just
    // combat). Persisted token positions win; otherwise deterministic placement.
    battleMap: buildBattleMapPayload(run),
    // Procedural LOCAL-AREA map (ruins/home base + forest + discovered POIs).
    // Discovered POIs ride on the persisted `location.state.discovered` flag, so
    // they're remembered across reopen/reload; undiscovered places stay fogged.
    areaMap: buildAreaMapPayload(run),
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

  // Image generation is enqueued in PRIORITY order: the things the player looks
  // at first generate first. The worker queue is FIFO, so enqueue order is the
  // generation order — player portrait, then the current location background,
  // then peripheral visible NPCs. All are opt-in + fire-and-forget (the live
  // scene route injects the enqueuers; the builder stays pure for tests) and
  // must never block scene delivery or throw.

  // 1. Player portrait — the player's own character, highest priority.
  if (typeof options.enqueuePlayerPortrait === "function") {
    try {
      if (playerNeedsPortrait(run)) {
        options.enqueuePlayerPortrait();
      }
    } catch {
      // Best-effort only.
    }
  }

  // 2. Current location background — the scene the player is standing in.
  if (typeof options.enqueueLocationImage === "function") {
    try {
      if (locationNeedsImage(run, currentLocation)) {
        options.enqueueLocationImage(currentLocation.locationId);
      }
    } catch {
      // Best-effort only.
    }
  }

  // 3. Visible NPC portraits — peripheral cast, generated after the above.
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
