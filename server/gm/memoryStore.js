import fs from "node:fs/promises";
import path from "node:path";
import { Document } from "flexsearch";
import { generateUtility } from "../ai/openrouter.js";
import { getStyleConfig } from "./styleConfig.js";

const DEFAULT_CONTEXT_BUDGET = Number(process.env.NOTDND_CONTEXT_BUDGET || 1500);
const LEGACY_DOCS = [
  { key: "human", fileName: "human-gm.md", title: "Human GM Guide" },
  { key: "agent", fileName: "agent-gm.md", title: "Agent GM Guide" },
  { key: "timeline", fileName: "shared-timeline.md", title: "Shared Timeline" }
];
const ENTITY_TYPES = new Set([
  "npc",
  "location",
  "faction",
  "event",
  "item",
  "lore",
  "player_character",
  "session_log",
  "relationship",
  "quest"
]);

const campaignStores = new Map();

function memoryRoot() {
  return process.env.NOTDND_MEMORY_ROOT
    ? path.resolve(process.env.NOTDND_MEMORY_ROOT)
    : path.resolve(process.cwd(), "data/campaigns");
}

function campaignRoot(campaignId) {
  return path.join(memoryRoot(), String(campaignId || "unknown-campaign"));
}

function memoryDir(campaignId) {
  return path.join(campaignRoot(campaignId), "memory");
}

