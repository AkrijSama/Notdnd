// COMBAT STATUS ENGINE — the sealed TEN (docs/handbook/ch8-life-and-death.md:86-101),
// on the CTB clock. The engine never grows: a world book RENAMES (a "chill", a
// "bleed"), but every named affliction compiles down to one of these ten (the rename
// law, ch8:110-115). Durations are the combatant's OWN turns for self-attached
// effects (ctb §8). Queue ops (slow/haste/stun) are defined ONCE in ctb.js and only
// there — this module calls them, it does not restate them.
import { applyStun as ctbStun, applyHaste as ctbHaste, applySlow as ctbSlow } from "./ctb.js";
import { applyDamage, getHp } from "./death.js";

// The sealed ten. `kind` maps to the condition-chip idiom (buff/mark/neutral/control/
// debuff). `queueOp` names the ctb.js operation (or false for a non-queue effect).
export const ENGINE_STATUSES = Object.freeze({
  poison: Object.freeze({ id: "poison", name: "Poisoned", kind: "debuff", queueOp: false, tickPct: -0.1 }),
  regen: Object.freeze({ id: "regen", name: "Regenerating", kind: "buff", queueOp: false, tickPct: 0.1 }),
  slow: Object.freeze({ id: "slow", name: "Slowed", kind: "debuff", queueOp: "slow" }),
  haste: Object.freeze({ id: "haste", name: "Hasted", kind: "buff", queueOp: "haste" }),
  stun: Object.freeze({ id: "stun", name: "Stunned", kind: "control", queueOp: "stun" }),
  blind: Object.freeze({ id: "blind", name: "Blinded", kind: "debuff", queueOp: false }),
  silence: Object.freeze({ id: "silence", name: "Silenced", kind: "control", queueOp: false }),
  sleep: Object.freeze({ id: "sleep", name: "Asleep", kind: "control", queueOp: false }),
  confuse: Object.freeze({ id: "confuse", name: "Confused", kind: "control", queueOp: false }),
  shield: Object.freeze({ id: "shield", name: "Shielded", kind: "buff", queueOp: false })
});

// World-book RIDER → engine status (the rename law). The inverted-element riders from
// the verdance bestiary (chill/burns/rots/mends) compile to the ten: a chill that saps
// tempo is Slow; a burn/rot/bleed that ticks vitality is Poison; a mend is Regen.
const RIDER_TO_STATUS = Object.freeze({
  chill: "slow", chills: "slow", frozen: "slow",
  bleed: "poison", bleeds: "poison", bleeding: "poison", burn: "poison", burns: "poison", rot: "poison", rots: "poison",
  mend: "regen", mends: "regen", heal: "regen",
  stun: "stun", stuns: "stun", stunned: "stun",
  poison: "poison", poisoned: "poison"
});

/** Compile a world-book rider name down to one of the sealed ten (or null). */
export function statusForRider(rider) {
  return RIDER_TO_STATUS[String(rider || "").toLowerCase()] || null;
}

/** Default duration, in the victim's own turns, for each engine status. Bounded. */
function defaultTurns(statusId) {
  switch (statusId) {
    case "stun": return 1; // stun is a single lost tempo; the CTB push IS the effect
    case "slow": case "haste": return 2;
    case "poison": case "regen": case "bleed": return 3;
    default: return 2;
  }
}

function isPlayer(combatant) {
  return combatant?.kind === "player";
}

/**
 * Apply an engine status to a combatant (compiling a world-book rider first, if
 * given). Adds a display condition + fires the queue op once (slow/haste immediately
 * bend tempo; stun pushes next_tick). `worldName` preserves the flavor label ("Chill")
 * for narration/chips while the mechanic stays one of the ten. Idempotent-ish: a
 * re-applied status refreshes its duration rather than stacking a duplicate.
 */
export function applyCombatStatus(combat, combatant, statusOrRider, { turns, worldName, run } = {}) {
  const statusId = ENGINE_STATUSES[statusOrRider] ? statusOrRider : statusForRider(statusOrRider);
  if (!statusId || !ENGINE_STATUSES[statusId]) return null;
  const meta = ENGINE_STATUSES[statusId];
  combatant.conditions = Array.isArray(combatant.conditions) ? combatant.conditions : [];
  const turnsLeft = Number.isFinite(turns) ? turns : defaultTurns(statusId);
  const label = worldName || meta.name;

  // Fire the queue op (ctb.js owns the math). Slow/haste are persistent flags that
  // expire when the duration does; stun is a one-shot tick push (no lasting flag).
  if (meta.queueOp === "slow") ctbSlow(combat, combatant, true);
  else if (meta.queueOp === "haste") ctbHaste(combat, combatant, true);
  else if (meta.queueOp === "stun") ctbStun(combat, combatant);

  const existing = combatant.conditions.find((c) => c.engineStatus === statusId);
  if (existing) {
    existing.turnsLeft = Math.max(existing.turnsLeft || 0, turnsLeft);
    existing.name = label;
    return existing;
  }
  const record = { id: statusId, engineStatus: statusId, name: label, kind: meta.kind, turnsLeft, worldName: worldName || null };
  combatant.conditions.push(record);
  return record;
}

