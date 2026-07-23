# STEEL vs FURNITURE — what the engine owns, what a world fills in

**Ratified 2026-07-21.** The audit behind the owner order: *"world #2 must be form-filling, not archaeology."*

**STEEL** = hardcoded engine mechanics every world stands on. A world may tune its
*parameters* (Law-6) but can never change the rule.
**FURNITURE** = world-book slots an author fills. The engine consumes them.

The machine-readable version of the furniture table is `WORLD_BOOK_SLOTS`
(`server/campaign/worldBook.js`) — the ONE registry the creator flow, `compileWorldBook`,
the bill of materials, and the schema test all read. Run the BOM for any world:

```
node scripts/world-manifest.mjs babel          # printable
node scripts/world-manifest.mjs --all --md     # every world, markdown
```

---

## 0. THE GOVERNING FACT: a world has three doors, and none is numeric

`server/campaign/scenarioLoader.js:228` is the chokepoint:

```js
for (const k of ["name","tone","flavor","artStyle","variant","era","sceneRegister"]) {
  if (isString(scenario.world[k])) run.world[k] = scenario.world[k];
}
```

Only these **string keys** of `scenario.world` survive into `run.world`. Everything else
authored there is silently dropped at load. The three working doors are:

| Door | file:line | Carries |
|---|---|---|
| Structural content | `scenarioLoader.js:265-360` | locations, cast, fronts, quests, factions, `bestiary.placements`/`statBlocks` |
| `scenario.world` whitelist | `scenarioLoader.js:228` | the strings above, and nothing else |
| `playerOrigin` | `scenarioLoader.js:251-263` | ability boost + named feat (clamped 1..30) |

`validateWorldState` (`server/solo/schema.js:626-677`) does **not** reject unknown keys, so
`run.world` is structurally an open bag — a tuning block *could* ride there with no schema
change. **The loader whitelist, not the schema, is what blocks Law-6 sovereignty.** That one
line is the highest-leverage edit in the codebase; widening it is how every deferred
migration below lands.

---

## 1. STEEL — the mechanics, and their Law-6 parameter surface

"Hook today" = does a per-world tuning path exist?