function archiveDir(campaignId) {
  return path.join(memoryDir(campaignId), "archive");
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeTag(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function slugifyName(value) {
  return String(value || "entity")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "entity";
}

function dedupeStrings(values = []) {
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

function dedupeRelations(relations = []) {
  const seen = new Set();
  const deduped = [];
  for (const relation of relations) {
    const target = String(relation?.target || "").trim();
    const type = String(relation?.type || "related_to").trim();
    if (!target) {
      continue;
    }
    const key = `${normalizeName(target)}::${normalizeName(type)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push({ target, type });
  }
  return deduped;
}

function entityType(value) {
  const normalized = normalizeName(value);
  return ENTITY_TYPES.has(normalized) ? normalized : "lore";
}

function toIso(value, fallback = null) {
  const parsed = new Date(value || fallback || Date.now());
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }
  return parsed.toISOString();
}

function parseScalar(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed === "null") {
    return null;
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineArray(raw) {
  const inner = String(raw || "")
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "");

  if (!inner) {
    return [];
  }

  return inner
    .split(",")
    .map((entry) => parseScalar(entry))
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
}

function extractLinks(body = "") {
  const matches = String(body || "").matchAll(/\[\[([^\]]+)\]\]/g);
  const links = [];
  for (const match of matches) {
    const value = String(match[1] || "").trim();
    if (value) {
      links.push(value);
    }
  }
  return dedupeStrings(links);
}

function parseFrontmatter(rawFrontmatter = "") {
  const lines = String(rawFrontmatter || "").split(/\r?\n/);
  const result = {
    type: "lore",
    name: "",
    tags: [],
    relations: [],
    lastAccessed: null,
    lastUpdated: null,
    accessCount: 0,
    confidence: 1
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!match) {
      i += 1;
      continue;
    }

    const key = match[1];
    const value = match[2];

    if (key === "tags") {
      if (value.trim().startsWith("[")) {
        result.tags = parseInlineArray(value);
        i += 1;
        continue;
      }
      const tags = [];
      i += 1;
      while (i < lines.length && /^\s*\-\s+/.test(lines[i])) {
        tags.push(parseScalar(lines[i].replace(/^\s*\-\s+/, "")));
        i += 1;
      }
      result.tags = tags.map((tag) => String(tag || "").trim()).filter(Boolean);
      continue;
    }

    if (key === "relations") {
      const relations = [];
      i += 1;
      let current = null;
      while (i < lines.length && /^\s{2,}\-\s+|^\s{4,}[a-zA-Z_]/.test(lines[i])) {
        const relationLine = lines[i].trim();
        const targetMatch = relationLine.match(/^-\s*target:\s*(.*)$/);
        if (targetMatch) {
          if (current?.target) {
            relations.push(current);
          }
          current = { target: String(parseScalar(targetMatch[1]) || "").trim(), type: "related_to" };
          i += 1;
          continue;
        }
        const typeMatch = relationLine.match(/^type:\s*(.*)$/);
        if (typeMatch) {
          if (!current) {
            current = { target: "", type: "related_to" };
          }
          current.type = String(parseScalar(typeMatch[1]) || "related_to").trim() || "related_to";
          i += 1;
          continue;
        }
        i += 1;
      }
      if (current?.target) {
        relations.push(current);
      }
      result.relations = dedupeRelations(relations);
      continue;
    }

    result[key] = parseScalar(value);
    i += 1;
  }

  result.type = entityType(result.type);
  result.name = String(result.name || "").trim();
  result.tags = dedupeStrings(result.tags || []);
  result.relations = dedupeRelations(result.relations || []);
  result.lastAccessed = toIso(result.lastAccessed);
  result.lastUpdated = toIso(result.lastUpdated);
  result.accessCount = Math.max(0, Number(result.accessCount || 0));
  result.confidence = Math.max(0, Math.min(1, Number(result.confidence ?? 1)));

  return result;
}

function splitFrontmatter(content = "") {
  const source = String(content || "");
  if (!source.startsWith("---")) {
    return {
      frontmatter: "",
      body: source
    };
  }

  const endMarker = "\n---";
  const endIndex = source.indexOf(endMarker, 3);
  if (endIndex === -1) {
    return {
      frontmatter: "",
      body: source
    };
  }

  const frontmatter = source.slice(3, endIndex).trim();
  const body = source.slice(endIndex + endMarker.length).replace(/^\s*\n/, "");

  return {
    frontmatter,
    body
  };
}

function serializeEntity(entity) {
  const lines = [
    "---",
    `type: ${entity.type}`,
    `name: \"${String(entity.name || "").replace(/\"/g, '\\\"')}\"`,
    `tags: [${(entity.tags || []).map((tag) => JSON.stringify(String(tag))).join(", ")}]`,
    "relations:"
  ];

  if (Array.isArray(entity.relations) && entity.relations.length > 0) {
    for (const relation of entity.relations) {
      lines.push(`  - target: ${JSON.stringify(String(relation.target || ""))}`);
      lines.push(`    type: ${String(relation.type || "related_to")}`);
    }
  }

  lines.push(`lastAccessed: ${toIso(entity.lastAccessed)}`);
  lines.push(`lastUpdated: ${toIso(entity.lastUpdated)}`);
  lines.push(`accessCount: ${Math.max(0, Number(entity.accessCount || 0))}`);
  lines.push(`confidence: ${Math.max(0, Math.min(1, Number(entity.confidence ?? 1)))}`);
  lines.push("---", "", String(entity.body || "").trim(), "");

  return `${lines.join("\n")}`;
}

function buildIndex() {
  return new Document({
    tokenize: "forward",
    charset: "latin:balance",
    document: {
      id: "id",
      index: ["name", "tags", "body", "type"],
      store: ["id", "name", "type", "tags", "body", "confidence", "lastAccessed", "accessCount"]
    }
  });
}

function indexDocumentFor(entity) {
  return {
    id: entity.id,
    name: entity.name,
    type: entity.type,
    tags: (entity.tags || []).join(" "),
    body: entity.body || "",
    confidence: entity.confidence,
    lastAccessed: entity.lastAccessed,
    accessCount: entity.accessCount
  };
}

function recencyWeight(lastAccessed) {
  const ts = new Date(lastAccessed || 0).getTime();
  if (!Number.isFinite(ts) || ts <= 0) {
    return 0.1;
  }
  const days = Math.max(0, (Date.now() - ts) / 86_400_000);
  return Math.max(0.05, Math.exp(-days / 30));
}

function accessWeight(accessCount, maxAccessCount) {
  const maxValue = Math.max(1, Number(maxAccessCount || 1));
  const value = Math.max(0, Number(accessCount || 0));
  return Math.min(1, Math.log1p(value) / Math.log1p(maxValue));
}

function hasTagOverlap(entityTags = [], configuredTags = []) {
  if (!Array.isArray(entityTags) || entityTags.length === 0 || !Array.isArray(configuredTags) || configuredTags.length === 0) {
    return false;
  }
  const normalizedEntityTags = new Set(entityTags.map((tag) => normalizeTag(tag)));
  return configuredTags.some((tag) => normalizedEntityTags.has(normalizeTag(tag)));
}

function playerAffinityBoost(entity, playerFocusWeights = {}) {
  if (!entity || !playerFocusWeights || typeof playerFocusWeights !== "object") {
    return 1;
  }

  const relationTargets = new Set((entity.relations || []).map((relation) => normalizeName(relation.target)));
  const normalizedName = normalizeName(entity.name);
  const normalizedBody = normalizeName(entity.body || "");
  const normalizedTags = new Set((entity.tags || []).map((tag) => normalizeName(tag)));

  let strongestWeight = 0;
  for (const [playerName, rawWeight] of Object.entries(playerFocusWeights)) {
    const normalizedPlayer = normalizeName(playerName);
    if (!normalizedPlayer) {
      continue;
    }
    const weight = Math.max(0, Math.min(1, Number(rawWeight || 0)));
    if (weight <= 0) {
      continue;
    }

    const playerSlug = normalizedPlayer.replace(/\s+/g, "-");
    const mentioned =
      relationTargets.has(normalizedPlayer)
      || normalizedName.includes(normalizedPlayer)
      || normalizedBody.includes(normalizedPlayer)
      || normalizedTags.has(playerSlug)
      || normalizedTags.has(normalizedPlayer);

    if (mentioned) {
      strongestWeight = Math.max(strongestWeight, weight);
    }
  }

  return strongestWeight > 0 ? 1 + strongestWeight : 1;
}

async function summarizeThreshold(campaignId, fallback = 2000) {
  try {
    const config = await getStyleConfig(campaignId);
    const configured = Number(config?.memory?.autoSummarizeThreshold);
    if (Number.isFinite(configured) && configured >= 300) {
      return Math.floor(configured);
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function firstWords(text, count = 200) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  return words.slice(0, count).join(" ");
}

function wordCount(text = "") {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

function storeFromCampaignId(campaignId) {
  return campaignStores.get(String(campaignId || "unknown-campaign")) || null;
}

async function ensureDirs(campaignId) {
  await fs.mkdir(memoryDir(campaignId), { recursive: true });
  await fs.mkdir(archiveDir(campaignId), { recursive: true });
  await fs.mkdir(campaignRoot(campaignId), { recursive: true });
}

async function readEntityFile(campaignId, fileName) {
  const filePath = path.join(memoryDir(campaignId), fileName);
  const raw = await fs.readFile(filePath, "utf8");
  const { frontmatter, body } = splitFrontmatter(raw);
  const parsed = parseFrontmatter(frontmatter);
  const entityName = parsed.name || fileName.replace(/\.md$/i, "");

  return {
    id: `${campaignId}:${fileName}`,
    campaignId: String(campaignId),
    fileName,
    filePath,
    name: entityName,
    type: parsed.type,
    tags: dedupeStrings(parsed.tags || []),
    relations: dedupeRelations(parsed.relations || []),
    body: String(body || "").trim(),
    links: extractLinks(body),
    lastAccessed: toIso(parsed.lastAccessed),
    lastUpdated: toIso(parsed.lastUpdated),
    accessCount: Math.max(0, Number(parsed.accessCount || 0)),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 1)))
  };
}

function rebuildGraph(store) {
  store.graph = new Map();

  function linkBoth(leftName, rightName) {
    const left = normalizeName(leftName);
    const right = normalizeName(rightName);
    if (!left || !right || left === right) {
      return;
    }

    if (!store.graph.has(left)) {
      store.graph.set(left, new Set());
    }
    if (!store.graph.has(right)) {
      store.graph.set(right, new Set());
    }
    store.graph.get(left).add(right);
    store.graph.get(right).add(left);
  }

  for (const entity of store.entitiesById.values()) {
    const source = normalizeName(entity.name);
    if (!store.graph.has(source)) {
      store.graph.set(source, new Set());
    }

    for (const relation of entity.relations || []) {
      linkBoth(entity.name, relation.target);
    }
    for (const linkName of entity.links || []) {
      linkBoth(entity.name, linkName);
    }
  }
}

function replaceInStore(store, entity, { rebuild = false } = {}) {
  const normalized = normalizeName(entity.name);
  const fileKey = normalizeName(entity.fileName);

  const previousByNameId = store.idsByName.get(normalized);
  if (previousByNameId && previousByNameId !== entity.id) {
    const previous = store.entitiesById.get(previousByNameId);
    if (previous) {
      store.index.remove(previous.id);
      store.entitiesById.delete(previous.id);
    }
  }

  const previousByFileId = store.idsByFile.get(fileKey);
  if (previousByFileId && previousByFileId !== entity.id) {
    const previous = store.entitiesById.get(previousByFileId);
    if (previous) {
      store.index.remove(previous.id);
      store.entitiesById.delete(previous.id);
    }
  }

  const current = store.entitiesById.get(entity.id);
  if (current) {
    store.index.remove(entity.id);
  }

  store.entitiesById.set(entity.id, entity);
  store.idsByName.set(normalized, entity.id);
  store.idsByFile.set(fileKey, entity.id);
  store.index.add(indexDocumentFor(entity));

  if (rebuild) {
    rebuildGraph(store);
  }
}

async function loadCampaignStore(campaignId) {
  const campaignKey = String(campaignId || "unknown-campaign");
  await ensureDirs(campaignKey);

  const files = await fs.readdir(memoryDir(campaignKey), { withFileTypes: true });
  const mdFiles = files
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const store = {
    campaignId: campaignKey,
    index: buildIndex(),
    entitiesById: new Map(),
    idsByName: new Map(),
    idsByFile: new Map(),
    graph: new Map()
  };

  for (const fileName of mdFiles) {
    const entity = await readEntityFile(campaignKey, fileName);
    replaceInStore(store, entity, { rebuild: false });
  }

  rebuildGraph(store);
  campaignStores.set(campaignKey, store);

  return store;
}

async function ensureStore(campaignId, { force = false } = {}) {
  const campaignKey = String(campaignId || "unknown-campaign");
  if (!force) {
    const existing = storeFromCampaignId(campaignKey);
    if (existing) {
      return existing;
    }
  }
  return loadCampaignStore(campaignKey);
}

function scoreResults(rawResults, store) {
  const weightsByField = {
    name: 1.3,
    tags: 1.1,
    body: 1,
    type: 0.7
  };

  const scores = new Map();
  const results = Array.isArray(rawResults) ? rawResults : [];

  for (const fieldResult of results) {
    const field = String(fieldResult?.field || "body");
    const weight = weightsByField[field] || 1;
    const list = Array.isArray(fieldResult?.result) ? fieldResult.result : [];
    const total = Math.max(1, list.length);

    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      let id = null;
      if (item && typeof item === "object") {
        id = String(item.id || item.doc?.id || "");
      } else if (typeof item === "string" || typeof item === "number") {
        id = String(item);
      }
      if (!id) {
        continue;
      }

      const base = (total - i) / total;
      scores.set(id, (scores.get(id) || 0) + base * weight);
    }
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score, entity: store.entitiesById.get(id) }))
    .filter((entry) => entry.entity)
    .sort((left, right) => right.score - left.score);
}

