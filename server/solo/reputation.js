// ---------------------------------------------------------------------------
// REPUTATION ENGINE (v1) — factions + individuals, tiered, preference-weighted.
//
// The server owns standing; the narrator only reads it. This is the romance
// foundation and the "where do I stand" spine. It generalizes the B2 social
// meters (relationships.js) into a running, tiered AFFINITY per individual and a
// per-world FACTION STANDING, both moved ONLY by resolver outcomes (never narrator
// inference). Design sources, owner-cited: Caves of Qud (per-faction standing +
// inter-faction ripple), enjoy-AI (romance gated by affection tier), Stardew Valley
// (per-target preference weights).
//
// PLACEMENT (deliberate): a person's intrinsic reputation traits — preferences,
// romanceable, factionId — live ON THE NPC (what THIS person values, independent of
// the player). The running relationship STATE — affinity, tier, romanceTier — lives
// on the player→NPC relationship record (relationships.js), extending B2. This
// module is pure/relationship-free math + the faction engine; relationships.js
// imports it (no cycle) and owns ensureRelationship / the commit call sites.
//
// COHERENCE (the invariants):
//  * Deltas commit from RESOLVER OUTCOMES only (social wins, gifts, quest/thread
//    resolutions, explicit witnessed acts). No prose inference.
//  * TIERS ARE DATA (economy-law Law 6): one owner-tunable thresholds table each,
//    names/thresholds PLACEHOLDER. Nothing hardcodes a tier boundary inline.
//  * VISIBILITY IS KNOWLEDGE: a standing is committed whether or not the player has
//    met the NPC / heard of the faction; the payload only SURFACES known ones.
//  * SFW WALL: romance register is warm/emotional/fade-to-black at most; explicit
//    is banned at EVERY tier (Forbidden Mode is a separate future lane).
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function hashSeed(value) {
  let hash = 0;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(hash);
}
function clampInt(n, min, max) {
  const v = Number.isFinite(n) ? Math.round(n) : 0;
  return Math.max(min, Math.min(max, v));
}

// Aggregate score ranges (wider than a single B2 meter, which is [-50,50]).
export const AFFINITY_MIN = -100;
export const AFFINITY_MAX = 100;
export const STANDING_MIN = -100;
export const STANDING_MAX = 100;
export const clampAffinity = (n) => clampInt(n, AFFINITY_MIN, AFFINITY_MAX);
export const clampStanding = (n) => clampInt(n, STANDING_MIN, STANDING_MAX);

// ── TIER TABLES (owner-tunable DATA — thresholds are placeholders) ────────────
// Each table is ascending by `min`; tierFor returns the highest tier whose min the
// value meets. Owner tunes names/thresholds later without touching logic.
export const INDIVIDUAL_TIERS = [
  { tier: "hostile", min: -100 },
  { tier: "wary", min: -10 },
  { tier: "neutral", min: 0 },
  { tier: "warm", min: 10 },
  { tier: "trusted", min: 25 },
  { tier: "devoted", min: 45 }
];
export const FACTION_TIERS = [
  { tier: "hated", min: -100 },
  { tier: "unwelcome", min: -20 },
  { tier: "neutral", min: 0 },
  { tier: "respected", min: 20 },
  { tier: "honored", min: 45 }
];
// Romance tiers gate on the AFFECTION axis specifically (B2 meter, [-50,50]).
export const ROMANCE_TIERS = [
  { tier: "stranger", min: -50 },
  { tier: "friendly", min: 8 },
  { tier: "close", min: 20 },
  { tier: "courting", min: 32 },
  { tier: "partner", min: 44 }
];

export function tierFor(value, table) {
  const v = Number.isFinite(value) ? value : 0;
  const rows = Array.isArray(table) ? table : [];
  let name = rows.length ? rows[0].tier : "neutral";
  for (const row of rows) {
    if (v >= row.min) name = row.tier;
    else break;
  }
  return name;
}
export const tierForAffinity = (affinity) => tierFor(affinity, INDIVIDUAL_TIERS);
export const factionTierForStanding = (standing) => tierFor(standing, FACTION_TIERS);
export const romanceTierForAffection = (affection) => tierFor(affection, ROMANCE_TIERS);

