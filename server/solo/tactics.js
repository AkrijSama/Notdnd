// ENEMY TACTICS / AGGRESSION (C1). Committed hostiles can START fights — but the wolf
// "watching" stays the DEFAULT (pre-combat tension is good; keep it). Aggression fires
// ONLY on committed conditions, never merely from a hostile being present (pre-mortem #1:
// otherwise every forest walk becomes a fight). The disposition ladder:
//   - "watching"  (default): a present hostile holds — tension, not a fight.
//   - AGGRESSIVE: enters combat this turn. Triggered by, in order:
//       (a) an explicit hunter disposition (behaviors.aggressive === true), OR
//       (b) a committed PROVOKE flag (run.flags.provoked[npcId] — set by a failed
//           provoking check or a player intrusion), OR
//       (c) a STALKER that has been co-present with the player for >= closeAfter turns
//           (behaviors.stalker === true only; a plain vicious creature is NOT a stalker).
//
// The lunge is COMBAT ENTRY (the engine), never narration — the caller enters the CTB
// engine with a telegraph from turn one.

import { resolveStatBlock } from "../campaign/bestiary.js";

const STALKER_CLOSE_AFTER = 3; // turns co-present before a stalker closes (Law-6 tunable)

// A committed, PRESENT hostile at the player's location that resolves to a real hostile
// stat block (has attacks). Excludes social-only cast, the dead, and the fled.
function presentHostiles(run) {
  const loc = run?.currentLocationId;
  const npcs = run?.npcs || {};
  const out = [];
  for (const [npcId, npc] of Object.entries(npcs)) {
    if (!npc || npc.currentLocationId !== loc) continue;
    if (npc.status && npc.status !== "present") continue; // not the fled/absent/dead
    const sbId = npc.statBlockId || npc.flags?.statBlockId;
    if (!sbId) continue;
    const block = resolveStatBlock(sbId);
    if (!block || !Array.isArray(block.attacks) || !block.attacks.length) continue; // not a fighter
    out.push({ npcId, npc, block });
  }
  return out;
}

/**
 * Should a committed present hostile START a fight this turn? Returns { npcId, reason }
 * for the first aggressor (deterministic by npc id order), or null when every hostile
 * is content to WATCH. Pure — reads committed state only.
 * @param {object} run
 * @returns {{ npcId: string, reason: "aggressive"|"provoked"|"stalker" } | null}
 */
export function resolveEnemyAggression(run) {
  if (!run || run.combat) return null; // already in a fight — nothing to start
  const provoked = (run.flags && run.flags.provoked) || {};
  const coPresent = (run.flags && run.flags.coPresentTurns) || {};
  for (const { npcId, npc, block } of presentHostiles(run).sort((a, b) => a.npcId.localeCompare(b.npcId))) {
    const beh = block.behaviors || {};
    if (beh.aggressive === true) return { npcId, reason: "aggressive" };
    if (provoked[npcId] === true) return { npcId, reason: "provoked" };
    if (beh.stalker === true && Number(coPresent[npcId] || 0) >= STALKER_CLOSE_AFTER) {
      return { npcId, reason: "stalker" };
    }
    void npc;
  }
  return null;
}

/**
 * Advance the co-present turn counters for stalkers (so behaviors.stalker can close after
 * STALKER_CLOSE_AFTER turns). Call once per resolved turn. Mutates run.flags.coPresentTurns.
 * A hostile no longer present resets to 0. Non-stalkers are ignored (cheap).
 * @param {object} run
 */
export function tickAggressionClocks(run) {
  if (!run) return;
  run.flags = run.flags || {};
  const next = {};
  for (const { npcId, block } of presentHostiles(run)) {
    if ((block.behaviors || {}).stalker === true) {
      next[npcId] = Number((run.flags.coPresentTurns || {})[npcId] || 0) + 1;
    }
  }
  run.flags.coPresentTurns = next; // absent stalkers drop to 0 by omission
}

/**
 * Commit a PROVOKE on a hostile (a failed provoking check / player intrusion) so it
 * aggresses next turn. Idempotent.
 * @param {object} run
 * @param {string} npcId
 */
export function commitProvoke(run, npcId) {
  if (!run || !npcId) return;
  run.flags = run.flags || {};
  run.flags.provoked = run.flags.provoked || {};
  run.flags.provoked[npcId] = true;
}