| Subsystem | Core impl | FIXED LAW (never tunable) | Parameter surface (what a world *may* legitimately tune) | Hook today |
|---|---|---|---|---|
| **CTB turn queue** | `solo/ctb.js:19-22,41-108` | Turn order is a delay-accumulator clock; queue ops defined once | `CTB_BASE 1200`, `SPEED_MIN 8`/`MAX 16`, `FORECAST_SLOTS 8`, haste ×1.5 / slow ×0.5, stun-immunity after 2 pushes | **ABSENT** |
| **Three-band resolution** | `solo/rules.js:111-122` | Resolver owns the band; nothing downstream authors it | middle-band width `margin >= -4` (a locked flat 20% of the d20) | **ABSENT** |
| **Entry gate / DC** | `solo/attempt.js:77-89` | A provider-proposed DC is floored so a bluffed DC can't make a contested attempt free | `RESOLUTION_DC_FLOOR 8`, `RETRY_DC_BUMP 5`, `FAILED_ATTEMPT_DAMAGE 2` | **ABSENT** |
| **Statuses (sealed ten)** | `solo/combatStatus.js:12-38` | The engine never grows: every named affliction compiles to one of ten | tick percentages (poison −0.1 / regen +0.1), default durations, **and the world's own vocabulary** | **EXISTS — the model.** `statusForRider()` + `RIDER_TO_STATUS`: a world names a "chill", the engine compiles it to `slow`. Mechanism sealed, vocabulary free. |
| **Morale / flee** | `solo/combat.js:633-652,761-787` | Flee is a declared creature trait, never a default | `injured hpFrac<=0.34`, `outmatched>=0.5`, `breakChance=(1-hpFrac)*70 (+20 cowardly)`, player flee `dc=10+fastest` | **PARTIAL** — `behaviors.{cowardly,injured,vicious}` per stat block is real world data; thresholds are not |
| **Reputation** | `solo/reputation.js:58-94` | Ascending-`min` tier tables; `tierFor` returns the highest tier met | all tier thresholds (individual/faction/romance), `METER_MAX 50`, `SOCIAL_AFFINITY_BASE` | **ABSENT** — consts are commented "owner-tunable" but read from no world file |
| **Romance two-track** | `solo/reputation.js:152-172` | Friendship is platonic ALWAYS; promotion needs an explicit committed switch **and** a per-tier gate event | `ROMANCE_PLATONIC_CEILING "close"`, romance tier mins, orientation mix | **ABSENT** (`orientationMix` is authored but dead — §3) |
| **Threads** | `solo/threads.js:46-58` | ≤3 active threads (anti-noise); the reveal ladder only ratchets up | `MAX_ACTIVE_THREADS 3`, `SEED_DEADLINE_MINUTES 180` | **PARTIAL** — fronts are rich world data; the caps are not |
| **Player goals** | `solo/goalDoors.js:20` | Goal scale sets deadline class; a goal is committed state the narrator may not invent | `GOAL_DEADLINE_MINUTES {project 4320, ambition 10080}` | **ABSENT** + a world-name branch at `:175` (§4) |
| **Affordances** | `solo/affordances.js:34-43` | Two-tier feasibility (`ok`/`gated`); a chip is committed state with a diegetic gate reason | service kinds, chip cap (`SOLO_AFFORDANCE_CAP 7`) | **PARTIAL** — per-POI `services[]` drives service chips |
| **Map layout** | `solo/layout.js:22,48-52` | Deterministic mint from location seed — same seed, same layout forever | `GRID_SIZE 12`, the template library | **PARTIAL** — per-location `layout`/`layoutTemplate` pins are world data, but the template library is ONE global file, not per-world |
| **World clock** | `solo/worldClock.js:23-67` | Real-minutes clock; phase derived, never authored | `DAY_MINUTES 1440`, phase bands (dawn 5-7 / day 7-18 / dusk 18-21), action costs, `TRAVEL_MINUTES 10`, `REST_HOUR_MINUTES 60` | **ABSENT** |
| **Progression** | `solo/progression.js:14-99` | Milestone is server truth; level is its computed display mirror | `MILESTONE_MAX 20`, `XP_AWARDS`, `HP_PER_MILESTONE 5`, curve `50·m·(m−1)`, `TIER_FLOOR`, the rank ladder | **BUILT BUT DEAD** — `run.worldBook.progressionMap` has a full validator and **no production writer** (§3) |
| **Bestiary / minting** | `campaign/bestiary.js:150+,217-231` | Chassis + tier-budget-bounded corruption, deterministic on (species, seed) | `TIER_BUDGET` (hp/ac boosts, skill counts), base-animal stat rows, the threat ladder, `socialCapable` | **PARTIAL** — `statBlocks`/`placements`/`spawnOnEnter` are live world data; `threatLadder` is authored but **not read** (§3) |
| **Essence-sight** | `solo/essence.js:52-70,369` | Server-owned committed traces; the narrator may describe but never invent (`index.js:2520`) | `TRACE_EXPIRY_MINUTES`, band words, sight phrases | **ABSENT** — mechanism is generic, vocabulary is hardcoded (§4) |
| **Quests / fronts / secrets** | `campaign/scenarioSchema.js:256-338` | ≤3 fronts, ≤1 foreground; 2–4 beats; every beat commits exactly one payload; a danger front never resolves by expiry alone | front kinds, topology, triggers, payloads, resolution | **EXISTS — richest authoring surface in the repo.** But `secrets` is dead (§3) |
| **Narrator + auditors** | `index.js:2391-2529`, `gm/actionNarration.js:55-62` | **Model describes, never adjudicates** — `stateMutations` always `[]`; wounds spoken in bands, never raw HP | word cap (120), fact-selection weights, safety length | **PARTIAL** — `world.tone`/`flavor` reach the prompt; `data/campaigns/<id>/style.json` is a real hook, but per-**campaign**, not per-**world** |
| **Art style lanes** | `solo/artStyle.js:304-359` | Style locks at run creation; checkpoint derives from validated exports; the seal applies at one choke-point | `artStyleOptions.{default,allowed}`, `sceneRegister` | **EXISTS — working exemplar.** babel: `{"default":"anime","allowed":["anime","dark-fantasy"]}` |
| **Starting state** | `solo/schema.js:1780-1841` | — | health 10, all abilities 10, stamina 6, gold 0, milestone 1, clock 07:00 day 1, weather clear | **ABSENT — no world hook whatsoever** |

### The three patterns worth copying
1. **The rename law** (`combatStatus.js:28-38`) — the cleanest split in the codebase. Seal the mechanism, free the vocabulary.
2. **`artStyleOptions`** (`artStyle.js:347-359`) — a world declares `{default, allowed}`; the engine narrows and preserves.
3. **`sceneRegister`** (this pass) — a world supplies a tone clause; the engine default is empty.

---

## 2. FURNITURE — the world-book slots

Authoritative machine-readable list: `WORLD_BOOK_SLOTS` in `server/campaign/worldBook.js`.
`defaultKind`: `required` (name only) · `table` (a frozen `DEFAULT_*`) · `literal` (a scalar
const) · `mint` (synthesised at compile) · `empty` (an explicit empty collection is the floor)
· `planned` (declared by law, engine-unbuilt).

**THE LAW: no slot may be default-less.** `{name, vibe}` must always compile to a playable
world. Enforced by `defaultlessSlots()` + `tests/world-book-slots.test.js`.