// Rank of a romance tier (0-based) — for gating "is register X allowed at tier T".
export function romanceTierRank(tier) {
  const i = ROMANCE_TIERS.findIndex((r) => r.tier === tier);
  return i < 0 ? 0 : i;
}

// ── PREFERENCE WEIGHTING (Stardew law) ────────────────────────────────────────
// weight = sum of the target's preference weights for the tags an action carries;
// 1 (neutral base) when the action touches none of their preferences — so an
// untagged gift still lands its base delta, a loved-tag gift amplifies, a
// hated-tag (negative weight) gift inverts to an insult.
export function preferenceWeight(preferences, tags) {
  const prefs = Array.isArray(preferences) ? preferences : [];
  const tagSet = new Set((Array.isArray(tags) ? tags : []).map((t) => String(t).toLowerCase()).filter(Boolean));
  if (!tagSet.size) return 1;
  let sum = 0;
  let matched = false;
  for (const p of prefs) {
    if (isPlainObject(p) && tagSet.has(String(p.tag).toLowerCase())) {
      sum += Number(p.weight) || 0;
      matched = true;
    }
  }
  return matched ? sum : 1;
}
export function computeWeightedDelta(preferences, tags, baseDelta) {
  const base = Number.isFinite(baseDelta) ? baseDelta : 0;
  return Math.round(base * preferenceWeight(preferences, tags));
}

// ── INDIVIDUAL AFFINITY (operates on a rel + npc; pure, no ensureRelationship) ─
// The single writer of rel.affinity/tier/romanceTier — relationships.js calls this
// after resolving the relationship record, for both social wins and gifts.
export function aggregateAffinityFromMeters(meters) {
  if (!isPlainObject(meters)) return 0;
  const trust = Number(meters.trust) || 0;
  const affection = Number(meters.affection) || 0;
  return clampAffinity(trust + affection);
}
export function recomputeIndividualTiers(rel, npc) {
  if (!isPlainObject(rel)) return;
  if (!Number.isFinite(rel.affinity)) rel.affinity = aggregateAffinityFromMeters(rel.meters);
  rel.tier = tierForAffinity(rel.affinity);
  rel.romanceTier = isRomanceEligible(npc) ? romanceTierForAffection(rel.meters?.affection ?? 0) : null;
}
export function applyAffinityToRelationship(rel, npc, baseDelta, tags = []) {
  if (!isPlainObject(rel)) return null;
  const prefs = Array.isArray(npc?.preferences) ? npc.preferences : [];
  const weight = preferenceWeight(prefs, tags);
  const delta = Math.round((Number.isFinite(baseDelta) ? baseDelta : 0) * weight);
  const before = Number.isFinite(rel.affinity) ? rel.affinity : aggregateAffinityFromMeters(rel.meters);
  rel.affinity = clampAffinity(before + delta);
  recomputeIndividualTiers(rel, npc);
  return { delta, weight, before, after: rel.affinity, tier: rel.tier, romanceTier: rel.romanceTier };
}

// The join view (npc-intrinsic + relationship-state) the payload/grounding read.
export function individualReputation(run, npcId) {
  const npc = run?.npcs?.[npcId];
  if (!isPlainObject(npc)) return null;
  const rel = Object.values(run?.relationships || {}).find(
    (r) => isPlainObject(r) && r.sourceEntityId === "player" && r.targetEntityId === npcId
  );
  const affinity = rel && Number.isFinite(rel.affinity) ? rel.affinity : aggregateAffinityFromMeters(rel?.meters);
  return {
    npcId,
    name: npc.generatedName || npc.displayName || npc.role || npcId,
    affinity,
    tier: tierForAffinity(affinity),
    preferences: Array.isArray(npc.preferences) ? npc.preferences : [],
    romanceable: isRomanceEligible(npc),
    romanceTier: isRomanceEligible(npc) ? romanceTierForAffection(rel?.meters?.affection ?? 0) : null,
    factionId: isString(npc.factionId) ? npc.factionId : null,
    // VISIBILITY: a tier is knowledge — surfaced only once the NPC is met/known.
    met: npc.known === true || npc.met === true || Boolean(rel)
  };
}

