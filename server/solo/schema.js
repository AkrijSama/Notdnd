import crypto from "node:crypto";

export const SOLO_RUN_VERSION = 1;
export const EDITIONS = ["mainline", "forbidden"];
export const RULESET_IDS = ["notdnd_basic", "5e_srd", "custom"];
export const CONTENT_RATINGS = ["general", "teen", "mature", "adult"];
export const DISTRIBUTION_CHANNELS = ["web", "direct_apk", "play_store", "app_store", "steam"];
export const MAINLINE_BLOCKED_TAGS = [
  "explicit_sexual_content",
  "sexual_violence",
  "trafficking",
  "erotic_captivity",
  "sexual_slavery",
  "nonconsensual_sexual_content",
  "forced_pregnancy",
  "explicit_anatomy"
];
export const FORBIDDEN_BLOCKED_TAGS = [
  "sexual_violence",
  "trafficking",
  "sexual_slavery",
  "nonconsensual_sexual_content",
  "forced_pregnancy"
];

const RUN_STATUSES = new Set(["active", "completed", "abandoned"]);
const EDITION_VALUES = new Set(EDITIONS);
const RULESET_VALUES = new Set(RULESET_IDS);
const CONTENT_RATING_VALUES = new Set(CONTENT_RATINGS);
const DISTRIBUTION_CHANNEL_VALUES = new Set(DISTRIBUTION_CHANNELS);
const IMAGE_TARGET_TYPES = new Set(["location", "npc", "item", "playerAsset", "scene"]);
const IMAGE_STATUSES = new Set(["placeholder", "queued", "generated", "failed"]);
const PLAYER_ASSET_TYPES = new Set(["base", "fortress", "lab", "room", "structure", "other"]);
const QUEST_STATUSES = new Set(["inactive", "active", "completed", "failed"]);
const REQUIRED_PLAYER_STATS = ["alchemy", "charm", "cunning", "might", "spirit", "luck"];
const PLAYER_ABILITIES = ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"];
const PLAYER_SKILLS = ["investigation", "perception", "stealth", "persuasion", "insight"];
const REQUIRED_RELATIONSHIP_METERS = ["trust", "affection", "fear", "debt", "suspicion", "loyalty", "rivalry"];

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

function isOptionalString(value) {
  return value === undefined || value === null || typeof value === "string";
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isBoolean(value) {
  return typeof value === "boolean";
}

function isIsoTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function validateRequiredString(value, path, errors) {
  if (!isString(value)) {
    push(errors, path, "Expected non-empty string");
  }
}

function validateOptionalString(value, path, errors) {
  if (!isOptionalString(value)) {
    push(errors, path, "Expected string or null");
  }
}

function validateNumber(value, path, errors) {
  if (!isNumber(value)) {
    push(errors, path, "Expected number");
  }
}

function validateOptionalNumber(value, path, errors) {
  if (value !== undefined && value !== null && !isNumber(value)) {
    push(errors, path, "Expected number");
  }
}

function validateBoolean(value, path, errors) {
  if (!isBoolean(value)) {
    push(errors, path, "Expected boolean");
  }
}

function validateArray(value, path, errors) {
  if (!Array.isArray(value)) {
    push(errors, path, "Expected array");
  }
}

function validateStringArray(value, path, errors) {
  if (!Array.isArray(value)) {
    push(errors, path, "Expected array");
    return;
  }
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      push(errors, `${path}.${index}`, "Expected non-empty string");
    }
  });
}

function validateObject(value, path, errors) {
  if (!isPlainObject(value)) {
    push(errors, path, "Expected object");
  }
}

function validateOptionalObject(value, path, errors) {
  if (value !== undefined && value !== null && !isPlainObject(value)) {
    push(errors, path, "Expected object");
  }
}

function validateTimestamp(value, path, errors) {
  if (!isIsoTimestamp(value)) {
    push(errors, path, "Expected ISO timestamp");
  }
}

