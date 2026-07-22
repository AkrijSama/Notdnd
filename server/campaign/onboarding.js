import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyOperation, createSoloRun, getSoloRun, getUserWorld, listUserHomebrew, saveSoloRun } from "../db/repository.js";
import { logTurnEvent } from "../logging/sessionLog.js";
import { normalizeContentForBuild } from "../homebrew/customContent.js";
import { ensureCampaignMemoryDocsAsync, rebuildCampaignIndex } from "../gm/memoryStore.js";
import { runGmPipeline } from "../gm/prompting.js";
import { buildOpeningGmMessage, buildOpeningFallback } from "../gm/actionNarration.js";
import { buildCharacter, toRunPlayer } from "../solo/characterBuild.js";
import { copyDraftPortraitToRun } from "../solo/imageWorker.js";
import { generateNpcIdentity, npcTakenNames, npcTakenMannerisms } from "../solo/npcIdentity.js";
import { ensureClock } from "../solo/worldClock.js";
import { buildSystemLoreClause } from "../gm/systemLore.js";
import { writeNpcMemoryDoc } from "../solo/npcMemory.js";
import { buildFarLocation, buildSecondLocation, generateWorld } from "../solo/worldGen.js";
import { createMainQuest } from "../solo/quests.js";
import { lockRunArtStyle } from "../solo/artStyle.js";
import { buildTrialQuest, TRIAL_QUEST_ID, buildDeliveryOffer } from "./authoredQuests.js";
import { resolveRequestedScenario, resolveUserWorldScenario, loadScenarioIntoRun } from "./scenarioLoader.js";
import { seedSandboxThreads } from "../solo/threads.js";
import { seedFactions, mintNpcReputation, migrateReputation, normalizeAgeClass } from "../solo/reputation.js";

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
        text: `The tavern keeper sets down a clean glass. "You're soaked through, ${characterName}. Sit by the fire. You look like someone who's heard the rumors about the missing shipment, and someone who might be fool enough to ask about them."`,
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
    ageClass: normalizeAgeClass(config.ageClass), // starting cast are adults unless a config says otherwise
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

