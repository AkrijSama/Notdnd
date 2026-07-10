import { providerSupportsReference, resolveImageProvider } from "../ai/providers.js";
import { getAvailableSoloActions } from "./actions.js";
import { MILESTONE_MAX, RANK_LADDER, tierForMilestone, displayLevelFor, rankForPlayer } from "./progression.js";
import { babelStatBlock } from "./babelStats.js";
import { deriveClock } from "./worldClock.js";
import { conditionStatusPayload } from "./conditions.js";
import { getVisibleEntities, validateVisibleEntity } from "./entities.js";
import { generatePlaceholderGmNarration, validateGmSceneOutput } from "./gm.js";
import { getAvailableMoves } from "./movement.js";
import { getQuestPayload } from "./quests.js";
import { getRecentDevelopment } from "./momentum.js";
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
      // Three-state outcome (#28): the card/history label the three bands
      // distinctly so a sub-DC roll never reads as a clean "Success".
      band: event.payload?.band || null,
      outcomeLabel: event.payload?.outcomeLabel || null,
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

// INTRODUCTION BEAT (baseline: the medic-Mara cold-surface). An NPC is "pending
// introduction" when EITHER it carries unconsumed authored introInstructions, OR
// it is a committed-but-never-introduced NPC PRESENT at the player's location
// (flags.introduced !== true) — the class that used to surface cold mid-turn
// with no arrival beat. The server GUARANTEES the intro context (the known-good
// momentum-arrival pattern), it is not a prompt suggestion; the caller marks
// each introduced after the narration lands (markNpcIntroduced).
function npcsPendingIntro(run) {
  if (!isPlainObject(run) || !isPlainObject(run.npcs)) {
    return [];
  }
  return Object.values(run.npcs).filter((npc) => {
    if (!isPlainObject(npc)) return false;
    if (isString(npc.introInstructions)) return true; // authored intro, any location
    if (npc.flags?.introduced === true) return false;
    // Default (synthesized) intro: only for a PRESENT, live NPC about to appear.
    return npc.currentLocationId === run.currentLocationId && npc.status !== "gone";
  });
}

// Pure. Returns the npcIds of NPCs whose introduction is still pending
// (authored introInstructions, or present-but-never-introduced).
export function collectNpcsWithPendingIntro(run) {
  return npcsPendingIntro(run)
    .map((npc) => npc.npcId)
    .filter((npcId) => isString(npcId));
}

// Pure. Builds a one-time GM directive describing how to introduce every
// pending NPC — the authored directive when supplied, else a synthesized
// arrival/presence beat from the committed identity. Returns "" when none.
export function buildNpcIntroDirective(run) {
  const pending = npcsPendingIntro(run);
  if (pending.length === 0) {
    return "";
  }
  const lines = pending.map((npc) => {
    const name = isString(npc.generatedName)
      ? npc.generatedName
      : isString(npc.displayName)
        ? npc.displayName
        : npc.role;
    if (isString(npc.introInstructions)) {
      return `- ${name} (${npc.role}): ${String(npc.introInstructions).trim()}`;
    }
    const appearance = isString(npc.appearance) ? ` Appearance: ${npc.appearance.trim()}.` : "";
    return (
      `- ${name} (${npc.role}): FIRST APPEARANCE — this character has never been narrated before. ` +
      `Introduce them with a concrete presence beat (where they are, what they are doing) before they speak or act;` +
      ` never treat them as already established.${appearance}`
    );
  });
  return `Introduce the following NPC(s) naturally into the scene, following each directive:\n${lines.join("\n")}`;
}

// Pure. Builds the full NPC roster (every NPC in run.npcs, policy-filtered) with
// resolved portrait/expression URIs, so the client cast list isn't limited to
// the current location. A URI is included only when its asset is generated.
// Open, un-accepted job offers held by NPCs PRESENT at the current location.
// Compact surface only (who + the pitch) — the full offer (quest, takeable,
// destination) stays server-side until resolveQuestAccept commits it.
export function buildOpenJobOffers(run) {
  const npcs = isPlainObject(run?.npcs) ? Object.values(run.npcs) : [];
  return npcs
    .filter(
      (npc) =>
        isPlainObject(npc) &&
        npc.currentLocationId === run?.currentLocationId &&
        npc.status !== "gone" &&
        isPlainObject(npc.questOffer) &&
        npc.questOffer.accepted !== true &&
        isString(npc.questOffer.offerText)
    )
    .map((npc) => ({
      npcId: npc.npcId,
      npcName: isString(npc.displayName) ? npc.displayName : "a figure",
      offerText: npc.questOffer.offerText
    }));
}

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
    // Don't surface never-encountered procedural placeholders that aren't here.
    // The default forest-ruins start seeds latent plot NPCs ("A waiting figure",
    // "A figure at the edge") at remote locations with present=false; on a
    // deliberately-alone start they'd pollute the roster and undercut the "you
    // are alone" framing. Identity is minted only when an NPC becomes visible
    // (co-located), so a procedural NPC with no generatedName that isn't present
    // has genuinely never been met — hide it until the player reaches it. Present
    // NPCs (e.g. a justified tavern keeper) and any already-encountered (named)
    // NPC are always kept, so this never hides a real cast member.
    .filter((npc) => {
      const present = npc.currentLocationId === run.currentLocationId;
      if (present) {
        return true;
      }
      const encountered = isString(npc.generatedName) && npc.generatedName.trim().length > 0;
      if (encountered) {
        return true;
      }
      return npc.origin !== "procedural";
    })
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
        // #50: committed gender/pronouns so the client can reflect them and the
        // portrait's subject is verifiable (the image worker grounds on these).
        gender: isString(npc.gender) ? npc.gender : null,
        pronouns: isString(npc.pronouns) ? npc.pronouns : null,
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

