# Milestone-Track Engine Delta — Spec

**Spec only. No implementation.** Scopes the engine changes that make the
Ch7 milestone/display-level split (`docs/handbook/ch7-progression.md`,
amendment commit `7fe39a3`) true in code. Written so implementation can
dispatch cold-start-free once the Babel world book's mapping is redlined.

Status tags follow ROADMAP-CANON law: **[LOCKED]** = doc-law already
directed; **[POSITION]** = this spec takes a stance, overridable at review;
**[RULING]** = genuinely needs the director.

---

## 1. What exists today (verified against the repo)

The engine speaks raw levels in one write path, one build path, and a
handful of read/display surfaces. There is **no tier gating anywhere yet** —
nothing in `quests.js`, `questFlow.js`, `movement.js`, or `attempt.js`
reads `player.level` to gate content (verified by sweep).

### 1a. The XP/level write path — `server/solo/progression.js`

- `XP_THRESHOLDS` (`progression.js:11`) — **5e cumulative thresholds, 10
  entries**: effective ceiling is level 10 today, not 20. The current curve
  matches neither the old cap-20 doc nor Ch7's `milestone × 100` law; it is
  replaced wholesale by this delta, not adapted.
- `XP_AWARDS` (`progression.js:14`) — `attempt_success: 25, search_found:
  50, quest_stage: 100, quest_complete: 250`. Committed-event-only law
  already holds structurally: awards flow only from resolved actions.
- `levelForXp()` (`progression.js:28`) — threshold scan.
- `awardXp()` (`progression.js:48`) — mutates `player.xp` / `player.level`,
  bumps HP by `HP_PER_LEVEL = 5` per level across **four HP mirrors**
  (`maxHealth`, `resources.hitPoints`, `resources.hp`, `health` —
  `progression.js:71-90`). Dead players earn nothing (`progression.js:54`).
  Returns `{awarded, xp, level, leveledUp, levelsGained}`.

### 1b. The committed-event award seam

- `server/solo/actions.js:413-439` — the one place free-play XP accrues:
  attempt success, search found, quest stage (×N), quest complete; result
  carries `playerLevel` (`actions.js:439`).
- `server/solo/combat.js:505-525` — combat-victory XP from
  `resolveStatBlock(c.statBlockId).xp`, paid through the same `awardXp()`.

Both callers pass through `awardXp` — the delta has **one choke point**.

### 1c. The build path — `server/solo/characterBuild.js`

- `buildCharacter()` takes `choices.level` (`characterBuild.js:53`), derives
  `proficiencyBonus` via `proficiencyBonusForLevel(level)`
  (`characterBuild.js:57`, table at `dndData.js:101`), and emits
  `derivedStats` (`characterBuild.js:89-95`) including
  `initiative: modifiers.dexterity` (`characterBuild.js:92`) — the
  **computed-but-unused d20 initiative mod** that the CTB spec re-purposes
  as Speed (`ctb-turn-engine-spec.md §2.1`: `speed = clamp(10 + dexMod,
  8, 16)`, dexMod = the existing modifier math, retained).
- `toRunPlayer()` writes `player.level` (`characterBuild.js:139`).

### 1d. Read/display surfaces

- `server/solo/scene.js:670` — scene payload exposes `level` to the UI.
- `server/solo/schema.js:481` — `validateNumber(player.level, ...)`;
  default `level: 1` (`schema.js:1421`).
- `server/gm/prompting.js:42,129` — the GM prompt states
  `ClassName <level>`.
- `server/index.js:2415` — character listing string.
- `server/db/repository.js:2223` — vault character persistence.
- UI: `src/components/soloSceneShell.js:1069,1157,1277` (status window
  renders "Level N"), `src/components/onboardingFlow.js:408` (review
  sheet), `src/components/characterVault.js:17` (level input, `max="20"`).

### 1e. What does NOT read level

- Combat math: `combat.js:101-106` reads `derivedStats.initiative` and a
  proficiency default — not `player.level` directly.
- Growth-profiles, feats, tier bands: **do not exist in the engine yet.**
  Ch7's milestone recompute (growth-profile arrays, feat picks) is part of
  the wider rulebook build; this delta specifies the *seams* they land in
  but does not build them.

---

## 2. Target model

**Server truth = the milestone counter.** `player.milestone` (integer,
1..`MILESTONE_MAX = 20`) is the ONLY number progression mechanics read:

- growth budget + stat recomputes (growth-profile arrays index by
  milestone),
- feat picks (milestones 5/10/15/20 — tier graduations),
- tier gates (§4),
- HP recompute, proficiency, and every derived stat
  (`proficiencyBonusForLevel` becomes `proficiencyBonusForMilestone`, same
  table).

