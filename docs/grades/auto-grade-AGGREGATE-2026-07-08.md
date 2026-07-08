# Auto-Grade AGGREGATE — 5 sessions × 16 turns — 2026-07-08

> Full grading pass on the hardened auto-grader (tip `eb9219c`), real DeepSeek
> (`deepseek/deepseek-v4-pro`), free-text autoplay. 5 sessions, 80 turns total.
> Scored against the manual walkthrough baseline (`docs/design/grade-improvement-roadmap.md`,
> run_b06da13d: Narration B / Coherence C+ / Depth C / Mechanical B− / Pacing D).

## Model integrity — all 5 sessions VALID

| # | run | deepseek | fallback | which |
|---|---|---|---|---|
| 1 | run_90765c15 | 15/16 | 1 | T13 gemini-2.5-flash |
| 2 | run_bfe980e7 | 15/16 | 1 | T13 gemini-2.5-flash |
| 3 | run_a55951a8 | 15/16 | 1 | T10 gemini-2.5-flash |
| 4 | run_1363af16 | 16/16 | 0 | — |
| 5 | run_1343f568 | 15/16 | 1 | T8 inkborne-gm:8b (local) |

**76/80 (95%) real-DeepSeek.** Every session cleared the real-GM-majority bar, so
no session's narration/coherence is invalidated. All 4 fallback turns were tagged
and excluded from narration/coherence per the built-in logic.

## Aggregate grades (5 valid sessions)

| Axis | Mean | Letter | Median | Range | vs baseline |
|---|---|---|---|---|---|
| Narration | 95.0 | **A** | 95 | 95–95 | B → **A** ↑ (see caveat) |
| Coherence | 66.6 | **D** | 82 (B−) | 0–88 | C+ → **bimodal** |
| Depth / Traction | 53.4 | **F** | 56 | 30–69 | C → **F** ↓ |
| Mechanical | 95.0 | **A** | 95 | 95–95 | B− → **A** ↑ |
| Pacing | 49.0 | **F** | 53 | 34–62 | D → **F** ↓ |

Per-session numerics: Narration 95/95/95/95/95 · Coherence 82/0/81/82/88 ·
Depth 43/69/56/30/69 · Mechanical 95/95/95/95/95 · Pacing 62/35/34/53/61.

**Read the coherence mean with care:** it is bimodal, not noisy. Four sessions sit
at B−/B+ (81–88); one (S2) collapsed to **F/0** on a 7-strong phantom-name cascade.
The median (B−/82) is the representative typical experience; the 0 is a real,
severe, intermittent tail-risk — not a model-integrity artifact.

## Consolidated findings — deduped, ranked (severity × recurrence)

### 1. 🟧 HIGH · depth · narrate-into-void — **5/5 sessions** (highest confidence)
- **Failure:** engine signals success but commits **no** state delta (loc/discovery/inv/quest/xp/objects/cast unchanged).
- **Turns:** T7 and T15 in **every** session; also T9/T10/T13/T16 variously. S1 T7,T9,T10,T15 · S2 T7,T16 · S3 T7,T15,T16 · S4 T7,T9,T10,T13,T15 · S5 T7,T15.
- **Root-cause:** the passive/observe intent classes — "wait by the door and watch", "look around and take stock", repeat "search" — resolve as success and route to no commit path.
- **Fix-target:** `server/solo/actions.js` detect→route→commit for observe/wait + repeat-search intents (a passive look should commit a discovery or not be graded a "success").

### 2. 🟨→🟧 clock divergence (#14) — **3/5 sessions**
- **Failure:** GM prose reads evening/dusk/night while the committed clock is still morning.
- **Turns:** S2 T5 (evening vs 07:04) · S3 T13 (dusk vs 07:46) + T15 (night vs 08:47) · S5 T7 (evening vs 07:36).
- **Root-cause:** committed clock barely advances (still 07:xx–08:xx after 16 turns) while narration drifts to night — either `durationMinutes` isn't committing enough or the GM prompt isn't clock-aware.
- **Fix-target:** `server/solo/worldClock.js` durationMinutes commit + GM-prompt clock-awareness clause.