| Slot | Default / mint (the ONE place) | Consumed by |
|---|---|---|
| `name` | **required** — the sole hard requirement | scenario.title, world.name |
| `vibe` | `""` | opening.situation, stakes, front/secret mint copy |
| `identity.era` | `""` | art pipeline era injection |
| `identity.tone` | `DEFAULT_TONE "grounded"` | world.tone → narrator register |
| `identity.genre` | `DEFAULT_GENRE "adventure"` | scenario.genre |
| `cosmology` | mint — falls back to `vibe` | world.flavor → narrator world brief |
| `poiTable` | mint — `compileWorldBook §1.4` mints one "beyond" POI | locations → map, travel, scene art |
| `startArea` | mint — `keptGroundStart()` | opening.startLocationRef; starter-zone auditor via `poi:start-area` |
| `factions` | `[]` | reputation engine; cast factionId |
| `threatLadder` | `DEFAULT_THREAT_LADDER` | **NONE — dead (§3)** |
| `bestiary` | mint — `compileBestiary()` + `mintStarterEncounter()` | combat stat blocks + placements |
| `nameBanks` | `DEFAULT_NAME_BANKS` | cast mint, POI mint, creature epithets (compile-time only) |
| `orientationMix` | `DEFAULT_ORIENTATION_MIX` | **NONE — dead (§3)** |
| `deathLaw` | `DEFAULT_DEATH_LAW` | **NONE — dead (§3)** |
| `services` | `DEFAULT_SERVICES []` | **NONE at world level — dead (§3);** only per-POI `locations[].services[]` is live |
| `fronts` | mint — `mintDefaultFront()` | threads engine (`scenarioLoader.js:527` lowers fronts → `run.threads`, cap 3) |
| `secrets` | mint — `mintDefaultSecret()` | **NONE — dead (§3)** |
| `cast` | mint — `mintStarterCast()` | NPC roster, dialogue, romance, portraits |
| `questOffers` | mint — `mintQuestSpine()` | quest engine; opening.questObjectiveFrom |
| `quests` | `{}` | quest engine (authored arcs) |
| `opening.situation` | mint — threshold template | first narrated beat |
| `world.artStyle` | `DEFAULT_ART_STYLE "illustrated"` | art lane selection |
| `world.sceneRegister` | `""` (engine default) | scene prompt tone clause — **migrated to furniture this pass** |
| `figures` · `artifacts` · `powerSystems` · `background` · `handbook` | **planned** | **NOT BUILT** — see §5 |

### Per-location furniture (live, but unreachable from the creator)
`layoutTemplate` · `layout` · `spawnOnEnter` · `notices` · `traceSeeds` · `searchDetails`
are consumed by the loader from an **authored** scenario, but `compilePoi`
(`worldBook.js`) silently **drops** them — so no *created* world can ever carry them.

---

## 3. DEAD SLOTS — authored and/or validated, consumed by nothing

Every row verified by grep returning zero production consumers. **This is the section that
matters most to an author**: filling these changes nothing until a consumer ships.

| Slot | Where it's declared | Status |
|---|---|---|
| `secrets[]` | required + exhaustively validated (`scenarioSchema.js:409-413`, even resolving `reveal.onLocation`/`onEntityKnown` refs) | `scenarioLoader.js` never mentions `secrets`. Validated, then discarded. No reveal engine exists. |
| `world.orientationMix` | `worldBook.js` | Compiled onto `scenario.world`, dropped by the loader whitelist. The romance path never consults it. |
| `world.deathLaw` | `worldBook.js` | Same. The real epilogue is a **hardcoded client dict** keyed on scenarioId with only `babel` populated (`soloSceneShell.js:3247-3255`). |
| `threatLadder` | `worldBook.js`, `babel.json` | The mint engine uses its own frozen `THREAT_LADDER` (`bestiary.js:217`). **Two ladders, one consumed.** |
| `services` (world level) | `normalizeWorldBook` | Never lowered by `compileWorldBook`. |
| `world.nameBanks` | `worldBook.js` | Compile-time only; runtime NPC minting uses `npcIdentity.js FALLBACK_NAMES`. |
| `locations[].notices[]` | `scenarioLoader.js:316` writes them | **Zero readers.** Babel's largest authored prose block (5 notices), two carrying live `questId`s that therefore can never be discovered through the board. |
| `run.worldBook.progressionMap` | `progression.js:116-215` — full validator + cap overrides | **No production writer.** A complete Law-6 subsystem, unreachable. |
| `MAX_ACTIVE_THREADS` | `threads.js:46` | Declared; never referenced anywhere in `server/`. |
| `fronts[].telegraph` | required by schema, copied by loader | Never reaches a prompt (`buildThreadNarrativeDriver` sends only label/brief/decision). |
| `fronts[].foreground` · `.topology` · `.reputationEffects` | schema | Not copied by `scenarioLoader.js:116-133`. Two divergent front→thread instantiators; `threads.js:581` reads `reputationEffects`, the scenario path does not. |
| `world.artStyleOptions.allowed` | `babel.json` | Silently discarded — `stampArtStyle` preserves the run's pre-existing `allowed`, so babel's narrowed list never binds. |
| `essenceTrail.band`/`.palette`/`.kind` · `placements[].reachableFrom`/`.note` · `bestiary.version`/`.engine`/`.doc`/`.nameFlavor` · `cast[].revealEvent` · `factions[].disposition` · `quests{}.summary` · `scenario.title` · `genreTags` (server) | various | Written and never read. Note `essenceTrail.band: "fresh"` in babel.json is **not even a legal value** — the engine enum is `bright/clear/faint/cold` and band is derived from age. |