// ── MIGRATION (B2 relationships → reputation) ─────────────────────────────────
// Backfills affinity (aggregated from committed trust+affection) + tiers onto every
// existing relationship WITHOUT discarding any B2 meter. Idempotent.
export function migrateRelationshipReputation(rel, npc) {
  if (!isPlainObject(rel)) return rel;
  if (!Number.isFinite(rel.affinity)) rel.affinity = aggregateAffinityFromMeters(rel.meters);
  recomputeIndividualTiers(rel, npc);
  return rel;
}
export function migrateReputation(run) {
  if (!isPlainObject(run) || !isPlainObject(run.relationships)) return { migrated: 0 };
  let migrated = 0;
  for (const rel of Object.values(run.relationships)) {
    if (!isPlainObject(rel) || rel.sourceEntityId !== "player") continue;
    if (!Number.isFinite(rel.affinity)) migrated += 1;
    migrateRelationshipReputation(rel, run.npcs?.[rel.targetEntityId]);
  }
  return { migrated };
}

// ── FACTIONS (Qud law) ────────────────────────────────────────────────────────
export function ensureFaction(run, factionId, seed = {}) {
  if (!isPlainObject(run.factions)) run.factions = {};
  if (!isPlainObject(run.factions[factionId])) {
    run.factions[factionId] = {
      factionId,
      name: isString(seed.name) ? seed.name : factionId,
      standing: Number.isFinite(seed.standing) ? clampStanding(seed.standing) : 0,
      tier: factionTierForStanding(Number.isFinite(seed.standing) ? seed.standing : 0),
      preferences: Array.isArray(seed.preferences) ? seed.preferences : [],
      relations: Array.isArray(seed.relations) ? seed.relations : [],
      discovered: seed.discovered === true,
      flags: {}
    };
  }
  return run.factions[factionId];
}

export function factionReputation(run, factionId) {
  const f = run?.factions?.[factionId];
  if (!isPlainObject(f)) return null;
  return {
    factionId,
    name: f.name || factionId,
    standing: Number(f.standing) || 0,
    tier: factionTierForStanding(Number(f.standing) || 0),
    preferences: Array.isArray(f.preferences) ? f.preferences : [],
    discovered: f.discovered === true
  };
}

// Apply a standing delta to ONE faction, then RIPPLE it one hop through that
// faction's relations modifiers (Qud) — related factions move by modifier×delta,
// but their OWN relations do NOT re-fire (no cascade). Same transaction. Returns
// the applied changes { primary, ripples: [...] }.
export function applyFactionStanding(run, factionId, delta, options = {}) {
  if (!isPlainObject(run) || !isString(factionId)) return null;
  const base = Number.isFinite(delta) ? delta : 0;
  if (base === 0) return null;
  const faction = ensureFaction(run, factionId);
  // preference weighting (a faction values acts too), when tags are supplied
  const weighted = Array.isArray(options.tags) && options.tags.length
    ? computeWeightedDelta(faction.preferences, options.tags, base)
    : base;
  const primaryBefore = Number(faction.standing) || 0;
  faction.standing = clampStanding(primaryBefore + weighted);
  faction.tier = factionTierForStanding(faction.standing);
  const primary = { factionId, delta: weighted, before: primaryBefore, after: faction.standing, tier: faction.tier };

  const ripples = [];
  for (const rel of Array.isArray(faction.relations) ? faction.relations : []) {
    if (!isPlainObject(rel) || !isString(rel.factionId) || rel.factionId === factionId) continue;
    const mod = Number(rel.modifier);
    if (!Number.isFinite(mod) || mod === 0) continue;
    const rippleDelta = Math.round(weighted * mod);
    if (rippleDelta === 0) continue;
    const other = ensureFaction(run, rel.factionId);
    const before = Number(other.standing) || 0;
    other.standing = clampStanding(before + rippleDelta); // ONE HOP — no further ripple
    other.tier = factionTierForStanding(other.standing);
    ripples.push({ factionId: rel.factionId, delta: rippleDelta, before, after: other.standing, tier: other.tier });
  }
  return { primary, ripples };
}