function entitySummary(entity) {
  return {
    name: entity.name,
    type: entity.type,
    tags: [...(entity.tags || [])],
    relations: [...(entity.relations || [])],
    body: entity.body,
    links: [...(entity.links || [])],
    lastAccessed: entity.lastAccessed,
    lastUpdated: entity.lastUpdated,
    accessCount: entity.accessCount,
    confidence: entity.confidence,
    fileName: entity.fileName
  };
}

async function writeEntityToDisk(campaignId, entity) {
  await ensureDirs(campaignId);
  const targetPath = path.join(memoryDir(campaignId), entity.fileName);
  await fs.writeFile(targetPath, serializeEntity(entity), "utf8");
  return targetPath;
}

async function appendFactsToEntity(entity, facts = []) {
  const filtered = dedupeStrings(facts || []);
  if (filtered.length === 0) {
    return entity;
  }

  const additions = filtered.map((fact) => `- ${fact}`).join("\n");
  const joined = [String(entity.body || "").trim(), additions].filter(Boolean).join("\n\n");
  return {
    ...entity,
    body: joined
  };
}

async function warmIndexesFromDisk() {
  try {
    const rootEntries = await fs.readdir(memoryRoot(), { withFileTypes: true });
    const campaignDirs = rootEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    for (const campaignId of campaignDirs) {
      try {
        await ensureStore(campaignId);
      } catch {
        // Ignore warm-up errors for invalid campaign folders.
      }
    }
  } catch {
    // Ignore warm-up errors until first campaign use.
  }
}

