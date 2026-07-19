// CTB TURN ENGINE (the clock) — docs/handbook/ctb-turn-engine-spec.md [LOCKED].
//
// Combat runs on a discrete, server-computed turn queue (FFX-style Conditional
// Turn-Based). There are NO rounds and NO initiative roll. Time is integer TICKS
// (queue currency only — never real seconds). Every combatant has a `nextTick`;
// the one with the lowest `nextTick` acts, then their `nextTick` grows by a delay
// derived from Speed × the action's weight. Repeat.
//
// This module is PURE + deterministic: no Math.random, no Date. Tie-breaks use a
// per-combat `queueSeed`. Everything here is the sealed law, not re-derived:
//   speed(i)      = clamp(10 + dexMod(i), 8, 16)                       (§2.1)
//   delay(i, act) = max(1, round((BASE / speed) × weight(act)))        (§3, BASE 1200)
//   start         = nextTick = delay(standard) for all; surprised = 2× (§3.4)
//   haste ×1.5 / slow ×0.5 speed THEN clamp, rescale pending (§5)      (clamp-after-mult is load-bearing)
//   stun          = nextTick += delay(standard) once (§5)
//   forecast      = order-only, next 8 slots, revealed combatants only (§6)
//   luck          = permanently excluded from queue math (§2.2/§10)

export const CTB_BASE = 1200;
export const CTB_SPEED_MIN = 8;
export const CTB_SPEED_MAX = 16;
export const CTB_FORECAST_SLOTS = 8;