### 3. 🟥 CRITICAL · coherence · phantom NPC / lore cascade (#27/#41) — **1/5 but severe**
- **Failure:** GM invents proper-noun NPCs/lore not committed to state; the phantom auditor did not strip them.
- **Turns:** S2 only — "Old Watchtower" (lore, ×4: T2,T3,T9), "Goran" (NPC, ×3: T5,T11,T12), "Vorga", "Mysterious Figure" (T12).
- **Root-cause:** the #27 phantom auditor misses (a) lore/place facts, and (b) some names introduced via dialogue attribution. This single cascade is what dropped S2 coherence to 0.
- **Fix-target:** `server/solo/npcCommit.js` phantom auditor — extend promote-or-strip coverage to lore/place nouns and dialogue-introduced names.

### 4. 🟧 HIGH · coherence · invented agent (B2 uncommitted social) — **2/5 sessions**
- **Failure:** GM narrates an actor/speaker with no committed entity.
- **Turns:** S1 T11 ("creature") · S4 T14 ("scavenger").
- **Fix-target:** `server/solo/npcCommit.js` commit-or-strip + GM-prompt actor discipline.

### 5. 🟧→🟨 pacing · latency — **5/5 sessions** (dominant volume)
- **Failure:** turns routinely 20–35s; ≥30s on S1 T10 (35.0s), S2 T7 (33.8) + T15 (31.0), S3 T13 (32.6).
- **Root-cause:** slow cloud GM calls; the tail trips the timeout→fallback path.
- **Fix-target:** `NOTDND_GM_CLOUD_TIMEOUT_MS` + reduce per-turn call fan-out (`server/solo/gmProvider.js`).

### 6. 🟧 HIGH · pacing · fallback frequency — **4/5 sessions**
- **Failure:** 1 turn/session fell to a fallback model (T13/T10/T8) — including one to **local `inkborne-gm:8b`**, which loaded 6 GB into the 8 GB GPU (freeze-risk; see infra note).
- **Fix-target:** cloud availability/timeout + provider chain (`server/ai/openrouter.js`).

## Did #14/#26/#27/#28 move the numbers?

- **#28 band-desync — WORKING.** Zero band/label desync findings across all 80 turns.
- **#26 conditions-without-shed — WORKING (or not exercised).** Zero findings; no forever-stacking debuffs. Mechanical A confirms band math + needsCheck→roll are consistent (baseline B− → A).
- **#27 committed NPCs / phantom auditor — PARTIAL.** Typical coherence up (C+ → B− median), phantom-free in 3/5 sessions — but S2's cascade proves the auditor still misses lore facts and some dialogue-named NPCs.
- **#14 clock — PARTIAL / not landing.** Divergence in 3/5 sessions; the clock isn't advancing enough for the prose it's paired with.

## Biggest remaining gaps (priority order)

1. **Depth / narrate-into-void (5/5)** — the core "world is narrated, not committed" problem is still fully open for observe/wait/repeat intents. This is why Depth reads F despite the commit-chain work: those intent classes never reach a commit. **Top fix.**
2. **Clock divergence (3/5)** — #14 committed the plumbing but the clock doesn't advance with narrated time.
3. **Phantom cascade tail-risk (1/5, critical)** — auditor coverage gap on lore + dialogue names.
4. **Latency (5/5, infra)** — real but non-narrative; timeout/fan-out tuning.

## Caveats (honest bounds on these grades)

- **Narration A is structural, not aesthetic.** The grader's narration axis checks mechanical AI-tells (em-dashes, recycled-loop) — it cannot judge prose quality/voice/fun the way the human B did. A ≠ "better prose than the human graded"; it means "no mechanical tells." Do not read the A as beating the human's B on craft.
- **The autoplay script biases the depth-void count.** The fixed 8-intent loop includes inherently passive beats ("wait and watch", "look around") that *should* commit little — so some void flags reflect the script's passivity. The finding still stands (a passive "success" that commits nothing is the problem), but the absolute count is inflated vs. a goal-directed player.
- Per [[validation-baseline]]: agent autoplay measures structure (commit/coherence/mechanics/latency), not fun. These numbers gate quality; they don't certify it.
