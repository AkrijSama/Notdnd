// ---------------------------------------------------------------------------
// CONDITIONS (#26) — timed player conditions the server owns and ticks.
//
// A condition is real, committed state: { id, name, effect, durationMinutes,
// appliedAtMinutes, expiresAtMinutes }. It is APPLIED by a failed check, an
// event, or an item; it is TICKED DOWN against the #14 world clock; and it is
// SHED automatically when it expires. The GM may narrate a status, but only the
// server commits/expires it — so the STATUS WINDOW and the narration can never
// disagree about what's afflicting the player (the coherence moat, for status).
//
// The vocabulary basis is the Ch8 FF-status set folded into the engine's own
// Edge/Burden circumstance language (server/solo/rules.js), so a condition's
// stated effect reads in the same terms the resolver actually rolls in.
//
// Pure functions: callers pass the current clock minutes (from world.time.minutes);
// no Date.now, no I/O.
// ---------------------------------------------------------------------------

// Canonical status vocabulary. `effect` is player-facing text framed in Edge/Burden.
// `defaultMinutes` is the fallback lifetime when neither the GM nor the caller sets
// one; null means it persists until explicitly cleared (e.g. removed by a cure).
export const CONDITION_VOCAB = Object.freeze({
  poisoned: { name: "Poisoned", effect: "Burden on attack rolls and ability checks.", defaultMinutes: 60 },
  frightened: { name: "Frightened", effect: "Burden while the source of fear is in sight; you cannot willingly approach it.", defaultMinutes: 10 },
  prone: { name: "Prone", effect: "Burden on attacks; melee attacks against you have Edge until you stand.", defaultMinutes: 2 },
  blinded: { name: "Blinded", effect: "You cannot see: sight-based checks auto-fail and you attack at Burden.", defaultMinutes: 10 },
  deafened: { name: "Deafened", effect: "You cannot hear: hearing-based checks auto-fail.", defaultMinutes: 10 },
  bleeding: { name: "Bleeding", effect: "An open wound; you lose ground until it is bound.", defaultMinutes: 30 },
  burning: { name: "Burning", effect: "Flames cling to you, searing each round until smothered.", defaultMinutes: 3 },
  stunned: { name: "Stunned", effect: "You cannot take actions; attacks against you have Edge.", defaultMinutes: 1 },
  slowed: { name: "Slowed", effect: "Your movement is halved and you act at Burden.", defaultMinutes: 10 },
  restrained: { name: "Restrained", effect: "You cannot move; attacks against you have Edge and you strike at Burden.", defaultMinutes: 10 },
  charmed: { name: "Charmed", effect: "You cannot act against the charmer and they persuade you at Edge.", defaultMinutes: 30 },
  exhausted: { name: "Exhausted", effect: "Burden on everything until you rest.", defaultMinutes: 480 },
  poisonedFood: { name: "Sickened", effect: "Nausea grips you; Burden on physical checks.", defaultMinutes: 60 },
  dazed: { name: "Dazed", effect: "Your head swims; Burden on your next actions.", defaultMinutes: 3 },
  weakened: { name: "Weakened", effect: "Your strength is sapped; Burden on Strength checks.", defaultMinutes: 60 }
});

const DEFAULT_UNKNOWN_MINUTES = 10;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Slug a free-text condition name into a stable id, and match it to the canon
// vocabulary when possible (so "poisoned"/"Poisoned"/"is poisoned" all land on the
// same entry). Returns { id, canon } where canon is the vocab record or null.
export function normalizeConditionId(rawName) {
  const text = String(rawName || "").trim().toLowerCase();
  const slug = text.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!slug) {
    return { id: "condition", canon: null };
  }
  // Direct vocab hit by id.
  if (CONDITION_VOCAB[slug]) {
    return { id: slug, canon: CONDITION_VOCAB[slug] };
  }
  // Word-contains match: "is poisoned by the fumes" -> poisoned.
  for (const [id, canon] of Object.entries(CONDITION_VOCAB)) {
    if (text.includes(id) || (canon.name && text.includes(canon.name.toLowerCase()))) {
      return { id, canon };
    }
  }
  return { id: slug, canon: null };
}

