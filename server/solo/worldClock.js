// ---------------------------------------------------------------------------
// WORLD CLOCK (#14) — a real minutes clock the SERVER owns.
//
// world.time historically carried an opaque { day, tick } counter: `tick`
// incremented by +1 on a move and by ad-hoc amounts on rest, with no wall-clock
// meaning, so nothing could derive day/night or price an action in real time.
//
// This module extends that to a genuine clock measured in MINUTES. The GM
// proposes a `durationMinutes` per action (its narrative discretion — a glance
// is a minute, forcing a lock is ten, searching a wing is an hour); the SERVER
// sanity-bounds it and commits it, then derives day / time-of-day / phase from
// the committed total. The LLM never owns the clock — it only proposes; the
// server is the single source of truth (the coherence moat, applied to time).
//
// Backward compatible: `minutes` is additive on world.time. `day` stays the
// canonical day counter (now DERIVED from minutes so the two can never drift),
// and the legacy `tick` field is left untouched for any caller still reading it.
// Pure functions only — no I/O, no Date.now (callers pass `now` for lastAdvancedAt).
// ---------------------------------------------------------------------------

export const DAY_MINUTES = 1440;

// A single freeform action may not advance more than half a day. The GM has full
// discretion WITHIN this band (searching a whole wing, waiting out a patrol); a
// value beyond it is almost always a model slip and is clamped, never trusted.
export const MAX_ACTION_MINUTES = 720;
export const MIN_ACTION_MINUTES = 0;

// Combat is measured in 6-second rounds (5e baseline), not narrative minutes —
// exposed so the combat resolver can advance the same clock at round scale.
export const COMBAT_ROUND_SECONDS = 6;

// Sensible defaults when the GM omits a duration, keyed off whether the action
// was contested (a rolled attempt takes longer than a glance). The GM's own
// number always wins when supplied; these only fill the gap.
export const DEFAULT_OBSERVE_MINUTES = 1;
export const DEFAULT_ACTION_MINUTES = 3;
export const DEFAULT_CHECK_MINUTES = 6;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Clamp a GM-proposed duration to the sane band and integer-round it. Non-numeric
// or negative input falls back to `fallback` (itself clamped). Never throws.
export function sanitizeDurationMinutes(raw, fallback = DEFAULT_ACTION_MINUTES) {
  const fb = isFiniteNumber(fallback) ? Math.min(MAX_ACTION_MINUTES, Math.max(MIN_ACTION_MINUTES, Math.round(fallback))) : DEFAULT_ACTION_MINUTES;
  if (!isFiniteNumber(raw)) {
    return fb;
  }
  const rounded = Math.round(raw);
  if (rounded < MIN_ACTION_MINUTES) return MIN_ACTION_MINUTES;
  if (rounded > MAX_ACTION_MINUTES) return MAX_ACTION_MINUTES;
  return rounded;
}