void warmIndexesFromDisk();

/**
 * Ensures the campaign memory directory exists and optionally seeds initial docs.
 * @param {string} campaignId
 * @param {Record<string, string>} [seedDocs]
 * @returns {Promise<void>}
 */
export async function ensureCampaignMemoryDocsAsync(campaignId, seedDocs = {}) {
  const campaignKey = String(campaignId || "unknown-campaign");
  await ensureDirs(campaignKey);

  const seeded = {};
  for (const spec of LEGACY_DOCS) {
    const content = String(seedDocs?.[spec.key] || "").trim();
    seeded[spec.fileName] = {
      fileName: spec.fileName,
      name: spec.title,
      body: content || `# ${spec.title}\n\n- Campaign: ${campaignKey}\n`
    };
  }

  for (const [name, body] of Object.entries(seedDocs || {})) {
    if (LEGACY_DOCS.some((spec) => spec.key === name)) {
      continue;
    }
    const fileName = `${slugifyName(name)}.md`;
    seeded[fileName] = {
      fileName,
      name: String(name),
      body: String(body || "").trim()
    };
  }

  for (const item of Object.values(seeded)) {
    const target = path.join(memoryDir(campaignKey), item.fileName);
    try {
      await fs.access(target);
    } catch {
      const now = new Date().toISOString();
      const entity = {
        campaignId: campaignKey,
        fileName: item.fileName,
        id: `${campaignKey}:${item.fileName}`,
        name: item.name,
        type: "lore",
        tags: ["seed"],
        relations: [],
        body: item.body,
        links: extractLinks(item.body),
        lastAccessed: now,
        lastUpdated: now,
        accessCount: 0,
        confidence: 1
      };
      await writeEntityToDisk(campaignKey, entity);
    }
  }

  for (const spec of LEGACY_DOCS) {
    const source = path.join(memoryDir(campaignKey), spec.fileName);
    const legacyTarget = path.join(campaignRoot(campaignKey), spec.fileName);
    try {
      await fs.access(legacyTarget);
    } catch {
      try {
        const content = await fs.readFile(source, "utf8");
        await fs.writeFile(legacyTarget, content, "utf8");
      } catch {
        // Ignore legacy mirror write errors.
      }
    }
  }

  await ensureStore(campaignKey, { force: true });
}

