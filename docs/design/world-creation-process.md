# World Creation Process — v1

*Sealed from the project's own history (Babel → Verdance → the World Creator). This is
the repeatable recipe for building world #2 (and #N) without re-deriving it each time.
It documents what already ships in code; every section names the module that owns it.*

---

## AUTHORING A WORLD = FILLING THIS FORM

**Owner law: world #2 must be form-filling, not archaeology.** You do not need to read the
engine to author a world. You need to fill slots. Everything you can fill is declared in ONE
place — `WORLD_BOOK_SLOTS` (`server/campaign/worldBook.js`) — and you can print the status of
any world's form at any time:

```
node scripts/world-manifest.mjs babel          # the bill of materials
node scripts/world-manifest.mjs --all --md     # every world, markdown
```

`[x]` you filled it · `[~]` the engine's default covers it · `[…]` planned, not built yet.

### The two halves

| | **STEEL** (engine) | **FURNITURE** (you) |
|---|---|---|
| What | The mechanics every world stands on — CTB queue, the three-band resolver, the sealed ten statuses, reputation tiers, the ≤3-front cap, "the model describes, never adjudicates" | The world-book slots the engine consumes |
| Can you change it? | **No.** You may tune declared parameters (Law-6) and you may **rename** freely — a world calls it a "chill", the engine compiles it to `slow` | **Yes — this is your whole job** |
| Where | `docs/design/steel-vs-furniture.md` §1 | §2, and `WORLD_BOOK_SLOTS` |

**The one hard requirement is a name.** `{name, vibe}` compiles to a complete, playable
world — every other slot has a mint-default, enforced by `tests/world-book-slots.test.js`.
A thin world is *thin, never broken*.

### Authoring cyberpunk = filling THIS form

| Slot | Cyberpunk example |
|---|---|
| `name` · `vibe` | "Kowloon Extended" · "everyone is leased, including you" |
| `identity.era` · `.tone` · `.genre` | "2091" · "neon-noir" · "cyberpunk" |
| `cosmology` | what the Net is, who owns the arcologies |
| `poiTable[]` | the Stack, Level 3 Market, the Cold Vault… (name + description + `connections`) |
| `factions[]` | Zhu-Ling Medical, the Unlicensed, Precinct 12 |
| `cast[]` | 4–6 people: keeper / trader / quest-giver / wanderer / elder |
| `fronts[]` (≤3) | the pressures, 2–4 grounded beats each |
| `nameBanks` | **fill this** — it names your cast, your POIs, and your creatures. Leave it blank and your cyberpunk world is populated by Mara and Corin of Wayrest |
| `bestiary.statBlocks` / `.placements` | your drones and dogs, on a base-animal chassis |
| `world.artStyle` · `.sceneRegister` | "cinematic" · "rain-slick neon, wet concrete, sodium haze" |
| `deathLaw` · `orientationMix` · `threatLadder` | fillable — but **currently inert**, see below |

### Read this before you spend effort

Some slots are **validated but consumed by nothing**. Filling them changes no behavior
until a consumer ships. As of 2026-07-21: `secrets`, `orientationMix`, `deathLaw`,
`threatLadder`, world-level `services`, and `locations[].notices[]`. The manifest prints
these under **DEAD SLOTS** so you never discover it the hard way.

And five slots the roadmap declares but the engine does not yet consume — `figures`,
`artifacts`, `powerSystems`, `background`, `handbook` — print as **PLANNED**. Babel's own
gaps are exactly these (key figures, handbook chapters).

Full detail, including the Law-6 parameter surface for every subsystem:
**[`steel-vs-furniture.md`](./steel-vs-furniture.md)**.

---

## 0. Why this exists

Building Babel taught the pipeline; building Verdance proved it generalizes; the World
Creator (`worldInterview.js` / `worldDraft.js` / `worldCreationService.js`) productized
it. The tedium in world #1 was **re-discovering the shape** — which questions matter,
what the engine will and won't honor, which laws are automatic. This doc removes that
re-discovery. Follow it and a new world is an evening of answers, not a research project.

**The spine, end to end:**

