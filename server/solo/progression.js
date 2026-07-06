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

// Player-facing band names (delta §3f: tier is chassis vocabulary, safe to show).
export const TIER_LABELS = Object.freeze({
  1: "Tier I — Local",
  2: "Tier II — Regional",
  3: "Tier III — Pivotal",
  4: "Tier IV — Defining"
});

/** Band + label for a milestone. Pure; clamps into 1..MILESTONE_MAX. */
export function tierForMilestone(milestone) {
  const m = Math.min(MILESTONE_MAX, Math.max(1, Math.round(Number(milestone) || 1)));
  const band = m >= 16 ? 4 : m >= 11 ? 3 : m >= 6 ? 2 : 1;
  return { band, label: TIER_LABELS[band] };
}

// ── Phase 2: the world-book display-mapping contract (delta §3c) ─────────────
//
// A world book may supply run.worldBook.progressionMap:
//   {
//     displayScale: { min: 1, max: 250 },     // max is lore, uncapped by chassis
//     breakthroughs: [1, 5, 10, ...],         // EXACTLY MILESTONE_MAX entries;
//                                             // breakthroughs[k] = display level of milestone k+1
//     minorHpTick: 1,                         // HP per minor display level (0..2)
//     caps: {                                 // world-law lore flags, engine-enforced
//       perCharacter: { type: "display-cap", value: 200, note: "..." },
//       overrides: [{ flag: "beckoned", value: 250, note: "..." }]   // matched vs player.capFlag
//     }
//   }
// No map (or an invalid one) = the identity mapping: display === milestone,
// no minor levels — nothing visibly changes for existing worlds.

/**
 * Validates a progression map (delta §3c rules). Same posture as growth-profile
 * validation: reject at load — no world book can print a broken map.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateProgressionMap(map) {
  const errors = [];
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    return { ok: false, errors: ["progressionMap: expected object"] };
  }
  const scale = map.displayScale;
  if (!scale || typeof scale !== "object" || !isNumber(scale.min) || !isNumber(scale.max)) {
    errors.push("displayScale: expected { min, max } numbers");
  } else {
    if (scale.min < 1) errors.push("displayScale.min: must be >= 1");
    if (scale.max <= scale.min) errors.push("displayScale.max: must exceed min");
  }
  const b = map.breakthroughs;
  if (!Array.isArray(b) || b.length !== MILESTONE_MAX) {
    errors.push(`breakthroughs: expected exactly ${MILESTONE_MAX} entries`);
  } else {
    for (let i = 0; i < b.length; i += 1) {
      if (!isNumber(b[i]) || !Number.isInteger(b[i])) {
        errors.push(`breakthroughs[${i}]: expected integer`);
        break;
      }
      if (i > 0 && b[i] <= b[i - 1]) {
        errors.push(`breakthroughs[${i}]: must be strictly increasing`);
        break;
      }
    }
    if (scale && isNumber(scale.min) && b[0] !== scale.min) {
      errors.push("breakthroughs[0]: must equal displayScale.min");
    }
    if (scale && isNumber(scale.max) && b[b.length - 1] !== scale.max) {
      errors.push("breakthroughs[last]: must equal displayScale.max (the span must be covered — no orphan display levels)");
    }
  }
  const tick = map.minorHpTick;
  if (tick !== undefined && (!isNumber(tick) || !Number.isInteger(tick) || tick < 0 || tick > 2)) {
    errors.push("minorHpTick: must be an integer in 0..2 (the drip must not become a second growth budget)");
  }
  if (map.caps !== undefined) {
    if (!map.caps || typeof map.caps !== "object" || Array.isArray(map.caps)) {
      errors.push("caps: expected object");
    } else {
      const pc = map.caps.perCharacter;
      if (pc !== undefined) {
        if (!pc || typeof pc !== "object" || !isNumber(pc.value)) {
          errors.push("caps.perCharacter: expected { value } number");
        } else if (scale && isNumber(scale.min) && isNumber(scale.max) && (pc.value < scale.min || pc.value > scale.max)) {
          errors.push("caps.perCharacter.value: must fall inside displayScale");
        }
      }
      const overrides = map.caps.overrides;
      if (overrides !== undefined) {
        if (!Array.isArray(overrides)) {
          errors.push("caps.overrides: expected array");
        } else {
          for (let i = 0; i < overrides.length; i += 1) {
            const o = overrides[i];
            if (!o || typeof o !== "object" || typeof o.flag !== "string" || o.flag.length === 0 || !isNumber(o.value)) {
              errors.push(`caps.overrides[${i}]: expected { flag: non-empty string, value: number }`);
            } else if (scale && isNumber(scale.min) && isNumber(scale.max) && (o.value < scale.min || o.value > scale.max)) {
              errors.push(`caps.overrides[${i}].value: must fall inside displayScale`);
            }
          }
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * The run's active progression map, or null for the identity default. An
 * invalid map also resolves to identity — load-time rejection is the world-book
 * loader's seam; the award path never crashes on bad data.
 */
export function resolveProgressionMap(run) {
  const map = run?.worldBook?.progressionMap;
  if (!map) {
    return null;
  }
  return validateProgressionMap(map).ok ? map : null;
}

/** The display-level cap this character converts XP up to (world-law caps). */
function displayCapFor(player, map) {
  if (!map) {
    return Infinity;
  }
  const flag = typeof player?.capFlag === "string" ? player.capFlag : null;
  if (flag && Array.isArray(map.caps?.overrides)) {
    const override = map.caps.overrides.find((o) => o && o.flag === flag && isNumber(o.value));
    if (override) {
      return override.value;
    }
  }
  if (isNumber(map.caps?.perCharacter?.value)) {
    return map.caps.perCharacter.value;
  }
  return map.displayScale.max;
}