function isStr(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Deterministic non-negative hash for tone-driven content selection.
function contentSeed(value) {
  let hash = 0;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// Builds the quest-giver's dialogue: the quest-completing arrival beat first
// (so reaching + talking still resolves stage 1 in one conversation), then
// tone-flavoured lore / hint / ambient beats for ongoing conversation. The
// extra beats carry no quest link, so they never advance the quest themselves.
function buildQuestGiverBeats(world = {}, place = "this place") {
  const tone = isStr(world.tone) ? world.tone.trim() : "uncertain";
  const worldName = isStr(world.name) ? world.name.trim() : "this world";
  return [
    {
      beatId: "beat_quest_main_arrival",
      label: "Why you came",
      text: `So, you reached ${place}. What you came looking for begins here. There is no turning back now.`,
      revealed: false,
      repeatable: false,
      linkedQuestIds: ["quest_main"],
      contentTags: []
    },
    {
      beatId: "beat_lore",
      label: "About this place",
      text: `They say ${place} remembers more of ${worldName} than the living do. Stand here long enough and the ${tone} of it all settles into your bones.`,
      revealed: false,
      repeatable: false,
      linkedQuestIds: [],
      contentTags: []
    },
    {
      beatId: "beat_hint",
      label: "What comes next",
      text: `If you mean to see this through, don't linger. Speak plainly with those who wait here, what you seek is closer than the road behind you.`,
      revealed: false,
      repeatable: false,
      linkedQuestIds: [],
      contentTags: []
    },
    {
      beatId: "beat_ambient",
      label: "A passing word",
      text: `The figure studies you. "${capitalizeFirst(tone)} days," they murmur, "and ${worldName} grows no kinder. Watch yourself."`,
      revealed: false,
      repeatable: true,
      linkedQuestIds: [],
      contentTags: []
    }
  ];
}

function capitalizeFirst(value) {
  const s = String(value || "").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Procedural STARTING-AREA features for an adoptable forest-ruins base. The
// default location graph (schema.js) ships only a bare "Scuffed Mark"; a base the
// player is invited to claim should have REAL, server-owned, discoverable content
// worth exploring + mapping — the ruins structure as a landmark plus a few POIs.
// Deterministic per world (tone/name flavor the prose), genre-consistent with the
// forest-ruins archetype. Returned as `searchDetails` (revealed by the search
// action), so the world has content — we never fake map markers.
function buildStartAreaFeatures(world = {}, seed = 0) {
  const tone = isStr(world.tone) ? world.tone.trim() : "dark fantasy";
  const worldName = isStr(world.name) ? world.name.trim() : "this world";
  const detail = (detailId, label, description) => ({
    detailId,
    label,
    description,
    revealed: false,
    contentTags: [],
    linkedEntityIds: ["start_location"],
    linkedMemoryFactIds: [],
    edition: "mainline",
    policyProfileId: "mainline_default"
  });
  // A small deterministic pick so two worlds don't read identically.
  const pick = (list) => list[Math.abs(Math.trunc(Number(seed) || 0)) % list.length];
  const heart = pick(["collapsed great hall", "roofless feast hall", "fallen keep's core"]);
  const watchpoint = pick(["leaning watchtower", "broken signal spire", "toppled gate-arch"]);
  return [
    detail(
      "start_location_ruins_hall",
      "The Collapsed Hall",
      `The ${heart} is the heart of these ruins, fire-scarred pillars still hold a span of roof, dry and defensible. ` +
        `This is the shell you could make your own: clear the rubble and it becomes a hearth, a wall, a foothold in ${worldName}.`
    ),
    detail(
      "start_location_old_well",
      "The Old Well",
      `A stone well-mouth, half-choked with leaves and creeper. The rope is long rotted, but the shaft runs deep and the air off it ` +
        `is cold and wet, there is water down there still, which means this place could keep someone alive.`
    ),
    detail(
      "start_location_watch",
      "The Broken Watchpoint",
      `A ${watchpoint} leans at the tree-line, its stair half-swallowed by roots. From its top a watcher could see anyone ` +
        `approaching through the ${tone} wood long before they reached the stones, the makings of a guarded threshold.`
    ),
    detail(
      "start_location_cache",
      "An Ash-Buried Cache",
      `Under a fall of soot and forest litter, the corner of a buried strongbox shows, whoever held these ruins last left ` +
        `in a hurry, or never left at all. Worth digging out: ruins like these reward the patient scavenger.`
    )
  ];
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
  // Committed service (affordances-map-law Part A): the tavern offers lodging, so
  // a "rent a room" affordance is real here (and INFEASIBLE — gated — anywhere
  // that lacks an inn service).
  startLocation.services = [{ kind: "inn", label: "Take a room upstairs" }];

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
      npcIndex,
      // Per-run first-name uniqueness (the two-Maras bug): each mint checks the
      // roster committed so far, so pre-seeded starting NPCs can never collide.
      takenNames: npcTakenNames(run),
      takenMannerisms: npcTakenMannerisms(run)
    });
    npc.generatedName = identity.generatedName;
    npc.appearance = identity.appearance;
    npc.personality = identity.personality;
    npc.portraitPrompt = identity.portraitPrompt;
    npc.identitySeed = identity.identitySeed;
    npc.displayName = identity.generatedName;
    // #50: carry the generated gender/pronouns so the starting NPC's portrait
    // matches the written character (else the base model defaults male).
    if (typeof identity.gender === "string" && identity.gender.trim()) npc.gender = identity.gender.trim();
    if (typeof identity.pronouns === "string" && identity.pronouns.trim()) npc.pronouns = identity.pronouns.trim();
    // Declared build (mint default: varied) so the starting cast carries mixed
    // committed shapes instead of the checkpoint's uniform default figure.
    if (typeof identity.bodyType === "string" && identity.bodyType.trim()) npc.bodyType = identity.bodyType.trim();
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

// A starting contact whose role suits the generated starting-location type.
function roleForLocationType(type) {
  const key = String(type || "").toLowerCase();
  const map = {
    tavern: "Tavern Keeper",
    "city gate": "Gate Warden",
    wilderness: "Wandering Hunter",
    dungeon: "Fellow Prisoner",
    port: "Dockmaster",
    market: "Merchant",
    temple: "Acolyte",
    ruins: "Scavenger",
    camp: "Camp Quartermaster",
    crossroads: "Wayfarer"
  };
  return map[key] || "Local";
}

// Coherence rule for scene population: DON'T place a person in the starting area
// without a reason. The player starts ALONE unless presence is justified —
//   (a) a campaign/module explicitly places one (world.startingNpc with a
//       `reason`), or
//   (b) a busy PUBLIC venue where a contact's presence is self-evident (a tavern
//       has a keeper, a market a merchant, a gate a warden, a port a dockmaster).
// An abandoned/wilderness start (the forest-ruins default, a dungeon, the wilds)
// has no such reason, so it stays empty — an unexplained stranger is worse than
// solitude. Returns a spec { role, reason, known } or null (start alone).
const SELF_EVIDENT_PRESENCE = {
  tavern: "tends this tavern and is here because it is their establishment",
  market: "trades in this market and is here to do business",
  "city gate": "stands watch at this gate as their posting",
  port: "runs the comings and goings of this port"
};

function resolveStartingNpcSpec(world, resolvedWorld) {
  // (a) Explicit module/world placement. Honoured only when it states a reason,
  // so we never reintroduce a contextless stranger.
  const spec = world && typeof world.startingNpc === "object" && world.startingNpc ? world.startingNpc : null;
  if (spec && isStr(spec.reason)) {
    return {
      role: isStr(spec.role) ? spec.role : roleForLocationType(resolvedWorld.startingLocationType),
      reason: spec.reason.trim(),
      known: spec.known !== false
    };
  }
  // (b) Self-evident presence at a busy public venue.
  const key = String(resolvedWorld.startingLocationType || "").toLowerCase();
  const evident = SELF_EVIDENT_PRESENCE[key];
  if (evident) {
    const role = roleForLocationType(resolvedWorld.startingLocationType);
    return { role, reason: `the ${role.toLowerCase()} ${evident}`, known: true };
  }
  // Otherwise: no justified reason -> the player starts alone.
  return null;
}

/**
 * World-generator onboarding (Tickets 38 + 39). Resolves the world from the
 * player's (partial) definition, creates the campaign + solo run, builds the
 * starting location from the generated world, seeds a world-overview memory doc,
 * generates one tone-appropriate starting NPC, and applies the full 5e
 * character onto run.player.
 * @param {string} userId
 * @param {{ world?: object, character?: object }} payload
 * @returns {Promise<{ campaignId: string, runId: string, world: object }>}
 */
// Item 2 (bucket-2) ROOT CAUSE FIX: this was a flat 15s race — LESS than the 35s
// the per-attempt cloud lane itself allows (gmCloudTimeoutMs), while the opening
// requests 420 tokens (2.2x a turn's budget) for orientation. The wrapper was
// aborting still-WORKING generations (~10-14s of pure decode + cold-start
// context), dropping ~half of cold-start openings to the deterministic template.
// Same principle as effectiveActionTimeoutMs: sit just ABOVE the lane window so
// this is a true backstop for hung calls, never a pre-emptor of working ones.
// Onboarding is a one-time cold start; the player is on the world-forge screen.
const OPENING_NARRATION_TIMEOUT_MS = (() => {
  const v = Number(process.env.NOTDND_OPENING_TIMEOUT_MS || process.env.INKBORNE_OPENING_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 40000;
})();

// Generates the world-entry opening via the real GM pipeline, bounded so a slow
// or unconfigured provider never blocks onboarding. Falls back to the starting
// location description on timeout/empty/error.
async function generateOpeningNarration({ campaignId, runId, message, playerName, actorUserId, fallback }) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), OPENING_NARRATION_TIMEOUT_MS);
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
  });
  const t0 = Date.now();
  try {
    const result = await Promise.race([
      Promise.resolve(runGmPipeline({ campaignId, message, mode: "companion", playerName, actorUserId, flashMaxTokens: 420, deferMemory: true, transcript: { runId, callType: "opening" } })).catch(() => null),
      timeout
    ]);
    if (timer) {
      clearTimeout(timer);
    }
    const narrative = result && typeof result.narrative === "string" ? result.narrative.trim() : "";
    if (!narrative) {
      // FORMERLY SILENT (#9): the opening GM call timed out/failed/empty and a
      // deterministic opening stood in — at the most-noticed moment (first entry).
      // Now LOUD in the run transcript so a quiet opening is explainable.
      logTurnEvent(runId, `OPENING narration fell back to deterministic prose after ${Date.now() - t0}ms (GM timeout ${OPENING_NARRATION_TIMEOUT_MS}ms / empty / error).`);
    }
    return narrative || fallback;
  } catch (error) {
    if (timer) {
      clearTimeout(timer);
    }
    logTurnEvent(runId, `OPENING narration ERRORED after ${Date.now() - t0}ms (${String(error?.message || error).slice(0, 120)}), deterministic opening used.`);
    return fallback;
  }
}

