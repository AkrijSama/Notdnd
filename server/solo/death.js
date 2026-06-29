// ---------------------------------------------------------------------------
// 5e LETHALITY CORE — the headline product identity.
//
// Unlike a pushover GM, this is a real 5e game where the player can DIE: often,
// early, and PERMANENTLY. This module is the single source of truth for:
//   - real HP/damage (reaching 0 → 'dying', NOT "blacks out and wakes up safe")
//   - 5e death saving throws (3 successes → 'stable'; 3 failures → 'dead';
//     nat 20 → regain 1 HP; nat 1 → two failures; damage at 0 HP → a failure,
//     a crit → two)
//   - instant death from massive damage
//   - terminal, PERMANENT death (player.status='dead' → run.status='dead')
//   - revival ONLY via a POSSESSED means (held revival item / capable companion
//     NPC / gated divine intervention) — absent a real means, the player STAYS
//     DEAD. No auto-respawn, no GM mercy.
//
// Pure logic over a run object (the caller works on a clone and persists it).
// Death/revival are resolved here so every entry point (failed attempt, combat,
// a trap, the dying-turn loop) shares ONE honest ruleset.
// ---------------------------------------------------------------------------

import { rollD20 } from "./rules.js";

export const PLAYER_STATUS = Object.freeze({
  ALIVE: "alive",
  DYING: "dying",
  STABLE: "stable",
  DEAD: "dead"
});

