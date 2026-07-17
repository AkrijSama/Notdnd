# Ruler v2 Replay Calibration — recorded-transcript dataset (2026-07-16)

**Method:** pure offline replay, zero model calls. The frozen ruler v2 prose-computable
checks (handles, paragraph-structure, invented-agents, unnamed-agents, phantom
proper-nouns, pronoun-mismatch) plus metadata axes (latency, truncation) were run
across every record in `data/logs/gm-transcripts/*.jsonl`, with per-record known-cast
context reconstructed from each record's own `promptMessages` directives.
Coherence checks needing full scene snapshots (state-drift, band-desync, clock,
conditions) cannot replay from transcripts and were not run.

**Corpus reality (read this before the numbers):** 1,305 prose records across 1,278
files, BUT 1,292 are near-duplicate one-line worldgen stubs (only **4 distinct
texts**, ~84 chars, regenerated across a synthetic battery) and just **13 records are
substantial prose** (>=300 chars: the live rep/thread demo campaigns, the VN-proof
runs, and one real player session `run_9e7a5486`). Frequencies below are reported
raw AND on the effective corpus; treat everything as directional, not statistical.

## Top 5 recurring check-failures (ranked worklist for the next GM-quality cycle)

### 1. handles(pacing) — missing on 1,296/1,305 raw; the true rates: 100% of stubs, 9/13 (69%) of substantial turns
- Excerpts:
  - `The tavern breathes with rain and smoke as the keeper studies you with careful eyes.` (stub class, x~1,290)
  - `…She says nothing. Dru sits near the hearth, tapping her thumb against her belt buckle in a slow three-beat rhythm.`
  - `…The lockpicks sit under Mira's hand. Dru is waiting to see how this ends. Garrick has not resumed his conversation.`
- Root-cause hypothesis: (a) the worldgen opening generator produces a single ambient
  line with no closing hook by design and is NOT covered by handles enforcement;
  (b) on real turns the beat often ends on NPC body language, which the ruler does
  not count as a hook, and the live `enforceHandles` retry either did not fire or its
  verdict thresholds diverge from the ruler's.
- Fix-target: `server/gm/handlesEnforcement.js` (cover the opening/one-line
  generation path; reconcile verdict thresholds with `scripts/selfplayAudit.mjs
  detectHandles`), plus the worldgen opening prompt.

### 2. invented-agents (v1 harness) — 75 flags, majority are sanctioned-protocol false positives
- Excerpts:
  - `state_tag:[INITIATIVE] :: [INITIATIVE]`
  - `state_tag:[CHECK: Dexterity DC 14]` + `dialogue:speech with no committed speaker :: [CHECK: Dexterity DC 14] "Show me how steady your hands are."`
  - `agent:someone :: He watches you with the careful disinterest of someone who has learned to read trouble…` (figurative clause)
- Root-cause hypothesis: the harness auditor predates the [CHECK]/[INITIATIVE]
  trigger-grammar law and counts sanctioned protocol tags as state-tag leaks; the
  "someone" hit is a figurative relative clause ("of someone who…"), not an actor.
- Fix-target: `scripts/selfplayAudit.mjs` (whitelist the sanctioned trigger grammar
  in the state_tag check; add a relative-clause guard to the agent-noun scan) — a
  ruler **v3** change, not done this pass (v2 is frozen). Note: the LIVE committer
  (`server/solo/npcCommit.js`) gained exactly these guards this pass (bracket-tag
  strip; noun-allowlist held).

### 3. phantom-proper-nouns (#27/#41) — 10 flags: 1 true positive class + 1 systematic FP class
- Excerpts:
  - FP: `{"name":"Dexterity","sentence":"[CHECK: Dexterity DC 14]…"}` (proper-noun
    extraction reads inside protocol tags)
  - TP: `{"name":"Thornwall","sentence":"Fenn's scarred brow lifts as you… spin a tale about a cart axle…"}` (invented landmark inside spoken tale, never committed)
- Root-cause hypothesis: `extractProperNouns` does not strip bracketed protocol tags;
  the lore committer's PLACE_SUFFIX list does not cover the "-wall" suffix class, so
  a Thornwall-type invented landmark is neither flagged-committed nor vouched.
- Fix-target: `scripts/selfplayAudit.mjs` (bracket-strip before proper-noun scan);
  `server/solo/npcCommit.js` PLACE_SUFFIX_WORDS (add wall/bridge/crossing class).

### 4. truncation (finish_reason=length) — 10 records, trim engaged on all 10
- Excerpts: `cmp_thread_demo.jsonl: trimApplied=true` (and 9 similar; the
  sentence-boundary trim repaired every one, no beheaded quotes shipped).
- Root-cause hypothesis: the narration token ceiling is tight for scene-setting
  turns; the trim machinery is doing its job but ~1% of generations pay latency for
  tokens that are then discarded.
- Fix-target: token-ceiling config for the narration/opening call types
  (`server/gm/prompting.js` model options); low priority, enforcement is healthy.

### 5. em-dash (narration law, ratified 2026-07-16) — 12 occurrences across 9 records (~0.9% of records, concentrated in REAL sessions)
- Excerpts:
  - `…arms still crossed — but her shoulders have lost their tension.` (cmp_rep_live)
  - `…palm down, fingers spread — a wall, not an offer.` (VN-proof run)
  - 7 occurrences in the one real player session `run_9e7a5486` (pre-ban records)
- Root-cause hypothesis: the prompt-side ban alone leaks at the model level exactly
  as documented (4/15 turns on run_b06da13d historically); every leak in this corpus
  predates chokepoint enforcement.
- Fix-target: DONE this pass — detection + substitution now sit at the single
  generation chokepoint (`server/gm/prompting.js`), covering narration, opening,
  talk, ooc, and handles-retry. Residual work: watch for `[em-dash]` warns in logs.

## Non-findings (checks that stayed clean on this corpus)
- paragraph-structure(raw-gm): 0 single-block walls.
- pronoun-gender-enforcement: 0 mismatches (prompt-derived entity set).
- latency: 1 record over 20s (cmp_thread_demo, 20.6s class).
- handles borderline: 8.

## Disagreement-auditor replay (work item 5)
- Law-active records (DISAGREEMENT LAW directive in prompt): **3**; compliance flags
  on bound speakers: **0**.
- Worst-case stress (every quoted line corpus-wide treated as law-bound): 31 quoted
  lines, **0** read as simple compliance → **0.0% worst-case false-flag rate**.
- Verdict: no guard tightening warranted on current evidence; the negation/grounding
  guards hold. Caveat: the dialogue-rich sample is thin (the corpus is dominated by
  worldgen stubs); re-run this replay after the next few real sessions accumulate.

---
*Produced by the harness-tightening pass, offline replay only. Ruler v2 registry
untouched (frozen); candidate v3 changes are listed as fix-targets above.*