// ── reputationEffects (quest/thread resolution → standing) ────────────────────
// effects: [{ target, delta, tags? }] — target auto-resolves to a faction (ripples)
// or, failing that, an individual (affinity). Server-committed only.
export function applyReputationEffects(run, effects, options = {}) {
  const applied = [];
  for (const e of Array.isArray(effects) ? effects : []) {
    if (!isPlainObject(e) || !isString(e.target) || !Number.isFinite(e.delta)) continue;
    if (isPlainObject(run.factions?.[e.target])) {
      const r = applyFactionStanding(run, e.target, e.delta, { tags: e.tags });
      if (r) applied.push({ kind: "faction", ...r });
    } else if (isPlainObject(run.npcs?.[e.target])) {
      const rel = Object.values(run.relationships || {}).find(
        (r) => isPlainObject(r) && r.sourceEntityId === "player" && r.targetEntityId === e.target
      );
      if (rel) {
        const r = applyAffinityToRelationship(rel, run.npcs[e.target], e.delta, e.tags);
        if (r) applied.push({ kind: "individual", npcId: e.target, ...r });
      }
    }
  }
  return applied;
}

// ── SEEDING (worldgen) ────────────────────────────────────────────────────────
// A palette of placeholder factions an author would otherwise supply as JSON. Kept
// generic (no world-flavor bleed); the owner/author replaces per world.
const SEED_FACTION_POOL = [
  { factionId: "faction_charter", name: "The Charter", preferences: [{ tag: "law", weight: 3 }, { tag: "violence", weight: -2 }, { tag: "honesty", weight: 2 }] },
  { factionId: "faction_underground", name: "The Undercurrent", preferences: [{ tag: "smuggling", weight: 3 }, { tag: "law", weight: -2 }, { tag: "coin", weight: 2 }] },
  { factionId: "faction_temple", name: "The Ashen Temple", preferences: [{ tag: "piety", weight: 3 }, { tag: "charity", weight: 2 }, { tag: "desecration", weight: -3 }] },
  { factionId: "faction_guild", name: "The Craftguild", preferences: [{ tag: "craft", weight: 3 }, { tag: "rare-herb", weight: 2 }, { tag: "theft", weight: -2 }] }
];
// A conventional relations web (rivalries/alliances) applied by index within the
// seeded slice — one hop each; the ripple test exercises this shape.
const SEED_FACTION_RELATIONS = {
  faction_charter: [{ factionId: "faction_underground", modifier: -0.5 }, { factionId: "faction_temple", modifier: 0.3 }],
  faction_underground: [{ factionId: "faction_charter", modifier: -0.5 }],
  faction_temple: [{ factionId: "faction_charter", modifier: 0.3 }],
  faction_guild: [{ factionId: "faction_charter", modifier: 0.2 }]
};

export function seedFactions(run, options = {}) {
  if (!isPlainObject(run) || Object.keys(run.factions || {}).length) return { seeded: [] };
  const seed = hashSeed(`${run.worldSeed || run.runId}|factions`);
  const count = 2 + (seed % 3); // deterministic 2-4
  const chosen = [];
  for (let i = 0; i < count && i < SEED_FACTION_POOL.length; i += 1) {
    chosen.push(SEED_FACTION_POOL[(seed + i) % SEED_FACTION_POOL.length]);
  }
  const seededIds = new Set(chosen.map((f) => f.factionId));
  for (const f of chosen) {
    // relations pruned to co-seeded factions (a modifier to an absent faction is inert).
    const relations = (SEED_FACTION_RELATIONS[f.factionId] || []).filter((r) => seededIds.has(r.factionId));
    ensureFaction(run, f.factionId, { name: f.name, preferences: f.preferences, relations, standing: 0 });
  }
  return { seeded: [...seededIds] };
}