/**
 * Ensures campaign memory docs and directories exist.
 * @param {string} campaignId
 * @param {Record<string, string>} [seedDocs]
 * @returns {void}
 */
export function ensureCampaignMemoryDocs(campaignId, seedDocs = {}) {
  void ensureCampaignMemoryDocsAsync(campaignId, seedDocs).catch(() => {});
}

/**
 * Rebuilds the in-memory index from markdown files on disk for a campaign.
 * @param {string} campaignId
 * @returns {Promise<{campaignId: string, entities: number}>}
 */
export async function rebuildCampaignIndex(campaignId) {
  const store = await ensureStore(campaignId, { force: true });
  return {
    campaignId: String(campaignId),
    entities: store.entitiesById.size
  };
}

/**
 * Lists entity summaries for a campaign.
 * @param {string} campaignId
 * @returns {Promise<Array<{name: string, type: string, tags: string[]}>>}
 */
export async function listEntities(campaignId) {
  const store = await ensureStore(campaignId);
  return [...store.entitiesById.values()]
    .map((entity) => ({ name: entity.name, type: entity.type, tags: [...(entity.tags || [])] }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Searches campaign memory using FlexSearch and ranks by relevance and recency.
 * @param {string} campaignId
 * @param {string} query
 * @param {{type?: string, limit?: number, minConfidence?: number}} [options]
 * @returns {Promise<Array<object>>}
 */
export async function search(campaignId, query, options = {}) {
  const store = await ensureStore(campaignId);
  const trimmed = String(query || "").trim();
  if (!trimmed) {
    return [];
  }

  const limit = Math.max(1, Number(options.limit || 8));
  const raw = store.index.search(trimmed, { enrich: true, suggest: true, limit: limit * 4 });
  const scored = scoreResults(raw, store);

  const typeFilter = options.type ? entityType(options.type) : null;
  const minConfidence = Number(options.minConfidence ?? 0);

  const ranked = scored
    .map((entry) => {
      const recency = recencyWeight(entry.entity.lastAccessed);
      return {
        ...entitySummary(entry.entity),
        relevance: entry.score,
        recency,
        score: entry.score * recency
      };
    })
    .filter((entry) => !typeFilter || entry.type === typeFilter)
    .filter((entry) => entry.confidence >= minConfidence)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);

  return ranked;
}

/**
 * Gets an entity by exact name or filename.
 * @param {string} campaignId
 * @param {string} name
 * @returns {Promise<object | null>}
 */
export async function getEntity(campaignId, name) {
  const store = await ensureStore(campaignId);
  const lookup = String(name || "").trim();
  if (!lookup) {
    return null;
  }

  const normalized = normalizeName(lookup);
  const byNameId = store.idsByName.get(normalized);
  if (byNameId && store.entitiesById.get(byNameId)) {
    return entitySummary(store.entitiesById.get(byNameId));
  }

  const fileCandidate = lookup.toLowerCase().endsWith(".md") ? lookup : `${lookup}.md`;
  const byFileId = store.idsByFile.get(normalizeName(fileCandidate));
  if (byFileId && store.entitiesById.get(byFileId)) {
    return entitySummary(store.entitiesById.get(byFileId));
  }

  return null;
}

/**
 * Traverses related entities from a starting entity using relations and wiki links.
 * @param {string} campaignId
 * @param {string} entityName
 * @param {number} [depth=1]
 * @returns {Promise<{root: string, depth: number, entities: object[], edges: Array<{from: string, to: string}>}>}
 */
export async function getRelated(campaignId, entityName, depth = 1) {
  const store = await ensureStore(campaignId);
  const root = await getEntity(campaignId, entityName);
  if (!root) {
    return { root: String(entityName || ""), depth: 0, entities: [], edges: [] };
  }

  const maxDepth = Math.max(0, Number(depth || 1));
  const queue = [{ key: normalizeName(root.name), level: 0 }];
  const visited = new Set();
  const included = new Set();
  const edges = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.key) || current.level > maxDepth) {
      continue;
    }
    visited.add(current.key);

    const id = store.idsByName.get(current.key);
    if (id) {
      included.add(id);
    }

    const neighbors = [...(store.graph.get(current.key) || [])];
    for (const neighbor of neighbors) {
      const fromName = store.entitiesById.get(id)?.name || root.name;
      const toId = store.idsByName.get(neighbor);
      const toName = toId ? store.entitiesById.get(toId)?.name || neighbor : neighbor;
      edges.push({ from: fromName, to: toName });

      if (!visited.has(neighbor) && current.level < maxDepth) {
        queue.push({ key: neighbor, level: current.level + 1 });
      }
    }
  }

  return {
    root: root.name,
    depth: maxDepth,
    entities: [...included]
      .map((id) => store.entitiesById.get(id))
      .filter(Boolean)
      .map((entity) => entitySummary(entity)),
    edges
  };
}

