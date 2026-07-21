// ONE-TAP AGENCY LAW (C5, owner ruling). When the power disparity is ABSURD — one side
// would one-tap the other, server-computable from the committed stat blocks — the server
// MAY resolve WITHOUT the full CTB engine, as a narrated outcome WITH committed
// consequences (damage/death/loot committed mechanically; narration only describes).
// A CONTESTED-range fight ALWAYS enters the engine. The disparity threshold is Law-6.
//
// The point: a level-1 wanderer does not get a dramatic six-round duel with a tier-4
// rapture-drifter — it ends, mechanically, and the world remembers. And the player one-
// tapping a rat does not get a combat surface either.

import { resolveStatBlock } from "../campaign/bestiary.js";
import { getHp } from "./death.js";

// Law-6 tunable: the stronger side's effective power must be >= THRESHOLD x the weaker's
// for a one-tap. Below it, the fight is contested and enters the engine.
export const DISPARITY_THRESHOLD = 4;

function avgDamage(expr) {
  // "1d6+2" -> average. Cheap: nDs+m -> n*(s+1)/2 + m.
  const m = /(\d+)d(\d+)\s*([+-]\s*\d+)?/i.exec(String(expr || ""));
  if (!m) return 1;
  const n = Number(m[1]) || 1, s = Number(m[2]) || 4, plus = Number(String(m[3] || "0").replace(/\s+/g, "")) || 0;
  return n * (s + 1) / 2 + plus;
}

// A combat POWER score from a stat block: durability (hp+ac) + offense (best attack avg,
// weighted). Deliberately simple + monotonic — the ratio is what matters, not the units.
export function blockPower(block) {
  if (!block || typeof block !== "object") return 1;
  const hp = Number(block.maxHp) || 1;
  const ac = Number(block.ac) || 10;
  const bestDmg = Math.max(1, ...(Array.isArray(block.attacks) ? block.attacks.map((a) => avgDamage(a.damage)) : [1]));
  return hp + ac + bestDmg * 4 + (Number(block.tier) || 0) * 6;
}

// The player's committed combat power (HP + a level/AC proxy + a modest offense floor).
export function playerPower(run) {
  const hp = getHp(run?.player) || { current: 1, max: 1 };
  const level = Number(run?.player?.level) || 1;
  const ac = Number(run?.player?.abilities?.ac || run?.player?.ac) || 12;
  return (hp.max || 1) + ac + level * 5 + 6;
}

/**
 * Verdict for a would-be fight between the player and a committed hostile NPC.
 * @param {object} run
 * @param {object} enemyNpc  the committed NPC (carries statBlockId)
 * @param {{ threshold?: number }} [opts]
 * @returns {{ verdict: "player_onetaps"|"enemy_onetaps"|"contested", ratio: number }}
 */
export function disparityVerdict(run, enemyNpc, { threshold = DISPARITY_THRESHOLD } = {}) {
  const block = resolveStatBlock(enemyNpc?.statBlockId || enemyNpc?.flags?.statBlockId);
  if (!block) return { verdict: "contested", ratio: 1 }; // unknown → let the engine own it
  const pp = playerPower(run);
  const ep = blockPower(block);
  if (ep >= pp * threshold) return { verdict: "enemy_onetaps", ratio: ep / pp };
  if (pp >= ep * threshold) return { verdict: "player_onetaps", ratio: pp / ep };
  return { verdict: "contested", ratio: pp >= ep ? pp / ep : ep / pp };
}

/**
 * Whether a would-be fight must enter the CTB engine (contested), or may resolve as a
 * one-tap narrated outcome. Contested range ALWAYS enters the engine.
 */
export function mustEnterEngine(run, enemyNpc, opts) {
  return disparityVerdict(run, enemyNpc, opts).verdict === "contested";
}
