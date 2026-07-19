// THE BESTIARY — server-authored enemy stat blocks (D.4 §5.1, combat Phase 1).
//
// Enemies exist ONLY as rows here. This is the resolution target for the
// `statBlockId` string contract (D.4 Phase 0 §3.4): both the combat resolver
// (server/solo/combat.js) and the D.5 thread `hostileNpc` beat payload carry a
// statBlockId string; `resolveStatBlock` turns it into stats. An unknown id
// resolves to null, and the caller SKIPS (a thread beat is rolled back and not
// narrated; a player attack on an unstatted NPC falls to the `civilian` default)
// — a hostile is never narrated that the bestiary did not commit (coherence
// leak #3/#9). No LLM ever mints an enemy: the model is never asked.
//
// VERTICAL-SLICE SCOPE (reconciled spine §C2): the one built/reachable enemy is
// `waylayer` — the reeve's collector the `the_shipment` danger thread places.
// `civilian` is the default block for the grounding-safety case (a player
// attacking any unstatted cast NPC — D.4 §2.2(1)). The rest of the D.4 §5.2
// starter bestiary (carrion_hound/ruin_creeper/hollow_husk) is deliberately NOT
// built here — it is gated on the grade.

// Numbers are 5e-plausible for a level-1 character (max HP ~9-13, AC 10-13):
// winnable, genuinely lethal on bad dice — matching the validated gate/failure
// spine. `dexMod` feeds initiative; `attacks[].toHit`/`damage` feed the resolver;
// `intents` are the telegraphed, weighted per-round choices (seeded selection).
const STAT_BLOCKS = Object.freeze({
  waylayer: Object.freeze({
    statBlockId: "waylayer",
    name: "The reeve's collector",
    tier: 1,
    maxHp: 12,
    ac: 13,
    dexMod: 1,
    xp: 60,
    attacks: Object.freeze([
      { attackId: "cudgel", toHit: 3, damage: "1d6+2", damageType: "bludgeoning" }
    ]),
    // Telegraphed by default (D.4 §2.3): every round the server picks one intent,
    // seeded-deterministic, and its telegraph is a committed fact the narrator
    // speaks forward. Weighted toward pressing the attack; one bracing beat.
    intents: Object.freeze([
      { intentId: "strike", kind: "attack", attackId: "cudgel", weight: 3, telegraph: "hefts a length of pipe, watching your hands", hidden: false },
      { intentId: "crowd", kind: "attack", attackId: "cudgel", weight: 2, telegraph: "steps in, crowding you toward the wall", hidden: false },
      { intentId: "brace", kind: "defend", weight: 1, telegraph: "sets his feet and raises a guard", hidden: false }
    ]),
    behaviors: Object.freeze({ vicious: false, cowardly: false }),
    loot: Object.freeze([{ itemId: "toll_scrip", name: "Sector Toll-Scrip", chance: 0.5 }]),
    tags: Object.freeze(["human", "enforcer"])
  }),

  // The default block for any unstatted cast NPC the player chooses to attack
  // (the lethal game; attacking anyone is allowed). Weak, flees at first blood in
  // spirit — but morale is off in Phase 1, so it simply fights poorly.
  civilian: Object.freeze({
    statBlockId: "civilian",
    name: "Bystander",
    tier: 0,
    maxHp: 6,
    ac: 10,
    dexMod: 0,
    xp: 10,
    attacks: Object.freeze([
      { attackId: "flail", toHit: 1, damage: "1d4", damageType: "bludgeoning" }
    ]),
    intents: Object.freeze([
      { intentId: "flail", kind: "attack", attackId: "flail", weight: 2, telegraph: "throws up desperate, clumsy hands", hidden: false },
      { intentId: "cower", kind: "defend", weight: 3, telegraph: "shrinks back, trying to shield themselves", hidden: false }
    ]),
    behaviors: Object.freeze({ vicious: false, cowardly: true }),
    loot: Object.freeze([]),
    tags: Object.freeze(["human", "civilian"])
  })
});

