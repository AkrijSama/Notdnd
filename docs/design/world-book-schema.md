# WORLD-BOOK SCHEMA — the form Babel discovered, formalized

**Status:** SEALED 2026-07-19 (owner law). The canonical shape behind the "Custom
World" creation flow. Code: `server/campaign/worldBook.js`. Guard tests:
`tests/world-book-schema.test.js`.

---

## THE ONE LAW

> A world-book with only `{name, vibe}` MUST load and play. Every other field has a
> mint-capable default; the engine's mints fill every gap. A young world is **thin,
> never broken.**

The user answers questions and curates drafts. They never see this schema, never fill
a field, and are never blocked from playing by an unfilled one.

---

## TWO LAYERS (why there are two validators)

```
world-book  (permissive, name-only floor)  ──compileWorldBook()──▶  scenario  (strict)
      ▲ validateWorldBook()                                              ▲ validateScenario()
      the CREATION artifact                                     the LOADER's gate (unchanged)
```

- **`validateWorldBook(wb)`** — the permissive front check. The *only* hard requirement
  is a name; every other field is type-checked *only if present*. A half-answered
  interview is a valid world-book. `babel.json` passes **unchanged** (regression).
- **`compileWorldBook(wb)`** — lowers a world-book into a **scenario object** that passes
  the existing strict `validateScenario` (`server/campaign/scenarioSchema.js`) and loads
  through the existing `loadScenarioIntoRun` pipeline. It MINTS a valid default front +
  secret + opening + a kept-ground start for anything absent.

`validateScenario` is deliberately strict — it requires fully-formed fronts (≥2 grounded
beats each), a non-empty secrets pool, and an opening. A `{name, vibe}` world cannot
clear that bar directly; compilation is what mints the missing structure. This split is
why babel (a fully-filled world-book) loads untouched via the authored path while a thin
user world rides the *same* loader after compilation.

---

## THE CANONICAL SHAPE

Every field is optional except a name. Field names accept both the creator's clean shape
and babel's native shape (so babel validates unchanged).

| Concept | World-book field(s) | Default when absent |
|---|---|---|
| **Identity — name** | `identity.name` \| `name` \| `title` \| `world.name` | *(required)* |
| **Identity — tagline** | `identity.tagline` \| `vibe` \| `spark` \| `stakes` | `""` |
| **Identity — era** | `identity.era` \| `world.era` | `""` (engine renders timeless) |
| **Identity — tone/genre** | `identity.tone` / `identity.genre` \| `tones[]` \| `genre` | `"grounded"` / `"adventure"` |
| **Cosmology + laws (canon doc)** | `cosmology` (freeform) \| `world.flavor` | derived from `vibe` |
| **POI table** | `pois[]` \| `poiTable[]` \| `locations{}` (map) | kept-ground start only |
| **Factions** | `factions[]` | `[]` |
| **Threat ladder** | `threatLadder{}` \| `bestiary.threatLadder{}` | `DEFAULT_THREAT_LADDER` (6 rungs) |
| **Bestiary refs** | `bestiary{}` | base-animal + chaos-tree engine, name-flavored (v1) |
| **Skill-tree refs** | *(engine-owned; v2 for per-world trees)* | chaos-tree machinery |
| **Name banks** | `nameBanks{settlements,wilds,people}` \| `world.nameBanks` | `DEFAULT_NAME_BANKS` |
| **Orientation mix** | `orientationMix{}` | `DEFAULT_ORIENTATION_MIX` = `{hetero:90,bi:6,homo:4}` |
| **Death law** | `deathLaw{}` | `DEFAULT_DEATH_LAW` = free-death epilogue / premium continuation |
| **Services seeds** | `pois[].services[]` (`{kind,label}`) | none (locations mint their own) |
| **Start area (kept ground)** | `startArea{}` | **minted** — universal anti-lost law (below) |
| **Fronts (cap-aware)** | `fronts[]` (≤3, ≤1 foreground) | **one** minted `opportunity` front |
| **Secrets** | `secrets[]` | **one** minted secret tied to the front |

Concept metadata with no scenario-schema home (`orientationMix`, `deathLaw`, `cosmology`)
rides `world.*` on the compiled scenario — loader-carried and engine-read, exactly like
babel's `nameBanks`. The strict scenario schema ignores it; the engine consumes it.

---

## THE UNIVERSAL ANTI-LOST LAW (kept ground)

**Every** compiled world gets a deliberately-clear starter zone — not just Babel. The
minted start location:

- is tagged **`poi:start-area`** (the contract `server/solo/starterZone.js` keys on), so
  the narrator's anti-lost directive + the post-narration lost-motif auditor fire for
  every world;
- carries kept-ground language ("the paths are honest and the way is plain") so the
  auditor's calibrated patterns pass;
- has `dangerLevel: 0`.

Orientation is never in doubt on kept ground. The wrongness of a world lives *past* the
threshold. This is `keptGroundStart()` in `worldBook.js`, asserted by the schema tests.

---

## DEFAULT TABLES (exported, single source of truth)

- `DEFAULT_ORIENTATION_MIX = { hetero: 90, bi: 6, homo: 4 }` (romance-legacy-law).
- `DEFAULT_DEATH_LAW = { kind: "free-death-epilogue", premiumContinuation: true, … }`.
- `DEFAULT_THREAT_LADDER` — 6 tone-neutral rungs (wildlife → apex); worlds re-skin the
  *names* via the interview / nameBanks. Mechanics are the base-animal + chaos-tree
  engine in v1.
- `DEFAULT_NAME_BANKS` — a small tone-neutral floor so name mints never starve.

---

## REGRESSION GUARANTEES (sealed)

1. `validateWorldBook(babel.json).ok === true` — babel validates as a world-book unchanged.
2. babel loads via the **authored** path (`loadScenarioFile` → `loadScenarioIntoRun`),
   untouched by any world-creator code.
3. `compileWorldBook({name, vibe}).validation.ok === true` — a minimal world compiles to a
   scenario that passes the strict gate and plays.
4. `compileWorldBook` is pure and deterministic (`idFactory` injected).

---

## v1 SCOPE / DEFERRED (ledger)

- **Per-world bestiary authoring (real stat blocks)** — v2. v1 reuses the base-animal +
  chaos-tree machinery with world-flavored *naming* via `nameBanks`.
- **Per-world skill trees** — v2 (advanced drawer stubbed "coming soon", not built).
- **Modules within a world** — the world/module taxonomy (`world-module-law.md`) reserves
  MODULE authoring for later; the creator ships a WORLD.