/**
 * Creates or updates a memory entity markdown file and re-indexes it.
 * @param {string} campaignId
 * @param {object} entity
 * @returns {Promise<object>}
 */
export async function upsertEntity(campaignId, entity) {
  const campaignKey = String(campaignId || "unknown-campaign");
  const store = await ensureStore(campaignKey);

  const name = String(entity?.name || "").trim();
  if (!name) {
    const error = new Error("entity.name is required.");
    error.code = "BAD_REQUEST";
    error.statusCode = 400;
    throw error;
  }

  const existing = await getEntity(campaignKey, name);
  const now = new Date().toISOString();
  const fileName = existing?.fileName || String(entity?.fileName || "") || `${slugifyName(name)}.md`;
  const mergedBody =
    entity?.facts && Array.isArray(entity.facts)
      ? (await appendFactsToEntity(existing || { body: String(entity?.body || "") }, entity.facts)).body
      : String(entity?.body ?? existing?.body ?? "").trim();

  const merged = {
    id: `${campaignKey}:${fileName}`,
    campaignId: campaignKey,
    fileName,
    filePath: path.join(memoryDir(campaignKey), fileName),
    name,
    type: entityType(entity?.type || existing?.type || "lore"),
    tags: dedupeStrings([...(existing?.tags || []), ...(entity?.tags || [])].map(normalizeTag)),
    relations: dedupeRelations([...(existing?.relations || []), ...(entity?.relations || [])]),
    body: mergedBody,
    links: extractLinks(mergedBody),
    lastAccessed: toIso(existing?.lastAccessed || now),
    lastUpdated: now,
    accessCount: Math.max(0, Number(existing?.accessCount || 0)),
    confidence: Math.max(0, Math.min(1, Number(entity?.confidence ?? existing?.confidence ?? 1)))
  };

  await writeEntityToDisk(campaignKey, merged);
  replaceInStore(store, merged, { rebuild: true });

  const threshold = await summarizeThreshold(campaignKey, 2000);
  if (wordCount(merged.body) > threshold) {
    return summarizeAndArchive(campaignKey, merged.name);
  }

  return entitySummary(merged);
}

/**
 * Increments access metadata for an entity and updates index cache.
 * @param {string} campaignId
 * @param {string} entityName
 * @returns {Promise<object | null>}
 */