export async function createWorldOnboardingRun(userId, { world = {}, character = {}, draftPortraitId = null, mode = "campaign", scenarioId = null, userWorldId = null } = {}) {
  const actorUserId = String(userId || "").trim();
  if (!actorUserId) {
    const error = new Error("userId is required to create a world onboarding run.");
    error.code = "BAD_REQUEST";
    error.statusCode = 400;
    throw error;
  }

  // item-2 diagnosis (purge-and-diagnose): stage marks for the opening path —
  // one greppable openingTiming line per opening (the turnTiming pattern).
  const stageT = { t0: Date.now(), marks: {} };
  const markStage = (name) => {
    const now = Date.now();
    stageT.marks[name] = now - (stageT.prev || stageT.t0);
    stageT.prev = now;
  };

  const resolvedWorld = await generateWorld(world);
  markStage("worldgen");
  const characterName = sanitizeName(character.name, "Wanderer");

  // SCENARIO FORK (root-cause of the location contradiction): a PRE-BUILT scenario
  // authoritatively provides world + location + cast + opening. It must NOT share
  // the sandbox worldgen path, or the player's chosen world/location (dark-fantasy
  // ruins) collides with the authored fiction (the Terra night market) and bleeds
  // into narration/suggestions. Resolved here (before the campaign + world-overview
  // doc) so the scenario's setting is the ONLY source of truth from the first byte.
  const sandbox = String(mode || "").trim().toLowerCase() === "sandbox";
  // AUTHORED scenario first (built-in id / env). If none, try an owner-scoped USER
  // WORLD (the Custom World flow) — the SAME loadScenarioIntoRun pipeline, never in
  // sandbox. getUserWorld is owner-scoped, so a foreign id resolves to nothing and
  // simply falls back to worldgen (world isolation is enforced at this boundary).
  let scenario = resolveRequestedScenario({ scenarioId, sandbox });
  let userWorldRecord = null;
  if (!scenario && !sandbox && isStr(userWorldId)) {
    userWorldRecord = getUserWorld(actorUserId, userWorldId.trim());
    scenario = resolveUserWorldScenario(userWorldRecord);
    if (!scenario) userWorldRecord = null; // invalid/foreign record → worldgen fallback
  }
  const scenarioActive = Boolean(scenario);
  // The effective setting: the scenario's authored world when active, else the
  // player-choice worldgen output. Drives the campaign record, the world-overview
  // memory doc, and run.world — every place worldgen flavor would otherwise leak.
  const sw = scenarioActive && scenario.world && typeof scenario.world === "object" ? scenario.world : null;
  const effectiveWorldName = (sw && isStr(sw.name)) ? sw.name : resolvedWorld.name;
  const effectiveWorldTone = (sw && isStr(sw.tone)) ? sw.tone : resolvedWorld.tone;
  const scenarioStartDesc = scenarioActive && isStr(scenario.opening?.situation) ? scenario.opening.situation.trim() : "";

  const created = applyOperation(
    "create_campaign",
    {
      name: effectiveWorldName,
      setting: effectiveWorldTone,
      status: "Ready",
      readiness: 90,
      players: [characterName]
    },
    { actorUserId }
  );
  const campaignId = String(created?.id || "").trim();
  if (!campaignId) {
    const error = new Error("Failed to create world onboarding campaign.");
    error.code = "CAMPAIGN_CREATE_FAILED";
    error.statusCode = 500;
    throw error;
  }

  // Seed a world-overview memory doc so the GM's context reflects the world. For a
  // SCENARIO run this MUST be the scenario's setting (not the worldgen ruins), or
  // the doc bleeds dark-fantasy lore into every GM turn.
  const worldOverview = scenarioActive
    ? `# ${effectiveWorldName}\n\nTone: ${effectiveWorldTone}\n\n${isStr(sw?.flavor) ? sw.flavor : scenario.stakes || ""}\n\n` +
      `Opening: ${scenarioStartDesc}`
    : `# ${resolvedWorld.name}\n\nTone: ${resolvedWorld.tone}\n\n${resolvedWorld.description}\n\n` +
      `Starting location: ${resolvedWorld.startingLocation.name}, ${resolvedWorld.startingLocation.description}`;
  await ensureCampaignMemoryDocsAsync(campaignId, { "World Overview": worldOverview });
  markStage("campaignDocs");

  const createdRun = createSoloRun({ userId: actorUserId });
  const run = getSoloRun(createdRun.runId);
  run.campaignId = campaignId;
  // C.5 / owner decision (a): a SANDBOX is a pure open world with ZERO authored
  // objective — it reacts to player-authored goals (Track A capturePlayerObjective)
  // instead of an assigned quarry. So we STOP CREATING the procedural spine (the
  // directed main quest + its quest-linked contacts) for sandbox runs, rather than
  // creating-then-suppressing it. Track A's quest-layer suppression remains as a
  // belt-and-suspenders net. Campaign/module runs are unchanged.
  // (sandbox/scenario resolved above, before the campaign + world-overview doc.)
  run.mode = sandbox ? "sandbox" : "campaign";
  // The scenario loader (loadScenarioIntoRun) overwrites run.world with the
  // scenario's authored setting; seeding worldgen values here for a scenario run
  // is harmless (they're replaced) but we skip the ruins-flavored fields that
  // would otherwise persist if the scenario under-specifies.
  run.world = {
    ...run.world,
    name: resolvedWorld.name,
    tone: resolvedWorld.tone,
    startingLocationName: resolvedWorld.startingLocationName,
    startingLocationType: resolvedWorld.startingLocationType,
    flavor: resolvedWorld.flavor,
    // Persistent weather seed (owner checklist item 1): worldgen may author it
    // (world-book extensibility later); default clear. Server-owned from here —
    // only the sky-hazard system overlays it, never the narrator.
    weather: resolvedWorld.weather || "clear",
    // artStyleOptions.default is the new primary; artStyle stays as the legacy
    // resume-safety fallback (both stamped by worldGen via stampArtStyle).
    artStyle: resolvedWorld.artStyle,
    artStyleOptions: resolvedWorld.artStyleOptions
  };
  // STYLE LOCK LAW: write the player's chosen art style ONCE, validated against
  // world.artStyleOptions.allowed. This is the guarded setter's first (grant-free)
  // write; any later CHANGING write throws unless a styleSwitch grant is passed
  // (the Ink-priced switch, not built here). resolvedWorld.artStyle is the choice
  // the world-select chip forwarded (normalized to canonical vocab by the setter).
  lockRunArtStyle(run, resolvedWorld.artStyle);

  // Replace the placeholder starting location with the generated one — but NOT for
  // a scenario run: the scenario authors start_location's name/description (the
  // loader applies it), and the worldgen ruins name/description here is exactly
  // the "GM says ruins, UI says market" contamination. The scenario is the source.
  const start = run.locations.start_location;
  if (!scenarioActive) {
    start.name = resolvedWorld.startingLocation.name;
    start.description = resolvedWorld.startingLocation.description;
    start.tags = Array.from(
      new Set([
        ...(start.tags || []).filter((tag) => tag !== "placeholder"),
        slugTag(resolvedWorld.tone),
        slugTag(resolvedWorld.startingLocationType)
      ])
    );
  }
  // Populate the starting area with real, server-owned, discoverable FEATURES so
  // it isn't bare terrain. An adoptable forest-ruins base (the default sandbox
  // start) gets the ruins structure as a landmark + a few POIs (well, watchpoint,
  // cache); explicit non-baseable venues (a tavern) keep the bare default. This is
  // the WORLD having content — the area generator placing it, not faked markers.
  // Skipped for a scenario run: these are dark-fantasy ruins POIs (ruins hall,
  // old well, watchpoint, cache) that would populate the scene with rubble the
  // authored fiction doesn't have.
  if (resolvedWorld.startIsBaseable === true && !scenarioActive) {
    start.searchDetails = buildStartAreaFeatures(
      resolvedWorld,
      contentSeed(`${resolvedWorld.name}|${resolvedWorld.startingLocationName}|features`)
    );
  }

  // Apply the full 5e character onto run.player, including any of the user's
  // custom homebrew content. Custom races/classes/backgrounds resolve through
  // the same code path as SRD, so their mechanics (ability bonuses, saves, hit
  // die, features) apply identically.
  const customContent = normalizeContentForBuild(listUserHomebrew(actorUserId));
  const built = buildCharacter(character, { customContent });
  run.player = toRunPlayer(built, run.player);
  // toRunPlayer sets pronouns to null when the player left the (optional) field
  // blank; default to he/him (owner default) so the GM is never left guessing.
  if (typeof run.player.pronouns !== "string" || !run.player.pronouns.trim()) {
    run.player.pronouns = "he/him";
  }

  // Record provenance: if the character used any custom content, mark the run's
  // ruleset as "custom" (additive — vanilla characters keep the default ruleset).
  const usedCustom =
    customContent.races.some((entry) => entry.name === built.race) ||
    customContent.classes.some((entry) => entry.name === built.class) ||
    customContent.backgrounds.some((entry) => entry.name === built.background);
  if (usedCustom) {
    run.rulesetId = "custom";
  }

  // Carry forward a portrait generated during character creation (draft run)
  // into this run's asset namespace, so /scene reuses it instead of
  // regenerating from scratch. Best-effort: if the draft is missing, the normal
  // scene-entry generation still runs.
  if (typeof draftPortraitId === "string" && draftPortraitId.trim()) {
    const carriedUri = copyDraftPortraitToRun(draftPortraitId.trim(), run.runId);
    if (carriedUri) {
      run.player.portraitUri = carriedUri;
    }
  }

  // Starting-area population is GATED on a real reason (see resolveStartingNpcSpec).
  // With no justification the player starts ALONE in the ruins — no contextless
  // stranger. When a contact IS placed, its `reason` is stored as the NPC's
  // introInstructions, which the scene/GM turns into a directive to introduce
  // them naturally AND explain why they're here (buildNpcIntroDirective).
  run.npcs = run.npcs || {};
  // Skipped for a scenario run: the scenario authors its own cast (Vesa the fixer,
  // the ripperdoc). A procedurally-placed dark-fantasy start contact here would be
  // an unauthored stranger contradicting the scene.
  const startingNpcSpec = scenarioActive ? null : resolveStartingNpcSpec(world, resolvedWorld);
  let npc = null;
  if (startingNpcSpec) {
    const npcRole = startingNpcSpec.role;
    npc = {
      npcId: "npc_start_contact",
      displayName: npcRole,
      role: npcRole,
      currentLocationId: "start_location",
      known: startingNpcSpec.known,
      status: "present",
      memoryFactIds: [],
      tags: [slugTag(npcRole)],
      flags: {},
      edition: "mainline",
      policyProfileId: "mainline_default",
      contentTags: [],
      origin: "procedural",
      // Why this person is in the starting area — surfaced to the GM so the
      // scene justifies their presence instead of spawning a faceless figure.
      introInstructions: `Justify this character's presence: ${startingNpcSpec.reason}. Introduce them naturally; do not force a conversation.`
    };
    const identity = await generateNpcIdentity({
      role: `${npcRole} in a ${resolvedWorld.tone} world`,
      worldSeed: run.worldSeed,
      npcIndex: 0,
      // Per-run first-name uniqueness (the two-Maras bug).
      takenNames: npcTakenNames(run),
      takenMannerisms: npcTakenMannerisms(run)
    });
    markStage("npcIdentity");
    npc.generatedName = identity.generatedName;
    npc.appearance = identity.appearance;
    npc.personality = identity.personality;
    npc.portraitPrompt = identity.portraitPrompt;
    npc.identitySeed = identity.identitySeed;
    npc.displayName = identity.generatedName;
    // #50: carry the generated gender/pronouns so the starting NPC's portrait
    // matches the written character (else the base model defaults male).
    if (typeof identity.gender === "string" && identity.gender.trim()) npc.gender = identity.gender.trim();
    if (typeof identity.pronouns === "string" && identity.pronouns.trim()) npc.pronouns = identity.pronouns.trim();
    if (typeof identity.bodyType === "string" && identity.bodyType.trim()) npc.bodyType = identity.bodyType.trim();
    const docId = writeNpcMemoryDoc(campaignId, npc);
    if (docId) {
      npc.memoryDocId = docId;
    }
    run.npcs[npc.npcId] = npc;
  }

  // Un-hardcode the second location: give it a tone-driven archetype name +
  // description (was the fixed "Ashenmoor Market Square" from the default graph).
  const worldSeed = contentSeed(`${resolvedWorld.name}|${resolvedWorld.tone}`);
  const secondLocation = run.locations?.second_location || null;
  // Skipped for a scenario run: the scenario authors second_location (the Terra
  // night market); a worldgen tone-archetype name/description would overwrite it.
  if (secondLocation && !scenarioActive) {
    const built = buildSecondLocation(resolvedWorld.tone, worldSeed, resolvedWorld.name);
    secondLocation.name = built.name;
    secondLocation.description = built.description;
    secondLocation.tags = Array.from(
      new Set([
        ...(secondLocation.tags || []).filter((tag) => !["ashenmoor", "market", "curfew"].includes(tag)),
        slugTag(resolvedWorld.tone),
        slugTag(built.suffix)
      ])
    );
  }

  // Seed stage-1 content at the second location: a quest-giver NPC whose arrival
  // beat is linked to the main quest (talking there completes stage 1), plus
  // tone-flavoured lore/hint/ambient beats for ongoing conversation.
  if (secondLocation && !sandbox && !scenarioActive) {
    run.npcs.npc_quest_giver = {
      npcId: "npc_quest_giver",
      displayName: "A waiting figure",
      role: "stranger",
      currentLocationId: "second_location",
      known: true,
      status: "present",
      memoryFactIds: [],
      tags: ["quest"],
      flags: {},
      edition: "mainline",
      policyProfileId: "mainline_default",
      contentTags: [],
      origin: "procedural",
      dialogueBeats: buildQuestGiverBeats(resolvedWorld, secondLocation.name)
    };
  }

  // Tone-driven far location: replace the placeholder third location (the far
  // edge of the graph — connected only to second_location, so unreachable from
  // start) with a destination named from the world, seed searchDetails so it
  // rewards exploration, and place a lone witness there with end-state lore.
  const thirdLocation = run.locations?.third_location || null;
  // Skipped for a scenario run: buildFarLocation names/describes/tags the third
  // location in the worldgen tone and seeds dark-fantasy relic/vista POIs ("before
  // {world} fell to its {tone}") — the scenario authors this location instead.
  if (thirdLocation && !scenarioActive) {
    const far = buildFarLocation(resolvedWorld.tone, worldSeed, resolvedWorld.name);
    thirdLocation.name = far.name;
    thirdLocation.description = far.description;
    thirdLocation.tags = Array.from(
      new Set([
        ...(thirdLocation.tags || []).filter((tag) => !["ashenmoor", "ashen-watch", "gatehouse"].includes(tag)),
        slugTag(resolvedWorld.tone),
        "destination"
      ])
    );
    thirdLocation.searchDetails = [
      {
        detailId: "third_location_relic",
        label: "A Half-Buried Relic",
        description:
          `Something old juts from the dirt, a marker from before ${resolvedWorld.name} fell to its ${resolvedWorld.tone}. ` +
          "The inscription is almost worn smooth, but a few words still hold.",
        revealed: false,
        contentTags: [],
        linkedEntityIds: ["third_location"],
        linkedMemoryFactIds: [],
        edition: "mainline",
        policyProfileId: "mainline_default"
      },
      {
        detailId: "third_location_vista",
        label: "The View Beyond",
        description:
          "From this vantage the full shape of what went wrong lies open across the land, and there is no mistaking " +
          "that the worst of it waits further on.",
        revealed: false,
        contentTags: [],
        linkedEntityIds: ["third_location"],
        linkedMemoryFactIds: [],
        edition: "mainline",
        policyProfileId: "mainline_default"
      }
    ];

    // Static plot NPC at the destination (mirrors npc_quest_giver): no identity
    // mint, faceless until the player arrives. Two beats — a reaction to the
    // player reaching the edge, and repeatable lore on how the world got here.
    // SANDBOX: skipped — these beats link the procedural quest_main, which a
    // sandbox does not create (a dangling linkedQuestId would fail validation).
    if (!sandbox && !scenarioActive) {
      run.npcs.npc_far_witness = {
      npcId: "npc_far_witness",
      displayName: "A figure at the edge",
      role: "witness",
      currentLocationId: "third_location",
      known: true,
      status: "present",
      memoryFactIds: [],
      tags: ["lore"],
      flags: {},
      edition: "mainline",
      policyProfileId: "mainline_default",
      contentTags: [],
      origin: "procedural",
      dialogueBeats: [
        {
          beatId: "beat_far_arrival",
          label: "You came this far",
          text: `Most turn back long before ${thirdLocation.name}. You didn't, and that tells me what kind of ending you're walking toward.`,
          revealed: false,
          repeatable: false,
          // Linked to the main quest: talking to the witness fires the final
          // stage (talk_beat -> npc_far_witness) and wins the run — so the
          // climax is the conversation, not arriving at the location.
          linkedQuestIds: ["quest_main"],
          contentTags: []
        },
        {
          beatId: "beat_far_lore",
          label: "How it ended",
          text: `${resolvedWorld.name} was not always like this. The ${resolvedWorld.tone} crept in slowly, and no one agreed on the moment it became too late. Out here, at the edge, you can still feel where it began.`,
          revealed: false,
          repeatable: true,
          // Also linked + repeatable, so the final stage can still be satisfied
          // if the player reaches the witness out of order (prevents a soft-lock).
          linkedQuestIds: ["quest_main"],
          contentTags: []
        }
      ]
      };
    }
  }

  // DELIVERY ARC — one complete, fully-committed loop: the quest-giver at the second
  // location OFFERS a delivery job. Accepting it (free-text) instantiates a real
  // tracked quest and drops a takeable crate here; the player takes the crate, carries
  // it to the far location, and hands it over for a committed reward. Campaign-only
  // (sandbox carries no authored quests), and only when both endpoints exist.
  if (!sandbox && !scenarioActive && secondLocation && thirdLocation && run.npcs?.npc_quest_giver) {
    const giver = run.npcs.npc_quest_giver;
    giver.questOffer = buildDeliveryOffer(resolvedWorld, {
      giverLocationName: secondLocation.name,
      destinationId: "third_location",
      destinationName: thirdLocation.name
    });
    // THE OFFER MUST BE SPOKEN (F2): a job no one mentions is undiscoverable.
    // (1) Fold the pitch into the giver's FIRST beat, so the very first
    // conversation both advances the main quest (its linkedQuestIds are kept)
    // and presents the job. (2) Add a dedicated REPEATABLE "The job" beat so the
    // pitch can be re-heard on later talks until accepted.
    if (Array.isArray(giver.dialogueBeats)) {
      const arrival = giver.dialogueBeats.find((beat) => beat && beat.beatId === "beat_quest_main_arrival");
      if (arrival) {
        arrival.text = `${arrival.text} And since you made it this far, hear me out: ${giver.questOffer.offerText}`;
      }
      const arrivalIndex = giver.dialogueBeats.findIndex((beat) => beat && beat.beatId === "beat_quest_main_arrival");
      giver.dialogueBeats.splice(arrivalIndex >= 0 ? arrivalIndex + 1 : 0, 0, {
        beatId: "beat_job_offer",
        label: "The job",
        text: giver.questOffer.offerText,
        revealed: false,
        repeatable: true,
        linkedQuestIds: [],
        contentTags: []
      });
    }
  }

  // Seed the two-stage MVP main quest: travel to the second location (stage 0),
  // then speak with the figure waiting there (stage 1). The tone-keyed template
  // (quests.js) supplies the title/objectives; targets resolve to this run.
  // SANDBOX (C.5 / owner decision a): the directed spine is NOT injected — a pure
  // open world has no assigned quarry; it reacts to player-authored goals instead.
  if (!sandbox && !scenarioActive) {
    run.quests = run.quests || {};
    run.quests.quest_main = createMainQuest(resolvedWorld, {
      secondLocationId: secondLocation ? "second_location" : null,
      secondLocationName: secondLocation?.name || null,
      firstNpcId: secondLocation ? "npc_quest_giver" : npc?.npcId || null,
      seed: worldSeed
    });

    // M.2 — the main quest TELLS the player where to go ("Travel to <second
    // location>"), and the opening narration names it. That is a legitimate
    // told-of knowledge event, so the destination is DISCOVERED for a campaign
    // run (a named exit from the start). A SANDBOX run gets no such reveal — its
    // adjacent location stays an unnamed path until the player actually goes there.
    if (secondLocation?.state) {
      secondLocation.state.discovered = true;
    }

    // Extend the arc to the far location: after the figure at the second location,
    // press on to the third location and SPEAK WITH the witness there. The win
    // fires on that conversation (talk_beat -> npc_far_witness), not on arrival —
    // so the player actually reaches the climax: arrives, meets the witness, hears
    // the closing beat, then wins. (advanceQuests resolves talk_beat by matching
    // the talk's linkedQuestIds against the quest id; the witness's beats carry
    // ["quest_main"].) Appended here rather than in the shared createMainQuest
    // contract, which tests lock to two stages.
    if (thirdLocation && Array.isArray(run.quests.quest_main?.stages)) {
      run.quests.quest_main.stages.push({
        objective: `Press on to ${thirdLocation.name} and seek out the figure waiting at the edge.`,
        completion: { kind: "talk_beat", targetId: "npc_far_witness" }
      });
    }

    // Authored, LOSABLE trial side-quest — the only content path that exercises the
    // check-gated / failOnMiss quest primitive end-to-end (reach the second
    // location, then one decisive d20: pass -> completed, MISS -> quest FAILED in
    // tracked state). Seeded only when a second location exists to ground its reach
    // stage. isMain:false, so it never wins/loses the run — it proves "fail a check
    // -> lose the quest" without ending the session. Campaign-only; sandbox carries
    // no authored quests.
    if (secondLocation) {
      run.quests[TRIAL_QUEST_ID] = buildTrialQuest(resolvedWorld, {
        secondLocationId: "second_location",
        secondLocationName: secondLocation.name
      });
    }
  }

  // D.5 SCENARIO LOAD — the declarative door. Instantiate cast → quests → threads
  // from the validated scenario into the (post-worldgen) run, in place of the
  // hand-wired campaign block skipped above. Fail-loud on a dangling ref.
  if (scenarioActive) {
    // T6: a world-bound sandbox loads the world's canon but not the authored opening
    // (loadScenarioIntoRun gates quests + fronts on the sandbox flag).
    loadScenarioIntoRun(run, scenario, { worldSeed, sandbox });
    // WORLD ISOLATION (the Worlds law): stamp a user world's id onto the run so the
    // character is bound to exactly this world for its whole existence — characters
    // never cross worlds. Authored runs already carry the scenarioId; user runs carry
    // the userWorldId + a worldKind marker.
    if (userWorldRecord) {
      run.world.userWorldId = userWorldRecord.id;
      run.world.worldKind = "user";
    }
    // STYLE PICKER (style-lock law): the scenario loader stamps the world's DEFAULT
    // style. If the player ACTIVELY picked a style at creation, honor it over the
    // default. The client's art-style picker only sets world.artStyle on an explicit
    // click, so its presence here is the "player chose" signal. Re-lock AFTER the
    // scenario load (with a grant) so the choice wins; guarded so an out-of-allowed
    // value is ignored and the scenario default stands. No pick → no re-lock.
    if (isStr(world.artStyle)) {
      try {
        lockRunArtStyle(run, world.artStyle.trim(), { grant: true });
      } catch {
        // out-of-allowed / invalid style → keep the scenario default
      }
    }
  } else {
    // D.5 WORLDGEN SEEDING (item 1) — a non-scenario run's narrative momentum comes
    // from the server, not an author: 1-3 threads grounded in the generated graph (a
    // danger near the start with a world-clock deadline, a secret further out),
    // through the SAME loader authored fronts use. Deterministic on worldSeed; a
    // no-op if the run already carries threads.
    seedSandboxThreads(run, { worldSeed });
    // reputation-engine-v1 — mint the world's factions (2-4, with preferences +
    // relations) then give each NPC its intrinsic reputation traits (1-3 preference
    // tags, nullable faction membership, sparse romanceable). Deterministic on
    // worldSeed; authored worlds supply the same as JSON. Order matters: factions
    // first, so NPC membership can reference a seeded faction.
    seedFactions(run, { worldSeed });
    mintNpcReputation(run, { worldSeed });
  }
  // Migrate any pre-reputation B2 relationships onto the running affinity/tier
  // (a no-op for a fresh run; the safety net for one carried in from before).
  migrateReputation(run);

  markStage("preIndex");
  await rebuildCampaignIndex(campaignId);
  markStage("indexRebuild");

  // Opening narration: the first thing the player reads when they enter the
  // world. Real GM prose (tone-aware, hooked to the main quest's first
  // objective), grounded in the world overview memory doc just indexed, bounded
  // by a 15s timeout with a deterministic tone-aware fallback (never blank, never
  // a bare location dump). Generated ONCE here and stored on the run.
  // Opening inputs: for a SCENARIO run they come entirely from the scenario's
  // authoritative setting — the current (authored) location, the scenario world,
  // the present authored cast (Vesa), and the courier objective — so the very
  // first prose describes the Terra night market, never the worldgen ruins. For a
  // normal run, the worldgen values as before.
  let openWorld = resolvedWorld;
  let openLocation = start;
  let openNpc = npc;
  let openNpcReason = npc && isStr(startingNpcSpec?.reason) ? startingNpcSpec.reason : null;
  let openBaseBuilding = resolvedWorld.startIsBaseable === true;
  let openObjective = (Array.isArray(run.quests?.quest_main?.stages) && run.quests.quest_main.stages[0]?.objective) || null;
  if (scenarioActive) {
    const curLoc = run.locations[run.currentLocationId] || {};
    openWorld = {
      name: effectiveWorldName,
      tone: effectiveWorldTone,
      description: isStr(sw?.flavor) ? sw.flavor : (isStr(scenario.stakes) ? scenario.stakes : ""),
      startingLocation: { name: curLoc.name, description: curLoc.description },
      startingLocationName: curLoc.name
    };
    openLocation = curLoc;
    openBaseBuilding = false; // a busy public venue is never an adoptable base
    // The authored cast member present at the opening location (the fixer), so the
    // GM introduces Vesa instead of declaring the player alone.
    const opener = Object.values(run.npcs || {}).find((n) => n && n.currentLocationId === run.currentLocationId);
    openNpc = opener ? { generatedName: opener.displayName, role: opener.role } : null;
    openNpcReason = opener ? "they are the fixer who set up this run" : null;
    openObjective =
      (isStr(scenario.questOffers?.[scenario.opening?.questObjectiveFrom]?.summary) && scenario.questOffers[scenario.opening.questObjectiveFrom].summary) ||
      (isStr(scenario.stakes) ? scenario.stakes : null);
  }
  // AUTHORED SET-PIECE OPENING (Babel's VOICE beat, §2): when a scenario authors
  // its opening verbatim, it is delivered EXACTLY as written — the VOICE's
  // load-bearing beats are locked canon and must not be paraphrased by the GM.
  // Bypasses the GM opening call entirely; the narrator only touches turns AFTER
  // the opening. Two forms: opening.authoredBeats (an ORDERED beat sequence — the
  // paced set-piece the client reveals one beat at a time, so the VOICE lands
  // instead of walling the player) or the legacy single opening.authoredNarration
  // string. Beats are the preferred form; run.narration seeds from the joined text.
  const authoredBeats = scenarioActive && Array.isArray(scenario.opening?.authoredBeats)
    ? scenario.opening.authoredBeats.filter((b) => isStr(b)).map((b) => String(b))
    : null;
  const authoredOpening = (authoredBeats && authoredBeats.length)
    ? authoredBeats.join("\n\n")
    : (scenarioActive && isStr(scenario.opening?.authoredNarration) ? String(scenario.opening.authoredNarration) : null);
  // #14: pin the opening to the run's COMMITTED clock (fresh runs start 07:00
  // morning) — the opening was the one narration path without the clock directive,
  // which produced the baseline's "night falls" openings at a committed 07:0x.
  const openClock = ensureClock(run);
  const openWorldTime = openClock ? { clock: openClock.clock, phase: openClock.phase } : null;
  markStage("preOpening");
  const opening = authoredOpening || await generateOpeningNarration({
    campaignId,
    runId: run.runId,
    message: buildOpeningGmMessage({
      characterName,
      race: built.race,
      characterClass: built.class,
      world: openWorld,
      npc: openNpc,
      npcReason: openNpcReason,
      baseBuilding: openBaseBuilding,
      questObjective: openObjective,
      worldTime: openWorldTime
    }) + buildSystemLoreClause(run.world),
    playerName: characterName,
    actorUserId,
    fallback: buildOpeningFallback({
      characterName,
      race: built.race,
      characterClass: built.class,
      world: openWorld,
      location: openLocation,
      baseBuilding: openBaseBuilding,
      questObjective: openObjective
    })
  });
  // Distinct, persistent field (survives action narration, which overwrites
  // run.narration). run.narration is also seeded with the opening so the
  // gm-scene endpoint shows the GM voice on first load for legacy/compat paths.
  run.openingNarration = opening;
  run.narration = opening;
  // The paced beat sequence (authored set-piece). The client reveals these one at
  // a time so the opening lands as a sequence, not a scroll-wall. Absent for
  // generated / single-string openings (the client then shows the full narration).
  if (authoredBeats && authoredBeats.length) {
    run.openingBeats = authoredBeats;
    // W1: the opening set-piece is a COMMITTED speaker's VN surface (the VOICE), not
    // anonymous narration — carry her cast id so the scene payload can attach her
    // identity + portrait. Absent → the client falls back to the generic kicker.
    const speakerId = isStr(scenario?.opening?.beatsSpeaker) ? scenario.opening.beatsSpeaker.trim() : "";
    if (speakerId && run.npcs && run.npcs[speakerId]) {
      run.openingSpeakerId = speakerId;
      // WALK-3 V4 — THE MISSING WORDS. WALK-3 V2 committed run.vn so vnMode is true,
      // but the opening's SPEECH still rode scene.openingBeats (not gmNarration.body),
      // which the client's VN-content bridge never reads — so the VN box opened EMPTY
      // and the words fell to the yellow prose renderer (the 4×-escaped bug). Carry the
      // index from which the authored beats are the SPEAKER's spoken lines (earlier beats
      // are scene-setting narration): the client routes beats[from..] into the real VN
      // box and keeps beats[0..from) as opening narration. Brackets are NOT a reliable
      // split (a VOICE beat can be multi-block or unclosed) — the authored index is truth.
      const beatsFrom = Number(scenario?.opening?.beatsSpeakerFrom);
      run.openingBeatsSpeakerFrom = Number.isInteger(beatsFrom) && beatsFrom >= 0 ? beatsFrom : 0;
      // WALK-3 V2 — THE MISSING DOOR. openingSpeakerId alone only fed a look-alike
      // nameplate in the narration log; the real VN cast surface
      // (renderSoloDialogueOverlay) gates on scene.vnMode ← run.vn, which the
      // authored-opening path never set. So the VOICE was NARRATED, never staged.
      // Committing run.vn here routes the opening through the same VN surface a
      // live talk beat uses, with her committed identity + portrait.
      run.vn = { active: true, speakerId };
    }
  }

  markStage("openingGm");
  const savedRun = saveSoloRun(run);
  markStage("runSave");
  try {
    const total = Date.now() - stageT.t0;
    logTurnEvent(run.runId, `openingTiming ${Object.entries(stageT.marks).map(([k, v]) => `${k}=${v}ms`).join(" ")} total=${total}ms`);
  } catch {
    // diagnosis line is best-effort
  }

  return { campaignId, runId: savedRun.runId, world: resolvedWorld };
}
