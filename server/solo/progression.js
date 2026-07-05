// ---------------------------------------------------------------------------
// XP / milestone progression — the consequence-spine reward half. Meaningful
// actions award xp; crossing a threshold advances the MILESTONE — the server's
// one progression truth (Ch7 milestone track, docs/specs/milestone-engine-delta.md
// Phase 1). player.level is retained as the computed DISPLAY mirror: under the
// default identity mapping it always equals the milestone, so every existing
// read surface (scene payload, GM prompt, vault, UI) emits unchanged numbers
// until a world book supplies a real display mapping (Phase 2).
//
// Pure logic over run.player (the caller works on a clone and persists it).
// ---------------------------------------------------------------------------

// The chassis growth budget spans exactly this many milestones (Ch7).
export const MILESTONE_MAX = 20;

// Award table for the meaningful actions the engine can detect.
export const XP_AWARDS = Object.freeze({
  attempt_success: 25,
  search_found: 50,
  quest_stage: 100,
  quest_complete: 250
});

// HP gained per milestone (a flat, predictable bump — keeps the lethal math legible).
const HP_PER_MILESTONE = 5;

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Ch7 curve: advancing FROM milestone m costs m×100 xp, so the cumulative
 * total to REACH milestone m is Σ_{i<m} i×100 = 50·m·(m−1).
 * (Boundaries of record: m2=100, m5=1,000, m10=4,500, m15=10,500, m20=19,000.)
 */
export function xpForMilestone(milestone) {
  const m = Math.min(MILESTONE_MAX, Math.max(1, Math.round(Number(milestone) || 1)));
  return 50 * m * (m - 1);
}

export function milestoneForXp(xp) {
  const total = isNumber(xp) ? xp : 0;
  let milestone = 1;
  while (milestone < MILESTONE_MAX && total >= xpForMilestone(milestone + 1)) {
    milestone += 1;
  }
  return milestone;
}

/**
 * Reads the player's milestone, lazily migrating legacy saves (delta §3e):
 * a player without one gets `min(MILESTONE_MAX, level)` — keep-and-floor, the
 * xp ledger untouched. The floor is never revoked: awardXp only ever raises it.
 * Mutates player (writes the migrated value) and returns the milestone.
 */
export function ensureMilestone(player) {
  if (!player || typeof player !== "object") {
    return 1;
  }
  const source = isNumber(player.milestone)
    ? player.milestone
    : (isNumber(player.level) ? player.level : 1);
  const milestone = Math.min(MILESTONE_MAX, Math.max(1, Math.round(source)));
  player.milestone = milestone;
  return milestone;
}

// Ch7 tier bands: I 1–5, II 6–10, III 11–15, IV 16–20. Floors keyed by band.
const TIER_FLOOR = Object.freeze({ 1: 1, 2: 6, 3: 11, 4: 16 });

/**
 * Tier-gate law (delta §4): content gates read the MILESTONE, never the display
 * level — a world book cannot fake a Tier-IV door open by inflating its level
 * numbers. This predicate is the ONLY sanctioned way to gate on progression;
 * server logic is forbidden to branch on player.level (see CONTRACT.md).
 * @param {object} player
 * @param {1|2|3|4} tierBand
 * @returns {boolean}
 */
export function meetsTier(player, tierBand) {
  const floor = TIER_FLOOR[tierBand];
  if (!floor || !player || typeof player !== "object") {
    return false;
  }
  return ensureMilestone(player) >= floor;
}

/**
 * Awards xp to the player and applies any milestone advances. Mutates
 * run.player in place. On a milestone gain, HP rises by HP_PER_MILESTONE per
 * milestone across every HP mirror (applyHpDelta) — a real, durable consequence
 * of progress — and the display level moves with it (identity mapping: display
 * === milestone; Phase 2's world-book mapping replaces only the display math).
 * The milestone is floored, never revoked: a grandfathered milestone above the
 * curve's computed value stands until out-earned. A dead or absent player is
 * never awarded. Phase-2/3 seams: minorLevelUps (world display drip) and the
 * growth-profile/feat recompute both land here, at the milestone-gain branch.
 * @param {object} run mutated in place
 * @param {number} amount xp to award
 * @returns {{awarded:number, xp:number, level:number, leveledUp:boolean,
 *   levelsGained:number, milestone:number, displayLevel:number,
 *   milestoneUp:boolean, minorLevelUps:number} | null}
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

  const beforeMilestone = ensureMilestone(player);
  const gain = Math.max(0, Math.round(Number(amount) || 0));
  if (gain <= 0) {
    const displayLevel = isNumber(player.level) ? player.level : beforeMilestone;
    return {
      awarded: 0,
      xp: isNumber(player.xp) ? player.xp : 0,
      level: displayLevel,
      leveledUp: false,
      levelsGained: 0,
      milestone: beforeMilestone,
      displayLevel,
      milestoneUp: false,
      minorLevelUps: 0
    };
  }

  const beforeXp = isNumber(player.xp) ? player.xp : 0;
  const afterXp = beforeXp + gain;
  player.xp = afterXp;

  // Floored, never revoked: the computed milestone may lag a grandfathered one
  // (legacy 5e thresholds were cheaper early, dearer late) — nobody de-levels.
  const afterMilestone = Math.max(beforeMilestone, milestoneForXp(afterXp));
  const milestonesGained = afterMilestone - beforeMilestone;
  if (milestonesGained > 0) {
    player.milestone = afterMilestone;
    // Identity display mapping: the level mirror moves only when the milestone
    // does, and never downward (a grandfathered display number stands).
    player.level = Math.max(isNumber(player.level) ? player.level : 1, afterMilestone);
    applyHpDelta(player, HP_PER_MILESTONE * milestonesGained);
  }

  const displayLevel = isNumber(player.level) ? player.level : afterMilestone;
  return {
    awarded: gain,
    xp: afterXp,
    level: displayLevel,
    leveledUp: milestonesGained > 0,
    levelsGained: milestonesGained,
    milestone: afterMilestone,
    displayLevel,
    milestoneUp: milestonesGained > 0,
    minorLevelUps: 0
  };
}

/**
 * Applies one HP delta across EVERY HP mirror the player carries — maxHealth,
 * resources.hitPoints.{max,current}, resources.hp.{max,current}, health. The
 * mirrors have historically drifted when bumped ad hoc; this is the single
 * write path so the UI's max HP and the death math's max HP can never disagree
 * (the worst class of bug in a lethal game). Mirrors a player doesn't carry are
 * skipped, never invented. Returns the delta actually applied.
 * @param {object} player mutated in place
 * @param {number} amount HP delta (positive on progression)
 * @returns {number}
 */
export function applyHpDelta(player, amount) {
  const delta = isNumber(amount) ? amount : 0;
  if (!player || typeof player !== "object" || delta === 0) {
    return 0;
  }
  if (isNumber(player.maxHealth)) {
    player.maxHealth += delta;
  }
  const gauge = player.resources?.hitPoints;
  if (gauge && isNumber(gauge.max)) {
    gauge.max += delta;
    if (isNumber(gauge.current)) {
      gauge.current += delta;
    }
  }
  if (player.resources?.hp && isNumber(player.resources.hp.max)) {
    player.resources.hp.max += delta;
    if (isNumber(player.resources.hp.current)) {
      player.resources.hp.current += delta;
    }
  }
  if (isNumber(player.health)) {
    player.health += delta;
  }
  return delta;
}
