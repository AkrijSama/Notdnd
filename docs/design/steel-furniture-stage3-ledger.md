# STEEL/FURNITURE — Stage 3 execution ledger (2026-07-21)

The audit (`steel-vs-furniture.md`) named the debt; this is what stage 3 *executed* vs
what it *ledgered*. Net: the governing whitelist widened, 4 ledgered bugs fixed, 5 dead
slots addressed (1 real consumer + 4 tested planned-gates), 1 trivial de-Babel migration
landed. Test net: `tests/steel-furniture-widening.test.js` (8 cases). **Suite is
2344/2344 serial** (`--test-concurrency=1`); parallel runs show a *moving* pre-existing
flake (random-port contention — see memory `test-suite-parallel-flakiness`), unrelated.

## LANDED

| Item | Change | Where |
|---|---|---|
| **Whitelist widening (the governing edit)** | Object/array world knobs now survive load; scalar `sightAccent` added to the string list | `scenarioLoader.js` §0 world block |
| **BUG factions.wants** | Read `f.wants \|\| f.flags?.wants`; loader writes `flags.wants`, old read was always undefined → goal↔faction relevance was name-only | `goalDoors.js:31` |
| **BUG front.reputationEffects** | Scenario front→thread path now carries `reputationEffects` (worldgen path already did; the two closers are reconciled) | `scenarioLoader.js` `instantiateThread` |
| **BUG essenceTrail.band** | Removed the illegal `band:"fresh"` (enum is bright/clear/faint/cold, band is age-derived). `palette:"violet"` KEPT — it is the CHAOS=violet law, not dead | `babel.json` placements |
| **BUG artStyleOptions.allowed** | Seat the scenario's narrowed `allowed` onto `run.world` BEFORE `stampArtStyle`, so babel's `["anime","dark-fantasy"]` binds instead of the worldgen full-STYLES default | `scenarioLoader.js` style block |
| **DEAD SLOT deathLaw → real consumer** | `babel.json` authors `world.deathLaw.epilogue`; loader carries it; scene payload serves it; client death screen prefers it (hardcoded dict kept as resume-safety fallback — behavior byte-identical for babel) | `babel.json`, `scenarioLoader.js`, `scene.js:1425`, `soloSceneShell.js` `deathEpilogue` |
| **DEAD SLOTS orientationMix / systemLore / playerSense / nameBanks → tested planned-gates** | Now carried into `run.world` (reachable) and asserted by the widening test; consumers pending. `nameBanks` was compile-time-only dead → now runtime-reachable | `scenarioLoader.js`, test |
| **Trivial de-Babel migration** | `loc_waking_mile` (a Verdance POI) removed from engine steel `STARTER_ZONE_LOCATION_IDS`; babel carries the `poi:start-area` tag which generalizes it; generic `start_location` kept as pre-tag compat | `starterZone.js:13` |

## LEDGERED — deferred, one line each (moderate / risky / needs a build)

- **progressionMap** (dead slot #5, planned): a full validator with no production writer; a real writer needs `compileWorldBook` to emit it — build, not a one-liner. Left planned.
- **secrets[]** (dead): validated (incl. resolving reveal refs) then discarded; needs a reveal engine — a subsystem, not a widening.
- **threatLadder** (dead): mint uses its own frozen `THREAT_LADDER`; wiring babel's authored ladder would CHANGE mint output (babel's ladder ≠ frozen) — behavior change, needs owner sign-off.
- **MAX_ACTIVE_THREADS** (dead): the ≤3 cap is not enforced by this constant anywhere; wiring it could DROP threads on existing runs — behavior change, ledgered not wired.
- **locations[].notices[]** (dead, 2 carry live questIds): needs a board/discovery consumer to surface the questIds — feature, not a one-liner.
- **services (world level)** (dead): never lowered by `compileWorldBook`; only per-POI `services[]` is live — needs a compile step.
- **VOICE_NPC_ID dead const** (`npcReveal.js:12`): a 1-line delete, but fence-adjacent to CLI-1's VOICE/coherence work — deferred to avoid a cross-fence collision, not on merit.
- §4 MODERATE leaks (`systemLore` module, `actionNarration` VOICE orientation, `babelStats`, `RANK_LADDER`, `imageWorker` BECKONED framing, bestiary corruption blocks): each needs its slot authored + a consumer swap; the `imageWorker` one also touches the sealed art choke-point (`art-path-wall`) — out of stage-3 scope.
- §4 RISKY leaks (`essence.js` whole-module vocabulary rename across 9 modules, `entityNature`/`chaoslingSpawn` coupling, bracketed VOICE god-speech render convention): multi-module renames — do as one dedicated pass, not folded into a widening.
- §4 TRIVIAL not-landed (`suggestions.js` exemplars, `scene.js` sheetSpec/statAliases gates, `styles.css` `--sight-accent`, client `AUTHORED_ORIGIN`/`BABEL_STATS` duplication): the whitelist now CARRIES their slots (`suggestionExemplars`, `sheetSpec`, `sightAccent`, `playerOrigin`), so each is now a one-consumer-swap away; deferred to keep the stage-3 diff auditable.