// ═══════════════════════════════════════════════════════════════════════════
// VERDANCE BESTIARY v1 — sealed docs/worlds/babel/verdance-bestiary-v1.md.
// LAW-6 OWNER-TUNABLE (verdance-region §Law-6 tunable-table convention): every
// number below is a starting value derived from the level-1-region chassis
// (waylayer hp12/ac13; civilian hp6/ac10) — winnable, lethal on bad dice. Retune
// any cell freely; the shape is the contract, the numbers are not.
// ═══════════════════════════════════════════════════════════════════════════

// (1) BASE ANIMALS — tier-1 wildlife chassis. kind:"wildlife". Combat-resolvable
// rows like any other stat block. Numbers scale by real danger: a black bear is
// the apex, a raven barely fights. Law-6 tunable.
const BASE_ANIMALS = Object.freeze({
  black_bear: Object.freeze({ statBlockId: "black_bear", name: "Black bear", kind: "wildlife", tier: 1, maxHp: 19, ac: 12, dexMod: 1, xp: 100,
    attacks: Object.freeze([{ attackId: "claw", toHit: 4, damage: "1d6+3", damageType: "slashing" }, { attackId: "bite", toHit: 4, damage: "1d8+3", damageType: "piercing" }]),
    intents: Object.freeze([{ intentId: "maul", kind: "attack", attackId: "claw", weight: 3, telegraph: "rears up, huge and unhurried", hidden: false }, { intentId: "bite", kind: "attack", attackId: "bite", weight: 2, telegraph: "drops to all fours and lunges", hidden: false }]),
    behaviors: Object.freeze({ vicious: true, cowardly: false }), loot: Object.freeze([]), tags: Object.freeze(["wildlife", "bear"]) }),
  mountain_lion: Object.freeze({ statBlockId: "mountain_lion", name: "Mountain lion", kind: "wildlife", tier: 1, maxHp: 13, ac: 13, dexMod: 3, xp: 75,
    attacks: Object.freeze([{ attackId: "pounce", toHit: 5, damage: "1d6+3", damageType: "slashing" }]),
    intents: Object.freeze([{ intentId: "pounce", kind: "attack", attackId: "pounce", weight: 3, telegraph: "coils low, eyes fixed on your throat", hidden: false }, { intentId: "circle", kind: "defend", weight: 1, telegraph: "melts a step into the ferns, circling", hidden: false }]),
    behaviors: Object.freeze({ vicious: true, cowardly: false }), loot: Object.freeze([]), tags: Object.freeze(["wildlife", "cat"]) }),
  grey_wolf: Object.freeze({ statBlockId: "grey_wolf", name: "Grey wolf", kind: "wildlife", tier: 1, maxHp: 11, ac: 13, dexMod: 2, xp: 50,
    attacks: Object.freeze([{ attackId: "bite", toHit: 4, damage: "1d6+2", damageType: "piercing" }]),
    intents: Object.freeze([{ intentId: "bite", kind: "attack", attackId: "bite", weight: 3, telegraph: "bares its teeth, hackles up", hidden: false }, { intentId: "flank", kind: "defend", weight: 2, telegraph: "pads wide, looking for your blind side", hidden: false }]),
    behaviors: Object.freeze({ vicious: false, cowardly: false }), loot: Object.freeze([]), tags: Object.freeze(["wildlife", "wolf"]) }),
  roosevelt_elk: Object.freeze({ statBlockId: "roosevelt_elk", name: "Roosevelt elk", kind: "wildlife", tier: 1, maxHp: 15, ac: 11, dexMod: 0, xp: 50,
    attacks: Object.freeze([{ attackId: "gore", toHit: 4, damage: "1d8+2", damageType: "piercing" }, { attackId: "trample", toHit: 4, damage: "1d6+2", damageType: "bludgeoning" }]),
    intents: Object.freeze([{ intentId: "gore", kind: "attack", attackId: "gore", weight: 2, telegraph: "lowers a rack of antlers and stamps", hidden: false }, { intentId: "wary", kind: "defend", weight: 3, telegraph: "holds its ground, nostrils flaring", hidden: false }]),
    behaviors: Object.freeze({ vicious: false, cowardly: false }), loot: Object.freeze([]), tags: Object.freeze(["wildlife", "ungulate"]) }),
  black_tailed_deer: Object.freeze({ statBlockId: "black_tailed_deer", name: "Black-tailed deer", kind: "wildlife", tier: 1, maxHp: 7, ac: 12, dexMod: 2, xp: 15,
    attacks: Object.freeze([{ attackId: "kick", toHit: 2, damage: "1d4", damageType: "bludgeoning" }]),
    intents: Object.freeze([{ intentId: "bolt", kind: "flee", weight: 4, telegraph: "freezes, then gathers to bolt", hidden: false }, { intentId: "kick", kind: "attack", attackId: "kick", weight: 1, telegraph: "wheels and lashes out with sharp hooves", hidden: false }]),
    behaviors: Object.freeze({ vicious: false, cowardly: true }), loot: Object.freeze([]), tags: Object.freeze(["wildlife", "ungulate"]) }),
  wild_boar: Object.freeze({ statBlockId: "wild_boar", name: "Wild boar", kind: "wildlife", tier: 1, maxHp: 12, ac: 11, dexMod: 0, xp: 50,
    attacks: Object.freeze([{ attackId: "tusk", toHit: 3, damage: "1d6+1", damageType: "slashing" }]),
    intents: Object.freeze([{ intentId: "charge", kind: "attack", attackId: "tusk", weight: 4, telegraph: "squares up and charges, relentless", hidden: false }]),
    behaviors: Object.freeze({ vicious: true, cowardly: false }), loot: Object.freeze([]), tags: Object.freeze(["wildlife", "boar"]) }),
  coyote: Object.freeze({ statBlockId: "coyote", name: "Coyote", kind: "wildlife", tier: 1, maxHp: 6, ac: 12, dexMod: 2, xp: 15,
    attacks: Object.freeze([{ attackId: "bite", toHit: 3, damage: "1d4+1", damageType: "piercing" }]),
    intents: Object.freeze([{ intentId: "nip", kind: "attack", attackId: "bite", weight: 2, telegraph: "darts in for a snapping bite", hidden: false }, { intentId: "slink", kind: "flee", weight: 3, telegraph: "shrinks back, tail low", hidden: false }]),
    behaviors: Object.freeze({ vicious: false, cowardly: true }), loot: Object.freeze([]), tags: Object.freeze(["wildlife", "canid"]) }),
  rattlesnake: Object.freeze({ statBlockId: "rattlesnake", name: "Rattlesnake", kind: "wildlife", tier: 1, maxHp: 4, ac: 12, dexMod: 2, xp: 30,
    attacks: Object.freeze([{ attackId: "venom_bite", toHit: 4, damage: "1d4", damageType: "poison", rider: "venom" }]),
    intents: Object.freeze([{ intentId: "strike", kind: "attack", attackId: "venom_bite", weight: 2, telegraph: "coils, rattle buzzing a warning", hidden: false }, { intentId: "coil", kind: "defend", weight: 2, telegraph: "draws back into a tight, ready coil", hidden: false }]),
    behaviors: Object.freeze({ vicious: false, cowardly: false }), loot: Object.freeze([]), tags: Object.freeze(["wildlife", "reptile"]) }),
  raven: Object.freeze({ statBlockId: "raven", name: "Raven", kind: "wildlife", tier: 1, maxHp: 3, ac: 13, dexMod: 3, xp: 10,
    attacks: Object.freeze([{ attackId: "peck", toHit: 3, damage: "1d3", damageType: "piercing" }]),
    intents: Object.freeze([{ intentId: "harry", kind: "attack", attackId: "peck", weight: 1, telegraph: "dives, beating black wings at your eyes", hidden: false }, { intentId: "watch", kind: "defend", weight: 4, telegraph: "cocks its head, watching, it has seen something", hidden: false }]),
    behaviors: Object.freeze({ vicious: false, cowardly: true }), loot: Object.freeze([]), tags: Object.freeze(["wildlife", "bird", "omen"]) }),
  river_otter: Object.freeze({ statBlockId: "river_otter", name: "River otter", kind: "wildlife", tier: 1, maxHp: 5, ac: 12, dexMod: 3, xp: 10,
    attacks: Object.freeze([{ attackId: "bite", toHit: 2, damage: "1d4", damageType: "piercing" }]),
    intents: Object.freeze([{ intentId: "bite", kind: "attack", attackId: "bite", weight: 1, telegraph: "chitters and nips, defending its bank", hidden: false }, { intentId: "slip", kind: "flee", weight: 3, telegraph: "slides toward the water", hidden: false }]),
    behaviors: Object.freeze({ vicious: false, cowardly: true }), loot: Object.freeze([]), tags: Object.freeze(["wildlife", "mustelid"]) })
});