**Display level = presentation.** `displayLevel` is *computed, never
stored as truth*, via the active world book's mapping (§3c). Between
breakthroughs, a display level-up commits a **minor-level event**: a small
HP tick (world-book-set, validator-bounded) + a flavor timeline event —
never stats, feats, or features.

**XP law unchanged**: committed events only, paid through `awardXp`.
**Curve per Ch7**: `XP to next milestone = current milestone × 100`
(cumulative quadratic; totals per Ch7's table — 19,000 XP from milestone 1
to 20). World books subdivide each milestone's XP span across their minor
levels; the subdivision is display pacing, the curve is law.

---

## 3. The delta, enumerated

### 3a. Fields

| Field | Change |
|---|---|
| `player.milestone` | **NEW** — integer 1..20, server truth. |
| `player.xp` | unchanged (committed-event ledger). |
| `player.level` | **RETIRED as truth; retained as a computed mirror** = `displayLevel`, recomputed on every award/mapping change, so every existing read surface (scene payload, GM prompt, vault listing, UI) keeps working unmodified during the transition. [POSITION: mirror, don't delete — deleting breaks 10+ read sites for zero mechanical gain; the schema validator marks it derived.] |
| `run.worldBook.progressionMap` | **NEW** — the mapping contract (§3c), carried on the run (worlds are per-run today). |

### 3b. Functions

| Function | Change |
|---|---|
| `levelForXp()` | replaced by `milestoneForXp()` implementing the Ch7 curve (`Σ i×100`). |
| `awardXp()` | same signature + choke point; on milestone gain: HP bump + (future seam) growth-profile recompute + feat-pick flag; on minor display level gain: minor HP tick + flavor event. Return shape gains `{milestone, displayLevel, milestoneUp, minorLevelUps}` (keeps `level` = displayLevel for callers). |
| `buildCharacter()` | `choices.level` → interpreted as milestone (creation is milestone 1 in practice; vault imports see §3e); `proficiencyBonusForLevel` re-keyed to milestone. **Byte-identical:** ability/save/skill math, `derivedStats` shapes, `initiative`/Speed derivation, hit-die HP. |
| `displayLevelFor(milestone, xp, map)` | **NEW pure fn** — the only place display math lives. |
| Scene/status emit (`scene.js:670`) | emits `displayLevel` (as `level`, unchanged key) **+ `milestoneTier`** (I–IV band name) — §3f. |

### 3c. World-book mapping contract (data, validator-checked)

```jsonc
"progression": {
  "displayScale": { "min": 1, "max": 250 },        // uncapped by chassis; max is lore
  "breakthroughs": [1, 10, 25, 50, ...],           // EXACTLY MILESTONE_MAX entries:
                                                    // breakthroughs[k] = display level of milestone k+1
  "minorHpTick": 1,                                 // HP per minor display level; validator-bounded (0..2)
  "caps": {                                         // lore flags, not chassis law
    "perCharacter": { "type": "milestone-cap", "value": 250, "note": "MC-250 lore cap" }
  }
}
```

Validator rules (same posture as growth-profile validation — reject at
load, no world book can print a broken map):

1. `breakthroughs` strictly **monotonic increasing**, length ==
   `MILESTONE_MAX`, first entry == `displayScale.min`, last entry ==
   `displayScale.max` (**covers the span** — no orphan display levels above
   the final milestone).
2. `minorHpTick` within the chassis bound (0..2) — keeps the drip from
   becoming a second growth budget. [POSITION: bound 0..2; at 250 display
   levels ×2 HP the drip is still smaller than lethal-math-relevant.]
3. `caps` entries are **lore flags**: the engine enforces them as
   world-law (a capped character stops converting XP), but they are
   world-book data, never chassis constants.
4. **Default mapping** (world book supplies none): identity —
   `breakthroughs = [1..20]`, `minorHpTick` irrelevant (no minor levels
   exist under 1:1). Nothing visibly changes for existing worlds.

Minor-level subdivision: milestone k's XP span (`k × 100`) divides evenly
across the display levels between `breakthroughs[k-1]` and
`breakthroughs[k]`; remainder lands on the breakthrough. Pure display
math, no state beyond `xp`.

### 3d. Byte-identical (regression contract)

- d20 math: ability modifiers, saves, skills, AC, passive perception
  (`characterBuild.js:59-95`), the CTB Speed law (DEX-only, clamp 8..16).
- Growth-profile array *shape* and validator *budgets* (+10 total, no stat
  above 20) — they re-key from level-index to milestone-index, which is a
  rename, not a re-budget.
- `XP_AWARDS` values and the committed-event award seam
  (`actions.js:413-439`, `combat.js:505-525`).
- The dead-earn-nothing rule and the four-mirror HP bump mechanics.

### 3e. Migration (existing saves)

[POSITION] `milestone = min(20, player.level)`, `xp` **kept as-is**, and the
milestone is **floored, never revoked**: `milestoneForXp(xp)` may lag the
grandfathered milestone (old 5e thresholds were cheaper early, dearer
late); `awardXp` already takes `max(before, computed)` (`progression.js:67`)
so nobody de-levels. Applied lazily in schema defaulting (`schema.js:1421`
peer): a loaded player without `milestone` gets it from `level`. Vault
characters (`repository.js:2223`, `characterVault.js:17` max=20) map 1:1 —
their level input becomes a milestone input; the vault UI label follows the
active world's display later, not in this delta.

### 3f. Status window / scene payload

- `level` key **stays** and carries `displayLevel` — the player-facing
  number is always the world's number. Raw milestone is **never** the
  player-facing number unless the world's mapping is identity (then they
  coincide, which is not exposure).
