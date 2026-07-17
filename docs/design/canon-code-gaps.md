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

## Closed

| Item | Law ref | Closed by |
|---|---|---|
| Em-dash auditor + universal enforcement | Narration law (em-dash ban, ratified 2026-07-16) | e98b392: detector (`gm/voice.js`) + chokepoint substitution (`gm/prompting.js`) + 54-fix UI-copy sweep |
| R10 block-and-regenerate on the live turn path | Law R10 (SFW enforcement) | VERIFIED LIVE 2026-07-17 on local 8b (zero cloud): blocked→regen-clean path AND blocked→retry-violated→template path both fired; probe also found + fixed the fallback-template intent-echo hole (`stripRomanceRegister`) |
| Weather in the time-of-day icon | Owner checklist item 1 (ruled cheap by tonight's grading) | a20ca37: persistent `world.weather` + sky-hazard overlay (`deriveWeather`) + phase-adjacent weather glyph |