// (2) CHAOS SKILL TREE — DATA rows the mint engine reads. Extensible: add a row.
// low tier: chaos-pack-aura (scaling advantage), inverted-element (element × wrong
// rider mint table). high tier: charm-person, vision-share, telepathy.
const INVERTED_ELEMENT_TABLE = Object.freeze([
  Object.freeze({ element: "fire", rider: "chills" }),
  Object.freeze({ element: "frost", rider: "burns" }),
  Object.freeze({ element: "bite", rider: "chill" }),
  Object.freeze({ element: "shock", rider: "rots" }),
  Object.freeze({ element: "venom", rider: "mends" })
]);
export const CHAOS_SKILLS = Object.freeze({
  "chaos-pack-aura": Object.freeze({ skillId: "chaos-pack-aura", tier: "low", family: "aura", name: "Chaos-Pack Aura",
    effect: "scaling-advantage", desc: "Allies within reach gain advantage that scales with how many chaos-touched stand together." }),
  "inverted-element": Object.freeze({ skillId: "inverted-element", tier: "low", family: "element", name: "Inverted Element",
    effect: "element-x-wrong-rider", desc: "An elemental attack carries the WRONG rider, fire that chills, a bite that freezes.", mintTable: INVERTED_ELEMENT_TABLE }),
  "charm-person": Object.freeze({ skillId: "charm-person", tier: "high", family: "mind", name: "Charm Person",
    effect: "charm", desc: "Bends a single mind toward trust it did not earn." }),
  "vision-share": Object.freeze({ skillId: "vision-share", tier: "high", family: "mind", name: "Vision Share",
    effect: "vision-share", desc: "Pushes what it sees into another's eyes, a shared, unbidden vision." }),
  "telepathy": Object.freeze({ skillId: "telepathy", tier: "high", family: "mind", name: "Telepathy",
    effect: "telepathy", desc: "Speaks mind-to-mind, wordless, across a room or a valley." })
});

