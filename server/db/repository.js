import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const homebrewSchema = JSON.parse(
  readFileSync(new URL('../homebrew/homebrew.schema.json', import.meta.url), 'utf8')
);

const statDefinition = homebrewSchema.definitions.entityStats;
const entityDefinition = homebrewSchema.definitions.entityStatBlock;
const STAT_KEYS = Object.keys(statDefinition.properties);
const DEFAULT_STATS = Object.fromEntries(STAT_KEYS.map(key => [key, 10]));
const DEFAULT_DISPOSITION = entityDefinition.properties.disposition.enum[1];
const DEFAULT_TOKEN_COLOR = '#5f8dd3';
const ACTIVE_CAMPAIGN_ID = 'quickstart';

const campaignStore = {
  activeCampaignId: ACTIVE_CAMPAIGN_ID,
  campaigns: {
    [ACTIVE_CAMPAIGN_ID]: {
      id: ACTIVE_CAMPAIGN_ID,
      tokens: [],
      initiative: [],
      chatLog: [],
      pendingSpawns: [],
      settings: {
        autoSpawnEntities: true,
      },
    },
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureCampaign(campaignId = ACTIVE_CAMPAIGN_ID) {
  if (!campaignStore.campaigns[campaignId]) {
    campaignStore.campaigns[campaignId] = {
      id: campaignId,
      tokens: [],
      initiative: [],
      chatLog: [],
      pendingSpawns: [],
      settings: {
        autoSpawnEntities: true,
      },
    };
  }

  return campaignStore.campaigns[campaignId];
}

function isHexColor(value) {
  return /^#(?:[0-9a-f]{3}){1,2}$/i.test(String(value || '').trim());
}

function toSafeInteger(value, fallback, minimum = 1) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.max(minimum, parsed);
}

function sanitizeStats(stats = {}) {
  return STAT_KEYS.reduce((accumulator, key) => {
    accumulator[key] = toSafeInteger(stats[key], DEFAULT_STATS[key]);
    return accumulator;
  }, {});
}

function sanitizeSpawnEntry(entry = {}) {
  const type = entityDefinition.properties.type.enum.includes(entry.type) ? entry.type : 'npc';
  const disposition = entityDefinition.properties.disposition.enum.includes(entry.disposition)
    ? entry.disposition
    : DEFAULT_DISPOSITION;
  const actions = Array.isArray(entry.actions)
    ? entry.actions
      .map(action => String(action || '').trim())
      .filter(Boolean)
    : [];

  return {
    type,
    name: String(entry.name || 'Unknown Entity').trim() || 'Unknown Entity',
    hp: toSafeInteger(entry.hp, 8),
    ac: toSafeInteger(entry.ac, 10),
    stats: sanitizeStats(entry.stats),
    actions,
    disposition,
    tokenColor: isHexColor(entry.tokenColor) ? entry.tokenColor : DEFAULT_TOKEN_COLOR,
  };
}

function buildSpawnPosition(tokenCount) {
  const column = tokenCount % 6;
  const row = Math.floor(tokenCount / 6);
  return {
    x: 24 + (column * 72),
    y: 24 + (row * 72),
  };
}

function buildToken(spawn, campaign) {
  const tokenId = randomUUID();
  const position = buildSpawnPosition(campaign.tokens.length);

  return {
    id: tokenId,
    entityId: `${spawn.type}:${tokenId}`,
    kind: spawn.type,
    name: spawn.name,
    hp: spawn.hp,
    maxHp: spawn.hp,
    ac: spawn.ac,
    stats: clone(spawn.stats),
    actions: [...spawn.actions],
    disposition: spawn.disposition,
    tokenColor: spawn.tokenColor,
    x: position.x,
    y: position.y,
  };
}

function buildInitiativeEntry(token) {
  const dexModifier = Math.floor((token.stats.dex - 10) / 2);
  return {
    id: randomUUID(),
    tokenId: token.id,
    name: token.name,
    initiative: 10 + dexModifier,
    type: token.kind,
    disposition: token.disposition,
  };
}

function insertSpawnEntries(campaign, entries) {
  const insertedTokens = entries.map(rawEntry => {
    const spawn = sanitizeSpawnEntry(rawEntry);
    const token = buildToken(spawn, campaign);
    const initiativeEntry = buildInitiativeEntry(token);

    campaign.tokens.push(token);
    campaign.initiative.push(initiativeEntry);
    campaign.initiative.sort((left, right) => right.initiative - left.initiative);

    return token;
  });

  return clone(insertedTokens);
}

export function resolveCampaignId(context = {}) {
  return String(context.campaignId || campaignStore.activeCampaignId || ACTIVE_CAMPAIGN_ID);
}

export function getCampaignState(campaignId = ACTIVE_CAMPAIGN_ID) {
  return clone(ensureCampaign(campaignId));
}

export function appendChatMessage(campaignId, message) {
  const campaign = ensureCampaign(campaignId);
  campaign.chatLog.push({
    id: randomUUID(),
    sender: String(message.sender || 'GM'),
    text: String(message.text || '').trim(),
    type: String(message.type || 'normal'),
    createdAt: new Date().toISOString(),
  });

  return clone(campaign.chatLog[campaign.chatLog.length - 1]);
}

export function setAutoSpawnEntities(campaignId, enabled) {
  const campaign = ensureCampaign(campaignId);
  campaign.settings.autoSpawnEntities = Boolean(enabled);
  return campaign.settings.autoSpawnEntities;
}

export function getAutoSpawnEntities(campaignId = ACTIVE_CAMPAIGN_ID) {
  return ensureCampaign(campaignId).settings.autoSpawnEntities;
}

export function queueSpawnEntries(campaignId, entries = []) {
  const campaign = ensureCampaign(campaignId);
  const queued = entries.map(entry => ({
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    entity: sanitizeSpawnEntry(entry),
  }));

  campaign.pendingSpawns.push(...queued);
  return clone(queued);
}

export function approvePendingSpawns(campaignId, pendingSpawnIds = []) {
  const campaign = ensureCampaign(campaignId);
  const approvedIdSet = new Set(
    Array.isArray(pendingSpawnIds) && pendingSpawnIds.length > 0
      ? pendingSpawnIds.map(id => String(id))
      : campaign.pendingSpawns.map(entry => entry.id)
  );

  const approvedEntries = [];
  const remainingEntries = [];

  for (const entry of campaign.pendingSpawns) {
    if (approvedIdSet.has(entry.id)) {
      approvedEntries.push(entry.entity);
    } else {
      remainingEntries.push(entry);
    }
  }

  campaign.pendingSpawns = remainingEntries;

  return {
    tokens: insertSpawnEntries(campaign, approvedEntries),
    pendingSpawns: clone(campaign.pendingSpawns),
  };
}

export function addSpawnsToCampaign(campaignId, entries = []) {
  return insertSpawnEntries(ensureCampaign(campaignId), entries);
}