```
spark ──► INTERVIEW ──► DRAFT ──► KEEP / TWIST / KILL ──► ASSEMBLE ──► COMPILE ──► LOAD
(1 line) (7 questions)  (1 LLM   (owner curation,        (world-book) (scenario) (run)
                         call)    per-card, free)
         worldInterview  worldDraft ─────────────────►   worldBook.compileWorldBook  scenarioLoader
```

Two principles hold the whole thing up:

1. **AI content only ever FILLS tables. The engine enforces every law.** A draft is
   never trusted raw and can never inject committed authority — the age wall, the front
   cap, orientation, budgets, and the anti-lost start are all minted *downstream* of any
   LLM output (`worldDraft.js` header; `worldBook.js` mints).
2. **The interview is a conversation, not a form.** Every question is skippable ("let
   the world decide"), and "just build it" completes the rest from the spark in one call.
   The worst case is a coherent world drafted from a single sentence — it never blocks.

---

## 1. The interview question sets (verbatim)

Source of truth: `server/campaign/worldInterview.js` → `INTERVIEW_QUESTIONS`
(`WORLD_INTERVIEW_VERSION = 1`). Copy is owner-reviewed; the register is warm and plain.
Each question declares the draft section it `feeds`.

### 1a. The region interview (7 questions)

| # | id | Question (verbatim) | feeds | skip label |
|---|----|--------------------|-------|-----------|
| 1 | `landmark` | *"Every world has one thing everyone's heard of. What's the landmark of yours — the thing people point to on the horizon?"* | `pois` | Let the world decide |
| 2 | `remnant` | *"Something came before. What did the old world leave behind that people still live with?"* | `cosmology` | Let the world decide |
| 3 | `temptation` | *"People with sense stay home. What's the temptation that makes your adventurers risk it anyway?"* | `fronts` | Let the world decide |
| 4 | `threats` | *"What's out there, weakest to worst? Give me a few rungs of the danger ladder."* | `threatLadder` | Let the world decide |
| 5 | `signature` | *"What's the one danger this world is known for — its signature, the thing players will tell stories about?"* | `bestiary` | Let the world decide |
| 6 | `powers` | *"Who holds power here? Name three or four factions pulling the strings."* | `factions` | Let the world decide |
| 7 | `region` | *"Last thing — what's this first region called? Or I can name it for you."* | `identity` | Name it for me |

Each carries a `help` line and a concrete `placeholder` (see the module). The
placeholders are Babel's own answers, so the examples are a *worked* world, not lorem —
e.g. landmark: *"a hundred-floor tower at the south pole, leaking something into the
green"*; signature: *"the Green Static — the corruption that eats your sense of
direction."*

### 1b. The bestiary "interview" (questions 4 + 5)

There is **no separate bestiary Q&A** — and that is the design, not a gap. The bestiary
is built from exactly two region answers, then minted by the engine:

- **`threats`** (weakest→worst) → the **threat ladder** (4–6 rungs, rarity ramped
  common→very-rare). `worldDraft.js` `DRAFT_THREAT_MIN/MAX`.
- **`signature`** → the **signature danger** (the one thing players tell stories about),
  which becomes the world's trademark hazard.

Those two answers hand off to `server/campaign/bestiary.js` — the engine (not the LLM)
that mints creatures: base animals + a deterministic **chaos-skill tree** +
**tier-budget-bounded** chaoslings (`THREAT_LADDER`, `TIER_BUDGET`, `mintChaosling`,
`spawnChaosling`). The interview supplies flavor and the ladder; the engine supplies
stat blocks, budgets, and the sight-readable skill data. Keep new-world bestiary work in
the answers + `nameBanks`; real per-world stat blocks are a v2 concern.

---

## 2. The keep / twist / kill pattern

Source: `server/campaign/worldDraft.js`. After one draft call the owner reviews the
generated card tables (`pois`, `factions`, `threatLadder`). Every card defaults to
**keep**; the owner acts only on the exceptions.

- **KEEP** — `keepCard(review, section, id)`. The default. Do nothing to accept a card.
- **TWIST** — `twistCard({ cardType, card, instruction, … })`: regenerate **one** card
  from a one-line instruction ("make it older / darker / tie it to the Charter"). ONE
  provider call; on unusable output it returns the card unchanged with the instruction
  noted — a twist never blocks the review.
- **KILL** — `killCard(review, section, id)`: drop the card. `reviewToDraft` collapses
  the review back to a curated draft with killed cards filtered out.

**The draft-safety ladder** (the house rule for all LLM content — mirrors
`gm/attemptInterpreter.js`): **coerce/repair → strict-validate → re-ask ONCE →
deterministic fallback**. `coerceDraft` clamps counts and ranges and backfills required
strings; `validateDraft` gates accept-vs-reask; `fallbackDraft` builds a coherent thin
world straight from the human answers when the provider is unusable. A world can always
be built.

**Cost discipline** (`createCostLedger`, `CREATION_BUDGET_USD = $0.15`): ONE call per
draft, ONE per twist, and **compilation is free** (deterministic, zero calls). The ledger
records every call and prints an under/over-budget line to the session log.

---

## 3. The canon-block → loader pipeline

A curated draft is assembled into a **world-book** (permissive, authorable data), then
**compiled** into a strict **scenario**, then **loaded** into a run. Compilation and
loading are deterministic — no LLM.

1. **Assemble** — `worldDraft.assembleWorldBook({ draft, interview, overrides })` →
   world-book (`schemaVersion 1`): identity, cosmology, pois, factions, threatLadder,
   nameBanks, plus defaults-drawer overrides (era, tone, genre, orientationMix, deathLaw,
   artStyle).
2. **Compile** — `worldBook.compileWorldBook(book)` → `{ scenario }`. Honors authored
   content and **mints the defaults** for anything absent: starter cast, quest spine,
   **fronts (cap 3, else one grounded default)**, secrets, and the **kept-ground start**.
   `validateWorldBook` is permissive (authoring); `compileWorldBook` is the strict gate.
3. **Load** — `scenarioLoader.loadScenarioIntoRun(run, scenario)` creates committed run
   state:
   - **POIs** → real locations; copies world fields `name, tone, flavor, artStyle,
     variant, era` onto the run.
   - **Region edges** — authored adjacency, then **symmetrized** (a one-way authoring
     slip can strand the player; the loader closes it, touching only real nodes).
   - **Factions** → `run.factions` seeds (standing 0, undiscovered).
   - **Fronts** → `run.threads` via `instantiateThread` (symbolic refs resolved to real
     ids).
   - **traceSeeds** → committed essence trails; rapture/spawn sites mint outbound trails.
   - Board notices ride their location.

**The rule that makes this safe: canon is authored *ahead of* code, so every authored
field needs a proven reader.** If you add a field to the book, confirm the loader copies
it and something downstream consumes it (see §5, "canon ahead of code").

---

## 4. The universal laws every world inherits

These are minted for **every** world, authored or drafted — you do not (and cannot) opt
out per world. Know them so you author *with* them.

1. **Kept-ground starter** — `worldBook.js` (`§ kept-ground start`). Every world begins
   on safe, honest ground: the start location is tagged **`poi:start-area`**, and the
   signature danger is placed so it **never sits on the kept ground** (`worldBook.js`).
   The opening front invites the player deeper but never forces it (`mintDefaultFront`:
   *"Chase the rumor deeper in, or take your time on kept ground first."*).

2. **Anti-lost** — the universal law made from Babel's Green Static. On the kept-clear
   start zone, *orientation is never in doubt*: the narrator directive
   (`gmProvider.js`) forbids narrating getting turned around / vanishing trails /
   rearranging woods / a fixed sun, and the **anti-lost auditor** (`starterZone.js`)
   enforces it. The wrongness lives **beyond** the boundary shimmer, never on it. Keyed on
   the `poi:start-area` tag, so it fires for every world, not just Babel.

3. **Age wall** — `reputation.js` (`isAdult` / `isRomanceEligible`). Romance is
   **FAIL-CLOSED**: it requires an *affirmative adult* age-class. Procedural cast defaults
   adult and is **stamped at mint** so the wall always has data to read; a non-adult is
   never romanceable, and the register ceiling (R10) bites here too. New worlds get this
   free — never hand-wire romance gating.

4. **Era field** — `scenarioLoader.js` copies `world.era`; `scripts/art/promptAssembly.js`
   `eraDescriptor` reads it so minted attire carries the world's era instead of defaulting
   to modern dress. Additive and optional, but **set it** — an unset era renders modern
   clothing regardless of tone (the ERA gap, §5). It lives in the defaults drawer
   (`assembleWorldBook` overrides.era).

5. **Orientation split (romance two-track)** — `reputation.js` `effectiveRomanceTier` +
   the world's `orientationMix`. **Friendship always follows the meter**; **romance is a
   separate, gated track**. The two never collapse into one number, so a warm platonic
   bond never trips a romance beat. Authored per-NPC orientation and the world mix feed
   the gate; the engine owns the rest.

---

## 5. The lessons ledger

Hard-won, in the project's own scars. Read these before authoring; they are the failure
modes that cost real sessions.

- **Canon ahead of code.** A canon field authored before any reader consumes it is
  invisible until the reader ships. The `era` field was wired end-to-end but *empty in
  every world* for weeks — art rendered modern because no book carried it
  (`docs/design/canon-code-gaps.md`; the ERA gap). **Rule:** when you add a canon field,
  add (or verify) its reader in the same change, and put a value in at least one world.

- **Reachability checks.** Authored content the engine can't reach is dead content. The
  minted default front's first beat shipped with a bare `descriptive.keywords` trigger,
  but the engine only honors `descriptive.onCanon.keywords` — so **every world with no
  authored fronts had a dead opening spine** until it was fixed (`threads.js`
  `descriptiveTriggerMet`; `worldBook.js` `mintDefaultFront`). **Rule:** every authored
  trigger/beat must have a test proving it can actually fire.

- **Trigger on committed ids, not display names.** The live identity worker renames NPCs
  (the committed row is `npc_collector`; the fiction calls him "Soren"). Thread/quest
  triggers that key on a display name silently stop matching. `canonKeywordsPresent`
  matches ids and tags, not just prose — **author triggers against committed ids.**

- **Species in the briefing, not just the name.** The Grey was narrated as "a man"
  because the briefing carried only its name, not its species. `server/solo/entityNature.js`
  is the single source of committed species-truth, read by the briefing, the nature
  auditor, and the art affordances. **Rule:** identity/species is committed state read by
  every consumer — never inferred from a name downstream.

- **Fail closed on safety.** The age wall defaults adult *and stamps it at mint* so the
  wall never reads missing data as permission. Safety gates need affirmative data, not
  absent data (`reputation.js`).

- **Symmetrize the map.** Authored adjacency is easy to write one-way by accident; the
  loader symmetrizes edges so a slip can't strand the player (`scenarioLoader.js`).

- **Never trust a draft raw.** AI fills tables; the engine enforces laws. Coerce →
  validate → re-ask once → deterministic fallback, always (`worldDraft.js`).

- **Cap the opening.** Front cap is 3 (`compileWorldBook`). A world that opens ten
  threads at once reads as noise — pick the pull, let the rest emerge.

---

## 6. Recipe — building world #2 (checklist)

1. Write a one-sentence **spark**.
2. Answer the **7 interview questions** (or skip any; or "just build it"). Give real
   answers to `landmark`, `signature`, and `threats` — they carry the most weight.
3. **Draft** (one call), then **keep / twist / kill** the POI, faction, and threat cards.
4. Set the **defaults drawer**: `era` (do not leave blank), `tone`, `artStyle`,
   `orientationMix`, `deathLaw`.
5. **Assemble → compile → load.** Compilation mints the kept-ground start, the default
   front, secrets, cast, and quest spine for anything you left to the engine.
6. **Verify reachability**: confirm the opening front can fire and the start zone is
   tagged `poi:start-area`. Confirm at least one reader consumes every canon field you
   authored (especially `era`).
7. The five universal laws (§4) are already on. Author *with* them.

---

*Owner-tunable surfaces: the interview copy (`worldInterview.js`), draft table sizes and
budget (`worldDraft.js`), threat ladder / tier budgets (`bestiary.js`), and the defaults
drawer (`assembleWorldBook` overrides). Extend these; don't rebuild the pipeline.*
