# Grade Improvement Roadmap (from run_b06da13d walkthrough grade)

> Source: the honest, critical grade of the director's real play session
> `run_b06da13d` (16 turns, ~2h wall-clock, deepseek-v4-pro on `d41a269`).
> Design doc only — no code. Prioritized by feel-per-effort, then by depth
> ceiling-lift.

## Current grades

| Axis | Grade |
|---|---|
| Narration | **B** |
| Coherence | **C+** |
| Depth | **C** |
| Mechanical | **B−** |
| Pacing | **D** |

## Core diagnosis

**The world is narrated, not committed** — a "well-toned reactive demo whose
people, clock, and status effects are still theatre." The reactive spine
**WORKS**: the momentum "hunted" pursuer arc spooked the director *for real*,
through all of the current problems. So the path forward is **commitment +
plumbing, not concept or prose**. The prose and the concept are already good
enough; what is missing is state behind the narration and the flow to read it.

---

## TIER 1 — Fast, high feel-per-effort (do first)

- **#34 narration-log scroll fix** (5-step, already diagnosed): make the log a
  bounded internal scroll region, auto-scroll to the newest entry. Highest
  felt-impact — currently you wait 15–30s, then the result is hidden off-screen.
- **Latency:** the timeout→gemini fallback fires on slow turns (2 of 16 ≥30s).
  Raise `NOTDND_GM_CLOUD_TIMEOUT_MS` or reduce per-turn call fan-out. Paired with
  #34 (the reading experience must be able to absorb the wait).
- **Failure-escalation rule:** repeated failure on the same action must
  **ESCALATE or open new options, never recycle identical punishment** (the
  T3–T9 dead-loop: 7 turns of recycled disorientation prose, the director
  disengaged for 42 + 56 min). GM-prompt + design fix.

**Target:** Pacing **D→B**, Depth **C→C+**.

---

## TIER 2 — The commit chain, biggest depth ceiling-lift

- **#14 time / world clock** — GM-proposed `durationMinutes`, server commits +
  sanity-bounds; day/night derives. Dead in play now (`day 1 / tick 1` after 16
  turns while the GM narrates "sundown long passed").
- **#26 conditions with durations + a shed mechanism** — 4 debuffs stacked
  forever in play, with no clearing. Depends on #14.
- **#27 committed NPC entities + auditor enforcement** — 0 NPC entities in play;
  Grace / Doc Han / the 6-turn pursuer were all phantom. The spook the director
  felt was from a phantom — commit it and the scare becomes durable / persistent.

**Target:** Coherence **C+→A**, Depth **C→B**, Mechanical **B−→B+**.

---

## TIER 3 — Compounding polish

- **Template / fallback narration:** run `composeAttemptNarration` + the no-roll
  templates through the voice + em-dash strip (4/15 turns showed bare
  stage-directions + leaked em-dashes on the fallback path). Enrich the thin
  no-roll templates.
- **Mechanical** rises automatically with #14 / #26.

**Target:** Narration **B→A**.

---

## Sequence

**Tier 1 (feel) → Tier 2 (depth) → Tier 3 (clean).** Tier 1 first so the game is
playable enough to test Tier 2 against. **Highest single-leverage item = #14 /
#26 / #27 (the depth ceiling).**
