import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyOperation } from "../db/repository.js";
import { ensureCampaignMemoryDocsAsync, rebuildCampaignIndex } from "../gm/memoryStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const onboardingSeedDir = path.join(__dirname, "onboarding-seeds");

function memoryRoot() {
  return process.env.NOTDND_MEMORY_ROOT
    ? path.resolve(process.env.NOTDND_MEMORY_ROOT)
    : path.resolve(process.cwd(), "data/campaigns");
}

function sanitizeName(value, fallback = "Wanderer") {
  const cleaned = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return cleaned || fallback;
}

function sanitizeLine(value, fallback = "") {
  const cleaned = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
  return cleaned || fallback;
}

function slugTag(value) {
  return String(value || "adventurer")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "adventurer";
}

function interpolateTemplate(template, replacements) {
  let output = String(template || "");
  for (const [key, value] of Object.entries(replacements)) {
    const token = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "g");
    output = output.replace(token, String(value ?? ""));
  }
  return output;
}

async function seedOnboardingMemory(campaignId, replacements) {
  const memoryDir = path.join(memoryRoot(), campaignId, "memory");
  await ensureCampaignMemoryDocsAsync(campaignId);
  await fs.mkdir(memoryDir, { recursive: true });

  for (const legacyFile of ["human-gm.md", "agent-gm.md", "shared-timeline.md"]) {
    try {
      await fs.unlink(path.join(memoryDir, legacyFile));
    } catch {
      // Ignore missing legacy docs for campaigns that were already customized.
    }
  }

  const files = (await fs.readdir(onboardingSeedDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  for (const fileName of files) {
    const sourcePath = path.join(onboardingSeedDir, fileName);
    const targetPath = path.join(memoryDir, fileName);
    const rawTemplate = await fs.readFile(sourcePath, "utf8");
    const hydrated = interpolateTemplate(rawTemplate, replacements);
    await fs.writeFile(targetPath, hydrated, "utf8");
  }

  await rebuildCampaignIndex(campaignId);
}

/**
 * Creates a solo-friendly onboarding campaign and seeds a starter memory graph.
 * @param {string} userId
 * @param {{characterName?: string, archetype?: string, backstorySnippet?: string}} characterInfo
 * @returns {Promise<string>}
 */
export async function createOnboardingCampaign(userId, characterInfo = {}) {
  const actorUserId = String(userId || "").trim();
  if (!actorUserId) {
    const error = new Error("userId is required to create an onboarding campaign.");
    error.code = "BAD_REQUEST";
    error.statusCode = 400;
    throw error;
  }

  const characterName = sanitizeName(characterInfo.characterName, "Wanderer");
  const archetype = sanitizeLine(characterInfo.archetype, "a hardened drifter");
  const backstorySnippet = sanitizeLine(
    characterInfo.backstorySnippet,
    "You carry old debts, older scars, and a quiet hunger for redemption."
  );

  const created = applyOperation(
    "create_campaign",
    {
      name: `${characterName}'s First Adventure`,
      setting: "Dark Fantasy",
      status: "Ready",
      readiness: 90,
      players: [characterName]
    },
    {
      actorUserId
    }
  );

  const campaignId = String(created?.id || "").trim();
  if (!campaignId) {
    const error = new Error("Failed to create onboarding campaign.");
    error.code = "CAMPAIGN_CREATE_FAILED";
    error.statusCode = 500;
    throw error;
  }

  applyOperation(
    "add_character",
    {
      campaignId,
      name: characterName,
      className: archetype,
      level: 1,
      ac: 12,
      hp: 12,
      speed: 30,
      stats: {
        str: 12,
        dex: 13,
        con: 12,
        int: 11,
        wis: 12,
        cha: 13
      },
      proficiencies: ["Perception", "Insight"],
      spells: [],
      inventory: ["Traveler's Cloak", "Weathered Blade", "Flint Kit"]
    },
    {
      actorUserId
    }
  );

  await seedOnboardingMemory(campaignId, {
    characterName,
    archetype,
    archetypeTag: slugTag(archetype),
    backstorySnippet
  });

  return campaignId;
}
