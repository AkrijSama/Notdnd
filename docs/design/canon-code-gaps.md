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
| R10 block-and-regenerate on the live turn path | Law R10 (SFW enforcement) | BUILT (e98b392): Mainline blocks + one corrective regen + committed-fact fallback; mocked tests green; PENDING LIVE VERIFICATION (regen is a runtime model call) | TBD by owner |
| Romanceable default | Romance law (default-true intent) | DIVERGES: `mintNpcReputation` mints `romanceable` ~1-in-6 (`seed % 6 === 0`), not default-true | TBD by owner |
| Weather in the time-of-day icon | Pending tonight's grading ruling | NOT RULED: hold until the ruling lands; world clock exists, weather surface does not | TBD by owner |

## Closed

| Item | Law ref | Closed by |
|---|---|---|
| Em-dash auditor + universal enforcement | Narration law (em-dash ban, ratified 2026-07-16) | e98b392: detector (`gm/voice.js`) + chokepoint substitution (`gm/prompting.js`) + 54-fix UI-copy sweep |