// Babel WINDOW skill list — the display projection of player.babelSkills (the
// SAME records rankForPlayer reads, so the list, the count, and RANK can never
// contradict). Records may be bare rank indices or objects; both normalize to a
// stable display shape. "What a skill does" comes from its `effect`/`name`
// fields when the acquisition system writes them; absent fields render null and
// the client shows the provenance it does have. Server owns this projection so
// the WINDOW stays a dumb, honest display.
function babelSkillDetails(skills) {
  if (!Array.isArray(skills)) {
    return [];
  }
  return skills.map((s, i) => {
    const rankIndex = typeof s === "number" ? s : (typeof s?.rankIndex === "number" ? s.rankIndex : NaN);
    const rank =
      Number.isFinite(rankIndex) && rankIndex >= 1 && rankIndex <= RANK_LADDER.length
        ? RANK_LADDER[Math.round(rankIndex) - 1]
        : null;
    const record = isPlainObject(s) ? s : {};
    const rawId = isString(record.skillId) ? record.skillId : "";
    const name = isString(record.name) && record.name
      ? record.name
      : rawId
        ? rawId.replace(/^skill[_-]/, "").replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
        : "Unnamed skill";
    return {
      id: rawId || `skill_${i}`,
      name,
      rank,
      stat: isString(record.stat) ? record.stat : null,
      effect: isString(record.effect) ? record.effect : null,
      source: isString(record.source) ? record.source : null,
      acquiredAtMilestone: typeof record.acquiredAtMilestone === "number" ? record.acquiredAtMilestone : null
    };
  });
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
    // Milestone tier band (delta §3f): chassis vocabulary, safe to show — the
    // raw counter is never the player-facing number, the band name is. Legacy
    // runs without a milestone derive it read-only by the migration rule
    // (min(cap, level)); legacy saves are all identity-mapped, so level ≤ 20.
    milestoneTier: tierForMilestone(
      typeof player.milestone === "number"
        ? player.milestone
        : Math.min(MILESTONE_MAX, typeof player.level === "number" ? player.level : 1)
    ).label,
    // The milestone counter itself (the engine's one progression truth) + the
    // world-book display level. A Babel STATUS WINDOW reads these: displayLevel is
    // the "LEVEL n" the world speaks, milestone drives the tier and content gates.
    // No world-book map ⇒ displayLevel === milestone (identity).
    milestone: typeof player.milestone === "number"
      ? player.milestone
      : Math.min(MILESTONE_MAX, typeof player.level === "number" ? player.level : 1),
    displayLevel: displayLevelFor(
      typeof player.milestone === "number" ? player.milestone : Math.min(MILESTONE_MAX, typeof player.level === "number" ? player.level : 1),
      typeof player.xp === "number" ? player.xp : 0,
      run?.worldBook?.progressionMap
    ),
    // Babel hunter rank (spec §5 RMS); "UNASSESSED" until a ranked skill is held.
    // A display readout only — gates read the milestone, never this.
    rank: rankForPlayer(player),
    // Ranked-skill count — the SAME source rank is computed from (player.babelSkills),
    // so the STATUS WINDOW's skill count and RANK can never contradict each other.
    // The 5e 18-row skill table (player.skills) is NOT the Babel skill surface;
    // a Beckoned start has no ranked skills → count 0 + rank UNASSESSED. (Defect 4.)
    rankedSkillCount: Array.isArray(player.babelSkills)
      ? player.babelSkills.filter((s) => Number.isFinite(typeof s === "number" ? s : s?.rankIndex)).length
      : 0,
    // The player's Awakening Origin (Babel's race slot) + its feat, when set.
    origin: isString(player.origin) ? player.origin : null,
    originFeat: isString(player.originFeat) ? player.originFeat : null,
    // State contract fields:
    xp: typeof player.xp === "number" ? player.xp : 0,
    resources: { hp: hpGauge, mp: mpGauge },
    inventory: playerInventoryArray(run),
    // CONDITIONS (#26): each active condition with its effect text and minutes
    // remaining (null = persists until cleared), ticked against the world clock —
    // the STATUS WINDOW reads one truth, never recomputed client-side.
    conditions: conditionStatusPayload(run, run?.world?.time?.minutes),
    // WORLD CLOCK (#14): derived day / time-of-day / phase from the committed
    // world.time.minutes, so the STATUS WINDOW reads one truth (never recomputed
    // client-side). { day, clock:"HH:MM", phase, isNight, isDark, minuteOfDay }.
    worldTime: (() => {
      const minutes = run?.world?.time?.minutes;
      const c = deriveClock(typeof minutes === "number" ? minutes : (typeof run?.world?.time?.day === "number" ? (run.world.time.day - 1) * 1440 + 7 * 60 : 7 * 60));
      return { day: c.day, clock: c.hhmm, phase: c.phase, isNight: c.isNight, isDark: c.isDark, minuteOfDay: c.minuteOfDay };
    })(),
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
    // BABEL STATUS WINDOW spine (single source of truth — server/solo/babelStats.js):
    // the six canon stats (STR/DEX/VIT/Spirit/INT/Luck) derived from `abilities`
    // using the EXACT lookup the resolver does, so the value the WINDOW displays is
    // byte-identical to the value a check against that stat resolves against. Only
    // emitted for the Babel world-family; null elsewhere. NOTE: the legacy notdnd
    // `stats` vocab (alchemy/charm/…) is deliberately NOT surfaced here — it is
    // read by no resolver or display path, and its `spirit`/`luck` keys would
    // name-collide with the Babel canon while holding dead values (a lie surface).
    // It remains a persisted schema field (unread) pending a dedicated migration.
    babelStats: run?.world?.variant === "babel" ? babelStatBlock(player.abilities) : null,
    // Babel WINDOW skills, display-normalized (name/rank/stat/effect/provenance)
    // from the same records rankForPlayer reads. Null outside the Babel family.
    babelSkills: run?.world?.variant === "babel" ? babelSkillDetails(player.babelSkills) : null,
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

// C.12 — bridge the presence/minimap feature gap. The current LOCATION's
// discoverable features (location.searchDetails — the ruins structure, well,
// watchpoint, cache that Opus 1 placed) are projected onto the presence grid as
// battleMap.features, which the "Where you are" map renders. This is a DERIVED
// view of a single source (searchDetails), computed at scene-build and never
// stored, so it cannot drift. It is the right SCOPE for this map: searchDetails
// are in-LOCATION features, distinct from areaMap.pois which are region LOCATIONS.
// searchDetails carry no coordinates, so positions are SYNTHESIZED deterministically
// (a fixed spread ring around the player) — stable across renders. Honest to state:
// a location with no searchDetails (e.g. the tavern) projects zero features.
const PRESENCE_FEATURE_RING = [
  [-4, -3], [4, -3], [-4, 3], [4, 3], [0, -5], [0, 5], [-5, 0], [5, 0], [-3, -4], [3, 4]
];
function presenceFeatureKind(detailId, label) {
  const hay = `${detailId || ""} ${label || ""}`.toLowerCase();
  if (/ruin|\bhall\b|keep|stronghold|fort/.test(hay)) return "ruins";
  if (/well|water|spring|cistern|pool|font/.test(hay)) return "water";
  if (/watch|tower|spire|gate|signal|lookout|sentry/.test(hay)) return "structure";
  if (/cache|strongbox|hoard|stash|chest|vault|loot/.test(hay)) return "loot";
  if (/shrine|altar|idol|reliqu/.test(hay)) return "shrine";
  return "landmark";
}
function buildPresenceFeatures(location, centre) {
  const details = Array.isArray(location?.searchDetails) ? location.searchDetails : [];
  return details
    .filter((detail) => isPlainObject(detail) && (isString(detail.label) || isString(detail.detailId)))
    .slice(0, PRESENCE_FEATURE_RING.length)
    .map((detail, index) => {
      const [dx, dy] = PRESENCE_FEATURE_RING[index % PRESENCE_FEATURE_RING.length];
      return {
        kind: presenceFeatureKind(detail.detailId, detail.label),
        x: clampCell(centre + dx),
        y: clampCell(centre + dy),
        name: isString(detail.label) ? detail.label : detail.detailId
      };
    });
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

  const currentLocation = isPlainObject(run?.locations) ? run.locations[currentLocationId] : null;
  const features = buildPresenceFeatures(currentLocation, centre);

  return {
    width: typeof persisted.width === "number" ? persisted.width : BATTLE_MAP_SIZE,
    height: typeof persisted.height === "number" ? persisted.height : BATTLE_MAP_SIZE,
    tokens,
    features
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

// D.5 — the player-facing thread summary. Only non-terminal threads surface, and
// only what reveal state permits: id/kind/status/revealState always; title once
// not hidden; agenda once revealed. A hidden thread's agenda never leaves here.
function buildThreadsSummary(run) {
  const threads = isPlainObject(run?.threads) ? run.threads : {};
  const out = [];
  for (const thread of Object.values(threads)) {
    if (!isPlainObject(thread)) continue;
    if (thread.status === "resolved" || thread.status === "expired" || thread.status === "abandoned") continue;
    const revealState = thread.revealState || "hidden";
    const entry = { threadId: thread.threadId, kind: thread.kind, status: thread.status, revealState };
    if (revealState !== "hidden" && typeof thread.title === "string") entry.title = thread.title;
    if (revealState === "revealed" && typeof thread.agenda === "string") entry.agenda = thread.agenda;
    out.push(entry);
  }
  return out;
}

// D.4 — the live combat surface (or null). Emits the committed roster with enemy
// wound-bands alongside true HP (the client may show numbers; the narrator speaks
// bands). Player HP/AC are read from the player payload, never duplicated here.
function buildCombatSummary(run) {
  const combat = run?.combat;
  if (!isPlainObject(combat)) return null;
  const enemies = [];
  for (const [id, c] of Object.entries(combat.combatants || {})) {
    if (c?.kind !== "enemy") continue;
    const cur = c.hp?.current ?? 0;
    const max = c.hp?.max ?? 1;
    const band = cur <= 0 ? "down" : cur <= max / 2 ? "bloodied" : "steady";
    enemies.push({
      id,
      npcId: c.npcId,
      name: c.name || run?.npcs?.[c.npcId]?.displayName || "Enemy",
      hp: c.hp,
      hpBand: band,
      ac: c.ac,
      conditions: c.conditions || [],
      intent: combat.enemyIntents?.[id] || null
    });
  }
  return {
    combatId: combat.combatId,
    status: combat.status,
    round: combat.round,
    turnOrder: combat.turnOrder || [],
    turnIndex: combat.turnIndex ?? 0,
    enemies,
    outcome: combat.outcome ?? null
  };
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
    // World identity (worldgen-display): the player's CHOSEN/GENERATED world name
    // is the root of the scene breadcrumb and every "what realm is this" render.
    // Emitted here so the client stops falling back to the hardcoded "Ashenmoor"
    // (C.25) — run.world.name is the single source of truth.
    world: {
      name: isString(run.world?.name) ? run.world.name : "",
      tone: isString(run.world?.tone) ? run.world.tone : "",
      // World-family discriminator (e.g. "babel"). The client keys its STATUS
      // WINDOW off this — Babel renders the six-stat / rank / milestone panel
      // instead of the default D&D AC/Speed/Mana sheet. Empty for default worlds.
      variant: isString(run.world?.variant) ? run.world.variant : ""
    },
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
    // The paced opening BEAT SEQUENCE (authored set-piece): the client reveals
    // these one at a time so the VOICE lands as a sequence, not a scroll-wall.
    // Only at the opening moment; null when the run authors no beats (the client
    // then renders openingNarration whole).
    openingBeats: isOpeningMoment(run) && Array.isArray(run.openingBeats) && run.openingBeats.length
      ? run.openingBeats.filter((b) => isString(b))
      : null,
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
    // D.5 narrative substrate: a thin thread summary (id/kind/status/revealState).
    // Reveal discipline (§5.3): a title rides only when the thread is not hidden;
    // the agenda rides only when it is revealed. A hidden thread's agenda never
    // leaves the server. (The load-bearing invariant — hidden threads absent from
    // the GM PROMPT — is enforced in the narrativeDriver fold-in, not here.)
    threads: buildThreadsSummary(run),
    // Open, un-accepted job offers held by PRESENT NPCs (F2: an offer no one can
    // discover is dead content). Server-authored truth: the GM may voice these —
    // accepting one is a real committed transition (resolveQuestAccept).
    openJobOffers: buildOpenJobOffers(run),
    // The world's own most recent COMMITTED development (momentum engine), while
    // fresh — the GM context narrates it grounded; it is already real in state.
    recentDevelopment: getRecentDevelopment(run),
    // D.4 combat: the live fight (or null). The client renders true enemy numbers
    // from here; the narrator speaks in wound-bands. availableActions below already
    // swaps to the combat menu while active (getAvailableSoloActions is combat-aware).
    combat: buildCombatSummary(run),
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