// Authored worlds supply factions as JSON (same authorability law as threads).
export function loadFactionsFromJson(run, factions, options = {}) {
  if (!isPlainObject(run) || !Array.isArray(factions) || !factions.length) return { loaded: [] };
  const loaded = [];
  const ids = new Set(factions.map((f) => f?.factionId).filter(isString));
  for (const f of factions) {
    if (!isPlainObject(f) || !isString(f.factionId)) continue;
    const relations = (Array.isArray(f.relations) ? f.relations : []).filter((r) => isPlainObject(r) && ids.has(r.factionId));
    ensureFaction(run, f.factionId, {
      name: f.name,
      preferences: Array.isArray(f.preferences) ? f.preferences : [],
      relations,
      standing: Number.isFinite(f.standing) ? f.standing : 0,
      discovered: f.discovered === true
    });
    loaded.push(f.factionId);
  }
  return { loaded };
}

// ── THE ROMANCE AGE WALL (law R2 — minors: absolute, architectural, no override) ─
// FAIL-CLOSED: romance eligibility requires an AFFIRMATIVE adult age-class. Missing
// or unknown age data is NOT adult — the wall never depends on a "minor" flag that
// something has to remember to set. Every romance enforcement point routes through
// isRomanceEligible, so even a stray romanceable:true can never bypass age.
export const ADULT_AGE_CLASS = "adult";
// STAMP-time normalization at NPC creation: procedurally minted cast defaults to
// adult (worlds mint adult casts; child NPCs exist only where world data
// affirmatively creates them). An explicit age-class (e.g. "child") is preserved.
export function normalizeAgeClass(value) {
  return (typeof value === "string" && value.trim()) ? value.trim().toLowerCase() : ADULT_AGE_CLASS;
}
// ENFORCEMENT-time predicate: strict — only the affirmative adult class passes.
export function isAdult(npc) {
  return isPlainObject(npc) && npc.ageClass === ADULT_AGE_CLASS;
}
// The single romance gate. Age is absolute and checked FIRST; the romanceable flag
// only matters once adulthood is affirmed.
export function isRomanceEligible(npc) {
  return isAdult(npc) && npc.romanceable === true;
}
// Default romanceable at mint (law R2): every ADULT NPC is romanceable unless a
// world-book/authored sheet opts out (romanceable:false) or the role is excluded
// (romance-excluded / no-romance tag). Non-adults are never romanceable — fail-closed.
export function romanceableDefault(npc) {
  if (!isAdult(npc)) return false; // FAIL-CLOSED: affirmative adult age-class required
  if (npc.romanceable === false) return false; // explicit world-book / authored opt-out
  const tags = Array.isArray(npc.tags) ? npc.tags : [];
  if (tags.includes("romance-excluded") || tags.includes("no-romance")) return false; // world-book-excluded role
  return true;
}

// Mint per-NPC reputation traits (preferences + faction membership + romanceable)
// deterministically for NPCs that lack them. romanceable defaults per law R2 (see
// romanceableDefault). Authored NPCs carry their own; this only fills gaps for
// worldgen/procedural NPCs.
const NPC_PREFERENCE_TAGS = ["coin", "honesty", "craft", "rare-herb", "law", "piety", "violence", "charity", "smuggling"];
export function mintNpcReputation(run, options = {}) {
  if (!isPlainObject(run) || !isPlainObject(run.npcs)) return { minted: [] };
  const factionIds = Object.keys(run.factions || {});
  const minted = [];
  for (const npc of Object.values(run.npcs)) {
    if (!isPlainObject(npc) || Array.isArray(npc.preferences)) continue; // already minted/authored
    const seed = hashSeed(`${run.worldSeed || run.runId}|npc-rep|${npc.npcId}`);
    const nPrefs = 1 + (seed % 3); // 1-3 tags
    const prefs = [];
    const used = new Set();
    for (let i = 0; i < nPrefs; i += 1) {
      const tag = NPC_PREFERENCE_TAGS[(seed + i * 7) % NPC_PREFERENCE_TAGS.length];
      if (used.has(tag)) continue;
      used.add(tag);
      const weight = ((seed >> (i + 1)) % 2 === 0) ? 2 : -2; // liked or disliked
      prefs.push({ tag, weight });
    }
    npc.preferences = prefs;
    // faction membership: nullable — ~half of NPCs unaffiliated.
    npc.factionId = factionIds.length && seed % 2 === 0 ? factionIds[seed % factionIds.length] : null;
    // age-class: procedural cast defaults adult (stamped so the wall always has
    // data); romanceable then defaults per law R2, fail-closed on age.
    npc.ageClass = normalizeAgeClass(npc.ageClass);
    npc.romanceable = romanceableDefault(npc);
    minted.push(npc.npcId);
  }
  return { minted };
}