- **NEW** `milestoneTier`: the band name ("Tier II — Regional") — tier is
  chassis vocabulary and safe to show; it leaks no raw counter beyond what
  the world already implies.
- GM prompt (`prompting.js:42,129`) states the display level — the GM
  narrates the world's fiction, and prompts must never teach the model a
  second, contradictory number.

---

## 4. Tier-gate law (anti-inflation)

**Gates read `player.milestone`, never `displayLevel`.** Ch7: "a tower
can't fake a Tier-IV door open by inflating its level numbers."

Today: **no level/tier gating exists** (verified — §1). So this law is
enforced by *construction*, not retrofit: the delta introduces one
predicate, `meetsTier(player, tierBand)`, reading `player.milestone` only,
and the CONTRACT doc (`server/solo/CONTRACT.md`) gains the rule that
content-gating code MUST call it — `displayLevel` is presentation-layer
data that server logic is forbidden to branch on. Test-of-record: a world
book with an inflated mapping (milestone 3 shown as level 60) must still
fail a Tier-II gate.

---

## 5. Scope, risk, tests

### Phased build

- **Phase 1 — milestone truth (smallest slice, ships alone):**
  `player.milestone` + Ch7 curve in `progression.js`, lazy migration,
  `level` re-emitted as displayLevel with the **default identity mapping**.
  Nothing visibly changes anywhere — same numbers on every surface — until
  a world book supplies a real mapping. Est. small: one module rewrite
  (`progression.js` is 100 lines), schema field, ~6 call-site touches.
- **Phase 2 — mapping contract:** `progressionMap` schema + validator +
  `displayLevelFor` + minor-level HP tick/flavor event + `milestoneTier`
  in the scene payload. Gated on the Babel world book redline (it is the
  first real consumer; specing its mapping against a live table is the
  cold-start this doc removes).
- **Phase 3 — recompute seams:** growth-profile application + feat-pick
  flags at milestones (lands with the wider rulebook build, not this
  delta; Phase 1-2 leave named seams in `awardXp`).

### Riskiest seam

`awardXp`'s four-mirror HP bump (`progression.js:71-90`) now fires on TWO
event kinds (milestone bump vs minor tick) with different magnitudes, and
the mirrors have historically drifted (see the state-contract inventory
WARN in selfplay). A missed mirror on the minor-tick path shows the UI a
different max HP than the death math uses — in a lethal game, that is the
worst class of bug. The delta should extract ONE `applyHpDelta(player,
amount)` used by both paths before adding the second path.

### Tests-of-record

1. Curve: `milestoneForXp` matches Ch7's table exactly (100/1,000/4,500/
   10,500/19,000 boundaries).
2. Migration: legacy save (level N, 5e-threshold xp) loads to milestone N;
   subsequent awards never de-level; milestone 20 hard-stops conversion.
3. Identity default: with no world mapping, every surface (scene, prompt,
   vault, status window) emits the same numbers as before the delta —
   byte-diff on payload fixtures.
4. Mapping validator: rejects non-monotonic, wrong-length, span-uncovering,
   over-tick maps; accepts the Babel 1–250 map.
5. Minor levels: crossing a minor display level pays HP tick + flavor event
   and does NOT touch stats/feats/proficiency; crossing a breakthrough pays
   the milestone recompute.
6. Anti-inflation: inflated mapping (milestone 3 → display 60) still fails
   a Tier-II `meetsTier` gate.
7. HP mirrors: after any mix of milestone/minor gains, all four HP mirrors
   agree (regression for the riskiest seam).

---

## Director rulings needed

1. **[RULING] Legacy-XP re-base.** Existing saves earned XP on 5e
   thresholds (cheaper early). Position taken here: keep `xp` as-is and
   floor the milestone (§3e) — simple, nobody de-levels, slight
   grandfather bonus. Alternative: re-base `xp` to the Ch7 curve's
   equivalent total for their milestone (clean books, touches every save).
   Low stakes now (few real saves), but it is a one-way door once real
   players exist.

Everything else in this spec is a [POSITION]: overridable at review, but
implementation should proceed on it without waiting.
