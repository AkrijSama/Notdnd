# VERDANCE BESTIARY v1 + CHAOS SKILL TREE v1

**Status:** SEALED 2026-07-19 (owner-ratified). World-book DATA for the Babel /
Verdance region. Companion to [verdance-region-v1.md](verdance-region-v1.md).
Executable rows live in `server/campaign/bestiary.js`; placement lives in
`server/campaign/scenarios/babel.json` (`bestiary`). **Enemies exist only as rows
in the bestiary — no LLM ever mints one.**

**LAW-6 (owner-tunable numbers).** Every number here is a *starting value* derived
from the level-1-region chassis (waylayer hp12/ac13, civilian hp6/ac10): winnable,
genuinely lethal on bad dice. The **shape is the contract; the numbers are not** —
retune any cell freely. This is the §Law-6 tunable-table convention.

---

## (1) BASE ANIMALS — tier-1 wildlife chassis

`kind: "wildlife"`, combat-resolvable rows like any other stat block. Numbers scale
by real danger (a black bear is the apex; a raven barely fights).

| id | name | HP | AC | dexMod | XP | signature attack |
|---|---|--:|--:|--:|--:|---|
| black_bear | Black bear | 19 | 12 | +1 | 100 | claw 1d6+3 / bite 1d8+3 |
| mountain_lion | Mountain lion | 13 | 13 | +3 | 75 | pounce 1d6+3 |
| grey_wolf | Grey wolf | 11 | 13 | +2 | 50 | bite 1d6+2 |
| roosevelt_elk | Roosevelt elk | 15 | 11 | +0 | 50 | gore 1d8+2 |
| black_tailed_deer | Black-tailed deer | 7 | 12 | +2 | 15 | kick 1d4 (bolts) |
| wild_boar | Wild boar | 12 | 11 | +0 | 50 | tusk 1d6+1 (relentless) |
| coyote | Coyote | 6 | 12 | +2 | 15 | bite 1d4+1 |
| rattlesnake | Rattlesnake | 4 | 12 | +2 | 30 | venom bite 1d4 + venom |
| raven | Raven | 3 | 13 | +3 | 10 | peck 1d3 (omen: watches) |
| river_otter | River otter | 5 | 12 | +3 | 10 | bite 1d4 |

---

## (2) CHAOS SKILL TREE — data rows the mint engine reads (extensible: add a row)

**Low tier**
- **chaos-pack-aura** (`family: aura`, effect `scaling-advantage`) — allies gain
  advantage that scales with how many chaos-touched stand together.
- **inverted-element** (`family: element`, effect `element-x-wrong-rider`) — an
  elemental attack carries the WRONG rider, from the mint table:

  | element | wrong rider |
  |---|---|
  | fire | chills |
  | frost | burns |
  | bite | chill |
  | shock | rots |
  | venom | mends |

**High tier** (unlocks at threat tier ≥ 3)
- **charm-person** (`family: mind`, effect `charm`)
- **vision-share** (`family: mind`, effect `vision-share`)
- **telepathy** (`family: mind`, effect `telepathy`)

---

## (3) CHAOSLING MINT RULE

`chaosling = base animal + bounded stat boost + 1..N chaos skills`, **deterministic
per (baseAnimalId, threatTier, seed)** (`mintChaosling`). Boost and skill-count are
bounded by the **TIER_BUDGET** (Law-6):

| tier | +HP ≤ | +AC ≤ | skills | high-tier skills? |
|---:|--:|--:|---|---|
| 1 | 4 | 1 | 0–1 | no |
| 2 | 8 | 2 | 1–2 | no |
| 3 | 14 | 3 | 2–3 | yes |
| 4 | 22 | 4 | 3–4 | yes |

- **N scales with tier** via the skill band; `rollChaosSkills(tier, seed)` returns
  distinct skillIds, deterministically ordered by a per-skill hash of the seed.
- **Deterministic seed**: `hashSeed("chaosling|<base>|<tier>|<seed>")` drives the
  boost; the skill roll keys off `<seed>|<base>`. Same inputs → byte-identical block.
- Rolled chaoslings are **minted on demand**, not static rows (only authored ones —
  e.g. the Limping Grey — are registry rows).

### Essence-sight integration (§sight-ledger)
A minted chaosling carries `carriedSkills` and `sightReadable: true`.
`sightReadableSkills(block)` returns those skills — the **DATA flag is live**.
**LEDGER (UI not yet wired):** `buildSightPayload` (essence.js) currently surfaces
committed *traces* only; rendering a chaosling's carried skills on the sight layer
is a follow-up surface. The data seam exists; the client read is owed.

---

## (4) THREAT LADDER (regional ruling)

| kind | rarity | tier | social-capable |
|---|---|--:|---|
| wildlife | common | 1 | no |
| bandit | uncommon | human-tier (1) | **yes** (can be talked to) |
| chaosling | uncommon | 2 | no |
| demon | very-rare | 4 | yes |

---

## (5) THE LIMPING GREY — authored starter encounter

A corrupted grey wolf, **visibly injured** (stat UNDERCUT from the `grey_wolf`
chassis: HP 11→7, AC 13→12, dexMod +2→+1 — it favours a ruined foreleg). Carries
**exactly one** chaos skill: **inverted-element bite that chills** (`element: bite →
rider: chill`), so its bite deals cold damage. `sightReadable: true`.

**Placement** (`babel.json` `bestiary.placements`): at **loc_waking_mile** — the
starter zone's first exit from the Green Static fringe (`start`) — with an **essence
trail** from `start` toward it (`band: fresh`), so a beckoned MC at the fringe reads
a fresh trace and can *Follow the trail* to the wolf.

---

## Files
- `server/campaign/bestiary.js` — rows + `CHAOS_SKILLS` / `THREAT_LADDER` /
  `TIER_BUDGET` + `mintChaosling` / `rollChaosSkills` / `sightReadableSkills`.
- `server/campaign/scenarios/babel.json` `bestiary` — threat ladder + placement.
- `tests/verdance-bestiary.test.js` — mint determinism, budget bounds, skill-roll
  counts by tier, Limping Grey loads + is placed.