export async function recordAccess(campaignId, entityName) {
  const campaignKey = String(campaignId || "unknown-campaign");
  const store = await ensureStore(campaignKey);
  const existing = await getEntity(campaignKey, entityName);
  if (!existing) {
    return null;
  }

  const updated = {
    ...existing,
    id: `${campaignKey}:${existing.fileName}`,
    campaignId: campaignKey,
    filePath: path.join(memoryDir(campaignKey), existing.fileName),
    lastAccessed: new Date().toISOString(),
    accessCount: Math.max(0, Number(existing.accessCount || 0)) + 1
  };

  await writeEntityToDisk(campaignKey, updated);
  replaceInStore(store, {
    ...updated,
    links: extractLinks(updated.body)
  }, { rebuild: false });

  return entitySummary(updated);
}

/**
 * Soft-deletes an entity by moving its markdown file into archive.
 * @param {string} campaignId
 * @param {string} entityName
 * @returns {Promise<{archived: boolean, archivePath: string | null}>}
 */
export async function archiveEntity(campaignId, entityName) {
  const campaignKey = String(campaignId || "unknown-campaign");
  const store = await ensureStore(campaignKey);
  const entity = await getEntity(campaignKey, entityName);
  if (!entity) {
    return { archived: false, archivePath: null };
  }

  await ensureDirs(campaignKey);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveName = `${entity.fileName.replace(/\.md$/i, "")}.${timestamp}.md`;
  const source = path.join(memoryDir(campaignKey), entity.fileName);
  const target = path.join(archiveDir(campaignKey), archiveName);

  await fs.rename(source, target);

  const id = `${campaignKey}:${entity.fileName}`;
  store.index.remove(id);
  store.entitiesById.delete(id);
  store.idsByName.delete(normalizeName(entity.name));
  store.idsByFile.delete(normalizeName(entity.fileName));
  rebuildGraph(store);

  return { archived: true, archivePath: target };
}

/**
 * Summarizes and archives oversized memory docs, keeping a compressed active copy.
 * @param {string} campaignId
 * @param {string} entityName
 * @returns {Promise<object | null>}
 */
export async function summarizeAndArchive(campaignId, entityName) {
  const campaignKey = String(campaignId || "unknown-campaign");
  const existing = await getEntity(campaignKey, entityName);
  if (!existing) {
    return null;
  }

  const threshold = await summarizeThreshold(campaignKey, 2000);
  if (wordCount(existing.body) <= threshold) {
    return existing;
  }

  let summary = "";
  try {
    const response = await generateUtility(
      [
        {
          role: "system",
          content:
            "You summarize RPG campaign memory docs. Return only concise markdown preserving important facts, relationships, and unresolved hooks."
        },
        {
          role: "user",
          content: `Summarize this memory document in under 400 words:\n\n${existing.body}`
        }
      ],
      campaignKey
    );
    summary = String(response.content || "").trim();
  } catch {
    summary = firstWords(existing.body, 400);
  }

  await archiveEntity(campaignKey, existing.name);

  const now = new Date().toISOString();
  const compressed = {
    ...existing,
    body: summary,
    lastUpdated: now,
    confidence: Math.max(0, Math.min(1, Number(existing.confidence || 1))),
    tags: dedupeStrings([...(existing.tags || []), "compressed"]),
    relations: dedupeRelations(existing.relations || [])
  };

  await upsertEntity(campaignKey, compressed);
  return getEntity(campaignKey, existing.name);
}

/**
 * Builds a constrained world-context block from relevant entities.
 * @param {string} campaignId
 * @param {string} query
 * @param {number} [tokenBudget]
 * @param {object} [styleConfig]
 * @returns {Promise<string>}
 */
