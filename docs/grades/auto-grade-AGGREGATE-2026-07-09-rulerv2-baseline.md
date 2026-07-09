# Auto-Grade AGGREGATE — RULER v2 BASELINE — 2026-07-09

> 5 independent fresh sessions × 16 turns (80 turns), tip `7118f89` (ruler v2, FROZEN),
> one server restart before S1 (server up throughout), real DeepSeek
> (`deepseek/deepseek-v4-pro`), `gm.localFallback=false`. **ruler=v2 only — do NOT
> compare numerically against v1 aggregates** (v2 added checks; see honest summary).
> Measurement only: no fixes, no prompt changes were made during or after this pass.

## Model integrity — all 5 sessions VALID, no replacement used

| # | run | deepseek | fallback |
|---|---|---|---|
| S1 | run_c0182ace | 15/16 | 1 |
| S2 | run_77497a09 | 15/16 | 1 |
| S3 | run_d76515c6 | 15/16 | 1 |
| S4 | run_2602dcce | 13/16 | 3 |
| S5 | run_e091e1bb | 16/16 | 0 |

**74/80 (92.5%) real-DeepSeek.** All sessions cleared the real-GM-majority rule
(S4 is the weakest at 13/16 — noted, still valid; fallback turns excluded from
narration/coherence per the built-in logic).

## Grades (numeric; letter from the standard scale)

| Axis | S1 | S2 | S3 | S4 | S5 | mean | median |
|---|---|---|---|---|---|---|---|
| Narration | 74 | 67 | 81 | 95 | 67 | **76.8 (C+)** | 74 (C) |
| Coherence | 5 | 0 | 0 | 3 | 49 | **11.4 (F)** | 3 (F) |
| Depth | 82 | 82 | 82 | 82 | 95 | **84.6 (B)** | 82 (B−) |
| Mechanical | 95 | 95 | 95 | 95 | 95 | **95.0 (A)** | 95 (A) |
| Pacing | 48 | 26 | 0 | 26 | 27 | **25.4 (F)** | 26 (F) |

Findings volume: **100 complaints + 209 compliments = 309** across 80 turns.

## Complaints — grouped by fix-target (count × sessions, severity)

