# Auto-Grade AGGREGATE — RULER v2 POST-FIX — 2026-07-10

> 5 fresh sessions × 16 turns (80 turns) on tip `1deac37` (engine-fix batch
> 73d8f05/f68fff6 + CLI 2's prose contract + fast-lane default-on), real DeepSeek,
> `gm.localFallback=false`, zero restarts during the pass. **ruler=v2** (version
> guard passed on all 5 reports) — directly comparable to the 2026-07-09 baseline.
> Measurement only: no fixes, prompt edits, or ruler changes during this pass.

## Model integrity — all 5 VALID, no replacement used

S1 run_2b72eead 15/16 (1 fallback) · S2 run_99fec529 16/16 · S3 run_d12f28ee 16/16
· S4 run_63a7a4b2 16/16 · S5 run_4d007a46 16/16 → **79/80 (98.8%) real-DeepSeek.**

## Grades — side-by-side with baseline

| Axis | S1 | S2 | S3 | S4 | S5 | **post-fix mean** | baseline | Δ |
|---|---|---|---|---|---|---|---|---|
| Narration | 95 | 95 | 95 | 95 | 95 | **95.0 (A)** | 76.8 | **+18.2** |
| Coherence | 69 | 39 | 69 | 43 | 49 | **53.8 (F)** | 11.4 | **+42.4** |
| Depth | 95 | 82 | 95 | 95 | 82 | **89.8 (B+)** | 84.6 | **+5.2** |
| Mechanical | 95 | 95 | 95 | 95 | 95 | **95.0 (A)** | 95.0 | 0 |
| Pacing | 0 | 67 | 0 | 0 | 0 | **13.4 (F)** | 25.4 | **−12.0** ⚠ |

Complaints 100 → **80**; compliments ~209 → ~190 (denominator similar).

## Delta analysis — per baseline complaint class (before → after)

| Class | baseline | post-fix | verdict |
|---|---|---|---|
| single-block prose | 13 | **0** | **CLEARED** (contract's native paragraphing; 59 paragraph compliments) |
| phantom compounds (CRITICAL) | 8 | **1** | **~CLEARED** — the 1 is "Through" flagged as a name (grader artifact, not a phantom) |
| clock-divergence #14 | 13 | **4** | **−69%** — openings now pinned (item 1 held); residue is 2 sessions' T1 turn prose |
| narrate-into-void | 4 | **2** | **halved** — object-search class gone; 2 residual T13 ask-turns where no target grounded a disposition commit |
| name-collision | 7 | **5** | artifact persists — still the article-"A" on UN-MINTED placeholders (mint-time fix can't rename what never mints); ruler-side or placeholder-mint fix needed |
| co-located invented agents | 8 | **6** | persists — model still gives agency to "a/the man" etc. despite contract clause |
| no-closing-handles | 20 | **22** | **flat** — handles land on ~72% of turns (38 compliments) but the contract does not hold on the rest |
| latency ≥20s / ≥30s | 16 / 5 | **24 / 14** | **REGRESSED** — see latency table; the new prose contract costs ~7s/turn on the gm stage |
| pronoun-mismatch | 1 | 1 | 1 slipped past enforcement (S5 "Talin" she×2) — repair reduced but did not eliminate |
| state-drift | 1 | 0 | cleared |
| fallback turns | 4 | 1 | improved |

## Findings by fix-target (post-fix, 80 complaints)

1. **38×** `NOTDND_GM_CLOUD_TIMEOUT_MS + per-turn fan-out` — 24× ≥20s MEDIUM + 14× ≥30s HIGH
2. **22×** `GM-prompt closing-handles clause` — turns ending with no grounded directions
3. **6×** `auditAndCommitInventedAgents co-location + actor discipline`
4. **5×** `worldgen namegen per-run first-name dedup` — all the article-"A" placeholder artifact
5. **4×** `worldClock durationMinutes + clock-awareness clause`
6. **2×** `actions.js detect→route→commit` (narrate-into-void residue)
7. **1×** each: phantom auditor ("Through" artifact), provider chain (fallback), gender enforcement (Talin)

Compliments: 59× native multi-paragraph · 52× grounded naming · 38× handles present
· 30× clean band/label · 11× grounded callbacks.

## Latency — 80 turns per stage (ms), side-by-side

| stage | post-fix med | post-fix p90 | post-fix max | baseline med | baseline p90 | baseline max |
|---|---|---|---|---|---|---|
| interpreter | **1,359** | 1,967 | 2,768 | 3,840 | 7,059 | 15,001 |
| commit | 245 | 267 | 282 | 231 | 259 | 295 |
| gm | **22,469** | 35,690 | 40,838 | 15,323 | 33,614 | 43,760 |
| auditor | 267 | 656 | 1,001 | 276 | 529 | 875 |
| **total** | **23,456** | 37,419 | 42,860 | 21,521 | 38,933 | 50,013 |

**Fast-lane effect confirmed:** interpreter median −65% (3.8s→1.4s), max 15.0s→2.8s
(the timeout ceiling never hit). **But the gm stage regressed +47% median**
(15.3s→22.5s) — the new prose contract (structured paragraphs + handles + longer
budget) makes narration calls substantially slower, more than eating the
interpreter win. That is the whole Pacing collapse: ≥30s HIGHs 5→14.

## Word-budget check (the 120-word cap)

**Not measurable this pass.** (a) Frozen ruler v2 contains **no word-budget check**
(verified by inspection — zero flags is by construction, not evidence); (b) GM
prose is not persisted anywhere post-hoc (responses are transient; timeline events
store the template line, `run.narration` holds only the final turn). Indirect
evidence the output shape changed: the single-block-prose class (which quotes char
counts) went 13 → 0. A real cap check needs a ruler v3 entry or harness capture.

## Spend — actual

S1 $0.1321 (66 calls) · S2 $0.1984 (74) · S3 $0.1539 (65) · S4 $0.1164 (58) ·
S5 $0.1550 (61) → **TOTAL $0.7558 / 324 calls** — under the $1.00 ceiling.

## Honest summary

**Cleared / strongly moved by the fixes:** single-block prose (13→0), phantom
compounds (8→1, and the 1 is an extractor artifact), clock-divergence (13→4 —
item 1's opening pin held: every opening read morning at the morning clock),
narrate-into-void (4→2), fallback frequency (4→1), state-drift (1→0). Narration
76.8→95, Coherence 11.4→53.8, Depth 84.6→89.8.

**Persisting:** no-closing-handles is FLAT (20→22) — the contract lands handles on
~72% of turns and the model drops them on the rest; co-located invented agents
8→6; the article-"A" name-collision (5×) is a placeholder/grader artifact my
mint-time fix cannot reach (the colliding NPCs never mint an identity); 2 void
residues on ask-turns with no groundable disposition target; 1 pronoun mismatch
slipped past the repair.

**Regression the fixes introduced:** the prose contract bought its quality wins
with **+47% gm-stage latency** — Pacing fell 25.4→13.4 and ≥30s turns nearly
tripled. The interpreter fast-lane works exactly as measured (−65% median) but is
outweighed. The next lever is the narration call itself (budget/timeout tuning or
a faster narration lane), not more engine work. No other new complaint class
appeared; the compliment guards (paragraphs, grounding, handles, band/label) all
held or improved.
