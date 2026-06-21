import {
  createDefaultForbiddenPolicyProfile,
  createDefaultMainlinePolicyProfile,
  validateEntityAgainstPolicy,
  validateSoloRun
} from "./schema.js";

const ENTITY_TYPES = new Set(["player", "party_member", "npc", "item", "location_object", "player_asset", "exit", "other"]);

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

function validateBoolean(value, path, errors) {
  if (typeof value !== "boolean") {
    push(errors, path, "Expected boolean");
  }
}

function validateObject(value, path, errors) {
  if (!isPlainObject(value)) {
    push(errors, path, "Expected object");
  }
}

function policyProfileForRun(run) {
  return run?.edition === "forbidden" ? createDefaultForbiddenPolicyProfile() : createDefaultMainlinePolicyProfile();
}

function visibleUnderPolicy(entity, policyProfile) {
  const policy = validateEntityAgainstPolicy(entity, policyProfile);
  return policy.ok;
}

function memoryFactsFor(run, ids = []) {
  const wanted = new Set(ids || []);
  return (run.memoryFacts || []).filter((fact) => wanted.has(fact.factId));
}

function relationshipsFor(run, entityId, rawId = entityId) {
  return Object.values(run.relationships || {}).filter((relationship) => {
    return (
      relationship.sourceEntityId === entityId ||
      relationship.targetEntityId === entityId ||
      relationship.sourceEntityId === rawId ||
      relationship.targetEntityId === rawId
    );
  });
}

function locationEntity(location) {
  return {
    entityId: `location:${location.locationId}`,
    entityType: "location_object",
    displayName: location.name,
    summary: "Current location",
    locationId: location.locationId,
    visible: true,
    inspectable: true,
    imageAssetId: location.imageAssetId ?? null,
    memoryFactIds: location.memoryFactIds || [],
    actionTypes: ["inspect"],
    edition: location.edition,
    policyProfileId: location.policyProfileId,
    contentTags: location.contentTags || [],
    tags: location.tags || [],
    flags: {}
  };
}

function playerEntity(player, currentLocationId) {
  return {
    entityId: `player:${player.playerId}`,
    entityType: "player",
    displayName: player.displayName,
    summary: "Player character",
    locationId: currentLocationId,
    visible: true,
    inspectable: true,
    imageAssetId: null,
    memoryFactIds: [],
    actionTypes: ["inspect"],
    contentTags: [],
    tags: player.tags || [],
    flags: player.flags || {}
  };
}

function npcEntity(npc, relationshipId = null) {
  return {
    entityId: `npc:${npc.npcId}`,
    entityType: "npc",
    displayName: npc.displayName,
    summary: npc.role,
    locationId: npc.currentLocationId ?? null,
    visible: npc.known !== false,
    inspectable: true,
    imageAssetId: npc.imageAssetId ?? null,
    relationshipId,
    memoryFactIds: npc.memoryFactIds || [],
    actionTypes: ["inspect", "talk"],
    edition: npc.edition,
    policyProfileId: npc.policyProfileId,
    contentTags: npc.contentTags || [],
    tags: npc.tags || [],
    flags: npc.flags || {}
  };
}

function exitEntity(location) {
  return {
    entityId: `exit:${location.locationId}`,
    entityType: "exit",
    displayName: location.name,
    summary: "Connected location",
    locationId: location.locationId,
    visible: true,
    inspectable: false,
    imageAssetId: location.imageAssetId ?? null,
    memoryFactIds: location.memoryFactIds || [],
    actionTypes: ["move"],
    edition: location.edition,
    policyProfileId: location.policyProfileId,
    contentTags: location.contentTags || [],
    tags: location.tags || [],
    flags: {}
  };
}

function playerAssetEntity(asset) {
  return {
    entityId: `player_asset:${asset.assetId}`,
    entityType: "player_asset",
    displayName: asset.name,
    summary: asset.type,
    locationId: asset.locationId ?? null,
    visible: true,
    inspectable: true,
    imageAssetId: asset.imageAssetId ?? null,
    memoryFactIds: asset.memoryFactIds || [],
    actionTypes: ["inspect"],
    edition: asset.edition,
    policyProfileId: asset.policyProfileId,
    contentTags: asset.contentTags || [],
    tags: asset.tags || [],
    flags: asset.flags || {}
  };
}

function relationshipIdForNpc(run, npcId) {
  const relationship = Object.values(run.relationships || {}).find((entry) => {
    return entry.sourceEntityId === npcId || entry.targetEntityId === npcId || entry.sourceEntityId === `npc:${npcId}` || entry.targetEntityId === `npc:${npcId}`;
  });
  return relationship?.relationshipId || null;
}

