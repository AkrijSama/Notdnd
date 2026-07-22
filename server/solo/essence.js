// ESSENCE-SIGHT (verdance-region-v1 §regional-law-5) — the protagonist's unique
// trait made playable. HE ALONE sees traces of demon essence (trails, residue,
// handler-scent), rendered via the STATUS WINDOW; a trail's strength reads its
// RECENCY. This is WHY the Goddess summoned him: her counter-weapon.
//
// LAW (implementation contract — mirrors the canon doc's implementation section):
//   • Essence traces are COMMITTED STATE, server-owned (run.essenceTraces), like
//     everything else. The narrator DESCRIBES committed traces; it never invents
//     them (see buildEssenceTraceDirective + auditNarratedEssenceTraces).
//   • Only the MC perceives traces — they ride the SIGHT layer of the scene
//     payload for the player character only; no NPC / OOC surface exposes them.
//   • Traces are BORN at committed events: rapture-sites mint an outbound TRAIL
//     (demons drift — regional law 2); portal sites mint standing RESIDUE
//     (guardians never leave); Congregation chalk MARKS carry handler-scent meta.
//   • STRENGTH derives from world-clock AGE via a TUNABLE band table (below),
//     never a hardcoded literal at the call site (regional law 6).
//
// Pure functions only — no I/O, no Date.now (age reads run.world.time.minutes,
// the server-owned world clock). Additive + resume-safe: a legacy run with no
// run.essenceTraces reads as "no traces" everywhere.
import { resolveStatBlock, sightReadableSkills } from "../campaign/bestiary.js";

// ── TUNABLE STRENGTH TABLE (regional law 6) ──────────────────────────────────
// Trail strength = recency: age (world-clock minutes since birth) → a band. The
// bands are ordered brightest→coldest; the FIRST whose ceiling the age is under
// wins. Tunable in one place — no caller hardcodes a threshold.
export const TRACE_STRENGTH_BANDS = Object.freeze([
  { band: "bright", maxAgeMinutes: 12 * 60 },       // ≤ 12h — fresh, still warm to look at
  { band: "clear", maxAgeMinutes: 3 * 1440 },       // ≤ 3 days — a clean track to follow
  { band: "faint", maxAgeMinutes: 14 * 1440 },      // ≤ 14 days — old, fading
  { band: "cold", maxAgeMinutes: Infinity }         // older — barely there
]);

// STANDING traces do not fade (they are replenished): a portal's guardians never
// leave (residue), a handler renews the chalk (mark). Their band is fixed per
// kind unless the seed overrides it.
export const STANDING_TRACE_BANDS = Object.freeze({
  residue: "bright",
  mark: "clear",
  trail: "clear"
});

export const TRACE_KINDS = Object.freeze(["trail", "residue", "mark"]);
export const TRACE_BANDS = Object.freeze(["bright", "clear", "faint", "cold"]);

// Per-kind + per-band display meta — the single source of truth for the UI's
// glyph + band word (multi-channel: never colour alone). Mirrors the frozen
// CONDITION_KIND_META idiom the conditions HUD uses.
export const TRACE_KIND_META = Object.freeze({
  trail: { glyph: "≈", word: "Trail" },
  residue: { glyph: "◈", word: "Residue" },
  mark: { glyph: "✶", word: "Mark" }
});
export const TRACE_BAND_META = Object.freeze({
  bright: { word: "Bright", order: 0 },
  clear: { word: "Clear", order: 1 },
  faint: { word: "Faint", order: 2 },
  cold: { word: "Cold", order: 3 }
});

