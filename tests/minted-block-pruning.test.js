// INSP-07 — MINTED-BLOCK PRUNING (lifecycle law). A block minted into the
// process-global RUNTIME_STAT_BLOCKS overlay (spawnChaosling / resolveOrMintCreatureBlock)
// must DIE with its run/encounter — not leak for the process lifetime. pruneRuntimeStatBlocks
// drops the overlay entry of a killed/removed foe (keyed by the run's live npc statBlockIds),
// keeps a live foe's block, and NEVER prunes a frozen REGISTRY (authored/base) block.
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveStatBlock,
  resolveOrMintCreatureBlock,
  pruneRuntimeStatBlocks,
  spawnChaosling
} from "../server/campaign/bestiary.js";

test("INSP-07: a killed encounter's minted block is pruned; a live one survives", () => {
  const run = {
    runId: "run_insp07",
    worldSeed: "seed_insp07",
    npcs: {
      npc_dead: { npcId: "npc_dead", species: "dire wolf", kind: "wildlife", status: "present", flags: { hostile: true } },
      npc_live: { npcId: "npc_live", species: "cave bear", kind: "wildlife", status: "present", flags: { hostile: true } }
    },
    mintedStatBlocks: {}
  };

  // Mint + register two runtime blocks, one per npc (resolveOrMintCreatureBlock stamps
  // npc.statBlockId onto each). Distinct npcIds → distinct seeds → distinct ids.
  const deadBlock = resolveOrMintCreatureBlock(run, run.npcs.npc_dead);
  const liveBlock = resolveOrMintCreatureBlock(run, run.npcs.npc_live);
  assert.ok(deadBlock && liveBlock, "two blocks minted");
  assert.notEqual(deadBlock.statBlockId, liveBlock.statBlockId, "distinct minted ids");
  assert.ok(resolveStatBlock(deadBlock.statBlockId), "dead-foe block resolves pre-prune");
  assert.ok(resolveStatBlock(liveBlock.statBlockId), "live-foe block resolves pre-prune");

  // Kill one encounter — the foe leaves the field exactly as closeCombat marks it.
  run.npcs.npc_dead.status = "dead";
  run.npcs.npc_dead.flags.defeated = true;

  const summary = pruneRuntimeStatBlocks(run);

  assert.ok(summary.pruned.includes(deadBlock.statBlockId), "dead foe's block is reported pruned");
  assert.equal(resolveStatBlock(deadBlock.statBlockId), null, "dead foe's minted block is GONE from resolveStatBlock");
  assert.ok(resolveStatBlock(liveBlock.statBlockId), "live foe's minted block SURVIVES");
  assert.ok(summary.keptLive.includes(liveBlock.statBlockId), "live block is reported kept");
});

test("INSP-07: a frozen REGISTRY block referenced by a dead npc is NEVER pruned", () => {
  const run = {
    runId: "run_insp07b",
    worldSeed: "seed_b",
    npcs: {
      // The authored Limping Grey — a frozen REGISTRY id, marked dead on the roster.
      npc_grey: { npcId: "npc_grey", status: "dead", flags: { defeated: true, statBlockId: "limping_grey" }, statBlockId: "limping_grey" }
    }
  };
  assert.ok(resolveStatBlock("limping_grey"), "authored block resolves before prune");
  const summary = pruneRuntimeStatBlocks(run);
  assert.ok(!summary.pruned.includes("limping_grey"), "an authored/frozen block is never in the prune set");
  assert.ok(resolveStatBlock("limping_grey"), "authored block STILL resolves after prune");
});

test("INSP-07: run.mintedStatBlocks loses the dead id so a restart cannot resurrect it", () => {
  const run = { runId: "run_insp07c", worldSeed: "seed_c", npcs: {}, mintedStatBlocks: {} };
  const block = spawnChaosling({ baseAnimalId: "grey_wolf", tier: 2, seed: "insp07c|spawn" });
  assert.ok(block, "chaosling minted");
  run.mintedStatBlocks[block.statBlockId] = block;
  run.npcs.foe = { npcId: "foe", status: "dead", flags: { defeated: true, statBlockId: block.statBlockId }, statBlockId: block.statBlockId };
  assert.ok(resolveStatBlock(block.statBlockId), "spawned block resolves pre-prune");

  pruneRuntimeStatBlocks(run);

  assert.equal(resolveStatBlock(block.statBlockId), null, "overlay entry gone");
  assert.equal(run.mintedStatBlocks[block.statBlockId], undefined, "restart-safety map entry gone");
});

test("INSP-07: a fled foe (kept alive by closeCombat) is NOT pruned", () => {
  const run = {
    runId: "run_insp07d",
    worldSeed: "seed_d",
    npcs: {
      npc_flee: { npcId: "npc_flee", species: "grey wolf", kind: "wildlife", status: "present", flags: { hostile: true } }
    },
    mintedStatBlocks: {}
  };
  const block = resolveOrMintCreatureBlock(run, run.npcs.npc_flee);
  assert.ok(resolveStatBlock(block.statBlockId), "block resolves pre-prune");
  // closeCombat marks a fled enemy alive (status active, flags.fled) — the world remembers it.
  run.npcs.npc_flee.status = "active";
  run.npcs.npc_flee.flags.fled = true;
  const summary = pruneRuntimeStatBlocks(run);
  assert.ok(!summary.pruned.includes(block.statBlockId), "a fled (still-alive) foe's block is not pruned");
  assert.ok(resolveStatBlock(block.statBlockId), "the fled foe's block SURVIVES for a re-encounter");
});

test("INSP-07: another run's minted block is untouched (run-scoped prune)", () => {
  const runA = { runId: "run_A", worldSeed: "seed_A", npcs: {}, mintedStatBlocks: {} };
  const runB = { runId: "run_B", worldSeed: "seed_B", npcs: {}, mintedStatBlocks: {} };
  const blockB = spawnChaosling({ baseAnimalId: "black_bear", tier: 2, seed: "runB|spawn" });
  runB.npcs.foeB = { npcId: "foeB", status: "present", flags: { statBlockId: blockB.statBlockId }, statBlockId: blockB.statBlockId };
  // Pruning run A (which owns none of run B's ids) must not drop run B's live block.
  pruneRuntimeStatBlocks(runA);
  assert.ok(resolveStatBlock(blockB.statBlockId), "run B's block is untouched when pruning run A");
});
