# PLAYER-GOALS LAW

**Status:** RATIFIED 2026-07-17 (structure owner-approved). Items marked
**PROVISIONAL** are Claude-recommended defaults awaiting owner confirm.

The founding defect: in the owner's last manual session he attempted "build a
shelter" during a committed storm and the GM ignored it and steered him to town.
This law makes that contract-illegal. The founding acceptance test: **"I build a
shelter" must work, matter, and be remembered.**

---

## THE LAW

### A GOAL is a committed server record
`run.goals` is a first-class, resume-safe record (like `run.threads`): each goal
carries **what** (`summary`), **scale**, **stakes**, **state**, and
**provenance** (capture door). Equal citizen with quests. Legacy runs carry no
goals and behave identically (additive/optional).

### THREE CAPTURE DOORS (all produce the same record type)
- **DECLARED** — intention-shaped speech commits it ("my goal is / I want to /
  I'm going to <sustained objective>"). Built this pass.
- **DEMONSTRATED** — 3+ committed same-pattern actions → **ONE diegetic ask**,
  never silent capture. **PROVISIONAL.** Deferred (see canon-code-gaps.md, HIGH).
- **OFFERED** — an NPC/world proposal accepted. Deferred (HIGH).

### SCALE LADDER
- **TASK** — attempt-pipeline resolution, possibly multi-stage. Uncapped.
- **PROJECT** — server-owned progress track, STATUS-WINDOW pips. **Cap 5
  (PROVISIONAL).**
- **AMBITION** — thread-source at faction grade. **Cap 3 (PROVISIONAL).**
- Scale inferred at capture; when ambiguous, commit as **Task** and let pursuit
  upgrade it.

### HONOR MACHINERY
1. Attempts resolve *doing* via the three-band engine; no-stakes-no-roll intact.
2. Success MUST commit state (objectState/inventory/conditions) **with builder
   provenance**.
3. Active goals register as **thread sources** (beats for Projects, arcs for
   Ambitions) in the D.5 fire-slot machinery. **Deferred (HIGH)** — this pass
   registers Tasks through the attempt pipeline only.
4. STATUS WINDOW displays goals + Project pips. Deferred to a UI pass.
5. **NARRATOR CONTRACT** — active goals ride every prompt as committed
   directives: acknowledge, advance, or lawfully obstruct. Ignoring or
   redirecting away from an actively-pursued goal is a **violation**. Built.
6. **GOAL-IGNORED auditor** — player pursued a committed goal; narration neither
   engaged nor lawfully obstructed → flag. Built.

### LAWFUL REFUSAL
Gate it / price it / rival it. Flat refusal only for genuine world-law
impossibility, stated in-fiction **with the reason**. "No, go to town" is
contract-illegal.

### LIFECYCLE
- **Abandon** — stated, or neglect → ONE diegetic check-in → archived; the world
  remembers. (Neglect check-in **deferred**; state machine + stated-abandon built.)
- **Fail** — consequences fire like any thread.
- **PROVISIONAL:** goal XP = committed-event XP law applied to achieved goals
  (Task 10 / Project 40 / Ambition 120). Abandonment leaves a gentle committed
  mark; failure a full one.

---

## FOUNDING EVIDENCE — the Jul 16 shelter-turn autopsy (read-only)

Traced the collapse session **`run_9e7a5486-13b5-4343-9246-7564f3990647`**
(run-log mtime 2026-07-16 19:47 EDT; all 7 GM records `finishReason: length`,
`trimApplied: true` — the token-cap collapse run).

- **The session is a tavern session** (The Shattered Flagon, keeper Fenn). Every
  committed intent, verbatim from the run log: `"give the trail loaf to Fenn"`,
  `"charm Fenn with a warm story from the road"` ×3, `"charm Fenn with a heartfelt
  toast to his hospitality"`. The storm fired turn 3 (`momentum: EVENT "The
  weather turns" (hazard) fired — committed objectState:the-sky`) while the
  player was **inside** the tavern.
- **There is NO "build a shelter" turn and no wilderness location** anywhere in
  the transcript or run log. A full-corpus grep of every `run_*.log` `action:`
  line for shelter/build/camp/lean-to returned only battery stubs and one *Jul
  08* run — nothing on Jul 16.

**Verdict — failure class (e): input never reached the server (turn loss).** It
is the only class consistent with an attempted intent that left no record;
(a)–(d) all presuppose a shelter turn the logs show never existed. Corroboration:
the collapse drove brutal latency (turn 1 `interpreter=15014ms`, turn 3
`gm=19569ms`, totals 23–25s); the client's resync path silently discards an
in-flight turn on exactly that kind of multi-second hang. **Honest caveat:** the
input's existence cannot be positively confirmed; a secondary possibility is
memory cross-wiring with a Jul 08 wilderness storm session (`"take cover in the
shed"` → `"hunker down"`). Either way, the Jul 16 collapse run never processed a
shelter build. This law removes both failure modes: a declared goal is a
committed record that survives a lost turn, and the goal-ignored auditor makes
the stiff-arm visible.

---

## ACCEPTANCE (automated, `tests/player-goals-acceptance.test.js`)
Committed storm active → player says "I'm going to build a shelter before the
storm hits" → goal committed (Task) → attempt resolves three-band → success
writes shelter `objectState` (builder provenance, quality-from-band) + a
`Sheltered` condition (storm interaction) + goal achieved +XP → NEXT TURN the
shelter is still in committed state and the goals directive references it.
Negative: the goal-ignored auditor flags the original town-steering shape over an
actively-pursued shelter goal (0 false positives across 1,846 transcript records).