// Resolve the { id, name, effect, defaultMinutes } for a condition spec, merging a
// caller/GM-supplied effect + duration over the vocab defaults.
export function describeCondition(spec) {
  const raw = isPlainObject(spec) ? spec : { name: spec };
  const { id, canon } = normalizeConditionId(raw.name || raw.condition || raw.id);
  const name = typeof raw.name === "string" && raw.name.trim() && !canon
    ? raw.name.trim()
    : (canon ? canon.name : (typeof raw.name === "string" ? raw.name.trim() : id));
  const effect = typeof raw.effect === "string" && raw.effect.trim()
    ? raw.effect.trim()
    : (canon ? canon.effect : "An affliction hampering you.");
  const defaultMinutes = isFiniteNumber(raw.durationMinutes) && raw.durationMinutes > 0
    ? Math.round(raw.durationMinutes)
    : (canon && canon.defaultMinutes !== null ? canon.defaultMinutes
      : (canon && canon.defaultMinutes === null ? null : DEFAULT_UNKNOWN_MINUTES));
  return { id, name, effect, defaultMinutes };
}

// Apply (or refresh) a timed condition on the player. `nowMinutes` is the current
// world clock (world.time.minutes). A fresh application of an already-present
// condition REFRESHES it to the longer remaining lifetime (a second dose extends,
// never shortens). Returns the committed entry, or null on bad input.
export function applyCondition(run, spec, nowMinutes) {
  const player = run && isPlainObject(run.player) ? run.player : null;
  if (!player) {
    return null;
  }
  if (!Array.isArray(player.conditions)) {
    player.conditions = [];
  }
  const desc = describeCondition(spec);
  const now = isFiniteNumber(nowMinutes) ? Math.round(nowMinutes) : 0;
  const durationMinutes = desc.defaultMinutes; // null => permanent until cleared
  const expiresAtMinutes = durationMinutes === null ? null : now + durationMinutes;

  const existing = player.conditions.find((entry) => isPlainObject(entry) && entry.id === desc.id);
  if (existing) {
    // Refresh: extend to the later expiry (permanent wins over timed).
    if (expiresAtMinutes === null || existing.expiresAtMinutes === null) {
      existing.expiresAtMinutes = null;
      existing.durationMinutes = null;
    } else if (expiresAtMinutes > existing.expiresAtMinutes) {
      existing.expiresAtMinutes = expiresAtMinutes;
      existing.durationMinutes = durationMinutes;
    }
    existing.name = desc.name;
    existing.effect = desc.effect;
    return existing;
  }
  const entry = {
    id: desc.id,
    name: desc.name,
    effect: desc.effect,
    durationMinutes,
    appliedAtMinutes: now,
    expiresAtMinutes
  };
  player.conditions.push(entry);
  return entry;
}

// Tick conditions against the clock: shed every timed condition whose expiry has
// arrived at `nowMinutes`. Permanent conditions (expiresAtMinutes null) and legacy
// entries without an expiry are kept. Returns { shed: [{id,name}], remaining }.
export function tickConditions(run, nowMinutes) {
  const player = run && isPlainObject(run.player) ? run.player : null;
  if (!player || !Array.isArray(player.conditions) || player.conditions.length === 0) {
    return { shed: [], remaining: 0 };
  }
  const now = isFiniteNumber(nowMinutes) ? Math.round(nowMinutes) : 0;
  const shed = [];
  const kept = [];
  for (const entry of player.conditions) {
    if (isPlainObject(entry) && isFiniteNumber(entry.expiresAtMinutes) && entry.expiresAtMinutes <= now) {
      shed.push({ id: entry.id, name: entry.name || entry.id });
    } else {
      kept.push(entry);
    }
  }
  player.conditions = kept;
  return { shed, remaining: kept.length };
}

// Remove a named condition outright (a cure/item). Returns the removed entry or null.
export function clearCondition(run, name) {
  const player = run && isPlainObject(run.player) ? run.player : null;
  if (!player || !Array.isArray(player.conditions)) {
    return null;
  }
  const { id } = normalizeConditionId(name);
  const index = player.conditions.findIndex((entry) => isPlainObject(entry) && entry.id === id);
  if (index === -1) {
    return null;
  }
  const [removed] = player.conditions.splice(index, 1);
  return removed;
}

// STATUS WINDOW projection: each active condition with its effect and the minutes
// remaining (null = persists until cleared). `nowMinutes` from world.time.minutes.
export function conditionStatusPayload(run, nowMinutes) {
  const player = run && isPlainObject(run.player) ? run.player : null;
  if (!player || !Array.isArray(player.conditions)) {
    return [];
  }
  const now = isFiniteNumber(nowMinutes) ? Math.round(nowMinutes) : 0;
  return player.conditions
    .filter(isPlainObject)
    .map((entry) => {
      const permanent = !isFiniteNumber(entry.expiresAtMinutes);
      const remainingMinutes = permanent ? null : Math.max(0, entry.expiresAtMinutes - now);
      return {
        id: entry.id,
        name: entry.name || entry.id,
        effect: typeof entry.effect === "string" ? entry.effect : "",
        remainingMinutes,
        permanent
      };
    });
}