// Action weights (§3.3) — applied to the delay AFTER the action resolves, so
// choosing a heavy action never postpones the current turn.
export const ACTION_WEIGHT = Object.freeze({ light: 0.75, standard: 1.0, heavy: 1.5 });

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
// Deterministic non-negative hash — same djb2-ish construction as the rest of the
// engine, so a fight replays identically (tie-break stability).
function hashSeed(value) {
  let hash = 0;
  const text = String(value == null ? "" : value);
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

/** DEX modifier → base Speed, clamped to [8,16]. Luck NEVER enters (§2.2). */
export function speedFromDexMod(dexMod) {
  const d = Number.isFinite(dexMod) ? dexMod : 0;
  return clamp(10 + d, CTB_SPEED_MIN, CTB_SPEED_MAX);
}

/** Effective Speed after status multipliers, clamped LAST (§5 — clamp-after-mult
 *  is the normative order; clamping before multiplying is nonconforming). */
export function effectiveSpeed(baseSpeed, { haste = false, slow = false } = {}) {
  let s = baseSpeed;
  if (haste) s *= 1.5;
  if (slow) s *= 0.5; // haste+slow multiply, not cancel: 1.5×0.5=0.75 → slow mostly wins
  return clamp(Math.round(s), CTB_SPEED_MIN, CTB_SPEED_MAX);
}

/** delay(i, action) = max(1, round(BASE/speed × weight)). */
export function delayFor(speed, weight = ACTION_WEIGHT.standard) {
  const w = Number.isFinite(weight) ? weight : ACTION_WEIGHT.standard;
  const s = clamp(speed || CTB_SPEED_MIN, CTB_SPEED_MIN, CTB_SPEED_MAX);
  return Math.max(1, Math.round((CTB_BASE / s) * w));
}

/** The standard-action delay for a combatant's CURRENT effective speed. */
export function standardDelay(combatant) {
  return delayFor(combatantSpeed(combatant), ACTION_WEIGHT.standard);
}

/** A combatant's live effective speed (base from dexMod, bent by haste/slow flags). */
export function combatantSpeed(combatant) {
  const base = Number.isFinite(combatant?.baseSpeed) ? combatant.baseSpeed : speedFromDexMod(combatant?.dexMod);
  return effectiveSpeed(base, { haste: Boolean(combatant?.ctb?.haste), slow: Boolean(combatant?.ctb?.slow) });
}

/**
 * Seed a combatant's CTB fields at combat start (§3.4). `now` is the queue clock
 * (0 at start). A surprised combatant enters at 2× its standard delay.
 */
export function seedCombatantQueue(combatant, { now = 0, surprised = false } = {}) {
  const base = speedFromDexMod(combatant?.dexMod);
  combatant.baseSpeed = base;
  combatant.ctb = { haste: false, slow: false, stunPushes: 0 };
  const d = delayFor(base, ACTION_WEIGHT.standard);
  combatant.nextTick = now + (surprised ? 2 * d : d);
  return combatant;
}

/**
 * The next actor: lowest nextTick; tie-break (1) lower nextTick, (2) higher speed,
 * (3) stable seeded order via queueSeed (§7). Considers only living combatants.
 * Returns the combatant object, or null if none can act.
 */
export function nextActor(combat) {
  const living = combatantsList(combat).filter((c) => isAlive(c));
  if (!living.length) return null;
  living.sort((a, b) => {
    if (a.nextTick !== b.nextTick) return a.nextTick - b.nextTick;
    const sa = combatantSpeed(a), sb = combatantSpeed(b);
    if (sa !== sb) return sb - sa; // higher speed wins the tie
    return hashSeed(`${combat.queueSeed}|${a.combatantId}`) - hashSeed(`${combat.queueSeed}|${b.combatantId}`);
  });
  return living[0];
}

/**
 * Commit a combatant's turn: advance the queue clock to their nextTick, then push
 * their nextTick forward by delay(speed, weight). Anti-stunlock reset: acting
 * clears the stun-push counter (§5). Returns the tick the action happened at.
 */
export function commitTurn(combat, combatant, { weight = ACTION_WEIGHT.standard } = {}) {
  combat.now = Math.max(combat.now || 0, combatant.nextTick || 0);
  combatant.nextTick = combat.now + delayFor(combatantSpeed(combatant), weight);
  if (combatant.ctb) combatant.ctb.stunPushes = 0;
  return combat.now;
}

// ── status → queue operations (§5). The ONLY things that bend the queue. ────────

/** Re-scale a combatant's pending wait when its speed changes (§4). Only touches
 *  its own entry: remaining = nextTick − now; new = max(1, round(remaining × old/new)). */
function rescalePending(combat, combatant, oldSpeed, newSpeed) {
  if (!newSpeed || oldSpeed === newSpeed) return;
  const now = combat.now || 0;
  const remaining = Math.max(0, (combatant.nextTick || now) - now);
  const scaled = Math.max(1, Math.round(remaining * (oldSpeed / newSpeed)));
  combatant.nextTick = now + scaled;
}

export function applyHaste(combat, combatant, on = true) {
  const oldSpeed = combatantSpeed(combatant);
  combatant.ctb = combatant.ctb || { haste: false, slow: false, stunPushes: 0 };
  combatant.ctb.haste = Boolean(on);
  rescalePending(combat, combatant, oldSpeed, combatantSpeed(combatant));
}
export function applySlow(combat, combatant, on = true) {
  const oldSpeed = combatantSpeed(combatant);
  combatant.ctb = combatant.ctb || { haste: false, slow: false, stunPushes: 0 };
  combatant.ctb.slow = Boolean(on);
  rescalePending(combat, combatant, oldSpeed, combatantSpeed(combatant));
}

/**
 * Stun (§5): push nextTick forward by ONE standard delay, once. Speed untouched.
 * Anti-stunlock: a combatant whose nextTick is pushed twice WITHOUT acting is
 * immune to further stun until they act. Returns true if the stun landed.
 */
export function applyStun(combat, combatant) {
  combatant.ctb = combatant.ctb || { haste: false, slow: false, stunPushes: 0 };
  if ((combatant.ctb.stunPushes || 0) >= 2) return false; // immune until they act
  combatant.nextTick = (combatant.nextTick || combat.now || 0) + delayFor(combatantSpeed(combatant), ACTION_WEIGHT.standard);
  combatant.ctb.stunPushes = (combatant.ctb.stunPushes || 0) + 1;
  return true;
}

// ── the forecast (§6): ORDER-ONLY, next 8 slots, REVEALED combatants only ───────
/**
 * Simulate the queue forward WITHOUT mutating real state. Each future slot assumes
 * a standard-weight action (we can't know an actor's future choice). Order-only:
 * emits { actorId, displayName, isPlayer, slotIndex }. Raw ticks NEVER leave here —
 * they're the debug field only. `isRevealed(c)` filters hidden/unrevealed foes
 * (ambush integrity): the forecast never shows a slot for someone the player can't
 * see, and never shows a wrong slot for someone they can. Filtered truth.
 */
export function buildForecast(combat, { slots = CTB_FORECAST_SLOTS, isRevealed = () => true } = {}) {
  const sim = combatantsList(combat)
    .filter((c) => isAlive(c) && isRevealed(c))
    .map((c) => ({
      combatantId: c.combatantId,
      displayName: c.name || (c.kind === "player" ? "You" : c.combatantId),
      isPlayer: c.kind === "player",
      nextTick: c.nextTick || 0,
      speed: combatantSpeed(c)
    }));
  if (!sim.length) return [];
  const out = [];
  for (let i = 0; i < slots; i += 1) {
    sim.sort((a, b) => {
      if (a.nextTick !== b.nextTick) return a.nextTick - b.nextTick;
      if (a.speed !== b.speed) return b.speed - a.speed;
      return hashSeed(`${combat.queueSeed}|${a.combatantId}`) - hashSeed(`${combat.queueSeed}|${b.combatantId}`);
    });
    const actor = sim[0];
    out.push({ actorId: actor.combatantId, displayName: actor.displayName, isPlayer: actor.isPlayer, slotIndex: i });
    actor.nextTick += delayFor(actor.speed, ACTION_WEIGHT.standard);
  }
  return out;
}

// ── small shared helpers ────────────────────────────────────────────────────────
function combatantsList(combat) {
  return Object.values(combat?.combatants || {});
}
function isAlive(c) {
  if (!c) return false;
  if (c.kind === "player") return true; // the player leaves the queue via the player-drop rule, handled in combat.js
  return (c.hp?.current ?? 0) > 0 && c.fled !== true; // a fled enemy has left the fight
}