export function validateVisibleEntity(entity) {
  const errors = [];
  if (!isPlainObject(entity)) {
    push(errors, "entity", "Expected object");
    return result(errors);
  }

  if (!isString(entity.entityId)) {
    push(errors, "entityId", "Expected non-empty string");
  }
  if (!ENTITY_TYPES.has(entity.entityType)) {
    push(errors, "entityType", `Expected one of: ${[...ENTITY_TYPES].join(", ")}`);
  }
  if (!isString(entity.displayName)) {
    push(errors, "displayName", "Expected non-empty string");
  }
  if (entity.summary !== undefined && entity.summary !== null && typeof entity.summary !== "string") {
    push(errors, "summary", "Expected string");
  }
  if (!isOptionalString(entity.locationId)) {
    push(errors, "locationId", "Expected string or null");
  }
  validateBoolean(entity.visible, "visible", errors);
  validateBoolean(entity.inspectable, "inspectable", errors);
  if (!isOptionalString(entity.imageAssetId)) {
    push(errors, "imageAssetId", "Expected string or null");
  }
  if (!isOptionalString(entity.relationshipId)) {
    push(errors, "relationshipId", "Expected string or null");
  }
  validateStringArray(entity.memoryFactIds, "memoryFactIds", errors);
  validateStringArray(entity.actionTypes, "actionTypes", errors);
  validateStringArray(entity.contentTags || [], "contentTags", errors);
  validateStringArray(entity.tags, "tags", errors);
  validateObject(entity.flags, "flags", errors);

  return result(errors);
}

export function filterEntitiesForPolicy(entities, policyProfile) {
  return entities.filter((entity) => entity.visible && visibleUnderPolicy(entity, policyProfile));
}

export function getVisibleEntities(run, options = {}) {
  const validation = validateSoloRun(run);
  if (!validation.ok) {
    return [];
  }

  const currentLocation = run.locations[run.currentLocationId];
  if (!currentLocation) {
    return [];
  }

  const entities = [
    locationEntity(currentLocation),
    playerEntity(run.player, run.currentLocationId)
  ];

  for (const npc of Object.values(run.npcs || {})) {
    if (npc.currentLocationId === run.currentLocationId) {
      entities.push(npcEntity(npc, relationshipIdForNpc(run, npc.npcId)));
    }
  }

  for (const asset of Object.values(run.playerAssets || {})) {
    if (asset.locationId === run.currentLocationId) {
      entities.push(playerAssetEntity(asset));
    }
  }

  for (const connectedLocationId of currentLocation.connectedLocationIds || []) {
    const connected = run.locations[connectedLocationId];
    if (connected) {
      entities.push(exitEntity(connected));
    }
  }

  const policyProfile = options.policyProfile || policyProfileForRun(run);
  return filterEntitiesForPolicy(entities, policyProfile);
}

export function getInspectableEntity(run, entityId, options = {}) {
  const errors = [];
  if (!isString(entityId)) {
    push(errors, "entityId", "Expected non-empty string");
    return {
      ok: false,
      entity: null,
      errors
    };
  }

  const allEntities = getVisibleEntities(run, options);
  const entity = allEntities.find((entry) => entry.entityId === entityId);
  if (!entity) {
    push(errors, "entityId", "Entity is not visible");
    return {
      ok: false,
      entity: null,
      errors
    };
  }

  if (!entity.inspectable) {
    push(errors, "entityId", "Entity is not inspectable");
    return {
      ok: false,
      entity,
      errors
    };
  }

  return {
    ok: true,
    entity,
    errors: []
  };
}

export function createEntityDetailPayload(run, entityId, options = {}) {
  const inspection = getInspectableEntity(run, entityId, options);
  if (!inspection.ok) {
    return {
      ok: false,
      entity: inspection.entity,
      details: null,
      errors: inspection.errors
    };
  }

  const { entity } = inspection;
  const rawId = entity.entityId.split(":").slice(1).join(":");
  const details = {
    title: entity.displayName,
    description: entity.summary || "",
    stats: {},
    relationships: relationshipsFor(run, entity.entityId, rawId),
    memoryFacts: memoryFactsFor(run, entity.memoryFactIds),
    availableActions: entity.actionTypes.map((type) => ({
      type,
      entityId: entity.entityId,
      enabled: type === "inspect" || type === "talk"
    }))
  };

  if (entity.entityType === "location_object") {
    const location = run.locations[rawId];
    details.description = location?.description || entity.summary || "";
    details.stats = location?.state || {};
  } else if (entity.entityType === "npc") {
    const npc = run.npcs[rawId];
    details.description = npc?.role || entity.summary || "";
    details.stats = {
      status: npc?.status || null,
      known: npc?.known ?? null,
      currentLocationId: npc?.currentLocationId || null
    };
  } else if (entity.entityType === "player") {
    details.description = "Player character";
    details.stats = run.player?.stats || {};
  } else if (entity.entityType === "player_asset") {
    const asset = run.playerAssets[rawId];
    details.description = asset?.type || entity.summary || "";
    details.stats = {
      level: asset?.level ?? null,
      components: asset?.components || {},
      resources: asset?.resources || {}
    };
  }

  return {
    ok: true,
    entity,
    details,
    errors: []
  };
}