// Phase of day from minutes-into-day (0..1439). Dawn/day/dusk/night drive lighting,
// NPC schedules (#26 downstream), and circumstance (darkness = Burden).
export function phaseForMinuteOfDay(minuteOfDay) {
  const m = ((Math.round(minuteOfDay) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const hour = Math.floor(m / 60);
  if (hour >= 5 && hour < 7) return "dawn";
  if (hour >= 7 && hour < 18) return "day";
  if (hour >= 18 && hour < 21) return "dusk";
  return "night";
}

// Derive the full human-readable clock from an absolute minute total. `day` is
// 1-based (minute 0 = day 1, 00:00). Pure — the single place time-of-day is
// computed so the payload, the prompt, and any UI all read one truth.
export function deriveClock(totalMinutes) {
  const total = isFiniteNumber(totalMinutes) && totalMinutes >= 0 ? Math.round(totalMinutes) : 0;
  const minuteOfDay = total % DAY_MINUTES;
  const day = Math.floor(total / DAY_MINUTES) + 1;
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const phase = phaseForMinuteOfDay(minuteOfDay);
  const hhmm = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return {
    totalMinutes: total,
    day,
    minuteOfDay,
    hour,
    minute,
    hhmm,
    phase,
    isNight: phase === "night",
    isDark: phase === "night" || phase === "dusk"
  };
}

// ── DERIVED WEATHER (owner checklist item 1) ─────────────────────────────────
// The single derived current-weather read: an ACTIVE sky-family hazard
// objectState on the current location OVERLAYS the persistent world.weather
// while it stands ("the-sky" is the committed momentum convention —
// hazard_storm writes objectStates["the-sky"].state = "storm-breaking").
// Recognized transient sky states map onto the weather enum; an unrecognized
// sky state (or none) falls through to the persistent value; a legacy save
// with no world.weather reads "clear" (resume-safe law). Server-owned end to
// end — the narrator may describe this value, never set it.
const WEATHER_DEFAULT = "clear";
const WEATHER_VALUES = new Set(["clear", "cloudy", "rain", "storm", "snow", "fog"]);
const SKY_STATE_TO_WEATHER = {
  "storm-breaking": "storm",
  storm: "storm",
  storming: "storm",
  rain: "rain",
  raining: "rain",
  snow: "snow",
  snowing: "snow",
  fog: "fog",
  fogbound: "fog",
  "fog-bound": "fog",
  overcast: "cloudy",
  cloudy: "cloudy",
  clearing: "clear",
  clear: "clear"
};

export function deriveWeather(run) {
  const sky = run?.locations?.[run?.currentLocationId]?.flags?.objectStates?.["the-sky"];
  if (sky && typeof sky.state === "string") {
    const mapped = SKY_STATE_TO_WEATHER[sky.state.toLowerCase()];
    if (mapped) {
      return mapped;
    }
  }
  const persistent = run?.world?.weather;
  return typeof persistent === "string" && WEATHER_VALUES.has(persistent) ? persistent : WEATHER_DEFAULT;
}

// Ensure run.world.time is a plain object carrying a numeric `minutes`. Migrates a
// legacy { day, tick } (no minutes) by seeding minutes from day: an existing day N
// with no minute detail lands at the start of that day (07:00, mid-morning, so an
// in-flight campaign doesn't teleport to midnight). Idempotent; returns the time obj.
export function ensureClock(run) {
  if (!run || typeof run !== "object") {
    return null;
  }
  if (!run.world || typeof run.world !== "object") {
    run.world = {};
  }
  const time = run.world.time && typeof run.world.time === "object" ? run.world.time : {};
  run.world.time = time;
  if (!isFiniteNumber(time.minutes)) {
    const legacyDay = isFiniteNumber(time.day) && time.day >= 1 ? time.day : 1;
    // Seed at 07:00 of the legacy day so migrated campaigns start in the morning.
    time.minutes = (legacyDay - 1) * DAY_MINUTES + 7 * 60;
  }
  if (!isFiniteNumber(time.tick)) {
    time.tick = 0;
  }
  const clock = deriveClock(time.minutes);
  time.day = clock.day;
  time.minuteOfDay = clock.minuteOfDay;
  time.clock = clock.hhmm;
  time.phase = clock.phase;
  return time;
}

// Commit a time advance. Sanity-bounds `minutes` to the per-action band, adds it to
// the world clock, re-derives day/phase, and stamps lastAdvancedAt from the passed
// `now` (never Date.now — deterministic for tests). Returns the advance record for
// surfacing on the attempt result. Mutates run in place.
export function advanceClock(run, minutes, { now = null, fallback = DEFAULT_ACTION_MINUTES } = {}) {
  const time = ensureClock(run);
  if (!time) {
    return null;
  }
  const spend = sanitizeDurationMinutes(minutes, fallback);
  const beforeTotal = time.minutes;
  const before = deriveClock(beforeTotal);
  time.minutes = beforeTotal + spend;
  const after = deriveClock(time.minutes);
  time.day = after.day;
  time.minuteOfDay = after.minuteOfDay;
  time.clock = after.hhmm;
  time.phase = after.phase;
  if (typeof now === "string" && now) {
    time.lastAdvancedAt = now;
  }
  return {
    minutes: spend,
    beforeMinutes: beforeTotal,
    afterMinutes: time.minutes,
    before: { day: before.day, clock: before.hhmm, phase: before.phase },
    after: { day: after.day, clock: after.hhmm, phase: after.phase },
    dayRolled: after.day > before.day,
    phaseChanged: after.phase !== before.phase
  };
}

// Advance the clock by whole combat rounds (6s baseline each). Rounds are far
// shorter than a narrative minute; we accumulate seconds and only spill whole
// minutes into the clock so a short skirmish doesn't burn game-hours.
export function advanceCombatRounds(run, rounds, { now = null } = {}) {
  const n = isFiniteNumber(rounds) && rounds > 0 ? Math.round(rounds) : 1;
  const seconds = n * COMBAT_ROUND_SECONDS;
  const wholeMinutes = Math.floor(seconds / 60);
  if (wholeMinutes <= 0) {
    // Sub-minute: keep the clock honest without advancing a full minute per round.
    const time = ensureClock(run);
    if (time && typeof now === "string" && now) {
      time.lastAdvancedAt = now;
    }
    return { minutes: 0, rounds: n, seconds };
  }
  const rec = advanceClock(run, wholeMinutes, { now, fallback: wholeMinutes });
  return { ...rec, rounds: n, seconds };
}