1. **[20× S1–S5, MEDIUM, pacing]** `GM-prompt closing-handles clause (2-4 grounded directions per turn)` — turns ending with zero actionable, state-grounded directions. *(NEW v2 check.)*
2. **[16× S1–S5, MEDIUM, pacing] + [5× S1/S3/S5, HIGH]** `NOTDND_GM_CLOUD_TIMEOUT_MS + per-turn fan-out` — latency ≥20s (16×) and ≥30s (5×, worst 33.6s). *(Pre-existing measure; see latency table. The opt-in `NOTDND_INTERPRETER_MODEL` fast-lane is NOT enabled.)*
3. **[13× S1/S2/S3/S5, MEDIUM, coherence]** `worldClock.js durationMinutes + GM clock-awareness clause` — narration reads "night/sundown" at committed 07:0x. *(PRE-EXISTING #14 class — the clock directive reduced but did NOT eliminate it; genuine recurrence.)*
4. **[13× S1/S2/S3/S5, MEDIUM, narration]** `GM-prompt paragraph-structure clause` — single-block prose (~570 chars, no paragraph break) that only the client chunker saves. *(NEW v2 check; pre-existing behavior newly measured.)*
5. **[8× S1–S4, CRITICAL, coherence]** `npcCommit.js phantom auditor + name/lore discipline` — e.g. "Lamp-Bearers" uncommitted. **Honest caveat:** hyphenated compounds are split ("Lamp" + "Bearers" = 2 CRITICALs for one entity), so the raw count double-books; the underlying phantom is real.
6. **[8× S1–S5, HIGH, coherence]** `auditAndCommitInventedAgents co-location + actor discipline` — unnamed invented agents ("a courier", "a woman") acting with no co-located committed entity. *(NEW strict co-location check — v1's vouching let non-co-located tokens cover these.)*
7. **[7× S1–S5, HIGH, coherence]** `worldgen/identity namegen per-run first-name dedup` — "2 committed NPCs share the name 'A'". **Honest caveat:** this keys on the first token of placeholder display names ("A shaken traveler" / "A waiting figure") — the article, not a name. Likely a v2 check artifact on un-minted placeholder names; the real underlying issue is placeholders surviving un-minted.
8. **[4× S1–S4, HIGH, depth]** `actions.js detect→route→commit` — narrate-into-void: signalled success, zero state delta. *(PRE-EXISTING class — 4/80 turns still slip past the observe/search reroutes; other passive intent classes remain.)*
9. **[4× S1–S4, HIGH, pacing]** `cloud availability/timeout + provider chain` — 1 fallback turn per session (3 in S4).
10. **[1× S1, HIGH, coherence]** `GM state-echo discipline + server-side narration state check` — narrated "you are bleeding," committed conditions = none. *(NEW Class-C drift check.)*
11. **[1× S5, HIGH, coherence]** `GM committed-gender echo + gender enforcement` — "Brynn" committed he/him, narrated she/her ×3. *(NEW pronoun-enforcement check; #50 committed the gender, the narration contradicted it.)*

## Compliments (regression guards, zero score weight; 209 total)

- [60× S1–S5] coherence · grounded narration — every named actor/place is committed state
- [57× S1–S5] narration · native multi-paragraph beat structure
- [34× S1–S5] pacing · handles present — actionable direction hooks in the closing beat
- [25× S1–S5] depth · grounded callback — narration references a committed fact
- [33× mixed] mechanical · clean band/label on Success / Failure / Success-at-a-cost

## Latency — per-stage across all 80 turns (instrumentation, ms)

| stage | n | min | median | p90 | max |
|---|---|---|---|---|---|
| interpreter | 80 | 0 | 3,840 | 7,059 | 15,001 |
| commit | 80 | 192 | 231 | 259 | 295 |
| gm (narration ∥ suggestions) | 80 | 2,689 | 15,323 | 33,614 | 43,760 |
| auditor | 80 | 0 | 276 | 529 | 875 |
| renderReady | 80 | 0 | 0 | 0 | 1 |
| **total** | 80 | 6,351 | **21,521** | 38,933 | 50,013 |

The gm stage dominates (median 15.3s, p90 33.6s); the interpreter adds a median
3.8s sequential prefix on contested turns (max = its 15s timeout). Engine-side
stages (commit/auditor/renderReady) are sub-second everywhere.

## Spend — actual, from the usage accounting

| session | campaign | cost | billed calls |
|---|---|---|---|
| S1 | cmp_mre1x2d4 | $0.1624 | 74 |
| S2 | cmp_mre253em | $0.1414 | 75 |
| S3 | cmp_mre2dlf2 | $0.1424 | 74 |
| S4 | cmp_mre2n34q | $0.1646 | 74 |
| S5 | cmp_mre2vod8 | $0.1620 | 69 |
| **total** | | **$0.7727** | **366** |

≈ $0.155/session, ≈ $0.0097/turn.

## Honest summary — new-check catches vs pre-existing

**Scores dropped because the ruler tightened, mostly — but not entirely.**

- **NEW-check catches (would not have scored under v1):** closing-handles (20),
  paragraph-structure (13), strict co-located invented agents (8), name-collision
  (7 — likely article-artifact on placeholders), state-drift (1), pronoun-mismatch
  (1). These account for ~50 of 100 complaints and most of the coherence/pacing
  collapse. They measure pre-existing *behavior* that v1 simply didn't check.
- **PRE-EXISTING classes genuinely recurring (v1 checked these too):**
  **clock-divergence #14 (13×)** — the biggest real regression signal: the clock
  directive did not hold at the session opening (night prose at committed 07:0x);
  **narrate-into-void (4×)** — passive classes beyond observe/wait still slip;
  **latency ≥20s (21×)** — unchanged reality, interpreter fast-lane still off;
  **fallback frequency (1/session, 3 in S4)**.
- **Grader artifacts to weigh before acting:** hyphen-split double-counting of
  compound phantom names (item 5) and the article-"A" name-collision (item 7).
- **What held:** Mechanical A across all 80 turns (band math clean, zero desync);
  Depth B (the void fixes mostly hold); 209 compliments confirm grounded naming,
  paragraph structure, handles, and callbacks fire on the majority of turns.