// (4) THREAT LADDER — rarity + social capability by kind (regional ruling). Law-6.
export const THREAT_LADDER = Object.freeze({
  wildlife: Object.freeze({ kind: "wildlife", rarity: "common", tier: 1, socialCapable: false }),
  bandit: Object.freeze({ kind: "bandit", rarity: "uncommon", tier: 1, socialCapable: true }), // human-tier: can be talked to
  chaosling: Object.freeze({ kind: "chaosling", rarity: "uncommon", tier: 2, socialCapable: false }),
  demon: Object.freeze({ kind: "demon", rarity: "very-rare", tier: 4, socialCapable: true })
});

// (3) CHAOSLING MINT — bounded stat boost + N chaos skills, N scales with tier.
// TIER_BUDGET caps the boost and the skill-count band per threat tier (Law-6).
export const TIER_BUDGET = Object.freeze({
  1: Object.freeze({ hpBoost: 4, acBoost: 1, skillsMin: 0, skillsMax: 1, highTier: false }),
  2: Object.freeze({ hpBoost: 8, acBoost: 2, skillsMin: 1, skillsMax: 2, highTier: false }),
  3: Object.freeze({ hpBoost: 14, acBoost: 3, skillsMin: 2, skillsMax: 3, highTier: true }),
  4: Object.freeze({ hpBoost: 22, acBoost: 4, skillsMin: 3, skillsMax: 4, highTier: true })
});
function clampTier(t) { const n = Math.trunc(Number(t) || 1); return Math.min(4, Math.max(1, n)); }
// Deterministic djb2 hash (matches the seed util used across the solo engine).
function hashSeed(value) { let h = 0; const s = String(value == null ? "" : value); for (let i = 0; i < s.length; i += 1) { h = (h * 31 + s.charCodeAt(i)) | 0; } return Math.abs(h); }