/**
 * The highest milestone this character may CONVERT xp into under the world's
 * cap law: the count of breakthroughs at or under their display cap. A capped
 * character stops converting; the xp ledger never closes. No map = the chassis
 * max. Never revokes a grandfathered milestone (awardXp floors, as ever).
 */
export function milestoneCapFor(player, map) {
  if (!map) {
    return MILESTONE_MAX;
  }
  const cap = displayCapFor(player, map);
  let count = 0;
  for (const level of map.breakthroughs) {
    if (level <= cap) {
      count += 1;
    }
  }
  return Math.max(1, Math.min(MILESTONE_MAX, count));
}

/**
 * The ONLY place display math lives (delta §3b). Ch7's law: milestone m's XP
 * span (m×100) divides evenly across the display levels between
 * breakthroughs[m-1] and breakthroughs[m]; the remainder lands on the
 * breakthrough itself, which is only ever granted by the milestone advancing —
 * xp drip can carry you to the last minor level, never through the door.
 * No map = identity: display === milestone.
 */
export function displayLevelFor(milestone, xp, map) {
  const m = Math.min(MILESTONE_MAX, Math.max(1, Math.round(Number(milestone) || 1)));
  if (!map) {
    return m;
  }
  const b = map.breakthroughs;
  const base = b[m - 1];
  if (m >= MILESTONE_MAX) {
    return base;
  }
  const steps = b[m] - base;      // display gains across this span; the final one IS the breakthrough
  const minors = steps - 1;
  if (minors <= 0) {
    return base;
  }
  const span = 100 * m;           // Ch7: xp span of milestone m
  const per = Math.floor(span / steps);
  if (per <= 0) {
    return base;
  }
  const into = Math.max(0, (isNumber(xp) ? xp : 0) - xpForMilestone(m));
  return base + Math.min(minors, Math.floor(into / per));
}

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
export function awardXp(run, amount, options = {}) {
  const player = run?.player;
  if (!player || typeof player !== "object") {
    return null;
  }
  // The dead earn nothing.
  if (player.status === "dead" || run.status === "dead") {
    return null;
  }

  const map = resolveProgressionMap(run);
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
  const beforeDisplay = map
    ? Math.min(displayCapFor(player, map), displayLevelFor(beforeMilestone, beforeXp, map))
    : (isNumber(player.level) ? player.level : beforeMilestone);
  const afterXp = beforeXp + gain;
  player.xp = afterXp;

  // Floored, never revoked: the computed milestone may lag a grandfathered one
  // (legacy 5e thresholds were cheaper early, dearer late) — nobody de-levels.
  // The world's cap law stops NEW conversion (milestoneCapFor), never revokes.
  const afterMilestone = Math.max(beforeMilestone, Math.min(milestoneCapFor(player, map), milestoneForXp(afterXp)));
  const milestonesGained = afterMilestone - beforeMilestone;
  if (milestonesGained > 0) {
    player.milestone = afterMilestone;
    // Phase-3 seam: growth-profile recompute + feat-pick flags land HERE, at
    // the milestone-gain branch — never on the minor-level path below.
    applyHpDelta(player, HP_PER_MILESTONE * milestonesGained);
  }

  let displayLevel;
  let minorLevelUps = 0;
  if (map) {
    // World-book display mapping: the level mirror carries the world's number.
    const afterDisplay = Math.min(displayCapFor(player, map), displayLevelFor(afterMilestone, afterXp, map));
    // Every display level gained is either a breakthrough (one per milestone
    // crossed) or a minor level. Minor levels pay the world's HP tick and a
    // flavor event — never stats, feats, or features (Ch7's law).
    minorLevelUps = Math.max(0, (afterDisplay - beforeDisplay) - milestonesGained);
    if (minorLevelUps > 0) {
      const tick = isNumber(map.minorHpTick) ? map.minorHpTick : 0;
      if (tick > 0) {
        applyHpDelta(player, tick * minorLevelUps);
      }
      if (Array.isArray(run.timeline)) {
        run.timeline.push({
          eventId: `event_minor_level_${afterDisplay}_${afterXp}`,
          type: "progression",
          title: `Level ${afterDisplay}`,
          summary: `Growth the world can see: level ${afterDisplay}. The climb continues.`,
          createdAt: typeof options.now === "string" ? options.now : new Date().toISOString(),
          locationId: run.currentLocationId ?? null,
          entityIds: [run.runId].filter(Boolean),
          memoryFactIds: [],
          tags: ["progression", "minor_level"],
          edition: run.edition
        });
      }
    }
    // Never downward, even here: a grandfathered display number (e.g. a save
    // above the world's cap) stands — computed display only ever catches up.
    player.level = Math.max(isNumber(player.level) ? player.level : afterDisplay, afterDisplay);
    displayLevel = player.level;
  } else {
    // Identity mapping: the level mirror moves only when the milestone does,
    // and never downward (a grandfathered display number stands).
    if (milestonesGained > 0) {
      player.level = Math.max(isNumber(player.level) ? player.level : 1, afterMilestone);
    }
    displayLevel = isNumber(player.level) ? player.level : afterMilestone;
  }

  return {
    awarded: gain,
    xp: afterXp,
    level: displayLevel,
    leveledUp: milestonesGained > 0 || minorLevelUps > 0,
    levelsGained: milestonesGained,
    milestone: afterMilestone,
    displayLevel,
    milestoneUp: milestonesGained > 0,
    minorLevelUps
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