export async function buildContextWindow(campaignId, query, tokenBudget = DEFAULT_CONTEXT_BUDGET, styleConfig = null) {
  const campaignKey = String(campaignId || "unknown-campaign");
  const searchResults = await search(campaignKey, query, { limit: 8 });

  const relevanceByName = new Map();
  const candidates = new Map();

  for (const result of searchResults) {
    const key = normalizeName(result.name);
    relevanceByName.set(key, Math.max(Number(result.relevance || result.score || 0), relevanceByName.get(key) || 0));
    candidates.set(key, result);
  }

  for (const entry of searchResults.slice(0, 3)) {
    const related = await getRelated(campaignKey, entry.name, 1);
    for (const relatedEntity of related.entities || []) {
      const key = normalizeName(relatedEntity.name);
      if (!candidates.has(key)) {
        candidates.set(key, relatedEntity);
      }
      if (!relevanceByName.has(key)) {
        relevanceByName.set(key, 0.2);
      }
    }
  }

  const all = [...candidates.values()];
  const maxAccessCount = all.reduce((maxValue, item) => Math.max(maxValue, Number(item.accessCount || 0)), 1);

  const ranked = all
    .map((entity) => {
      const key = normalizeName(entity.name);
      const baseRelevance = Number(relevanceByName.get(key) || 0.1);
      const priorityMultiplier = hasTagOverlap(entity.tags, styleConfig?.memory?.priorityTags || []) ? 1.5 : 1;
      const deprioritizedMultiplier = hasTagOverlap(entity.tags, styleConfig?.memory?.deprioritizedTags || []) ? 0.3 : 1;
      const playerMultiplier = playerAffinityBoost(entity, styleConfig?.memory?.playerFocusWeights || {});
      const relevance = baseRelevance * priorityMultiplier * deprioritizedMultiplier * playerMultiplier;
      const recency = recencyWeight(entity.lastAccessed);
      const access = accessWeight(entity.accessCount, maxAccessCount);
      return {
        ...entity,
        relevance,
        contextRank: relevance * 0.6 + recency * 0.3 + access * 0.1
      };
    })
    .sort((left, right) => right.contextRank - left.contextRank);

  const maxChars = Math.max(800, Number(tokenBudget || DEFAULT_CONTEXT_BUDGET) * 4);
  const included = [];
  let totalChars = 0;

  for (const entity of ranked) {
    const summary = firstWords(entity.body, 200);
    const chunk = [
      `[${entity.type}] ${entity.name}`,
      `Tags: ${(entity.tags || []).join(", ") || "none"}`,
      `Relations: ${(entity.relations || []).map((rel) => `${rel.type} -> ${rel.target}`).join("; ") || "none"}`,
      `Summary: ${summary}`
    ].join("\n");

    if (totalChars + chunk.length > maxChars) {
      continue;
    }

    included.push({ name: entity.name, text: chunk });
    totalChars += chunk.length + 2;
  }

  await Promise.all(included.map((item) => recordAccess(campaignKey, item.name)));

  return included.map((entry) => entry.text).join("\n\n");
}

/**
 * Legacy compatibility wrapper for listing campaign memory docs.
 * @param {string} campaignId
 * @returns {Promise<Array<{key: string, title: string, content: string, updatedAt: number}>>}
 */
export async function listCampaignMemoryDocs(campaignId) {
  const store = await ensureStore(campaignId);
  return [...store.entitiesById.values()].map((entity) => ({
    key: entity.fileName.replace(/\.md$/i, ""),
    title: entity.name,
    path: entity.filePath,
    content: entity.body,
    updatedAt: new Date(entity.lastUpdated || Date.now()).getTime()
  }));
}

/**
 * Legacy compatibility wrapper to write memory content by doc key.
 * @param {string} campaignId
 * @param {string} docKey
 * @param {string} content
 * @returns {Promise<{key: string, title: string, path: string, content: string, updatedAt: number}>}
 */
export async function writeCampaignMemoryDoc(campaignId, docKey, content) {
  const entity = await upsertEntity(campaignId, {
    name: String(docKey || "Untitled").replace(/[-_]/g, " "),
    type: "lore",
    tags: [String(docKey || "legacy")],
    body: String(content || "")
  });
  return {
    key: entity.fileName.replace(/\.md$/i, ""),
    title: entity.name,
    path: path.join(memoryDir(campaignId), entity.fileName),
    content: entity.body,
    updatedAt: new Date(entity.lastUpdated || Date.now()).getTime()
  };
}

/**
 * Legacy compatibility wrapper for keyword search.
 * @param {string} campaignId
 * @param {string} query
 * @param {{docKey?: string, limit?: number}} [options]
 * @returns {Promise<Array<{docKey: string, title: string, text: string, score: number, heading: string}>>}
 */
export async function searchCampaignMemory(campaignId, query, options = {}) {
  const type = options.docKey ? "lore" : undefined;
  const results = await search(campaignId, query, { type, limit: Number(options.limit || 5) });
  return results.map((entry) => ({
    docKey: entry.fileName.replace(/\.md$/i, ""),
    title: entry.name,
    heading: entry.name,
    text: firstWords(entry.body, 120),
    score: entry.score
  }));
}