// ── ROMANCE / SFW AUDITOR ─────────────────────────────────────────────────────
// EXPLICIT is banned at EVERY tier (the SFW wall). Romantic-PHYSICAL register
// (kiss/embrace/…) is only lawful once a present romanceable NPC has reached the
// "courting" tier. Below that, physical romance narrated with a romanceable present
// NPC is a register violation — same severity family as narrated-state drift.
const EXPLICIT_RES = [
  /\b(sex|sexual|orgasm|arousal|aroused|nipple|genital|thrust(?:ing|s)?|penetrat\w*|naked bod|undress\w*|make love|making love|in bed together|climax(?:ed|ing)?)\b/i
];
const ROMANTIC_PHYSICAL_RES = [
  /\b(kiss(?:es|ed|ing)?|embrace(?:s|d)?|caress\w*|passionate\w*|lover'?s?\b|press(?:es|ed)? (?:their|her|his) lips|pull\w* (?:you|them) close(?:r)?|share a bed|tangle(?:d)? together|hold\w* (?:you|them) close)\b/i
];

// The highest romanceTier among present romanceable NPCs (the permissive ceiling).
export function romanceCeilingForRun(run) {
  if (!isPlainObject(run) || !isPlainObject(run.npcs)) return { tier: null, rank: -1, npcId: null };
  const here = run.currentLocationId;
  let best = { tier: null, rank: -1, npcId: null };
  for (const npc of Object.values(run.npcs)) {
    if (!isRomanceEligible(npc)) continue; // R10 register ceiling — age wall bites here too
    if (npc.currentLocationId !== here || npc.status === "gone") continue;
    const rel = Object.values(run.relationships || {}).find(
      (r) => isPlainObject(r) && r.sourceEntityId === "player" && r.targetEntityId === npc.npcId
    );
    const tier = romanceTierForAffection(rel?.meters?.affection ?? 0);
    const rank = romanceTierRank(tier);
    if (rank > best.rank) best = { tier, rank, npcId: npc.npcId };
  }
  return best;
}

const COURTING_RANK = romanceTierRank("courting");

export function detectRomanceRegisterViolations(narrationText, run) {
  const text = String(narrationText || "");
  if (!text.trim()) return [];
  const out = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  const ceiling = romanceCeilingForRun(run);
  for (const sentence of sentences) {
    // (a) EXPLICIT — banned at every tier, referent or not.
    let flagged = false;
    for (const re of EXPLICIT_RES) {
      if (re.test(sentence)) {
        out.push({ kind: "explicit", phrase: (re.exec(sentence) || [""])[0].slice(0, 60), sentence: sentence.trim().slice(0, 160) });
        flagged = true;
        break;
      }
    }
    if (flagged) continue;
    // (b) ROMANTIC-PHYSICAL — only lawful at/above "courting" with a present
    // romanceable NPC. Below that ceiling → register violation.
    if (ceiling.rank < COURTING_RANK) {
      for (const re of ROMANTIC_PHYSICAL_RES) {
        if (re.test(sentence)) {
          out.push({
            kind: "over-tier",
            tier: ceiling.tier || "none",
            phrase: (re.exec(sentence) || [""])[0].slice(0, 60),
            sentence: sentence.trim().slice(0, 160)
          });
          break;
        }
      }
    }
  }
  return out;
}
