// ---------------------------------------------------------------------------
// XP / level progression — the consequence-spine reward half. Meaningful actions
// award xp; crossing a threshold levels the character up (and toughens them, so
// progress is felt in the one currency that matters in a lethal game: survival).
//
// Pure logic over run.player (the caller works on a clone and persists it).
// ---------------------------------------------------------------------------

// 5e-style cumulative XP thresholds (subset). Index === level-1; level is the
// highest tier whose threshold the xp total has reached.
export const XP_THRESHOLDS = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000];

// Award table for the meaningful actions the engine can detect.
export const XP_AWARDS = Object.freeze({
  attempt_success: 25,
  search_found: 50,
  quest_stage: 100,
  quest_complete: 250
});

// HP gained per level (a flat, predictable bump — keeps the lethal math legible).
const HP_PER_LEVEL = 5;

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function levelForXp(xp) {
  const total = isNumber(xp) ? xp : 0;
  let level = 1;
  for (let i = 0; i < XP_THRESHOLDS.length; i += 1) {
    if (total >= XP_THRESHOLDS[i]) {
      level = i + 1;
    }
  }
  return level;
}

/**
 * Awards xp to the player and applies any level-ups. Mutates run.player in place.
 * On level-up, maxHealth (and current HP, by the same delta) rises by
 * HP_PER_LEVEL per level gained — a real, durable consequence of progress. A dead
 * or absent player is never awarded. Returns a record of what changed.
 * @param {object} run mutated in place
 * @param {number} amount xp to award
 * @returns {{awarded:number, xp:number, level:number, leveledUp:boolean, levelsGained:number} | null}
 */
export function awardXp(run, amount) {
  const player = run?.player;
  if (!player || typeof player !== "object") {
    return null;
  }
  // The dead earn nothing.
  if (player.status === "dead" || run.status === "dead") {
    return null;
  }
  const gain = Math.max(0, Math.round(Number(amount) || 0));
  if (gain <= 0) {
    return { awarded: 0, xp: isNumber(player.xp) ? player.xp : 0, level: isNumber(player.level) ? player.level : 1, leveledUp: false, levelsGained: 0 };
  }

  const beforeXp = isNumber(player.xp) ? player.xp : 0;
  const beforeLevel = isNumber(player.level) ? player.level : 1;
  const afterXp = beforeXp + gain;
  player.xp = afterXp;

  const afterLevel = Math.max(beforeLevel, levelForXp(afterXp));
  const levelsGained = afterLevel - beforeLevel;
  if (levelsGained > 0) {
    player.level = afterLevel;
    const hpBump = HP_PER_LEVEL * levelsGained;
    if (isNumber(player.maxHealth)) {
      player.maxHealth += hpBump;
    }
    const gauge = player.resources?.hitPoints;
    if (gauge && isNumber(gauge.max)) {
      gauge.max += hpBump;
      if (isNumber(gauge.current)) {
        gauge.current += hpBump;
      }
    }
    if (player.resources?.hp && isNumber(player.resources.hp.max)) {
      player.resources.hp.max += hpBump;
      if (isNumber(player.resources.hp.current)) {
        player.resources.hp.current += hpBump;
      }
    }
    if (isNumber(player.health)) {
      player.health += hpBump;
    }
  }

  return {
    awarded: gain,
    xp: afterXp,
    level: player.level,
    leveledUp: levelsGained > 0,
    levelsGained
  };
}