function validateOptionalTimestamp(value, path, errors) {
  if (value !== undefined && value !== null && !isIsoTimestamp(value)) {
    push(errors, path, "Expected ISO timestamp");
  }
}

function validateEnum(value, allowed, path, errors) {
  if (!allowed.has(value)) {
    push(errors, path, `Expected one of: ${[...allowed].join(", ")}`);
  }
}

function validateOptionalEdition(value, path, errors) {
  if (value !== undefined && value !== null) {
    validateEnum(value, EDITION_VALUES, path, errors);
  }
}

function validateContentMetadata(entity, errors) {
  validateOptionalEdition(entity.edition, "edition", errors);
  validateOptionalString(entity.policyProfileId, "policyProfileId", errors);
  if (entity.contentTags !== undefined) {
    validateStringArray(entity.contentTags, "contentTags", errors);
  }
}

function validateNumberRecord(value, path, requiredKeys, errors) {
  if (value === undefined || value === null) {
    return;
  }
  if (!isPlainObject(value)) {
    push(errors, path, "Expected object");
    return;
  }
  for (const key of requiredKeys) {
    validateNumber(value[key], `${path}.${key}`, errors);
  }
}

function validateRecord(value, path, errors, validator) {
  if (!isPlainObject(value)) {
    push(errors, path, "Expected object");
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const entryResult = validator(entry);
    for (const error of entryResult.errors) {
      push(errors, `${path}.${key}.${error.path}`, error.message);
    }
  }
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

function generatedId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function validateSearchDetail(detail) {
  const errors = [];
  if (!isPlainObject(detail)) {
    push(errors, "detail", "Expected object");
    return result(errors);
  }

  validateRequiredString(detail.detailId, "detailId", errors);
  validateRequiredString(detail.label, "label", errors);
  validateRequiredString(detail.description, "description", errors);
  if (detail.revealed !== undefined) {
    validateBoolean(detail.revealed, "revealed", errors);
  }
  if (detail.check !== undefined) {
    if (!isPlainObject(detail.check)) {
      push(errors, "check", "Expected object");
    } else {
      validateOptionalString(detail.check.checkId, "check.checkId", errors);
      validateOptionalString(detail.check.rulesetId, "check.rulesetId", errors);
      validateRequiredString(detail.check.ability, "check.ability", errors);
      validateOptionalString(detail.check.skill, "check.skill", errors);
      validateNumber(detail.check.dc, "check.dc", errors);
      if (detail.check.advantage !== undefined) {
        validateBoolean(detail.check.advantage, "check.advantage", errors);
      }
      if (detail.check.disadvantage !== undefined) {
        validateBoolean(detail.check.disadvantage, "check.disadvantage", errors);
      }
    }
  }
  validateStringArray(detail.contentTags || [], "contentTags", errors);
  validateStringArray(detail.linkedEntityIds || [], "linkedEntityIds", errors);
  validateStringArray(detail.linkedMemoryFactIds || [], "linkedMemoryFactIds", errors);
  validateContentMetadata(detail, errors);

  return result(errors);
}

export function validatePlayerState(player) {
  const errors = [];
  if (!isPlainObject(player)) {
    push(errors, "player", "Expected object");
    return result(errors);
  }

  validateRequiredString(player.playerId, "playerId", errors);
  validateRequiredString(player.displayName, "displayName", errors);
  validateNumber(player.level, "level", errors);
  validateNumber(player.health, "health", errors);
  validateNumber(player.maxHealth, "maxHealth", errors);
  validateNumber(player.gold, "gold", errors);
  validateNumber(player.reputation, "reputation", errors);

  if (!isPlainObject(player.stats)) {
    push(errors, "stats", "Expected object");
  } else {
    for (const stat of REQUIRED_PLAYER_STATS) {
      validateNumber(player.stats[stat], `stats.${stat}`, errors);
    }
  }

  validateStringArray(player.tags, "tags", errors);
  validateObject(player.flags, "flags", errors);
  validateOptionalString(player.rulesetId, "rulesetId", errors);
  if (player.rulesetId !== undefined && player.rulesetId !== null) {
    validateEnum(player.rulesetId, RULESET_VALUES, "rulesetId", errors);
  }
  validateNumberRecord(player.abilities, "abilities", PLAYER_ABILITIES, errors);
  validateNumberRecord(player.skills, "skills", PLAYER_SKILLS, errors);

  return result(errors);
}

export function validateWorldState(world) {
  const errors = [];
  if (!isPlainObject(world)) {
    push(errors, "world", "Expected object");
    return result(errors);
  }

  validateRequiredString(world.worldId, "worldId", errors);
  validateRequiredString(world.name, "name", errors);

  if (!isPlainObject(world.time)) {
    push(errors, "time", "Expected object");
  } else {
    validateNumber(world.time.day, "time.day", errors);
    validateNumber(world.time.tick, "time.tick", errors);
    validateOptionalTimestamp(world.time.lastAdvancedAt, "time.lastAdvancedAt", errors);
  }

  validateObject(world.flags, "flags", errors);
  validateStringArray(world.tags, "tags", errors);

  return result(errors);
}

export function validateLocation(location) {
  const errors = [];
  if (!isPlainObject(location)) {
    push(errors, "location", "Expected object");
    return result(errors);
  }

  validateRequiredString(location.locationId, "locationId", errors);
  validateRequiredString(location.name, "name", errors);
  validateRequiredString(location.description, "description", errors);
  validateStringArray(location.connectedLocationIds, "connectedLocationIds", errors);

  if (!isPlainObject(location.state)) {
    push(errors, "state", "Expected object");
  } else {
    validateBoolean(location.state.visited, "state.visited", errors);
    validateBoolean(location.state.discovered, "state.discovered", errors);
    validateOptionalNumber(location.state.dangerLevel, "state.dangerLevel", errors);
  }

  validateStringArray(location.memoryFactIds, "memoryFactIds", errors);
  validateOptionalString(location.imageAssetId, "imageAssetId", errors);
  validateStringArray(location.tags, "tags", errors);
  validateObject(location.flags, "flags", errors);
  validateContentMetadata(location, errors);

  if (location.searchDetails !== undefined) {
    if (!Array.isArray(location.searchDetails)) {
      push(errors, "searchDetails", "Expected array");
    } else {
      const seenDetailIds = new Set();
      location.searchDetails.forEach((detail, index) => {
        appendNestedErrors(errors, `searchDetails.${index}`, validateSearchDetail(detail));
        if (isPlainObject(detail) && isString(detail.detailId)) {
          if (seenDetailIds.has(detail.detailId)) {
            push(errors, `searchDetails.${index}.detailId`, "Duplicate search detail id");
          }
          seenDetailIds.add(detail.detailId);
        }
      });
    }
  }

  return result(errors);
}

export function validateLocationGraph(locations, options = {}) {
  const errors = [];
  const allowSelfConnections = options.allowSelfConnections === true;

  if (!isPlainObject(locations)) {
    push(errors, "locations", "Expected object");
    return result(errors);
  }

  for (const [key, location] of Object.entries(locations)) {
    appendNestedErrors(errors, `locations.${key}`, validateLocation(location));

    if (!isPlainObject(location)) {
      continue;
    }

    if (isString(location.locationId) && key !== location.locationId) {
      push(errors, `locations.${key}.locationId`, "Location key must match locationId");
    }

    if (!Array.isArray(location.connectedLocationIds)) {
      continue;
    }

    const seenConnections = new Set();
    location.connectedLocationIds.forEach((connectedLocationId, index) => {
      const path = `locations.${key}.connectedLocationIds.${index}`;
      if (typeof connectedLocationId !== "string" || !connectedLocationId.trim()) {
        return;
      }

      if (seenConnections.has(connectedLocationId)) {
        push(errors, path, "Duplicate connection");
      }
      seenConnections.add(connectedLocationId);

      if (!allowSelfConnections && connectedLocationId === location.locationId) {
        push(errors, path, "Self-connections are not allowed");
      }

      if (!locations[connectedLocationId]) {
        push(errors, path, "Connected location does not exist");
      }
    });
  }

  if (
    options.currentLocationId !== undefined &&
    options.currentLocationId !== null &&
    isString(options.currentLocationId) &&
    !locations[options.currentLocationId]
  ) {
    push(errors, "currentLocationId", "Location does not exist in locations");
  }

  return result(errors);
}

export function validateNpc(npc) {
  const errors = [];
  if (!isPlainObject(npc)) {
    push(errors, "npc", "Expected object");
    return result(errors);
  }

  validateRequiredString(npc.npcId, "npcId", errors);
  validateRequiredString(npc.displayName, "displayName", errors);
  validateRequiredString(npc.role, "role", errors);
  validateOptionalString(npc.currentLocationId, "currentLocationId", errors);
  validateBoolean(npc.known, "known", errors);
  validateRequiredString(npc.status, "status", errors);
  validateStringArray(npc.memoryFactIds, "memoryFactIds", errors);
  validateOptionalString(npc.imageAssetId, "imageAssetId", errors);
  validateStringArray(npc.tags, "tags", errors);
  validateObject(npc.flags, "flags", errors);
  validateContentMetadata(npc, errors);

  return result(errors);
}

export function validateRelationship(relationship) {
  const errors = [];
  if (!isPlainObject(relationship)) {
    push(errors, "relationship", "Expected object");
    return result(errors);
  }

  validateRequiredString(relationship.relationshipId, "relationshipId", errors);
  validateRequiredString(relationship.sourceEntityId, "sourceEntityId", errors);
  validateRequiredString(relationship.targetEntityId, "targetEntityId", errors);

  if (!isPlainObject(relationship.meters)) {
    push(errors, "meters", "Expected object");
  } else {
    for (const meter of REQUIRED_RELATIONSHIP_METERS) {
      validateNumber(relationship.meters[meter], `meters.${meter}`, errors);
    }
  }

  validateStringArray(relationship.memoryFactIds, "memoryFactIds", errors);
  validateObject(relationship.flags, "flags", errors);

  return result(errors);
}

export function validateMemoryFact(fact) {
  const errors = [];
  if (!isPlainObject(fact)) {
    push(errors, "fact", "Expected object");
    return result(errors);
  }

  validateRequiredString(fact.factId, "factId", errors);
  validateStringArray(fact.entityIds, "entityIds", errors);
  validateRequiredString(fact.type, "type", errors);
  validateRequiredString(fact.text, "text", errors);
  validateRequiredString(fact.source, "source", errors);
  validateTimestamp(fact.createdAt, "createdAt", errors);
  validateOptionalTimestamp(fact.updatedAt, "updatedAt", errors);
  validateStringArray(fact.tags, "tags", errors);
  validateBoolean(fact.canonical, "canonical", errors);
  validateOptionalNumber(fact.confidence, "confidence", errors);
  if (fact.supersedesFactIds !== undefined) {
    validateStringArray(fact.supersedesFactIds, "supersedesFactIds", errors);
  }
  validateContentMetadata(fact, errors);

  return result(errors);
}

export function validateTimelineEvent(event) {
  const errors = [];
  if (!isPlainObject(event)) {
    push(errors, "event", "Expected object");
    return result(errors);
  }

  validateRequiredString(event.eventId, "eventId", errors);
  validateRequiredString(event.type, "type", errors);
  validateRequiredString(event.title, "title", errors);
  validateRequiredString(event.summary, "summary", errors);
  validateTimestamp(event.createdAt, "createdAt", errors);
  validateOptionalString(event.locationId, "locationId", errors);
  validateStringArray(event.entityIds, "entityIds", errors);
  validateStringArray(event.memoryFactIds, "memoryFactIds", errors);
  validateStringArray(event.tags, "tags", errors);
  validateOptionalObject(event.payload, "payload", errors);
  validateContentMetadata(event, errors);

  return result(errors);
}

export function validateImageAsset(asset) {
  const errors = [];
  if (!isPlainObject(asset)) {
    push(errors, "asset", "Expected object");
    return result(errors);
  }

  validateRequiredString(asset.assetId, "assetId", errors);
  validateEnum(asset.targetType, IMAGE_TARGET_TYPES, "targetType", errors);
  validateRequiredString(asset.targetId, "targetId", errors);
  validateEnum(asset.status, IMAGE_STATUSES, "status", errors);
  validateOptionalString(asset.promptSummary, "promptSummary", errors);
  validateOptionalString(asset.uri, "uri", errors);
  validateNumber(asset.version, "version", errors);
  validateTimestamp(asset.createdAt, "createdAt", errors);
  validateOptionalTimestamp(asset.updatedAt, "updatedAt", errors);
  validateStringArray(asset.tags, "tags", errors);
  validateObject(asset.flags, "flags", errors);
  validateContentMetadata(asset, errors);

  return result(errors);
}

export function validatePlayerAsset(asset) {
  const errors = [];
  if (!isPlainObject(asset)) {
    push(errors, "asset", "Expected object");
    return result(errors);
  }

  validateRequiredString(asset.assetId, "assetId", errors);
  validateEnum(asset.type, PLAYER_ASSET_TYPES, "type", errors);
  validateRequiredString(asset.name, "name", errors);
  validateOptionalString(asset.locationId, "locationId", errors);
  validateNumber(asset.level, "level", errors);
  validateObject(asset.components, "components", errors);
  validateObject(asset.resources, "resources", errors);
  validateStringArray(asset.memoryFactIds, "memoryFactIds", errors);
  validateOptionalString(asset.imageAssetId, "imageAssetId", errors);
  validateStringArray(asset.tags, "tags", errors);
  validateObject(asset.flags, "flags", errors);
  validateContentMetadata(asset, errors);

  return result(errors);
}

export function validateQuestState(quest) {
  const errors = [];
  if (!isPlainObject(quest)) {
    push(errors, "quest", "Expected object");
    return result(errors);
  }

  validateRequiredString(quest.questId, "questId", errors);
  validateEnum(quest.status, QUEST_STATUSES, "status", errors);
  validateNumber(quest.stage, "stage", errors);
  validateStringArray(quest.relatedEntityIds, "relatedEntityIds", errors);
  validateStringArray(quest.memoryFactIds, "memoryFactIds", errors);
  validateObject(quest.flags, "flags", errors);
  validateContentMetadata(quest, errors);

  return result(errors);
}

export function validateInventoryItem(item) {
  const errors = [];
  if (!isPlainObject(item)) {
    push(errors, "item", "Expected object");
    return result(errors);
  }

  validateRequiredString(item.itemId, "itemId", errors);
  validateOptionalString(item.templateId, "templateId", errors);
  validateRequiredString(item.name, "name", errors);
  validateNumber(item.quantity, "quantity", errors);
  validateStringArray(item.tags, "tags", errors);
  validateObject(item.flags, "flags", errors);
  validateOptionalString(item.imageAssetId, "imageAssetId", errors);
  validateContentMetadata(item, errors);

  return result(errors);
}

export function validatePolicyProfile(profile) {
  const errors = [];
  if (!isPlainObject(profile)) {
    push(errors, "policyProfile", "Expected object");
    return result(errors);
  }

  validateRequiredString(profile.policyProfileId, "policyProfileId", errors);
  validateEnum(profile.edition, EDITION_VALUES, "edition", errors);
  validateEnum(profile.contentRating, CONTENT_RATING_VALUES, "contentRating", errors);
  validateStringArray(profile.distributionChannels, "distributionChannels", errors);
  if (Array.isArray(profile.distributionChannels)) {
    profile.distributionChannels.forEach((channel, index) => {
      if (!DISTRIBUTION_CHANNEL_VALUES.has(channel)) {
        push(errors, `distributionChannels.${index}`, `Expected one of: ${DISTRIBUTION_CHANNELS.join(", ")}`);
      }
    });
  }
  validateBoolean(profile.ageGateRequired, "ageGateRequired", errors);
  validateStringArray(profile.allowedTags, "allowedTags", errors);
  validateStringArray(profile.blockedTags, "blockedTags", errors);
  validateOptionalString(profile.aiPromptProfileId, "aiPromptProfileId", errors);
  validateOptionalString(profile.imagePolicyProfileId, "imagePolicyProfileId", errors);
  validateObject(profile.flags, "flags", errors);

  return result(errors);
}

export function validateEntityAgainstPolicy(entity, policyProfile) {
  const errors = [];
  const policyValidation = validatePolicyProfile(policyProfile);
  if (!policyValidation.ok) {
    for (const error of policyValidation.errors) {
      push(errors, `policyProfile.${error.path}`, error.message);
    }
    return result(errors);
  }

  if (!isPlainObject(entity)) {
    push(errors, "entity", "Expected object");
    return result(errors);
  }

  const tags = Array.isArray(entity.contentTags) ? entity.contentTags : [];
  const blocked = new Set(policyProfile.blockedTags || []);
  tags.forEach((tag, index) => {
    if (blocked.has(tag)) {
      push(errors, `contentTags.${index}`, `Blocked by policy profile: ${tag}`);
    }
  });

  if (entity.edition !== undefined && entity.edition !== null && entity.edition !== policyProfile.edition) {
    push(errors, "edition", "Entity edition does not match policy profile edition");
  }

  return result(errors);
}

export function validateSoloRun(run) {
  const errors = [];
  if (!isPlainObject(run)) {
    push(errors, "run", "Expected object");
    return result(errors);
  }

  validateRequiredString(run.runId, "runId", errors);
  validateOptionalString(run.userId, "userId", errors);
  validateEnum(run.status, RUN_STATUSES, "status", errors);
  validateTimestamp(run.createdAt, "createdAt", errors);
  validateTimestamp(run.updatedAt, "updatedAt", errors);
  validateRequiredString(run.worldSeed, "worldSeed", errors);
  validateRequiredString(run.currentLocationId, "currentLocationId", errors);
  validateEnum(run.edition, EDITION_VALUES, "edition", errors);
  validateRequiredString(run.policyProfileId, "policyProfileId", errors);
  validateEnum(run.rulesetId ?? "notdnd_basic", RULESET_VALUES, "rulesetId", errors);
  validateNumber(run.version, "version", errors);
  if (run.version !== SOLO_RUN_VERSION) {
    push(errors, "version", `Expected version ${SOLO_RUN_VERSION}`);
  }

  for (const [path, value] of [
    ["locations", run.locations],
    ["npcs", run.npcs],
    ["relationships", run.relationships],
    ["inventory", run.inventory],
    ["quests", run.quests],
    ["playerAssets", run.playerAssets],
    ["imageAssets", run.imageAssets],
    ["flags", run.flags]
  ]) {
    validateObject(value, path, errors);
  }

  appendNestedErrors(errors, "player", validatePlayerState(run.player));
  appendNestedErrors(errors, "world", validateWorldState(run.world));
  appendFlatErrors(errors, validateLocationGraph(run.locations, { currentLocationId: run.currentLocationId }));
  validateRecord(run.npcs, "npcs", errors, validateNpc);
  validateRecord(run.relationships, "relationships", errors, validateRelationship);
  validateRecord(run.inventory, "inventory", errors, validateInventoryItem);
  validateRecord(run.quests, "quests", errors, validateQuestState);
  validateRecord(run.playerAssets, "playerAssets", errors, validatePlayerAsset);
  validateRecord(run.imageAssets, "imageAssets", errors, validateImageAsset);

  if (!Array.isArray(run.memoryFacts)) {
    push(errors, "memoryFacts", "Expected array");
  } else {
    run.memoryFacts.forEach((fact, index) => appendNestedErrors(errors, `memoryFacts.${index}`, validateMemoryFact(fact)));
  }

  if (!Array.isArray(run.timeline)) {
    push(errors, "timeline", "Expected array");
  } else {
    run.timeline.forEach((event, index) => appendNestedErrors(errors, `timeline.${index}`, validateTimelineEvent(event)));
  }

  const knownEntityIds = new Set([
    run.runId,
    run.player?.playerId,
    ...Object.keys(run.locations || {}),
    ...Object.keys(run.npcs || {}),
    ...Object.keys(run.inventory || {}),
    ...Object.keys(run.playerAssets || {})
  ].filter(Boolean));
  const knownFactIds = new Set(Array.isArray(run.memoryFacts) ? run.memoryFacts.map((fact) => fact.factId).filter(Boolean) : []);
  for (const [locationId, location] of Object.entries(run.locations || {})) {
    if (!Array.isArray(location?.searchDetails)) {
      continue;
    }
    location.searchDetails.forEach((detail, detailIndex) => {
      (detail.linkedEntityIds || []).forEach((entityId, entityIndex) => {
        if (!knownEntityIds.has(entityId)) {
          push(errors, `locations.${locationId}.searchDetails.${detailIndex}.linkedEntityIds.${entityIndex}`, "Linked entity does not exist");
        }
      });
      (detail.linkedMemoryFactIds || []).forEach((factId, factIndex) => {
        if (!knownFactIds.has(factId)) {
          push(errors, `locations.${locationId}.searchDetails.${detailIndex}.linkedMemoryFactIds.${factIndex}`, "Linked memory fact does not exist");
        }
      });
    });
  }

  return result(errors);
}

function appendNestedErrors(errors, prefix, validation) {
  for (const error of validation.errors) {
    push(errors, `${prefix}.${error.path}`, error.message);
  }
}

function appendFlatErrors(errors, validation) {
  for (const error of validation.errors) {
    push(errors, error.path, error.message);
  }
}

export function createDefaultLocationGraph(options = {}) {
  const creationFactId = isString(options.creationFactId) ? options.creationFactId : null;

  return {
    start_location: {
      locationId: "start_location",
      name: "Start Location",
      description: "Neutral placeholder starting location.",
      connectedLocationIds: ["second_location"],
      state: {
        visited: true,
        discovered: true
      },
      memoryFactIds: creationFactId ? [creationFactId] : [],
      tags: ["placeholder"],
      edition: "mainline",
      policyProfileId: "mainline_default",
      contentTags: [],
      searchDetails: [
        {
          detailId: "start_location_scuffed_mark",
          label: "Scuffed Mark",
          description: "A scuffed mark is visible near the edge of the path.",
          revealed: false,
          contentTags: [],
          linkedEntityIds: ["start_location"],
          linkedMemoryFactIds: [],
          edition: "mainline",
          policyProfileId: "mainline_default"
        }
      ],
      flags: {}
    },
    second_location: {
      locationId: "second_location",
      name: "Second Location",
      description: "Neutral placeholder connected location.",
      connectedLocationIds: ["start_location", "third_location"],
      state: {
        visited: false,
        discovered: true
      },
      memoryFactIds: [],
      tags: ["placeholder"],
      edition: "mainline",
      policyProfileId: "mainline_default",
      contentTags: [],
      flags: {}
    },
    third_location: {
      locationId: "third_location",
      name: "Third Location",
      description: "Neutral placeholder distant location.",
      connectedLocationIds: ["second_location"],
      state: {
        visited: false,
        discovered: false
      },
      memoryFactIds: [],
      tags: ["placeholder"],
      edition: "mainline",
      policyProfileId: "mainline_default",
      contentTags: [],
      flags: {}
    }
  };
}

export function createDefaultSoloRun(options = {}) {
  const timestamp = isoFromOption(options.now);
  const runId = isString(options.runId) ? options.runId : generatedId("run");
  const userId = options.userId === undefined ? null : options.userId;
  const worldSeed = isString(options.worldSeed) ? options.worldSeed : generatedId("seed");
  const currentLocationId = "start_location";
  const playerId = "player";
  const creationFactId = "fact_run_created";

  return {
    runId,
    userId,
    status: "active",
    edition: "mainline",
    policyProfileId: "mainline_default",
    rulesetId: "notdnd_basic",
    createdAt: timestamp,
    updatedAt: timestamp,
    worldSeed,
    currentLocationId,
    player: {
      playerId,
      displayName: isString(options.displayName) ? options.displayName : "Player",
      level: 1,
      health: 10,
      maxHealth: 10,
      gold: 0,
      reputation: 0,
      stats: {
        alchemy: 0,
        charm: 0,
        cunning: 0,
        might: 0,
        spirit: 0,
        luck: 0
      },
      rulesetId: "notdnd_basic",
      abilities: {
        strength: 10,
        dexterity: 10,
        constitution: 10,
        intelligence: 10,
        wisdom: 10,
        charisma: 10
      },
      skills: {
        investigation: 0,
        perception: 0,
        stealth: 0,
        persuasion: 0,
        insight: 0
      },
      tags: [],
      flags: {}
    },
    world: {
      worldId: "world",
      name: "Placeholder World",
      time: {
        day: 1,
        tick: 0
      },
      flags: {},
      tags: []
    },
    locations: createDefaultLocationGraph({ creationFactId }),
    npcs: {},
    relationships: {},
    inventory: {},
    quests: {},
    playerAssets: {},
    imageAssets: {},
    memoryFacts: [
      {
        factId: creationFactId,
        entityIds: [runId, playerId, currentLocationId],
        type: "run_created",
        text: "Solo run created with a neutral placeholder starting state.",
        source: "system",
        createdAt: timestamp,
        tags: ["system", "placeholder"],
        edition: "mainline",
        policyProfileId: "mainline_default",
        contentTags: [],
        canonical: true,
        confidence: 1,
        supersedesFactIds: []
      }
    ],
    timeline: [
      {
        eventId: "event_run_created",
        type: "run_created",
        title: "Run Created",
        summary: "Solo run initialized with a neutral placeholder starting state.",
        createdAt: timestamp,
        locationId: currentLocationId,
        entityIds: [runId, playerId, currentLocationId],
        memoryFactIds: [creationFactId],
        tags: ["system", "placeholder"],
        edition: "mainline",
        policyProfileId: "mainline_default",
        contentTags: [],
        payload: {}
      }
    ],
    flags: {},
    version: SOLO_RUN_VERSION
  };
}

export function createDefaultMainlinePolicyProfile() {
  return {
    policyProfileId: "mainline_default",
    edition: "mainline",
    contentRating: "teen",
    distributionChannels: ["web", "play_store", "app_store"],
    ageGateRequired: false,
    allowedTags: ["dark_fantasy", "romance", "fade_to_black", "danger", "betrayal"],
    blockedTags: [...MAINLINE_BLOCKED_TAGS],
    aiPromptProfileId: null,
    imagePolicyProfileId: null,
    flags: {}
  };
}

export function createDefaultForbiddenPolicyProfile() {
  return {
    policyProfileId: "forbidden_default",
    edition: "forbidden",
    contentRating: "adult",
    distributionChannels: ["web", "direct_apk", "steam"],
    ageGateRequired: true,
    allowedTags: ["dark_fantasy", "romance", "fade_to_black", "danger", "betrayal", "adult_themes"],
    blockedTags: [...FORBIDDEN_BLOCKED_TAGS],
    aiPromptProfileId: null,
    imagePolicyProfileId: null,
    flags: {}
  };
}