// DIEGETIC SIGHT PHRASES (Law-6, owner-tunable): the essence-sight affordance/chip label
// reads as the CHARACTER'S PERCEPTION, never a field name or a raw band token (and never
// with an em-dash — the ban). Keyed [kind][band]; an unknown kind falls back to trail
// phrasing, an unknown band to `clear`. mark/residue carry phrasing distinct from a
// trail. The mechanical band still rides the tooltip (traceBandTooltip) for clarity.
export const SIGHT_PHRASES = Object.freeze({
  trail: Object.freeze({
    bright: "The trail burns fresh",
    clear: "The scent holds",
    faint: "A fading trace",
    cold: "Cold remnants linger"
  }),
  mark: Object.freeze({
    bright: "A mark, freshly cut",
    clear: "A mark holds its edge",
    faint: "A mark worn thin",
    cold: "An old mark, all but gone"
  }),
  residue: Object.freeze({
    bright: "Raw residue still clings",
    clear: "Residue lingers close",
    faint: "Residue thinning away",
    cold: "The faintest cold residue"
  })
});
export function sightPhrase(kind, band) {
  const k = SIGHT_PHRASES[kind] ? kind : "trail";
  const b = SIGHT_PHRASES[k][band] ? band : "clear";
  return SIGHT_PHRASES[k][b];
}
// The mechanical strength read for a tooltip (the perception label stays diegetic).
export function traceBandTooltip(kind, band) {
  const kw = TRACE_KIND_META[kind]?.word || "Trace";
  const bw = TRACE_BAND_META[band]?.word || "Clear";
  return `${kw} · ${bw}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// The world-clock minute a run is "now" at, read-only (never mutates the run —
// derivation must be a pure read). Legacy/uninitialised clocks read 0.
export function currentWorldMinutes(run) {
  const m = Number(run?.world?.time?.minutes);
  return Number.isFinite(m) ? m : 0;
}

// ── NORMALISER (resume-safe) ─────────────────────────────────────────────────
// Ensure run.essenceTraces is an array. Legacy runs (predate the field) become
// []. Idempotent; returns the array. Mirrors ensureEquipment / ensureClock.
export function ensureEssenceTraces(run) {
  if (!isPlainObject(run)) {
    return [];
  }
  if (!Array.isArray(run.essenceTraces)) {
    run.essenceTraces = [];
  }
  return run.essenceTraces;
}

export function getEssenceTraces(run) {
  return Array.isArray(run?.essenceTraces) ? run.essenceTraces : [];
}

// Derive the strength BAND of a trace at a given world-clock minute. STANDING
// traces read their fixed band; others decay by age through the tunable table.
export function deriveTraceStrength(trace, nowMinutes) {
  if (!isPlainObject(trace)) {
    return "cold";
  }
  if (trace.standing) {
    return isString(trace.standingBand) ? trace.standingBand : (STANDING_TRACE_BANDS[trace.kind] || "clear");
  }
  const born = Number(trace.bornMinutes);
  const now = Number(nowMinutes);
  if (!Number.isFinite(born) || !Number.isFinite(now)) {
    return "cold";
  }
  const age = Math.max(0, now - born);
  for (const step of TRACE_STRENGTH_BANDS) {
    if (age <= step.maxAgeMinutes) {
      return step.band;
    }
  }
  return "cold";
}

// A trail is FOLLOWABLE from its own location when its next hop (path[0]) is a
// committed edge out of that location — you can only track along real geography.
function trailNextHop(run, trace) {
  if (!isPlainObject(trace) || trace.kind !== "trail") {
    return null;
  }
  const path = Array.isArray(trace.path) ? trace.path.filter(isString) : [];
  const next = path[0] || null;
  if (!next) {
    return null;
  }
  const here = run?.locations?.[trace.locationId];
  const edges = Array.isArray(here?.connectedLocationIds) ? here.connectedLocationIds : [];
  return edges.includes(next) && run?.locations?.[next] ? next : null;
}

// The committed traces perceived AT a location, newest/brightest first. Each is
// enriched with its derived band + display glyph — the shape both the sight
// payload and the narrator directive read.
export function tracesAtLocation(run, locationId, nowMinutes = null) {
  const now = nowMinutes == null ? currentWorldMinutes(run) : nowMinutes;
  const out = [];
  for (const trace of getEssenceTraces(run)) {
    if (!isPlainObject(trace) || trace.locationId !== locationId) {
      continue;
    }
    const kind = TRACE_KINDS.includes(trace.kind) ? trace.kind : "trail";
    const band = deriveTraceStrength(trace, now);
    const nextHop = trailNextHop(run, trace);
    const targetLoc = nextHop ? run.locations[nextHop] : null;
    const targetKnown = Boolean(targetLoc?.state?.discovered || targetLoc?.state?.visited);
    out.push({
      id: isString(trace.id) ? trace.id : null,
      kind,
      band,
      glyph: TRACE_KIND_META[kind].glyph,
      kindWord: TRACE_KIND_META[kind].word,
      bandWord: (TRACE_BAND_META[band] || TRACE_BAND_META.cold).word,
      source: isString(trace.source) ? trace.source : null,
      meta: isPlainObject(trace.meta) ? trace.meta : {},
      // Following is committed-edge gated; the DISPLAY direction respects map-fog
      // (an undiscovered next node is a heading, not a named place).
      targetLocationId: nextHop,
      followable: Boolean(nextHop),
      direction: nextHop ? (targetKnown ? String(targetLoc.name || "") : null) : null
    });
  }
  return out.sort((a, b) => (TRACE_BAND_META[a.band].order - TRACE_BAND_META[b.band].order) || a.kind.localeCompare(b.kind));
}

// The SIGHT layer of the scene payload — PLAYER-PERSPECTIVE ONLY. A concrete,
// defaulted value always (the contract law); empty traces when the sight is
// quiet. Never placed on any NPC / cast / OOC surface.
export function buildSightPayload(run) {
  const locationId = run?.currentLocationId || null;
  const now = currentWorldMinutes(run);
  const traces = locationId ? tracesAtLocation(run, locationId, now) : [];
  return {
    traces,
    followable: traces.some((t) => t.followable),
    // The next node a followed trail reveals — a SILHOUETTE, distinct from a
    // map-item reveal (the map renders it fogged/dashed; see regionMap.js).
    sightReveals: traces
      .filter((t) => t.followable)
      .map((t) => ({ locationId: t.targetLocationId, band: t.band })),
    // THE BLOODHOUND ADVANTAGE (combat sight): a sightReadable creature co-located
    // with the MC has its carried chaos skills READ before the fight — "you read: a
    // bite that chills". PLAYER-PERSPECTIVE only, like every sight field.
    readableEnemies: locationId ? readableEnemiesAt(run, locationId) : []
  };
}

// Turn a carried chaos skill into the bloodhound's read — a short, in-fiction phrase.
// An inverted-element mint reads "a <element> that <rider>s" ("a bite that chills").
export function readChaosSkillPhrase(skill) {
  if (!skill) return null;
  if (skill.skillId === "inverted-element" && skill.mint && skill.mint.element) {
    const rider = String(skill.mint.rider || "");
    const verb = !rider ? "turns wrong" : /s$/.test(rider) ? rider : `${rider}s`;
    return `a ${skill.mint.element} that ${verb}`;
  }
  if (skill.skillId === "chaos-pack-aura") return "a pack that feeds on numbers";
  return skill.name ? String(skill.name).toLowerCase() : null;
}

// The read phrases for a stat block's sightReadable carried skills (for the enemy
// combat card — the MC's sight reads the corruption it is fighting).
export function readStatBlockSkills(statBlockId) {
  return sightReadableSkills(resolveStatBlock(statBlockId)).map(readChaosSkillPhrase).filter(Boolean);
}

/**
 * The sightReadable creatures co-located with the player, with their carried chaos
 * skills read into short phrases. The essence-sight bloodhound edge: the MC reads a
 * creature's corruption BEFORE engaging it. Player-perspective (rides scene.sight).
 */
export function readableEnemiesAt(run, locationId) {
  const npcs = run?.npcs || {};
  const out = [];
  for (const npc of Object.values(npcs)) {
    if (!isPlainObject(npc) || npc.currentLocationId !== locationId) continue;
    if (npc.status === "dead" || npc.flags?.defeated === true) continue;
    const statBlockId = npc.statBlockId || npc.flags?.statBlockId;
    if (!isString(statBlockId)) continue;
    const reads = sightReadableSkills(resolveStatBlock(statBlockId)).map(readChaosSkillPhrase).filter(Boolean);
    if (reads.length) out.push({ npcId: npc.npcId, name: resolveStatBlock(statBlockId)?.name || npc.displayName || "a corrupted thing", reads });
  }
  return out;
}

// The followable trails at the run's current location (for the affordance chip).
export function followableTrailsAtCurrent(run) {
  const locationId = run?.currentLocationId || null;
  if (!locationId) {
    return [];
  }
  return tracesAtLocation(run, locationId).filter((t) => t.followable);
}

// The next-hop node of the brightest followable trail at the current location —
// what "Follow the trail" tracks along. Returns { toLocationId, band } or null.
export function trailFollowTargetAtCurrent(run) {
  const followable = followableTrailsAtCurrent(run);
  const best = followable[0] || null; // already sorted brightest-first
  return best ? { toLocationId: best.targetLocationId, band: best.band } : null;
}

// ── MINTING ──────────────────────────────────────────────────────────────────
// Upsert a trace by id (idempotent — re-firing a committed beat never duplicates
// or refreshes-away; the first mint's birth-time is authoritative unless force).
export function upsertTrace(run, trace) {
  if (!isPlainObject(run) || !isPlainObject(trace) || !isString(trace.id)) {
    return null;
  }
  const traces = ensureEssenceTraces(run);
  const existing = traces.findIndex((t) => isPlainObject(t) && t.id === trace.id);
  if (existing >= 0) {
    return traces[existing];
  }
  traces.push(trace);
  return trace;
}

// Shape a well-formed trace record. Callers pass committed refs only.
// `sourceNpcId` (optional) is the STRONG link to the roster entity that laid the
// trail — its death/removal destroys the trail (see the DESTROY FATE section). A
// placement trail carries the encounter it leads to on `meta.encounter` instead
// (a soft link); a free-descriptor drift trail carries neither and dies only by age.
export function makeTrace({ id, kind, source, locationId, path = [], bornMinutes = 0, standing = false, standingBand = null, sourceNpcId = null, meta = {} }) {
  const k = TRACE_KINDS.includes(kind) ? kind : "trail";
  const rec = {
    id: String(id),
    kind: k,
    source: isString(source) ? source : "unknown",
    locationId: String(locationId),
    path: Array.isArray(path) ? path.filter(isString) : [],
    bornMinutes: isFiniteNumber(bornMinutes) ? bornMinutes : 0,
    standing: Boolean(standing),
    standingBand: isString(standingBand) ? standingBand : null,
    sourceNpcId: isString(sourceNpcId) ? sourceNpcId : null,
    meta: isPlainObject(meta) ? meta : {}
  };
  return rec;
}

// A demon/rapture-spawning committed event mints an OUTBOUND trail (demons drift,
// regional law 2). Wired into the thread-beat + momentum-hazard commit paths at
// fire time — `spawn` is the committed marker they carry. Idempotent by id.
//   spawn: { kind?: "rapture"|"demon", trailTo?: <locId>, source?, meta? }
export function mintTraceFromSpawn(run, spawn, { id, locationId, nowMinutes } = {}) {
  if (!isPlainObject(run) || !isPlainObject(spawn) || !isString(id) || !isString(locationId)) {
    return null;
  }
  const born = isFiniteNumber(nowMinutes) ? nowMinutes : currentWorldMinutes(run);
  // The drift target: an explicit committed edge if authored, else the first
  // committed exit out of the spawn location (demons wander OUT).
  let trailTo = isString(spawn.trailTo) ? spawn.trailTo : null;
  const here = run?.locations?.[locationId];
  const exits = Array.isArray(here?.connectedLocationIds) ? here.connectedLocationIds : [];
  if (trailTo && !exits.includes(trailTo)) {
    trailTo = null; // never invent an edge — only track real geography
  }
  if (!trailTo) {
    trailTo = exits[0] || null;
  }
  const kind = spawn.kind === "residue" ? "residue" : "trail";
  const trace = makeTrace({
    id,
    kind,
    source: isString(spawn.source) ? spawn.source : `spawn:${locationId}`,
    locationId,
    path: trailTo ? [trailTo] : [],
    bornMinutes: born,
    standing: kind === "residue",
    sourceNpcId: isString(spawn.sourceNpcId) ? spawn.sourceNpcId : null,
    meta: isPlainObject(spawn.meta) ? spawn.meta : {}
  });
  return upsertTrace(run, trace);
}

// ── DESTROY FATE / LIFECYCLE (verdance-region-v1 §law-5) ─────────────────────
// A followable TRAIL is a perishable thing: it must not outlive the demon that
// laid it, nor its own recency. Without a destroy fate a followed trail stays
// followable after its owner (the hostile) is dead, and the array grows unbounded.
//
// Two death fates, applied to NON-standing trails only:
//   (a) SOURCE DEAD/REMOVED — the roster entity the trail belongs to is dead,
//       defeated, or gone from the run entirely.
//   (b) EXPIRY — the trail has aged past the horizon (a track gone truly cold).
//
// STANDING residue/marks are EXEMPT: a portal's guardians never leave (residue),
// a handler renews the chalk (mark) — regional law 2's replenishment exception.
// They persist until an owner beat removes them explicitly. Pure — no I/O.

// The age horizon beyond which a non-standing trail is destroyed (Law-6 tunable,
// one place). Well past the coldest band (14d) — a trail nobody followed in a
// month is gone, which also bounds run.essenceTraces growth. Tunable here only.
export const TRACE_EXPIRY_MINUTES = 30 * 1440; // 30 days

// (a) Is the trail's SOURCE entity dead/removed? A trail links to its owner two ways:
//   • STRONG — `sourceNpcId` (an explicit roster ref): its ABSENCE from the roster
//     means the source was removed from the world (a death fate), and present-and-
//     dead is a death fate too.
//   • SOFT — the encounter the trail LEADS TO (`meta.encounter`, stamped by a
//     bestiary placement) or a `source` that happens to resolve to a committed npc:
//     only a PRESENT-and-dead source kills the trail. An absent soft ref may be a
//     not-yet-spawned encounter (spawnOnEnter), so it is NOT treated as removed.
// Standing traces have no source-death fate. Free-descriptor trails (no linkable
// entity) return false here and die only by expiry.
export function isTraceSourceDead(run, trace) {
  if (!isPlainObject(trace) || trace.standing) {
    return false;
  }
  const npcs = isPlainObject(run?.npcs) ? run.npcs : {};
  const isDeadNpc = (npc) => isPlainObject(npc) && (npc.status === "dead" || npc.flags?.defeated === true);
  // STRONG link.
  if (isString(trace.sourceNpcId)) {
    const npc = npcs[trace.sourceNpcId];
    return npc === undefined || npc === null ? true : isDeadNpc(npc);
  }
  // SOFT link — the encounter it leads to, else a source that names a committed npc.
  const soft =
    (isPlainObject(trace.meta) && isString(trace.meta.encounter) && trace.meta.encounter) ||
    (isString(trace.source) && npcs[trace.source] ? trace.source : null);
  if (soft) {
    return isDeadNpc(npcs[soft]);
  }
  return false;
}

// (b) Has a non-standing trail aged past the destroy horizon?
export function traceReachedExpiry(trace, nowMinutes) {
  if (!isPlainObject(trace) || trace.standing) {
    return false;
  }
  const born = Number(trace.bornMinutes);
  const now = Number(nowMinutes);
  if (!Number.isFinite(born) || !Number.isFinite(now)) {
    return false;
  }
  return now - born > TRACE_EXPIRY_MINUTES;
}

// Prune destroyed trails from run.essenceTraces IN PLACE. A standing residue/mark
// is never touched; a non-standing trail whose source is dead/removed OR that has
// aged past the horizon is spliced out (destroyed — served to nothing, no longer
// followable). Idempotent + resume-safe: a legacy run with no field is a no-op.
// Returns the ids of the destroyed trails (for observability on the tick record).
// Wired onto the world-clock tick (worldClock.advanceClock) so a followed trail
// cannot outlive its source or its recency.
export function pruneEssenceTraces(run, nowMinutes = null) {
  if (!isPlainObject(run) || !Array.isArray(run.essenceTraces) || run.essenceTraces.length === 0) {
    return [];
  }
  const now = nowMinutes == null ? currentWorldMinutes(run) : nowMinutes;
  const removed = [];
  run.essenceTraces = run.essenceTraces.filter((trace) => {
    if (!isPlainObject(trace)) {
      return true; // leave anything we don't understand untouched
    }
    if (trace.standing) {
      return true; // STANDING residue/mark — exempt from every death fate
    }
    if (isTraceSourceDead(run, trace) || traceReachedExpiry(trace, now)) {
      if (isString(trace.id)) {
        removed.push(trace.id);
      }
      return false;
    }
    return true;
  });
  return removed;
}

// ── SEEDING (loader) ─────────────────────────────────────────────────────────
// Turn a scenario POI's authored `traceSeeds` rows into committed traces. Called
// by the scenario loader after all locations are minted (so path endpoints
// exist). Ages are authored relative to run-start ("this trail is 90 min old"),
// stamped against the committed run-start minute so decay is deterministic.
//   seed: { kind, source, ageMinutes?, path?, standing?, standingBand?, meta? }
export function seedEssenceTracesFromScenario(run, scenario, { resolveLocationRef = (x) => x } = {}) {
  if (!isPlainObject(run) || !isPlainObject(scenario) || !isPlainObject(scenario.locations)) {
    return ensureEssenceTraces(run);
  }
  const traces = ensureEssenceTraces(run);
  const nowMinutes = currentWorldMinutes(run);
  for (const [locRef, loc] of Object.entries(scenario.locations)) {
    if (!isPlainObject(loc) || !Array.isArray(loc.traceSeeds)) {
      continue;
    }
    const locationId = resolveLocationRef(locRef);
    if (!isString(locationId) || !run.locations?.[locationId]) {
      continue;
    }
    loc.traceSeeds.forEach((seed, idx) => {
      if (!isPlainObject(seed)) {
        return;
      }
      const id = isString(seed.id) ? seed.id : `trace_${locationId}_${idx}`;
      const standing = Boolean(seed.standing);
      const age = isFiniteNumber(seed.ageMinutes) ? seed.ageMinutes : 0;
      const path = Array.isArray(seed.path) ? seed.path.map(resolveLocationRef).filter(isString) : [];
      upsertTrace(run, makeTrace({
        id,
        kind: seed.kind,
        source: seed.source,
        locationId,
        path,
        // Born `ageMinutes` BEFORE the run began → decays forward from run-start.
        bornMinutes: standing ? nowMinutes : nowMinutes - age,
        standing,
        standingBand: seed.standingBand || null,
        meta: seed.meta
      }));
    });
  }
  return traces;
}

// ── NARRATOR CONTRACT ─────────────────────────────────────────────────────────
// The committed traces at the scene ride the prompt as SIGHT-FACTS with an
// explicit perception register: ONLY the MC perceives them; NPCs cannot see or
// discuss them as visible things. And a hard ban on inventing traces — the sight
// is quiet unless a trace is listed. Returns "" when there is nothing to say.
export function buildEssenceTraceDirective(run) {
  const locationId = run?.currentLocationId || null;
  if (!locationId) {
    return "";
  }
  const traces = tracesAtLocation(run, locationId);
  if (!traces.length) {
    // Quiet sight is still a committed fact — the ban keeps the narrator from
    // inventing a trail where the WINDOW shows none.
    return " ESSENCE-SIGHT (committed, player-perception only): the champion's sight reads NO essence trace here. Do NOT describe any trail, residue, or handler-scent as visible; invent none.";
  }
  const lines = traces.map((t) => {
    const dir = t.followable ? (t.direction ? ` leading toward ${t.direction}` : " leading onward, out of this place") : "";
    const scent = isString(t.meta?.handlerScent) ? ` carrying a handler-scent (${t.meta.handlerScent})` : "";
    return `a ${t.bandWord.toLowerCase()} ${t.kindWord.toLowerCase()}${dir}${scent}`;
  });
  return (
    " ESSENCE-SIGHT SIGHT-FACTS (committed world-state, the champion's unique trait; describe these, invent no others): " +
    `the WINDOW reads ${lines.join("; ")}. ` +
    "PERCEPTION REGISTER: ONLY the champion perceives essence. No NPC can see, point at, smell, or discuss a trace as a visible thing; it is theirs alone. " +
    "Describe ONLY the traces listed here; never invent a trail, residue, or scent the WINDOW does not show."
  );
}

// ── AUDITOR (never-invents guard) ─────────────────────────────────────────────
// Conservative strip-guard: the narrator must not assert a FRESH/NEW essence
// trail (or residue/handler-scent) at a location that has NO committed trace.
// When a committed trace exists here, the narrator is DESCRIBING it — allowed.
// Only fires on the clear invention pattern; mirrors the found-object auditor's
// sentence scan + committed-token allow-list, but strips (server-owned) rather
// than commits. Returns { text, stripped: [...] }.
const TRACE_INVENTION_RE = /\b(?:a\s+)?(?:fresh|bright|new|faint|glowing|shimmering|recent)?\s*(?:essence[- ]?trail|essence[- ]?trace|essence[- ]?residue|handler[- ]?scent|demon[- ]?essence)\b[^.!?]*(?:lead|trail|glow|shimmer|linger|snak|wind|run|head|point)[^.!?]*[.!?]/gi;

export function auditNarratedEssenceTraces(run, narrationText) {
  const text = typeof narrationText === "string" ? narrationText : "";
  if (!text) {
    return { text, stripped: [] };
  }
  const locationId = run?.currentLocationId || null;
  const committed = locationId ? tracesAtLocation(run, locationId) : [];
  // If the WINDOW shows a trace here, trace-prose is the narrator describing
  // committed state — permitted, strip nothing.
  if (committed.length > 0) {
    return { text, stripped: [] };
  }
  const stripped = [];
  const cleaned = text.replace(TRACE_INVENTION_RE, (match) => {
    stripped.push(match.trim());
    return "";
  });
  if (!stripped.length) {
    return { text, stripped: [] };
  }
  const tidied = cleaned.replace(/\s{2,}/g, " ").replace(/\s+([.!?])/g, "$1").trim();
  return { text: tidied, stripped };
}
