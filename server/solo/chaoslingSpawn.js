// LIVE CHAOSLING SPAWN (A3.2) — mint-on-demand INTO the scene. A location can carry a
// `spawnOnEnter` chaosling spec (authored in a world-book, e.g. babel's Warm House);
// arriving there mints a chaosling through the bestiary registry (spawnChaosling),
// persists the minted block on the run (restart-safe), and places it as a hostile NPC
// the player can then attack (detectAttackIntent → combat). Guarded so it fires once per
// location. Reusable — this serves every future authored encounter, not only the Warm
// House. The "ledgered item, now built."
import { spawnChaosling, registerStatBlock, resolveCorruptionIdentity } from "../campaign/bestiary.js";
import { createEmptyExpressionVariants } from "./schema.js";

export function spawnChaoslingOnEnter(run, locationId) {
  const loc = run?.locations?.[locationId];
  const spec = loc?.spawnOnEnter;
  if (!spec || !spec.baseAnimalId || loc.flags?.chaoslingSpawned) return null;
  const seed = `${run.worldSeed || run.runId}|spawn|${spec.seed || locationId}`;
  // The spawned foe's corruption identity is the WORLD's (world.corruption): babel → chaosling/
  // violet (byte-identical); a world declaring none → NEUTRAL (plain beast, no chaosling role/tags,
  // essence-sight silent). Threaded so a spawnOnEnter foe is never Babel-corrupted by default.
  const corruption = resolveCorruptionIdentity(run?.world?.corruption);
  const block = spawnChaosling({
    baseAnimalId: spec.baseAnimalId, tier: spec.tier || 2, seed,
    forceSkill: spec.forceSkill || null, name: spec.name || null, corruption
  });
  if (!block) return null;
  // Persist for restart-safety (re-registered at combat entry), then place the foe.
  run.mintedStatBlocks = run.mintedStatBlocks && typeof run.mintedStatBlocks === "object" ? run.mintedStatBlocks : {};
  run.mintedStatBlocks[block.statBlockId] = block;
  const npcId = spec.npcId || `npc_chaosling_${locationId}`;
  run.npcs = run.npcs && typeof run.npcs === "object" ? run.npcs : {};
  run.npcs[npcId] = {
    npcId,
    displayName: spec.name || block.name,
    // role + tags follow the world's corruption identity, not a hardcoded "chaosling".
    role: corruption.kind,
    currentLocationId: locationId,
    known: true,
    status: "present",
    memoryFactIds: [],
    expressionVariants: createEmptyExpressionVariants(),
    tags: [...corruption.extraTags],
    flags: { hostile: true, statBlockId: block.statBlockId },
    ageClass: "adult",
    romanceable: false, // a hostile spawn is never a romance target
    edition: "mainline",
    policyProfileId: "mainline_default",
    contentTags: [],
    origin: "procedural",
    statBlockId: block.statBlockId,
    dialogueBeats: []
  };
  loc.flags = loc.flags && typeof loc.flags === "object" ? loc.flags : {};
  loc.flags.chaoslingSpawned = true; // fire once
  return { npcId, statBlockId: block.statBlockId, block };
}

// Re-register a run's persisted minted blocks into the bestiary runtime overlay, so a
// spawned foe still RESOLVES after a server restart mid-run. Called at combat entry.
export function reregisterMintedBlocks(run) {
  const minted = run?.mintedStatBlocks;
  if (!minted || typeof minted !== "object") return;
  for (const block of Object.values(minted)) registerStatBlock(block);
}
