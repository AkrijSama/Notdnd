import fs from "node:fs";
import path from "node:path";
import { buildQuickstartBlueprint } from "../campaign/quickstart.js";
import { uid } from "../utils/ids.js";
import { createSeedState } from "./seedState.js";

const DEFAULT_STORE_PATH = path.resolve(process.cwd(), "server/db/notdnd.db.json");

function storePath() {
  return process.env.NOTDND_DB_PATH ? path.resolve(process.env.NOTDND_DB_PATH) : DEFAULT_STORE_PATH;
}

function ensureStoreDir() {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowEpochSec() {
  return Math.floor(Date.now() / 1000);
}

let db = null;

function loadFromDisk() {
  ensureStoreDir();
  if (!fs.existsSync(storePath())) {
    return null;
  }

  try {
    const raw = fs.readFileSync(storePath(), "utf8");
    if (!raw.trim()) {
      return null;
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeToDisk() {
  ensureStoreDir();
  fs.writeFileSync(storePath(), JSON.stringify(db, null, 2), "utf8");
}

function ensureDb() {
  if (!db) {
    db = loadFromDisk() || createSeedState();
    writeToDisk();
  }
}

function selectedCampaignId(payload = {}) {
  return payload.campaignId || db.selectedCampaignId;
}

function activeGmSettings() {
  const key = db.selectedCampaignId || Object.keys(db.gmSettingsByCampaign || {})[0];
  return (
    db.gmSettingsByCampaign?.[key] || {
      gmName: "Narrator Prime",
      gmStyle: "Cinematic Tactical",
      safetyProfile: "Table-Friendly",
      primaryRulebook: "Core Rules SRD"
    }
  );
}

export function resolveStorePath() {
  return storePath();
}

export function initializeDatabase() {
  ensureDb();
}

export function resetDatabase() {
  db = createSeedState();
  writeToDisk();
}

export function getState() {
  ensureDb();
  return {
    campaigns: deepClone(db.campaigns),
    selectedCampaignId: db.selectedCampaignId,
    books: deepClone(db.books),
    characters: deepClone(db.characters),
    encounters: deepClone(db.encounters),
    maps: deepClone(db.maps),
    tokensByMap: deepClone(db.tokensByMap),
    initiative: deepClone(db.initiative),
    chatLog: deepClone(db.chatLog),
    aiJobs: deepClone(db.aiJobs),
    gmSettings: deepClone(activeGmSettings())
  };
}

export function getAiJobById(jobId) {
  ensureDb();
  const found = db.aiJobs.find((job) => job.id === jobId);
  return found ? deepClone(found) : null;
}

export function updateAiJobStatus({ jobId, status, result, providerName, modelValue }) {
  ensureDb();
  db.aiJobs = db.aiJobs.map((job) => {
    if (job.id !== jobId) {
      return job;
    }

    return {
      ...job,
      status,
      updatedAt: nowEpochSec(),
      ...(result !== undefined ? { result } : {}),
      ...(providerName !== undefined ? { providerName } : {}),
      ...(modelValue !== undefined ? { modelValue } : {})
    };
  });
  writeToDisk();
}

function appendChatLine(campaignId, speaker, text) {
  db.chatLog.push({
    id: uid("chat"),
    campaignId,
    speaker,
    text,
    createdAt: nowEpochSec()
  });
}

function upsertHomebrewBook(book) {
  const normalizedTitle = String(book.title || "").toLowerCase();
  const existing = db.books.find((entry) => String(entry.title || "").toLowerCase() === normalizedTitle);
  if (existing) {
    return existing.id;
  }

  const id = uid("book");
  db.books.unshift({
    id,
    title: book.title || "Imported Homebrew",
    type: book.type || "Homebrew",
    tags: book.tags || [],
    chapters: book.chapters || [],
    createdAt: nowEpochSec()
  });
  return id;
}

export function createQuickstartCampaignFromParsed({
  campaignName,
  setting,
  players,
  parsed
}) {
  ensureDb();

  const blueprint = buildQuickstartBlueprint({
    campaignName,
    setting,
    players,
    parsed
  });

  const sourceBookIds = [];
  for (const book of blueprint.books) {
    sourceBookIds.push(upsertHomebrewBook(book));
  }

  const campaign = {
    ...blueprint.campaign,
    sourceBooks: sourceBookIds
  };

  db.campaigns.unshift({
    ...campaign,
    createdAt: nowEpochSec()
  });
  db.selectedCampaignId = campaign.id;

  db.characters = [...blueprint.characters.map((entry) => ({ ...entry, createdAt: nowEpochSec() })), ...db.characters];
  db.encounters.unshift({ ...blueprint.encounter, createdAt: nowEpochSec() });
  db.maps.unshift({ ...blueprint.map, createdAt: nowEpochSec() });
  db.tokensByMap[blueprint.map.id] = blueprint.tokens;
  db.initiative.push(...blueprint.initiative.map((turn) => ({ ...turn, createdAt: nowEpochSec() })));

  db.gmSettingsByCampaign[campaign.id] = {
    ...blueprint.gmSettings,
    updatedAt: nowEpochSec()
  };

  for (const line of blueprint.chatLines) {
    appendChatLine(campaign.id, line.speaker, line.text);
  }
  appendChatLine(campaign.id, "System", "VTT room launched with party sheets, tokens, and initiative preloaded.");

  writeToDisk();

  return {
    campaignId: campaign.id,
    mapId: blueprint.map.id,
    encounterId: blueprint.encounter.id,
    parsedSummary: blueprint.parsedSummary
  };
}

export function applyOperation(op, payload = {}) {
  ensureDb();

  switch (op) {
    case "reset_all": {
      resetDatabase();
      return { ok: true };
    }

    case "select_campaign": {
      if (!payload.campaignId) {
        throw new Error("campaignId is required");
      }
      db.selectedCampaignId = payload.campaignId;
      writeToDisk();
      return { campaignId: payload.campaignId };
    }

    case "create_campaign": {
      const id = payload.id || uid("cmp");
      const campaign = {
        id,
        name: payload.name || "Unnamed Campaign",
        setting: payload.setting || "Unknown Setting",
        status: payload.status || "Prep",
        readiness: Number(payload.readiness) || 35,
        sessionCount: Number(payload.sessionCount) || 0,
        players: payload.players || [],
        sourceBooks: payload.sourceBooks || payload.bookIds || [],
        activeMapId: payload.activeMapId || null,
        activeEncounterId: payload.activeEncounterId || null,
        createdAt: nowEpochSec()
      };
      db.campaigns.unshift(campaign);
      db.selectedCampaignId = id;
      db.gmSettingsByCampaign[id] = {
        gmName: "Narrator Prime",
        gmStyle: "Cinematic Tactical",
        safetyProfile: "Table-Friendly",
        primaryRulebook: "Core Rules SRD",
        updatedAt: nowEpochSec()
      };
      writeToDisk();
      return { id };
    }

    case "increment_campaign_readiness": {
      const campaignId = selectedCampaignId(payload);
      const amount = Number(payload.amount) || 0;
      db.campaigns = db.campaigns.map((campaign) =>
        campaign.id === campaignId
          ? { ...campaign, readiness: Math.max(0, Math.min(100, Number(campaign.readiness || 0) + amount)) }
          : campaign
      );
      writeToDisk();
      return { campaignId };
    }

    case "add_book": {
      const id = payload.id || uid("book");
      db.books.unshift({
        id,
        title: payload.title || "Untitled Book",
        type: payload.type || "Homebrew",
        tags: payload.tags || [],
        chapters: payload.chapters || [],
        createdAt: nowEpochSec()
      });
      writeToDisk();
      return { id };
    }

    case "add_character": {
      const id = payload.id || uid("char");
      db.characters.unshift({
        id,
        campaignId: selectedCampaignId(payload),
        name: payload.name || "Unnamed",
        className: payload.className || "Class",
        level: Number(payload.level) || 1,
        ac: Number(payload.ac) || 10,
        hp: Number(payload.hp) || 8,
        speed: Number(payload.speed) || 30,
        stats: payload.stats || {},
        proficiencies: payload.proficiencies || [],
        spells: payload.spells || [],
        inventory: payload.inventory || [],
        createdAt: nowEpochSec()
      });
      writeToDisk();
      return { id };
    }

    case "add_encounter": {
      const id = payload.id || uid("enc");
      db.encounters.unshift({
        id,
        campaignId: selectedCampaignId(payload),
        name: payload.name || "Untitled Encounter",
        difficulty: payload.difficulty || "Medium",
        monsters: payload.monsters || [],
        xpBudget: Number(payload.xpBudget) || 0,
        createdAt: nowEpochSec()
      });
      writeToDisk();
      return { id };
    }

    case "set_token_position": {
      const mapId = payload.mapId;
      const tokenId = payload.tokenId;
      if (!mapId || !tokenId) {
        throw new Error("mapId and tokenId are required");
      }
      const tokens = db.tokensByMap[mapId] || [];
      db.tokensByMap[mapId] = tokens.map((token) =>
        token.id === tokenId ? { ...token, x: Number(payload.x) || 0, y: Number(payload.y) || 0 } : token
      );
      writeToDisk();
      return { mapId, tokenId };
    }

    case "add_initiative_turn": {
      const id = payload.id || uid("init");
      db.initiative.push({
        id,
        campaignId: selectedCampaignId(payload),
        name: payload.name || "Unit",
        value: Number(payload.value) || 10,
        createdAt: nowEpochSec()
      });
      writeToDisk();
      return { id };
    }

    case "push_chat_line": {
      const id = payload.id || uid("chat");
      db.chatLog.push({
        id,
        campaignId: selectedCampaignId(payload),
        speaker: payload.speaker || "System",
        text: payload.text || "",
        createdAt: nowEpochSec()
      });
      writeToDisk();
      return { id };
    }

    case "queue_ai_job": {
      const id = payload.id || uid("job");
      db.aiJobs.unshift({
        id,
        campaignId: selectedCampaignId(payload),
        type: payload.type || "gm",
        prompt: payload.prompt || "",
        status: payload.status || "Queued",
        providerName: payload.providerName,
        modelValue: payload.modelValue,
        result: payload.result || null,
        createdAt: nowEpochSec(),
        updatedAt: nowEpochSec()
      });
      writeToDisk();
      return { id };
    }

    case "set_ai_job_status": {
      if (!payload.jobId) {
        throw new Error("jobId is required");
      }
      updateAiJobStatus({
        jobId: payload.jobId,
        status: payload.status || "Queued",
        result: payload.result,
        providerName: payload.providerName,
        modelValue: payload.modelValue
      });
      return { jobId: payload.jobId };
    }

    case "set_gm_settings": {
      const campaignId = selectedCampaignId(payload);
      db.gmSettingsByCampaign[campaignId] = {
        gmName: payload.gmName || "Narrator Prime",
        gmStyle: payload.gmStyle || "Cinematic Tactical",
        safetyProfile: payload.safetyProfile || "Table-Friendly",
        primaryRulebook: payload.primaryRulebook || "Core Rules SRD",
        updatedAt: nowEpochSec()
      };
      writeToDisk();
      return { campaignId };
    }

    case "upsert_map": {
      const id = payload.id || uid("map");
      const existing = db.maps.find((map) => map.id === id);
      if (existing) {
        db.maps = db.maps.map((map) =>
          map.id === id
            ? {
                ...map,
                name: payload.name || map.name,
                width: Number(payload.width) || map.width,
                height: Number(payload.height) || map.height,
                fogEnabled: payload.fogEnabled !== undefined ? Boolean(payload.fogEnabled) : map.fogEnabled,
                dynamicLighting:
                  payload.dynamicLighting !== undefined ? Boolean(payload.dynamicLighting) : map.dynamicLighting
              }
            : map
        );
      } else {
        db.maps.unshift({
          id,
          campaignId: selectedCampaignId(payload),
          name: payload.name || "Untitled Map",
          width: Number(payload.width) || 10,
          height: Number(payload.height) || 10,
          fogEnabled: Boolean(payload.fogEnabled),
          dynamicLighting: Boolean(payload.dynamicLighting),
          createdAt: nowEpochSec()
        });
      }
      writeToDisk();
      return { id };
    }

    default:
      throw new Error(`Unsupported operation: ${op}`);
  }
}