/**
 * Tick a combatant's statuses at the START of its turn (ch8: poison/regen tick here),
 * then decrement durations by one own-turn and expire the finished ones (undoing the
 * queue op). Returns a list of tick events for the turn log. Mutates hp via the real
 * spine for the player; enemies mutate their combatant hp directly.
 */
export function tickStatusesOnTurnStart(run, combat, combatant, options = {}) {
  const events = [];
  const conditions = Array.isArray(combatant.conditions) ? combatant.conditions : [];
  const max = isPlayer(combatant)
    ? (run?.player ? getHp(run.player).max : 1)
    : (combatant.hp?.max ?? 1);

  for (const c of conditions) {
    const meta = ENGINE_STATUSES[c.engineStatus];
    if (!meta) continue;
    if (typeof meta.tickPct === "number" && meta.tickPct !== 0) {
      const amt = Math.max(1, Math.round(Math.abs(meta.tickPct) * max));
      if (meta.tickPct < 0) {
        if (isPlayer(combatant)) {
          const rec = applyDamage(run, amt, { now: options.now });
          events.push({ status: c.engineStatus, name: c.name, hp: -rec.amount });
        } else {
          combatant.hp.current = Math.max(0, (combatant.hp.current ?? 0) - amt);
          events.push({ status: c.engineStatus, name: c.name, hp: -amt });
        }
      } else {
        if (isPlayer(combatant)) {
          const hp = getHp(run.player);
          const healed = Math.min(hp.max, hp.current + amt) - hp.current;
          run.player.resources = run.player.resources || {};
          run.player.resources.hitPoints = { current: hp.current + healed, max: hp.max };
          events.push({ status: c.engineStatus, name: c.name, hp: +healed });
        } else {
          const healed = Math.min(combatant.hp.max, (combatant.hp.current ?? 0) + amt) - (combatant.hp.current ?? 0);
          combatant.hp.current = (combatant.hp.current ?? 0) + healed;
          events.push({ status: c.engineStatus, name: c.name, hp: +healed });
        }
      }
    }
  }

  // Decrement + expire (one own-turn spent). Expiry undoes the queue op.
  combatant.conditions = conditions.filter((c) => {
    c.turnsLeft = (c.turnsLeft ?? 1) - 1;
    if (c.turnsLeft > 0) return true;
    const meta = ENGINE_STATUSES[c.engineStatus];
    if (meta?.queueOp === "slow") ctbSlow(combat, combatant, false);
    else if (meta?.queueOp === "haste") ctbHaste(combat, combatant, false);
    events.push({ status: c.engineStatus, name: c.name, expired: true });
    return false;
  });
  return events;
}

/**
 * Project a combatant's live conditions into the condition-chip payload shape
 * ({ id, name, effect, kind, remainingMinutes, permanent }) the portrait/enemy-card
 * HUD renders. Combat durations are TURNS, not minutes, so remainingMinutes is null
 * and the turn count rides the effect text (the chip tooltip surfaces it).
 */
export function combatConditionsPayload(combatant) {
  const conditions = Array.isArray(combatant?.conditions) ? combatant.conditions : [];
  return conditions
    .filter((c) => c && (c.name || c.id))
    .map((c) => {
      const meta = ENGINE_STATUSES[c.engineStatus];
      const turns = Number.isFinite(c.turnsLeft) ? c.turnsLeft : null;
      const effectBase = c.worldName && c.worldName !== meta?.name ? `${c.worldName} — ${meta?.name || c.engineStatus}` : (meta?.name || c.engineStatus);
      const effect = turns != null ? `${effectBase} · ${turns} turn${turns === 1 ? "" : "s"} left` : effectBase;
      return {
        id: c.id || c.engineStatus,
        name: c.name || meta?.name || c.engineStatus,
        effect,
        kind: c.kind || meta?.kind || "neutral",
        remainingMinutes: null,
        permanent: false
      };
    });
}