/**
 * Roll 1..N chaos skills for a threat tier — DETERMINISTIC from seed. Count is
 * bounded by TIER_BUDGET[tier] {skillsMin,skillsMax}; high-tier skills unlock only
 * when the tier's budget allows (highTier). Returns distinct skillIds. Pure.
 */
export function rollChaosSkills(threatTier, seed) {
  const tier = clampTier(threatTier);
  const budget = TIER_BUDGET[tier];
  const pool = Object.values(CHAOS_SKILLS).filter((s) => budget.highTier || s.tier === "low").map((s) => s.skillId);
  const span = budget.skillsMax - budget.skillsMin + 1;
  const count = Math.min(pool.length, budget.skillsMin + (hashSeed(`${seed}|count`) % span));
  // Deterministic distinct pick: sort the pool by a per-skill hash of the seed, take count.
  const ordered = [...pool].sort((a, b) => hashSeed(`${seed}|${a}`) - hashSeed(`${seed}|${b}`));
  return ordered.slice(0, count);
}

/**
 * Mint a chaosling stat block from a base animal — DETERMINISTIC per (base,tier,seed).
 * = base animal + bounded stat boost (<= TIER_BUDGET) + rolled chaos skills. The
 * carried skills are essence-sight-readable (sightReadable flag). Returns a frozen
 * block, or null if the base is not a known wildlife chassis. Pure.
 */
export function mintChaosling(baseAnimalId, threatTier, seed) {
  const base = BASE_ANIMALS[baseAnimalId];
  if (!base) return null;
  const tier = clampTier(threatTier);
  const budget = TIER_BUDGET[tier];
  const h = hashSeed(`chaosling|${baseAnimalId}|${tier}|${seed}`);
  const hpBoost = h % (budget.hpBoost + 1);
  const acBoost = Math.trunc(h / 7) % (budget.acBoost + 1);
  const skillIds = rollChaosSkills(tier, `${seed}|${baseAnimalId}`);
  const carriedSkills = Object.freeze(skillIds.map((id) => {
    const skill = CHAOS_SKILLS[id];
    if (skill.family === "element") {
      const row = skill.mintTable[hashSeed(`${seed}|${baseAnimalId}|${id}`) % skill.mintTable.length];
      return Object.freeze({ skillId: id, name: skill.name, tier: skill.tier, mint: row });
    }
    return Object.freeze({ skillId: id, name: skill.name, tier: skill.tier });
  }));
  return Object.freeze({
    statBlockId: `chaosling_${baseAnimalId}_${seed}`,
    name: `Chaos-${base.name.toLowerCase()}`,
    kind: "chaosling",
    tier,
    baseAnimalId,
    maxHp: base.maxHp + hpBoost,
    ac: base.ac + acBoost,
    dexMod: base.dexMod,
    xp: base.xp + tier * 25,
    attacks: base.attacks,
    // A rolled active mind-skill (charm) becomes a usable combat intent; passives
    // (vision-share, telepathy) are read elsewhere, no intent needed.
    intents: skillIds.includes("charm-person") ? Object.freeze([...base.intents, CHARM_INTENT]) : base.intents,
    behaviors: Object.freeze({ ...base.behaviors, vicious: true }),
    loot: base.loot,
    carriedSkills,
    sightReadable: true, // essence-sight integration point (see doc §sight-ledger)
    tags: Object.freeze([...base.tags, "chaosling", "corrupted"])
  });
}

