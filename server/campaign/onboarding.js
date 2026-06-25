import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyOperation, createSoloRun, getSoloRun, saveSoloRun } from "../db/repository.js";
import { ensureCampaignMemoryDocsAsync, rebuildCampaignIndex } from "../gm/memoryStore.js";
import { generateNpcIdentity } from "../solo/npcIdentity.js";
import { writeNpcMemoryDoc } from "../solo/npcMemory.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const onboardingSeedDir = path.join(__dirname, "onboarding-seeds");

// Starting-area NPC roles for the onboarding tavern. These are roles, not named
// characters — name/appearance/personality are generated per run (see
// generateNpcIdentity). The display name stays the role as a placeholder until
// identity is minted, then becomes the generated name.
const STARTING_NPCS = [
  {
    npcId: "tavern_keeper",
    role: "Tavern Keeper",
    known: true,
    tags: ["tavern-keeper", "quest-giver"],
    dialogueBeats: (characterName) => [
      {
        beatId: "tavern_keeper_greeting",
        label: "Greet the Tavern Keeper",
        text: `The tavern keeper sets down a clean glass. "You're soaked through, ${characterName}. Sit by the fire. You look like someone who's heard the rumors about the missing shipment — and someone who might be fool enough to ask about them."`,
        revealed: false,
        repeatable: true,
        contentTags: [],
        linkedMemoryFactIds: [],
        linkedQuestIds: [],
        edition: "mainline",
        policyProfileId: "mainline_default"
      }
    ]
  },
  {
    npcId: "mercenary",
    role: "Mercenary",
    known: false,
    tags: ["mercenary"],
    dialogueBeats: () => []
  },
  {
    npcId: "whisperer",
    role: "Whisperer",
    known: false,
    tags: ["mysterious", "quest-hook"],
    dialogueBeats: () => []
  }
];

function buildStartingNpc(config, characterName) {
  return {
    npcId: config.npcId,
    displayName: config.role,
    role: config.role,
    currentLocationId: "start_location",
    known: config.known === true,
    status: "present",
    memoryFactIds: [],
    tags: config.tags || [],
    flags: {},
    edition: "mainline",
    policyProfileId: "mainline_default",
    contentTags: [],
    dialogueBeats: config.dialogueBeats(characterName)
  };
}

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

  const createdRun = createSoloRun({ userId: actorUserId });
  const run = getSoloRun(createdRun.runId);
  // Link the run to its campaign so NPC state can be bridged into the campaign
  // memory graph the GM reads (and resolved later on first-encounter writes).
  run.campaignId = campaignId;
  // Personalize the run's player with the created character (createSoloRun
  // defaults displayName to "Player" and has no class). className is an extra
  // field the validator tolerates; the sidebar reads both.
  run.player.displayName = characterName;
  run.player.className = archetype;
  const startLocation = run.locations.start_location;
  startLocation.name = "The Shattered Flagon";
  startLocation.description =
    "A rain-soaked tavern in Ashenmoor. Lamp oil, wet wool, and iron-rich blood. The keeper watches the door from behind the bar.";
  startLocation.tags = Array.from(new Set([...(startLocation.tags || []), "ashenmoor", "tavern"]));

  run.npcs = run.npcs || {};
  // Mint a procedural identity for each starting-area NPC upfront, before the
  // player enters the world, and write it onto the entity. generateNpcIdentity
  // is deterministic per (worldSeed, npcIndex) and never blocks gameplay here —
  // onboarding is a one-time setup path, not a hot scene request.
  let npcIndex = 0;
  for (const config of STARTING_NPCS) {
    const npc = buildStartingNpc(config, characterName);
    npc.origin = "procedural";
    // eslint-disable-next-line no-await-in-loop
    const identity = await generateNpcIdentity({
      role: npc.role,
      worldSeed: run.worldSeed,
      npcIndex
    });
    npc.generatedName = identity.generatedName;
    npc.appearance = identity.appearance;
    npc.personality = identity.personality;
    npc.portraitPrompt = identity.portraitPrompt;
    npc.identitySeed = identity.identitySeed;
    npc.displayName = identity.generatedName;
    // Bridge the NPC into the campaign memory graph (synchronous write).
    const docId = writeNpcMemoryDoc(campaignId, npc);
    if (docId) {
      npc.memoryDocId = docId;
    }
    run.npcs[npc.npcId] = npc;
    npcIndex += 1;
  }

  // Refresh the memory index so the GM sees the freshly-written NPC docs.
  await rebuildCampaignIndex(campaignId);

  const savedRun = saveSoloRun(run);

  return { campaignId, runId: savedRun.runId };
}