// Statuses at which the player is at 0 HP and cannot act normally.
const INCAPACITATED = new Set([PLAYER_STATUS.DYING, PLAYER_STATUS.STABLE, PLAYER_STATUS.DEAD, "downed"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function nowIso(options = {}) {
  if (options.now instanceof Date && Number.isFinite(options.now.getTime())) {
    return options.now.toISOString();
  }
  if (typeof options.now === "string" && Number.isFinite(Date.parse(options.now))) {
    return options.now;
  }
  return new Date().toISOString();
}

// --- HP gauge access -------------------------------------------------------
// Canonical store is player.resources.hitPoints (what the engine has always
// mutated). We mirror to resources.hp (the state-contract gauge) and the
// top-level player.health/maxHealth so every reader stays consistent.

export function getHp(player) {
  if (!isPlainObject(player)) {
    return null;
  }
  const gauge = isPlainObject(player.resources?.hitPoints) ? player.resources.hitPoints : null;
  if (gauge && isNumber(gauge.current)) {
    const max = isNumber(gauge.max) ? gauge.max : (isNumber(player.maxHealth) ? player.maxHealth : gauge.current);
    return { current: gauge.current, max };
  }
  const mirror = isPlainObject(player.resources?.hp) ? player.resources.hp : null;
  if (mirror && isNumber(mirror.current)) {
    const max = isNumber(mirror.max) ? mirror.max : (isNumber(player.maxHealth) ? player.maxHealth : mirror.current);
    return { current: mirror.current, max };
  }
  if (isNumber(player.health)) {
    return { current: player.health, max: isNumber(player.maxHealth) ? player.maxHealth : player.health };
  }
  return null;
}

// Writes HP across every mirror, clamped to [0, max]. Returns the clamped value.
export function setHp(player, current) {
  const hp = getHp(player);
  const max = hp ? hp.max : (isNumber(player?.maxHealth) ? player.maxHealth : current);
  const clamped = Math.max(0, Math.min(isNumber(max) ? max : current, Math.round(current)));
  if (!isPlainObject(player.resources)) {
    player.resources = {};
  }
  if (!isPlainObject(player.resources.hitPoints)) {
    player.resources.hitPoints = { current: clamped, max: isNumber(max) ? max : clamped };
  } else {
    player.resources.hitPoints.current = clamped;
  }
  if (isPlainObject(player.resources.hp)) {
    player.resources.hp.current = clamped;
  }
  if (isNumber(player.health)) {
    player.health = clamped;
  }
  return clamped;
}

function ensureDeathSaves(player) {
  if (!isPlainObject(player.deathSaves)) {
    player.deathSaves = { successes: 0, failures: 0 };
  }
  if (!Number.isInteger(player.deathSaves.successes)) {
    player.deathSaves.successes = 0;
  }
  if (!Number.isInteger(player.deathSaves.failures)) {
    player.deathSaves.failures = 0;
  }
  return player.deathSaves;
}

function addFailures(player, n) {
  const ds = ensureDeathSaves(player);
  ds.failures = Math.min(3, ds.failures + n);
  return ds;
}

function addSuccesses(player, n) {
  const ds = ensureDeathSaves(player);
  ds.successes = Math.min(3, ds.successes + n);
  return ds;
}

function resetDeathSaves(player) {
  player.deathSaves = { successes: 0, failures: 0 };
}

// --- Lifecycle predicates --------------------------------------------------

export function isDead(run) {
  return run?.status === PLAYER_STATUS.DEAD || run?.player?.status === PLAYER_STATUS.DEAD;
}

export function isDying(run) {
  return run?.player?.status === PLAYER_STATUS.DYING && !isDead(run);
}

export function isStable(run) {
  return run?.player?.status === PLAYER_STATUS.STABLE && !isDead(run);
}

// True at 0 HP / unable to act normally (dying, stable, dead, legacy downed).
export function isIncapacitated(run) {
  return isDead(run) || INCAPACITATED.has(run?.player?.status);
}

// --- Possession-gated revival ---------------------------------------------
// A run carries no auto-respawn. Revival is gated on a real, POSSESSED means.

function inventoryItems(run) {
  return isPlainObject(run?.inventory) ? Object.values(run.inventory) : [];
}

function itemIsRevival(item) {
  if (!isPlainObject(item)) {
    return false;
  }
  if (isPlainObject(item.use) && item.use.effectType === "revive") {
    return true;
  }
  return Array.isArray(item.tags) && item.tags.includes("revival");
}

// A present companion NPC who can actually cast a revival (capability marker +
// an available charge/resource). Conservative: both must be present.
function companionCanRevive(npc, run) {
  if (!isPlainObject(npc) || npc.status === "gone") {
    return false;
  }
  if (npc.currentLocationId && run?.currentLocationId && npc.currentLocationId !== run.currentLocationId) {
    return false;
  }
  const capable = npc.capabilities?.revive === true || npc.flags?.canRevive === true;
  if (!capable) {
    return false;
  }
  const charges = isNumber(npc.reviveCharges) ? npc.reviveCharges : (isNumber(npc.resources?.revive) ? npc.resources.revive : null);
  // A capable companion with no tracked charge resource is treated as able once
  // (capability alone), but a tracked-and-exhausted resource blocks it.
  return charges === null ? true : charges > 0;
}

/**
 * Finds a POSSESSED revival means, in priority order: a held revival item, then
 * a capable present companion NPC, then a gated divine intervention (off unless
 * run.flags.divineInterventionAvailable is explicitly true). Returns a descriptor
 * or null when the player has no real means and must STAY DEAD.
 * @param {object} run
 * @returns {{kind:'item', itemId:string} | {kind:'companion', npcId:string} | {kind:'divine'} | null}
 */
export function findRevivalMeans(run) {
  for (const item of inventoryItems(run)) {
    if (itemIsRevival(item) && (item.quantity === undefined || item.quantity > 0)) {
      return { kind: "item", itemId: item.itemId };
    }
  }
  const npcs = isPlainObject(run?.npcs) ? Object.values(run.npcs) : [];
  for (const npc of npcs) {
    if (companionCanRevive(npc, run)) {
      return { kind: "companion", npcId: npc.npcId };
    }
  }
  if (run?.flags?.divineInterventionAvailable === true) {
    return { kind: "divine" };
  }
  return null;
}

// Consumes the located means (item qty / companion charge / divine grant) so a
// revival can only ever happen ONCE per possessed means.
function consumeRevivalMeans(run, means) {
  if (!means) {
    return;
  }
  if (means.kind === "item") {
    const item = run.inventory?.[means.itemId];
    if (isPlainObject(item) && isNumber(item.quantity)) {
      item.quantity = Math.max(0, item.quantity - 1);
    }
    // Mirror onto the contract array if the same id is carried there.
    if (Array.isArray(run.player?.inventory)) {
      for (const entry of run.player.inventory) {
        if (isPlainObject(entry) && (entry.id === means.itemId || entry.itemId === means.itemId)) {
          if (isNumber(entry.qty)) {
            entry.qty = Math.max(0, entry.qty - 1);
          }
        }
      }
    }
    return;
  }
  if (means.kind === "companion") {
    const npc = run.npcs?.[means.npcId];
    if (isPlainObject(npc)) {
      if (isNumber(npc.reviveCharges)) {
        npc.reviveCharges = Math.max(0, npc.reviveCharges - 1);
      } else if (isPlainObject(npc.resources) && isNumber(npc.resources.revive)) {
        npc.resources.revive = Math.max(0, npc.resources.revive - 1);
      }
    }
    return;
  }
  if (means.kind === "divine") {
    if (isPlainObject(run.flags)) {
      run.flags.divineInterventionAvailable = false;
    }
  }
}

// Brings the player back: alive at `hp` HP (default 1), death saves cleared, the
// run un-terminated. Used by both the death-pre-empt and explicit revive paths.
export function revivePlayer(run, options = {}) {
  const player = run.player;
  const hp = isNumber(options.hp) ? options.hp : 1;
  setHp(player, Math.max(1, hp));
  player.status = PLAYER_STATUS.ALIVE;
  resetDeathSaves(player);
  if (run.status === PLAYER_STATUS.DEAD) {
    run.status = "active";
    delete run.outcome;
    delete run.completedAt;
  }
  return player;
}

// Marks the player TERMINALLY dead and the run non-resumable (contract: run.status
// 'dead' is a terminal DEFEAT distinct from 'completed'). Permanent — the
// character is gone.
export function markDead(run, options = {}) {
  const now = nowIso(options);
  run.player.status = PLAYER_STATUS.DEAD;
  setHp(run.player, 0);
  run.status = PLAYER_STATUS.DEAD;
  run.outcome = "death";
  run.completedAt = now;
  return run;
}

// The single death gate: a killing blow only kills if the player has NO possessed
// revival means. With a means, it is consumed and the player is revived ONCE
// instead. Returns { dead, revived, revivedBy }.
function resolveLethal(run, options = {}) {
  const means = findRevivalMeans(run);
  if (means) {
    consumeRevivalMeans(run, means);
    revivePlayer(run, { hp: 1 });
    return { dead: false, revived: true, revivedBy: means };
  }
  markDead(run, options);
  return { dead: true, revived: false, revivedBy: null };
}

/**
 * Applies `amount` damage to the player with full 5e lethality.
 *   - HP > 0: reduce HP; hitting 0 sets 'dying' (fresh death saves); leftover
 *     damage ≥ max HP is INSTANT death.
 *   - HP = 0 (dying/stable): a hit ≥ max HP is instant death; otherwise it is a
 *     death-save failure (one, or two on a crit); the 3rd failure kills.
 * Death is gated through resolveLethal (possessed-means revival, else permadeath).
 * Returns a structured record (back-compatible with the old applyFailureDamage:
 * amount/hpBefore/hpAfter/max/downed), or null when there is no HP gauge.
 * @param {object} run mutated in place (work on a clone)
 * @param {number} amount damage
 * @param {{crit?: boolean, now?: string|Date}} [options]
 */
export function applyDamage(run, amount, options = {}) {
  const player = run?.player;
  const hp = getHp(player);
  if (!hp) {
    return null;
  }
  const statusBefore = player.status || PLAYER_STATUS.ALIVE;
  const record = {
    amount: 0,
    hpBefore: hp.current,
    hpAfter: hp.current,
    max: hp.max,
    crit: options.crit === true,
    downed: false,
    instantDeath: false,
    deathSaveFailuresAdded: 0,
    statusBefore,
    statusAfter: statusBefore,
    dying: false,
    dead: false,
    revived: false,
    revivedBy: null
  };

  // Terminal: a dead character takes no further damage.
  if (isDead(run)) {
    record.dead = true;
    return record;
  }

  const dmg = Math.max(0, Math.round(Number(amount) || 0));
  const crit = options.crit === true;

  if (hp.current > 0) {
    const newHp = hp.current - dmg;
    if (newHp > 0) {
      setHp(player, newHp);
      record.hpAfter = newHp;
      record.amount = hp.current - newHp;
      record.statusAfter = player.status || PLAYER_STATUS.ALIVE;
      return record;
    }
    // Dropped to 0 (or below).
    const overkill = dmg - hp.current; // damage beyond 0
    setHp(player, 0);
    record.hpAfter = 0;
    record.amount = hp.current; // HP actually lost (clamped)
    record.downed = true;
    if (hp.max > 0 && overkill >= hp.max) {
      // Massive damage on the dropping blow → instant death, skip saves.
      record.instantDeath = true;
      const lethal = resolveLethal(run, options);
      Object.assign(record, lethal);
    } else {
      resetDeathSaves(player);
      player.status = PLAYER_STATUS.DYING;
      record.dying = true;
    }
    record.statusAfter = player.status;
    return record;
  }

  // Already at 0 HP (dying / stable / downed).
  setHp(player, 0);
  record.downed = true;
  if (dmg <= 0) {
    record.statusAfter = player.status;
    return record;
  }
  if (hp.max > 0 && dmg >= hp.max) {
    record.instantDeath = true;
    const lethal = resolveLethal(run, options);
    Object.assign(record, lethal);
    record.statusAfter = player.status;
    return record;
  }
  // Damage at 0 HP = death-save failure(s): one, or two on a crit.
  const fails = crit ? 2 : 1;
  addFailures(player, fails);
  record.deathSaveFailuresAdded = fails;
  if (player.deathSaves.failures >= 3) {
    const lethal = resolveLethal(run, options);
    Object.assign(record, lethal);
  } else {
    player.status = PLAYER_STATUS.DYING;
    record.dying = true;
  }
  record.statusAfter = player.status;
  return record;
}

/**
 * Rolls ONE death saving throw for a dying player (the dying-turn loop):
 *   nat 20 → regain 1 HP (back to alive, saves cleared);
 *   nat 1  → two failures;
 *   ≥10    → one success;  <10 → one failure.
 * 3 successes → 'stable' (saves cleared); 3 failures → death (possessed-means
 * revival, else permadeath). No-op unless the player is dying.
 * @param {object} run mutated in place
 * @param {{fixedRoll?: number, fixedRolls?: number[], rng?: () => number, now?: string|Date}} [options]
 */
export function rollDeathSave(run, options = {}) {
  if (!isDying(run)) {
    return { ok: false, reason: "NOT_DYING", status: run?.player?.status || null };
  }
  const player = run.player;
  ensureDeathSaves(player);
  const roll = rollD20(options);
  const record = {
    ok: true,
    roll,
    outcome: null,
    stabilized: false,
    dead: false,
    revived: false,
    revivedBy: null,
    status: player.status,
    deathSaves: null
  };

  if (roll === 20) {
    // A natural 20: you regain 1 HP and are back on your feet.
    revivePlayer(run, { hp: 1 });
    record.outcome = "nat20_revive";
    record.revived = true;
    record.status = player.status;
    record.deathSaves = { ...player.deathSaves };
    return record;
  }
  if (roll === 1) {
    addFailures(player, 2);
    record.outcome = "nat1_double_fail";
  } else if (roll >= 10) {
    addSuccesses(player, 1);
    record.outcome = "success";
  } else {
    addFailures(player, 1);
    record.outcome = "fail";
  }

  if (player.deathSaves.failures >= 3) {
    const lethal = resolveLethal(run, options);
    Object.assign(record, lethal);
  } else if (player.deathSaves.successes >= 3) {
    player.status = PLAYER_STATUS.STABLE;
    resetDeathSaves(player);
    record.stabilized = true;
  }
  record.status = player.status;
  record.deathSaves = { ...player.deathSaves };
  return record;
}

/**
 * Explicit revival via a possessed means (a player using a revival item /
 * a companion casting). Revives a dying OR just-dead player to `hp` HP, consuming
 * the means. Returns { ok:false, reason:'NO_REVIVAL_MEANS' } when there is none —
 * the player STAYS DEAD.
 * @param {object} run mutated in place
 * @param {{means?: object, hp?: number}} [options]
 */
export function attemptRevive(run, options = {}) {
  if (run?.player?.status === PLAYER_STATUS.ALIVE) {
    return { ok: false, reason: "NOT_INCAPACITATED", status: PLAYER_STATUS.ALIVE };
  }
  const means = options.means || findRevivalMeans(run);
  if (!means) {
    return { ok: false, reason: "NO_REVIVAL_MEANS", status: run?.player?.status || null };
  }
  consumeRevivalMeans(run, means);
  revivePlayer(run, { hp: isNumber(options.hp) ? options.hp : 1 });
  return { ok: true, revivedBy: means, status: PLAYER_STATUS.ALIVE };
}