// (5) THE LIMPING GREY — authored starter encounter. A corrupted grey wolf, VISIBLY
// INJURED (stat UNDERCUT below the grey_wolf chassis: hp 11→7, ac 13→12), carrying
// EXACTLY ONE chaos skill: inverted-element bite that CHILLS (element:bite → rider:
// chill), so its bite deals cold. Placed at loc_waking_mile (starter zone's first
// exit) with an essence trail — see babel.json bestiary.placements. Law-6.
const LIMPING_GREY = Object.freeze({
  limping_grey: Object.freeze({
    statBlockId: "limping_grey",
    name: "The Limping Grey",
    kind: "chaosling",
    tier: 2,
    baseAnimalId: "grey_wolf",
    maxHp: 7, // undercut from grey_wolf's 11 (favouring a ruined foreleg)
    ac: 12, // undercut from 13
    dexMod: 1, // undercut from 2 (the limp)
    xp: 45,
    attacks: Object.freeze([{ attackId: "chaos_bite", toHit: 3, damage: "1d6+1", damageType: "cold", rider: "chill" }]),
    intents: Object.freeze([
      { intentId: "chaos_bite", kind: "attack", attackId: "chaos_bite", weight: 3, telegraph: "snarls; frost rimes its bared teeth", hidden: false },
      { intentId: "favor_leg", kind: "defend", weight: 2, telegraph: "shifts weight off a ruined foreleg, circling short", hidden: false }
    ]),
    // EXACTLY ONE chaos skill (authored, not rolled): inverted-element bite/chill.
    carriedSkills: Object.freeze([
      Object.freeze({ skillId: "inverted-element", name: "Inverted Element", tier: "low", mint: Object.freeze({ element: "bite", rider: "chill" }) })
    ]),
    sightReadable: true,
    behaviors: Object.freeze({ vicious: true, cowardly: false, injured: true }),
    loot: Object.freeze([]),
    tags: Object.freeze(["wildlife", "wolf", "chaosling", "corrupted"])
  })
});

// The merged registry: core hostiles + base animals + the authored Limping Grey.
// (Rolled chaoslings are minted on demand via mintChaosling — not static rows.)
const REGISTRY = Object.freeze({ ...STAT_BLOCKS, ...BASE_ANIMALS, ...LIMPING_GREY });

// RUNTIME OVERLAY (world-creator v2): compiled USER worlds mint their own tier-1
// threat via mintChaosling, which produces a block that is NOT in the frozen
// REGISTRY. The scenario carries those blocks in bestiary.statBlocks; the loader
// registers them here so a placement + combat can resolve them. Additive-only:
// never shadows a frozen registry id (authored content always wins), ids are
// world-seeded so cross-world collisions don't occur.
const RUNTIME_STAT_BLOCKS = {};

/** Register a minted stat block so resolveStatBlock can find it. Refuses to shadow
 *  a frozen registry id and requires a non-empty statBlockId. Returns the id or null. */
export function registerStatBlock(block) {
  if (!block || typeof block !== "object") return null;
  const id = typeof block.statBlockId === "string" ? block.statBlockId.trim() : "";
  if (!id || REGISTRY[id]) return null; // never shadow authored/base content
  RUNTIME_STAT_BLOCKS[id] = block;
  return id;
}

// The default statBlockId for an attack on a present NPC that carries no explicit
// hostile stat block (D.4 §2.2(1)).
export const DEFAULT_STAT_BLOCK_ID = "civilian";