### Live bug found by this audit
**`factions[].wants` never reaches its consumer.** `scenarioLoader.js:489` writes
`faction.flags.wants`; the one consumer `goalDoors.js:31` reads top-level `f.wants` →
always `undefined`. Faction↔goal relevance silently degrades to name-only matching.

---

## 4. BABEL CONTENT LEAKED INTO STEEL — the migration ledger

37 findings. Each becomes a furniture slot with Babel as the first filler. **✅ = migrated.**

### Migrated this pass
| Leak | Was | Now |
|---|---|---|
| ✅ **Scene tone law** `imageWorker.js:1513` | `"beautiful yet subtly wrong, uneasy stillness, faint shimmer in the air, over-still water, off light"` appended to **every scene prompt of every world** — a cyberpunk alley rendered with over-still water | `world.sceneRegister`, engine default `""`; babel.json carries the Verdance original. Babel's prompt byte-identical; other worlds clean. |

### Deferred — TRIVIAL (one-line, independently landable)
| file:line | Leak | Proposed slot |
|---|---|---|
| `index.js:1276`, `onboarding.js:1124`, `oocGrounding.js:128`, `index.js:2369` | `buildSystemLoreClause()` / `detectSystemLoreViolations()` fire **unconditionally** for every world | no-op when `world.systemLore` absent |
| `index.js:1281` | `buildEssenceTraceDirective(run)` unconditional ("reads NO essence trace here" fires for any world) | gate on `world.playerSense` |
| `suggestions.js:199` | Few-shot primes **every** world with Babel NPC + POI (`"Ask Grace what a license actually buys"`, `"…Hollow Pine"`) | `world.suggestionExemplars[]` |
| `scene.js:847,850` | `run.world.variant === "babel" ? babelStatBlock(...) : null` | gate on `world.sheetSpec` presence |
| `scene.js:1451` | `displayName: … : "The VOICE"` | `"Narrator"` / omit |
| `attempt.js:528-530` | `abilityForBabelWord(value)` | `world.sheetSpec.statAliases` |
| `combat.js:519-523` | `playerHasFocus` gated by `/beckoned|status window|essence/` regex on a world's origin string | `world.playerSense.grantsCombatFocus` |
| `goalDoors.js:175-179` | `variant === "babel" ? "[ YOU RETURN TO THIS… ]" : "You keep coming back…"` | `world.speechConventions.systemAskTemplate` with `{GOAL}` |
| `starterZone.js:13` | `STARTER_ZONE_LOCATION_IDS = new Set(["start_location","loc_waking_mile"])` — a Verdance POI hardcoded into engine protection | delete; the `poi:start-area` tag path (line 12) already generalizes |
| `styles.css:5667` | `:root { --sight-accent: #8b5cf6 }` for all worlds | `world.sightAccent`, keep `#8b5cf6` as default |
| `bestiary.js:359` | `LIMPING_GREY` spliced into the frozen engine `REGISTRY` | drop from merge (after the row below) |
| `main.js:722`, `onboardingFlow.js:239-246,109-117` | `AUTHORED_ORIGIN = { babel: "The Beckoned" }`; full Babel origin prose + world-select catalogue hardcoded client-side | serve from `scenario.playerOrigin` / a server-served catalogue |
| `soloSceneShell.js:1435-1446,1628` | client duplicate of `BABEL_STATS`; `"The Beckoned"` / `"UNASSESSED"` literals | delete (server payload authoritative); `world.rankLadder.unrankedLabel` |
| `soloSceneShell.js:3247-3254` | `DEATH_LAW_EPILOGUE = { babel: … }` | **the slot already exists** — add `deathLaw.epilogue` to babel.json + widen the scene `world` payload |
| `npcReveal.js:12` | `VOICE_NPC_ID = "npc_voice"` | dead code — delete |
| `worldInterview.js:55-72`, `worldCreator.js:26-29` | Babel used as the interview's worked example, duplicated client+server | `INTERVIEW_EXEMPLARS` data file, single source |

