# Canon-Code Gap Ledger (v1)

Canon that is ahead of code, in one place, so ratified law never silently rots
as unbuilt intent. One row per gap; the owner assigns priority. Rows get CLOSED
(struck to the bottom section) when the code ships and is verified.

Maintained by hand at every reconcile pass. Source laws:
docs/design/romance-legacy-law.md (R-laws, economy laws, narration law, ads law).

## Open gaps

| Item | Law ref | Code status | Priority |
|---|---|---|---|
| Provenance recording on assets (creator/origin chain into the runtime asset records, not just the batch library sidecars) | Law 7 (rarity + provenance) | NOT BUILT: batch library sidecars carry origin/creator; runtime `run.imageAssets` records carry neither | TBD by owner |
| Ink ledger (balances, drips, spends; the tailor pricing hook is a stub seam awaiting it) | Laws 1/2/4 (economy) | NOT BUILT: `tailorFullbody` exposes `onBeforeGenerate` stub only; no ledger, no charging anywhere | TBD by owner |
| Romanceable default | Romance law (default-true intent) | DIVERGES: `mintNpcReputation` mints `romanceable` ~1-in-6 (`seed % 6 === 0`), not default-true | TBD by owner |
| Romance-register detector lexicon (paraphrase evasion) | Law R10 (SFW enforcement) | REFINEMENT: the live probe showed a blocked register re-entering as paraphrase the detector's lexicon misses ("lips meet yours", "bodies intertwine"); machinery verified, lexicon needs a calibration pass | TBD by owner |
| Goal capture doors: DEMONSTRATED (3+ same-pattern actions → one diegetic ask) + OFFERED (NPC/world proposal accepted) | Player-goals law | NOT BUILT: only the DECLARED door ships; the shared goal record + honor pipeline are ready to receive both | **HIGH** |
| Goals as D.5 thread sources (Project beats, Ambition arcs) | Player-goals law (honor machinery 3) | NOT BUILT: Tasks honor through the attempt pipeline; Projects/Ambitions do not yet register as thread sources (threads engine read-only this pass) | **HIGH** |
| Goal STATUS-WINDOW surface (goals list + Project pips) | Player-goals law (honor machinery 4) | NOT BUILT: goals are committed + ride the prompt, but not yet drawn in the status/VN UI | TBD by owner |
| Goal lifecycle: neglect check-in → archive | Player-goals law (lifecycle) | PARTIAL: state machine + stated-abandon + achieve/fail states exist; the neglect → ONE diegetic check-in → archive path is not wired | TBD by owner |
| Geometry-contradiction auditor (narration places a committed feature somewhere the committed layout doesn't) | Map-layout law (narrator consumes layout) | NOT BUILT: layout rides the prompt as SCENE GEOMETRY facts (`buildLayoutDirective`); the auditor-family detector that flags narrated contradictions is ledgered, not built | TBD by owner |

## Closed

| Item | Law ref | Closed by |
|---|---|---|
| Map-knowledge loot pickup (Ranger Station 9 / The Unfinished Map seed the `map:babel` reveal fact) | Verdance region-v1 gap ledger item 2 / affordances-map-law ("this pass ships the read") | c494ab7 (verdance plumbing): `babel.json` `grantKnowledge:["map:babel"]` on both takeable maps → `take.js` stamps the tag onto the take fact → `regionMap.mapKnowledgeReveals` unlocks the nodes. Verified: `verdance-region.test.js` map-reveal case. |
| Service kinds beyond inn/market/training (Elkwater quest-board, Root Shrine lore) | Verdance region-v1 gap ledger item 3 | c494ab7 (verdance plumbing): `LOCATION_SERVICE_KINDS` now carries `quest-board` + `lore` (`schema.js`); `SERVICE_META` affordances live (`affordances.js`); Root Shrine seeds a `lore` service (`babel.json`). |
| Em-dash auditor + universal enforcement | Narration law (em-dash ban, ratified 2026-07-16) | e98b392: detector (`gm/voice.js`) + chokepoint substitution (`gm/prompting.js`) + 54-fix UI-copy sweep |
| R10 block-and-regenerate on the live turn path | Law R10 (SFW enforcement) | VERIFIED LIVE 2026-07-17 on local 8b (zero cloud): blocked→regen-clean path AND blocked→retry-violated→template path both fired; probe also found + fixed the fallback-template intent-echo hole (`stripRomanceRegister`) |
| Weather in the time-of-day icon | Owner checklist item 1 (ruled cheap by tonight's grading) | a20ca37: persistent `world.weather` + sky-hazard overlay (`deriveWeather`) + phase-adjacent weather glyph |

---

## LEDGER NOTES (2026-07-20, tasklist batch)

- **Batch cook (System B) stays separate — by ruling.** The batch/offline card cook and
  the live runtime image path are DELIBERATELY separate systems. Their only shared
  contract is the **validated per-lane exports** (`scripts/art/workflows/<lane>-<slug>.json`
  + the prompt blocks). Do not merge them; keep the exports as the single source both read.
- **Provider-agnostic seal is moot while fallbacks are gated.** The sealed-prompt +
  validated-recipe path is the only live image path today; the pollinations/kontext and
  cloud fallbacks are gated OFF (`NOTDND_ALLOW_UNSEALED_EDIT` unset; provider=comfyui).
  So a "provider-agnostic seal" is not needed *now*. **If any fallback is ever re-enabled,
  the seal MUST move with it** (the seal cannot stay comfyui-only) — cross-ref CLI 1's
  "sealed-or-nothing" law in flight. Track this as a hard precondition on re-enabling a
  fallback, not a today-gap.
- **LAN bind + NODE_ENV=production for any non-localhost exposure.** The dev build binds
  loopback only and refuses to boot test-hooks-enabled on a public bind (server/index.js
  boot guard). For ANY future non-localhost exposure: set `NODE_ENV=production` (drops the
  test hooks) AND bind a real host (`NOTDND_HOST=<lan-ip>`), never `INKBORNE_PUBLIC=true`
  on an unsafe build. There is no override flag — exposing hooks publicly requires a
  visible code edit, on purpose.