/**
 * Resolve a statBlockId string to its (frozen) stat block, or null if unknown.
 * The string contract's only resolver (D.4 Phase 0 §3.4). Never throws.
 * @param {string} statBlockId
 * @returns {object|null}
 */
export function resolveStatBlock(statBlockId) {
  if (typeof statBlockId !== "string" || !statBlockId.trim()) {
    return null;
  }
  // ONE runtime overlay serves both CLI 2's creator-world people (worlds B1) and the
  // A3.2 live chaosling spawn: minted-on-demand blocks are registered via
  // registerStatBlock (above) so this — the sole resolution point — finds them.
  return REGISTRY[statBlockId] || RUNTIME_STAT_BLOCKS[statBlockId] || null;
}

// A chaosling's active mind skill (charm) is used as a combat intent; the pack/telegraph
// skills (vision-share, telepathy) are passives read elsewhere.
const CHARM_INTENT = Object.freeze({ intentId: "charm-person", kind: "skill", skillId: "charm-person", weight: 2, telegraph: "its gaze softens, reaching for your mind", hidden: false });

function chaosSkillRow(skillId, seed) {
  const skill = CHAOS_SKILLS[skillId];
  if (!skill) return null;
  return skill.family === "element"
    ? Object.freeze({ skillId, name: skill.name, tier: skill.tier, mint: skill.mintTable[hashSeed(`${seed}|${skillId}`) % skill.mintTable.length] })
    : Object.freeze({ skillId, name: skill.name, tier: skill.tier });
}

function withForcedSkill(block, skillId, seed) {
  if (!CHAOS_SKILLS[skillId] || (block.carriedSkills || []).some((s) => s.skillId === skillId)) return block;
  const carriedSkills = Object.freeze([...(block.carriedSkills || []), chaosSkillRow(skillId, seed)]);
  const intents = skillId === "charm-person" ? Object.freeze([...block.intents, CHARM_INTENT]) : block.intents;
  return Object.freeze({ ...block, carriedSkills, intents });
}

/**
 * Mint a chaosling on demand and REGISTER it (into the shared runtime overlay) so combat
 * can resolve it — the live-spawn wiring. Optionally force a specific chaos skill (the
 * rapture-born Warm House chaosling carries a high-tier skill even below its roll) and/or
 * a display name. Deterministic.
 */
export function spawnChaosling({ baseAnimalId, tier = 2, seed, forceSkill = null, name = null } = {}) {
  let block = mintChaosling(baseAnimalId, tier, seed);
  if (!block) return null;
  if (forceSkill) block = withForcedSkill(block, forceSkill, seed);
  if (name) block = Object.freeze({ ...block, name });
  registerStatBlock(block); // CLI 2's registerStatBlock returns the id; hand back the BLOCK
  return block;
}

/**
 * Is this a known stat block id? (For validation / grounding checks.)
 * @param {string} statBlockId
 * @returns {boolean}
 */
export function isKnownStatBlock(statBlockId) {
  return resolveStatBlock(statBlockId) !== null;
}

export function listStatBlockIds() {
  return Object.keys(REGISTRY);
}

/** The 10 base-animal chassis ids (kind:"wildlife"). */
export function listBaseAnimals() {
  return Object.keys(BASE_ANIMALS);
}

/**
 * Essence-sight read of a stat block's carried chaos skills, or [] when none /
 * not sight-readable. SIGHT LEDGER: the DATA flag is live here; the UI surface
 * that renders these on the sight layer is NOT yet wired (buildSightPayload reads
 * traces only) — tracked in verdance-bestiary-v1.md §sight-ledger.
 */
export function sightReadableSkills(statBlock) {
  if (!statBlock || statBlock.sightReadable !== true || !Array.isArray(statBlock.carriedSkills)) {
    return [];
  }
  return statBlock.carriedSkills;
}
