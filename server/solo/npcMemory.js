import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// NPC → memory-graph bridge (synchronous).
//
// The GM reads the campaign memory graph (markdown docs under
// data/campaigns/<id>/memory/), NOT run.npcs. This writes a memory doc for an
// NPC so the GM can actually see it. Intentionally synchronous and unqueued:
// callers persist the returned docId onto the NPC, then trigger the async
// rebuildCampaignIndex so the in-memory index picks the new doc up.
//
// Only markdown is written to disk here — never into notdnd.db.json.
// ---------------------------------------------------------------------------

function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function memoryRoot() {
  return process.env.NOTDND_MEMORY_ROOT
    ? path.resolve(process.env.NOTDND_MEMORY_ROOT)
    : path.resolve(process.cwd(), "data/campaigns");
}

function memoryDir(campaignId) {
  return path.join(memoryRoot(), String(campaignId || "unknown-campaign"), "memory");
}

function slugify(value) {
  return (
    String(value || "npc")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 90) || "npc"
  );
}

function nowIso() {
  return new Date().toISOString();
}

function quote(value) {
  return `"${String(value || "").replace(/"/g, '\\"')}"`;
}

function buildDoc(npc) {
  const name = String(npc.generatedName || npc.displayName || npc.role || npc.npcId || "NPC").trim();
  const role = String(npc.role || "character").trim();
  const origin = String(npc.origin || "procedural").trim();
  const tags = ["npc", origin, slugify(role)];

  const now = nowIso();
  const frontmatter = [
    "---",
    "type: npc",
    `name: ${quote(name)}`,
    `tags: [${tags.map((tag) => quote(tag)).join(", ")}]`,
    "relations:",
    `lastAccessed: ${now}`,
    `lastUpdated: ${now}`,
    "accessCount: 0",
    "confidence: 0.9",
    "---"
  ].join("\n");

  const bodyParts = [`${name} is the ${role.toLowerCase()}.`];
  if (isString(npc.appearance)) {
    bodyParts.push(`Appearance: ${String(npc.appearance).trim()}`);
  }
  if (isString(npc.personality)) {
    bodyParts.push(`Personality: ${String(npc.personality).trim()}`);
  }
  if (isString(npc.introInstructions)) {
    bodyParts.push(`GM introduction directive: ${String(npc.introInstructions).trim()}`);
  }

  return `${frontmatter}\n\n${bodyParts.join("\n\n")}\n`;
}

/**
 * Synchronously writes a memory doc for an NPC into the campaign memory dir and
 * returns its docId (the markdown filename). Idempotent: if the NPC already has
 * a memoryDocId, returns it without writing. Returns null when the campaign id
 * or NPC is missing.
 * @param {string} campaignId
 * @param {object} npc
 * @returns {string | null}
 */
export function writeNpcMemoryDoc(campaignId, npc) {
  const campaignKey = String(campaignId || "").trim();
  if (!campaignKey || !npc) {
    return null;
  }
  if (isString(npc.memoryDocId)) {
    return npc.memoryDocId;
  }

  const fileName = `npc-${slugify(npc.npcId || npc.generatedName || npc.role)}.md`;
  const dir = memoryDir(campaignKey);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), buildDoc(npc), "utf8");
  return fileName;
}
