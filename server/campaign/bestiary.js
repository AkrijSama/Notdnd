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
  return STAT_BLOCKS[statBlockId] || null;
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
  return Object.keys(STAT_BLOCKS);
}