### Deferred — MODERATE
`gm/systemLore.js:12-28` (the whole module is one world's cosmology → `world.systemLore`) ·
`actionNarration.js:575-585,622-625` (VOICE orientation + "farthest from the Tower" +
Babel-prose GM fallback → `world.opening.orientationBeats[]` / `world.startArea.register`) ·
`gmProvider.js:322` ("Her kept-clear ground", "the shimmer") · `babelStats.js:19-41`
(→ `world.sheetSpec.stats[]` / `.statAliases`) · `progression.js:92,104-112`
(`RANK_LADDER E…DG` is a Solo-Leveling ladder → `world.rankLadder`; run field
`player.babelSkills` → `rankedSkills`) · `imageWorker.js:725-741,800-836` (`BECKONED_ORIGIN_RE`
+ `MODERN_EARTH_SUBJECT` → `world.playerOrigin.artFraming`; **touches the sealed art
choke-point + `art-path-wall`**) · `bestiary.js:112-135,241-246,323-355` (`rapture_drifter`,
`LIMPING_GREY`, `CHAOS_VIOLET_MARKERS` → `babel.json bestiary.statBlocks` +
`world.corruption`; the runtime-overlay path already exists at `bestiary.js:361-381`).

#### MODERATE — routability audit (2026-07-21, the leaks pass)

Each moderate item was traced end-to-end against the runtime data flow. **The finding:
none of the object-shaped moderate migrations is independently landable — every one is
gated on the loader whitelist (`scenarioLoader.js:233`) and/or the `WORLD_BOOK_SLOTS`
registry (`worldBook.js`).** This is §0's GOVERNING FACT made concrete: `run.world` is the
only runtime carrier, and it is whitelisted to seven **string** keys. `run.worldBook` and
`run.scenario` **do not exist at runtime** (verified: the only mention is a dead
`CONTRACT.md` note for `progressionMap`). So any object/array/new-string world field is
DROPPED at load and never reaches the consumer.

The regression gate cannot be met inside a single fenced commit: to keep Babel byte-identical
the moved field must REACH Babel at runtime (needs the loader), and to close the leak the
engine default must be neutral — but a neutral default that never receives world data drops
Babel to nothing. The "additive local constant + ledger-for-merge" mechanism cannot square
this: a Babel-carrying default still leaks to every world; a neutral default breaks Babel
until the loader is widened. **These migrations are therefore CLI-2-gated, not deferrable-by-choice.**

| Item | Target | Runtime carrier needed | Blocking fence | Exact unblock (CLI 2) |
|---|---|---|---|---|
| `gm/systemLore.js:12-28` | `world.systemLore` (object) | `run.world.systemLore` | loader whitelist is string-only | object copy at `scenarioLoader.js:233` + `WORLD_BOOK_SLOTS.systemLore` slot |
| `actionNarration.js:575-585,622-625` | `world.opening.orientationBeats[]` / `world.startArea.register` (array/object) | `run.world.opening` / `run.startArea` | same | loader object-copy + two registry slots |
| `babelStats.js:19-41` | `world.sheetSpec.stats[]` / `.statAliases` (object) | `run.world.sheetSpec` | same | loader object-copy + `sheetSpec` slot |
| `progression.js:92,104-112` | `world.rankLadder` (array) + run `player.babelSkills`→`rankedSkills` | `run.world.rankLadder` + a run-field rename | loader (array) **and** a `run.player` schema rename across persistence | loader array-copy + `rankLadder` slot; the `rankedSkills` rename is its own schema+DB migration |
| `imageWorker.js:725-741,800-836` | `world.playerOrigin.artFraming` (new field on the origin object) | `run.playerOrigin.artFraming` | the `playerOrigin` door (`scenarioLoader.js:251-263`) carries only ability-boost + named feat; a new field is dropped — **and this is the SEALED art choke-point (`art-path-wall`)** | widen the playerOrigin copy + a wall/drift-test-guarded art change (high-risk, own pass) |
| `bestiary.js` `rapture_drifter`/`LIMPING_GREY` | `babel.json bestiary.statBlocks` (overlay door is OPEN) | already reachable via `registerStatBlock` (`scenarioLoader.js:146-149`) | **not the loader — the FROZEN-BLOCK test contract.** ~8 tests (`verdance-bestiary`, `missing-rungs`, `combat-narration`, `scene-hostile-injection`, `combat-battle-surface`, `combat-door`, `minted-block-pruning`, `combat-grey-depth`) call `resolveStatBlock("limping_grey"/"rapture_drifter")` directly with no scenario load; `minted-block-pruning` asserts frozen blocks are NEVER pruned | moving to the runtime overlay inverts the prune contract and breaks those tests — land only alongside a test-contract rework, not as a "moderate" |
| `server/solo/gmProvider.js:322` | prose → `world.startArea.register` | `run`-derived `location.starterZone` (already flows) | **CORRECTED (CLI-2):** the file EXISTS — at `server/solo/gmProvider.js:322`, not `server/ai/`. The "Her kept-clear ground"/"the shimmer" strings are a starter-zone anti-lost directive **gated on `location.starterZone`** (the generic tag path). Not a phantom; a real deferred prose→furniture migration | keep the anti-lost LAW generic; move only the Verdance flavor prose to `world.startArea.register` (own pass — has an em-dash that trips the authored-content ban) |

**Essence-vocabulary family (the 9-module span, JOB 2.3):** same wall. All vocabulary
(`SIGHT_PHRASES`, `TRACE_BAND_META`/`TRACE_KIND_META` words, the "champion / essence /
demon-essence" directive register) lives as module-level constants in `essence.js`; the
**trace CONTENT** (sources, `handlerScent`, seeds) already flows from world data via
`scenario.traceSeeds` → `run.essenceTraces`, but the **register layer** takes no world handle.
Routing world vocabulary in would require either `run.world.*` (fenced loader) or threading a
worldBook handle through all 10 consumers **plus** the client mirror (`soloSceneShell.js:1832`,
bound to the server copy by the `em-dash-server-strings.test.js:71` `deepEqual` parity lock)
plus rewriting `essence-sight`, the parity, and `nature-coherence` tests (which assert the exact
Babel strings). Deferred as a coherent CLI-2-gated commit. **One in-family coherence bug was
fixed in this pass without migration:** `buildEssenceTraceDirective` hardcoded the male pronoun
"it is his sight alone" for every player of every world (misgenders non-male players even in
Babel) → neutralized to "it is theirs alone" (register tests stay green; no world data needed).

#### MODERATE — RE-AUDIT against the WIDENED loader (2026-07-21, CLI-2)

The routability table above was written when `scenarioLoader.js:233` was string-only. Stage 3
(`c0f2662`) then widened it to carry object/array world knobs — **the recorded blocker went
stale.** Re-audited each held item against the shipped loader (carry set:
`deathLaw, orientationMix, systemLore, playerSense, speechConventions, rankLadder, sheetSpec,
nameBanks` [objects] · `suggestionExemplars` [array] · `sightAccent` [string]). Verdicts:

| Item | Verdict | Precise mechanism |
|---|---|---|
| **systemLore** | ✅ **LANDED** (`cb59330`) | Carrier `run.world.systemLore` is in the widened set. Migrated: babel authors it, consumers read it, engine default neutral. Byte-identical bar one justified em-dash→comma diff. Live door: the narrator/opening/OOC prompt clause. |
| **actionNarration beats** | **STILL BLOCKED (loader)** | Carrier `run.world.opening` / `run.startArea` is **not** in the widened set — probes confirm both are dropped at load. *Also:* babel uses `opening.authoredBeats`, so `buildOpeningGmMessage`'s Babel prose is DEAD for babel and leaks only into the **worldgen** opening builder — the fix is a worldgen de-Babel gating change (test surface: `solo-action-narration.test.js`, `server-clearout.test.js` item 2), not a byte-identical world-knob carry. Its own pass. |
| **sheetSpec** | **STILL BLOCKED (client, not loader)** | The loader now **carries** `run.world.sheetSpec` (probe confirms). The live blocker moved to the CLIENT: the STATUS WINDOW render is hard-gated `world.variant === "babel"` at `soloSceneShell.js:1429` (**CLI-1 fenced**). A server-only generalize (`scene.js:862`) is byte-identical for babel and **dead furniture** for every other world (pre-mortem b). Needs the client gate generalized. |
| **rankLadder** | **STILL BLOCKED (three ways)** | (a) `RANK_LADDER` is an ARRAY; `carryObject` skips arrays, so an array `world.rankLadder` is dropped (probe confirms). (b) `player.babelSkills`→`rankedSkills` is a separate schema+persistence rename. (c) the rank display door is variant-gated at `soloSceneShell.js:1429` (CLI-1 fenced). Display-only; no non-Babel consumer. |
| **imageWorker art-framing** | **STILL BLOCKED (art pass)** | Carrier `run.playerOrigin.artFraming`: the playerOrigin door (`scenarioLoader.js:255-267`) copies only boost/name/feat — a new field is dropped (probe confirms). AND it is the SEALED art choke-point (`art-path-wall`). Not a loader widening; a drift-guarded art pass. |
| **bestiary rapture_drifter / LIMPING_GREY** | **STILL BLOCKED (test contract) — report only** | Not the loader (overlay door open). Inversion required: moving to `babel.json bestiary.statBlocks` makes `resolveStatBlock` return null with no scenario load → breaks ~8 tests, and `minted-block-pruning`'s "frozen blocks are NEVER pruned" contract inverts. Safe only WITH a test-contract rework (load babel / seed the overlay in those tests; redefine the prune invariant to "never prune a block referenced by an active encounter"). Not a moderate fold-in. |

**NET: 1 landed (systemLore), 5 correctly held.** The held five are blocked by NEW/OTHER fences
(client variant-gate in a CLI-1 file · a DB-field rename · the art choke-point · a frozen-registry
test contract) — not by the loader. Landing any server-only half would ship dead furniture.

### JOB 3 — THE HELD-ITEM CONTRACT (the anti-stale-blocker law)

Two robots passed each other and a blocker went stale **silently**: CLI-1 held four items on
"loader is string-only"; Stage 3 widened the loader; nothing turned red; systemLore sat falsely
"blocked". **A stale blocker is a process bug, not just a code bug.** The law, from here on:

> **Every HELD item MUST record (a) its exact blocking mechanism as `file:line`, and (b) a
> machine-checkable UNBLOCK CONDITION.** A held item without both is not "held" — it is
> forgotten. The rows above comply: each names its mechanism and the observable that flips it.

**Machine-checkable enforcement:** `tests/held-item-contract.test.js` encodes each still-held
blocker as a runtime probe (inject the carrier into a babel load; read the client gate as text;
resolve the frozen block with no scenario). **When a blocker stops describing reality — the loader
widens, the client gate generalizes, the run field is renamed, the frozen registry is reworked —
the matching assertion goes RED and names the item to re-audit.** Green = the HELD list is honest.
This is the exact check that would have caught the systemLore staleness the moment Stage 3 shipped.

*Honesty note:* this net is cheap and real for the loader/client/registry blockers (all are
observable from a test). It does **not** attempt to prove a *negative-of-a-negative* (e.g. "no
future consumer will read a carried-but-dead knob"); that is the route-inventory law's job, done
per-migration in prose, not by a standing check.

### Deferred — RISKY / arguably generic law
`essence.js` whole module (`SIGHT_PHRASES`, "the champion's sight", hardcoded male pronoun) —
**9 consuming modules**; do as one vocabulary rename with the ~12 `ESSENCE-SIGHT` tag sites ·
`entityNature.js` + `chaoslingSpawn.js` (coupled to that rename) ·
`soloSceneShell.js:307-322` + `styles.css:3616` (bracketed VOICE god-speech is a *rendering*
convention, but it is Babel's) · `starterZone.js:30-48` `LOST_MOTIF_PATTERNS` — **leave in
engine**, anti-lost is declared universal; only the calibration is Babel-derived.

### The inverse — steel stranded in `babel.json`
Essentially clean. `bestiary.engine`/`version`/`doc` and babel's `threatLadder` are the
**documented compile contract** (`compileBestiary` emits exactly that shape), not leaks.
The only real items: `essenceTrail.band`/`palette` (dead + illegal value) and a `note`
restating `bestiary.js` intent. Two-field deletion. **The leak is one-directional:
content flowed into the engine; mechanics did not flow out.**

---

## 5. PLANNED FURNITURE — the real world-#2 gap

`docs/ROADMAP-CANON.md` **locks** the "Law of Creating Worlds" valid-world schema as
*factions, figures, artifacts, power-systems, background*, plus per-world handbook chapters
(races/classes/power-systems/bestiary/lore live in the per-world book; the main manual is
world-agnostic chassis only).

**The engine consumes none of `figures`, `artifacts`, `powerSystems`, `background`, or
`handbook`.** They are declared as `planned` slots so an author sees the true shape of the
form and the BOM reports honest gaps. Babel's manifest surfaces exactly these — which is
the acceptance test: *Babel's gaps are key figures and handbook chapters*, not engine coverage.

---

## 6. Where defaults still diverge (the "ONE place" backlog)

| Default | Sites | Divergence |
|---|---|---|
| artStyle `"illustrated"` | `DEFAULT_ART_STYLE` · `artStyle.js:47` `DEFAULT_ENGINE_STYLE` · `worldCreator.js:258` · `main.js:880` | 4 sites, 2 unaware of the constant |
| threat-ladder rarities | `DEFAULT_THREAT_LADDER` · `worldDraft.js:189-191` · `:126` · `:301` | **three contradictory rarity tables** |
| faction `disposition` / `wants` / `standing` | `worldDraft.js:119-120,184-185,296,389` | 2–3 values each; creator factions can never author standing or secrecy, unlike babel |
| interview questions | `worldInterview.js:19-76` · `worldCreator.js:22-30` | full copy-paste of all 7 questions (parity-tested, still two sources) |
| poiClass / dangerLevel | `worldDraft.js:96,109,304` vs `compilePoi` | draft defaults to `1`, compile emits nothing |

### Creator-pipeline leaks (furniture that never arrives)
- **`signatureDanger` is thrown away** — the interview asks for it, both draft paths build
  it, and `assembleWorldBook` never copies it into the book.
- **`nameBanks` is never world-flavored** — `assembleWorldBook` reads `draft.nameBanks`, but
  no draft path ever produces that key. **Every created world ships with the generic
  Mara/Corin/Wayrest floor**, and those banks drive the minted cast, the encounter epithet,
  and the beyond-POI name.
- `compileWorldBook` never mints `genreTags`, `playerOrigin`, `artStyleOptions`,
  `authoredBeats`, or `quests` — five slots babel fills that no created world can have.

---

## 7. Doc-vs-code drift corrected by this audit
- `worldBook.js` "The engine reads them" (of `orientationMix`/`deathLaw`) — **false**, corrected.
- `scenarioLoader.js:295` "drives the regionMap hazard read" (of `dangerLevel`) — **false**; `regionMap.js` has no danger reference.
- `world-book-schema.md:64` "locations mint their own services" — no such mint exists.
- `world-book-schema.md:96-98` threat-ladder / name-bank re-skin — unimplemented.

---

## 8. THIRD-PASS RECONCILIATION (2026-07-22, CLI-2) — end the loop

The audit re-surfaced this class a third time. Reconciled against §4's ledger + the held-item
contract. **The contract's probes did NOT fire on the new findings** — it only probes the 5
recorded held items through ONE door (`scenarioLoader`). Three blind spots let new instances
through: (1) new leaks/drops (nothing probes "authored + read + not-carried"), (2) the second
door (`compileWorldBook` never probed — a field wired for one door, dead for the other), (3) the
hand-maintained manifest prose. This pass converts all three into red tests.

### Landed (verified: Babel byte-identical + non-Babel neutral + a live door)
| Job | Fix | Guard added |
|---|---|---|
| **JOB 1 (F2/F3)** | `scene.js` `rank`/`rankedSkillCount` were emitted UNGATED for every world; now `variant==="babel"`-gated exactly like `babelStats`. Door: the STATUS WINDOW readout. | `rank-gate-furniture.test.js` |
| **JOB 3 (mirror bug)** | `world.plausibleFauna` (authored, read at `absentTarget.js:124`) was dropped; now carried. **Full enumeration**: of every authored Babel world key with a live `run.world` reader, plausibleFauna was the ONE drop (startingLocationName/Type are carried by a separate loader path :389-393). Door: the absent-target grounder. | `world-key-carry-parity.test.js` — fails if ANY authored+read key is dropped |
| **JOB 4 (two doors)** | `scenarioLoader` and `compileWorldBook` carried different world-knob sets. Both now read ONE registry `CARRIED_WORLD_KEYS` (`scenarioLoader.js`); `compileWorldBook` passes through every carried knob the world-book declares. A creator-authored `sheetSpec`/`rankLadder` now reaches `run.world`. | `two-doors-parity.test.js` — fails on divergence |
| **JOB 6 (manifest)** | `deathLaw` manifest entry falsely read "DEAD SLOT" after the slot was wired (scene.js:1477 emits it, the death screen reads it). Corrected. Self-check policy: a reader-derived `consumer` field is not cheap, so the machine-derivable BOM (defaults→filled/gap) stays self-checking and the drift point (deathLaw LIVE) is test-locked. | `manifest-honesty.test.js` |

### HELD — recorded blocker + machine-checkable unblock (per the held-item law)
Not landed this pass (regression-risk / multi-system / test-contract inversion); each keeps its
`held-item-contract.test.js` probe so it goes RED the moment its blocker stops describing reality.
| Job | Blocker (file:line) | Unblock condition |
|---|---|---|
| **JOB 2** chaosling/violet mint → world.corruption | `bestiary.js:241-319` mint is deterministic Babel canon; moving to data must reproduce the violet mint byte-identical (pre-mortem b) | a `world.corruption` slot + `mintChaosling` reads it + a golden byte-identical test for babel's tier-1 mint |
| **JOB 5** rankLadder→progression / sheetSpec→status window / threatLadder→encounters | rankLadder is an ARRAY (loader `carryObject` skips it — `held-item-contract` rankLadder probe); sheetSpec's STATUS WINDOW render is `variant==="babel"`-gated in the client (`soloSceneShell.js:1429` — sheetSpec probe); threatLadder unread (`bestiary.js:217`) | carry the array + progression reads `world.rankLadder`; generalize the client gate to `world.sheetSpec`; encounter selection reads `world.threatLadder`. NOTE: `sightAccent` wiring is `styles.css` — **CLI-1 fenced this pass**, not touched |
| **JOB 7** VOICE forms + Limping Grey → babel | forms authored path is `entityForms.js` runtime-only (ships, reads `npc.forms` first); the Grey is a FROZEN registry block — moving it to the babel overlay inverts `minted-block-pruning`'s "frozen blocks never pruned" contract + breaks ~8 tests (`held-item-contract` bestiary probe) | ship the world-book `forms` authoring schema; rework the frozen-block test contract (seed the overlay / redefine the prune invariant) THEN move the Grey |

**What ends the loop:** the two new class-guards (`world-key-carry-parity`, `two-doors-parity`)
plus the corrected manifest self-check mean the next authored-but-dropped key, the next
one-door-only field, and the next stale manifest claim each turn a test RED and name themselves —
the exact silent-drift that made this a third pass.
