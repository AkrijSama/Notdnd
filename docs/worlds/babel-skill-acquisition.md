# BABEL — Skill Acquisition Design (Hybrid)

**Status: DESIGN SPEC ONLY.** No engine code, no UI implementation. This locks
the acquisition design so the build sequence can pick it up in order. Companion
to `docs/worlds/babel-lebab-spec.md` (the World Book) — this doc expands §4.3–4.4a
(the skill ladder) and §6 (milestones) into *how a skill actually gets into the
sheet*. Tags follow the World Book's convention: **canon** (director-ruled),
**[PROPOSED]** (mechanics for redline), **[INVENTED]** (creative, for redline).

Director's decision (canon): **HYBRID acquisition** — two mechanisms, one commit
law. Most skills are learned *diegetically* from world sources and the WINDOW
reflects them after commit; a rare set of *milestone breakthroughs* present a
weighted PICK. Neither path is ever a narrator invention, and neither is a
free-floating RPG menu.

---

## 0. The one law both mechanisms obey

Every skill — by either path — is a **server-committed grant against the
world-book skill catalog**, landed in state **before** any narration runs. The
narrator *describes* the skill the server already granted; it never conjures one.
This is the **Fortune's Pocket law** (World Book §4.4, ruled 2026-07-05) applied to
the whole skill surface: *the model classifies and colors, the resolver owns the
state.* The STATUS WINDOW is a **readout of committed state** — it shows what was
granted, never what the prose gestured at.

The shared primitive (spec name; [PROPOSED]): a single server operation
`grantSkill(run, skillId, { source, milestone? })` that BOTH mechanisms call. It:
1. resolves `skillId` against the world-book **skill catalog** (the machine-readable
   form of §4.4 / §4.4a) — an unknown id is refused, not invented;
2. refuses a duplicate (a held skill is never re-granted);
3. checks the acquisition is *earned* (the source is real and reached, or the
   milestone actually crossed — see §1/§2);
4. appends to `player.babelSkills` the committed record
   `{ skillId, rankIndex, stat, source, acquiredAtMilestone }`
   (`rankIndex` is the §4.3 index that feeds the RANK RMS in §5 and the sheet's
   ranked-skill count — both already read `player.babelSkills`);
5. emits a committed **skill-learned event** the WINDOW renders from.

Because both paths terminate in `grantSkill`, coherence is structural: there is
exactly one write path into the skill list, and it only accepts catalog entries.

---

## 1. Mechanism ONE — DIEGETIC LEARNING (most skills)

Skills are learned **in-fiction, from a real world source**, then the WINDOW
reflects them. Never a menu-pick. The source ladder (World Book §4.4 / §4.4a) *is*
the content-pacing, and each rank band is sourced differently — so "how you learn
it" is a different committed event per band.

### 1.1 The committed-event shapes (four archetypes) [PROPOSED]

Each archetype is a diegetic action or moment that, on commit, calls `grantSkill`.
The archetypes cover the ladder; the specific gate per band is the fiction.

| Archetype | Bands | The committed event | Gate the server checks |
|---|---|---|---|
| **PURCHASE / TRAIN** | E (academies, town) | A `train_skill` action taken at a source location with a teacher/vendor present; costs money + time (a committed resource + XP/time tick). | at a valid source; can afford; skill is on that source's teach-list |
| **MENTOR ARC** | D (Warden Calloway) | Completion of a mentor's multi-beat lesson — the training arc (§2.6), not a single buy. The *final* lesson beat commits the grant. | the mentor relationship reached; the arc's prior beats committed |
| **TUITION + CONTRACT** | C, B (association tuition; patronage) | Two-step: **enroll** (pay tuition / sign patronage — a committed standing change) unlocks the teaching; some skills additionally gate behind **completing an attached contract** (§4.4a: "associations start attaching contracts to tuition"). The grant commits on the *unlock* (C tuition) or the *contract completion* (contract-gated C/B). | association standing / patronage reached; contract resolved if attached |
| **CLEAR / DISCOVERY** | A, S (deep zones, Tower floors) | No one sells A/S. Taken from a **zone heart** or **Tower Threshold floor** — the grant commits on **clearing the source** (defeating the heart, holding the floor). A discovery event, not a purchase. | the source cleared this run; tier/milestone reached (A gates behind Tower access; S deep-Tower) |

All four end in the *same* `grantSkill` call — they differ only in the diegetic
gate that authorizes it. (DG is out of scope for Book One per §4.3 — no DG instance
ships.)

### 1.2 How the WINDOW shows a diegetic grant [PROPOSED — moment; INVENTED — copy]

Diegetic learning is **frequent and low-ceremony** — it must not interrupt like a
breakthrough does. On the next WINDOW render after commit, the skill simply
**appears in the SKILLS list**, and a single quiet line writes itself into the
sheet as it lands:

```
  SKILLS
    Sprint Burst · E                    ← newly present
    …
  [ LEARNED: Sprint Burst. THE WINDOW DOES NOT LIE. ]
```

- **Understated, not fanfare.** The WINDOW *reflects* — it does not celebrate. The
  weight of the moment lives in the fiction that earned it (the trainer's nod, the
  cleared heart), which the GM narrates; the WINDOW just makes it *true and legible*.
- **The VOICE stays silent here** (locked director decision: the VOICE is rare;
  ongoing legibility belongs to the WINDOW). A bought E-skill is a WINDOW event, not
  a VOICE event.
- The one-line notice is the diegetic-learning counterpart of the STATUS WINDOW's
  standing "[ THE WINDOW DOES NOT LIE ]" register (§2.3) — same voice, one line.

---

## 2. Mechanism TWO — MILESTONE BREAKTHROUGH CHOICE (rare, significant)

At a breakthrough, the champion's power **crystallizes** — and here, and only here,
the player makes a genuine **PICK**, presented with weight as a **STATUS WINDOW
EVENT**. This is the agency/depth beat. It is deliberately rare so it stays heavy.

### 2.1 What triggers it [PROPOSED]

The milestone engine already owns the trigger: `player.milestone` (1..20) advances,
and `run.worldBook.progressionMap.breakthroughs[20]` maps each milestone to its
display level (§6). The breakthrough CHOICE does **not** fire on all 20 — that would
dilute it into a per-level menu. It fires on a **curated subset**: the **walls and
tier graduations** from §6, where the world itself marks a threshold —

> **[PROPOSED] breakthrough-choice milestones: 3 (disp 10 — first solo beast),
> 5 (disp 20 — Tier I→II graduation), 6 (disp 25 — the associations call),
> 11 (disp 50 — THE TOWER GATE), 15 (disp 100 — the classic cap), 19 (disp 200 —
> the S-ceiling; DG becomes takeable), 20 (disp 250 — the Beckoned's cap).**

Ordinary (non-wall) breakthroughs still tick the sheet (HP, rank math, minor-level
fiction per §6) but do **not** open a choice — they are the quiet growth between
the crystallizations. The exact subset is the director's dial; the *principle* is
canon: **the choice is rare and lands on thresholds the world already names.**

### 2.2 The options — count and provenance [PROPOSED]

- **2–3 options** per breakthrough (few enough to weigh, not a catalog).
- Options are drawn from the **world-book skill catalog filtered to what this
  threshold makes reachable**: the player's current **tier/rank band** (§4.3
  distribution) intersected with **what the fiction has sourced** (you can only
  crystallize toward power the world has put in front of you — an association you've
  signed, a zone you've touched, the Tower once you're through the gate).
- The options are **catalog entries**, so a picked skill grants through the exact
  same `grantSkill(run, skillId, { source: "milestone-breakthrough", milestone })`
  primitive as diegetic learning. The breakthrough is a *different way to reach the
  grant*, not a different kind of skill.
- **[PROPOSED] pool sourcing:** the eligible pool is assembled server-side from the
  catalog at grant time (never model-authored) so the three options are always real,
  reachable, budget-legal skills — and never a narrator invention.

### 2.3 How it's PRESENTED — the UX intent (this is the point) [INVENTED — copy; PROPOSED — surface]

This must read as **crossing a line**, not opening a level-up menu. The design intent:

- **The WINDOW takes the whole moment.** Not a chip, not a sidebar — the STATUS
  WINDOW itself becomes the scene for a beat. The sheet stills; the RANK / tier
  readout ticks up in front of the player; a line crosses the window:

  ```
  ┌─ STATUS ────────────────────────────────┐
  │  [ YOU HAVE CROSSED A THRESHOLD. ]      │
  │  RANK  D → C        TIER  I → II        │
  │                                         │
  │  SOMETHING IN YOU CRYSTALLIZES.         │
  │  CHOOSE WHAT YOU BECOME:                │
  │    ▸ Chainbreaker Blow · C · STR        │
  │    ▸ Null Ward · C · Spirit             │
  │    ▸ Fortune's Pocket · C · Luck        │
  │  [ THE WINDOW DOES NOT LIE. ]           │
  └─────────────────────────────────────────┘
  ```

- **VOICE-adjacent weight, WINDOW's mouth.** The register is the VOICE's — spare,
  capitalized, no small talk — but it is the **WINDOW speaking**, not the VOICE. The
  VOICE stays rare (locked decision); the WINDOW is the one that "does not lie," and
  a breakthrough is the WINDOW at its most solemn. On the marquee walls (disp 50 Tower
  Gate, disp 200 DG-unlock, disp 250 the Beckoned's cap) the **VOICE may be permitted
  a single line** — director's call, and only at those — but the *ordinary*
  breakthrough is WINDOW-only.
- **The pick is diegetic, not administrative.** The copy frames it as *what you
  become*, not *which upgrade you buy*. The options are named skills with their rank
  and stat, presented as facets of the champion the player is crystallizing into —
  the fiction of the threshold, made choosable.
- **Weight through rarity + staging, not modality.** Because it fires only on
  thresholds (§2.1), the player has gone many turns since the last one; the staging
  (the sheet stilling, the rank ticking) signals "this is one of the few." It should
  feel earned and heavy every time precisely because it is not frequent.
- **The choice commits, the WINDOW seals it.** On pick, `grantSkill` commits; the
  window resolves back to the standing sheet with the new skill present and the
  threshold behind you. No take-backs — you crossed the line.

---

## 3. Coherence — how BOTH paths commit (the discipline)

| | Diegetic learning | Milestone breakthrough |
|---|---|---|
| Authorizing gate | a real source reached (§1.1) | a real milestone crossed (§2.1) |
| Options provenance | the fiction's teach-list / clear | catalog filtered by tier+fiction (server-assembled) |
| Grant path | `grantSkill(…, {source})` | `grantSkill(…, {source:"milestone-breakthrough", milestone})` |
| Commit order | **before narration** | **before the window seals** |
| WINDOW role | reflects (quiet one-liner) | presents + seals (the event surface) |
| Invention risk | none — catalog-only, server-gated | none — catalog-only, server-assembled pool |

Both are the **same commit-first law as Fortune's Pocket**: state first, prose
second, catalog-bound throughout. The WINDOW never shows a skill the server did not
commit; the narrator never speaks a skill into being. One write path
(`player.babelSkills` via `grantSkill`), one source of truth (the catalog), two
diegetic ways to reach it.

---

## 4. Build-time prerequisites (dependency order — DO NOT BUILD from this doc)

This design **depends on** the following, none of which exists yet. Listed in build
order so the eventual implementation dispatch knows the sequence. (What *does* exist
today: the `player.babelSkills` field — read-only, feeding the §5 RANK RMS and the
sheet's ranked-skill count; the milestone engine + `breakthroughs[20]`
(`progression.js`); the Fortune's Pocket commit-first precedent; the WINDOW render.)

1. **Skill catalog as world-book data** — the §4.4 / §4.4a tables made
   machine-readable (`{ skillId, name, rank, rankIndex, stat, effect, source, budget,
   tags }`). The single source of truth every grant validates against. *Blocks
   everything below.*
2. **The `grantSkill` primitive + write path** — the shared commit operation (§0):
   catalog resolution, dedup, tier/prereq check, append to `player.babelSkills`
   (currently read-only — needs a write path), committed skill-learned event. *Blocks
   both mechanisms.*
3. **Diegetic acquisition hooks** (§1.1) — the four archetypes, each ending in
   `grantSkill`. Sub-dependencies: a **source/location teach-list model** (who teaches
   what — E vendors, Calloway's D arc), an **association standing / patronage model**
   (C/B gates), **contract/quest completion hooks** (contract-gated C/B), and
   **zone-heart / Tower-floor clear events** (A/S). Several of these are their own
   systems.
4. **Milestone-breakthrough choice hook** (§2) — fires when the milestone engine
   crosses a designated breakthrough (§2.1); server-assembles the 2–3-option pool from
   the catalog (§2.2); presents the WINDOW event; commits the pick. Depends on #1, #2,
   and the existing milestone engine.
5. **Skill EFFECTS / check-consumption** — skills must *do* something when used. Their
   effects are written in engine vocabulary (edge/burden, the ten statuses, granted
   attack verbs, derived-stat bonuses, CTB queue operations — §4.3). Depends on: the
   **check economy** (partially exists), the **status system**, and — for every combat
   skill — the **CTB combat engine**. **Combat-tagged skills cannot be exercised until
   combat exists.** (Acquisition and display can ship before effects; a granted skill
   is legible on the sheet before it is usable in a fight.)
6. **STATUS WINDOW presentation** — the skill-list display (partially exists via the
   ranked-skill count; needs the full named list) and the **breakthrough event
   surface** (§2.3): the window-takeover moment, the option presentation, the seal.
   Depends on the scene/window payload (exists) carrying a skill list + a
   breakthrough-event payload, and the client rendering both.

**Suggested build order:** 1 → 2 → (3, 4 in parallel; 4 is lighter) → 6 → 5.
Acquisition + display (1,2,3,4,6) form a coherent shippable slice *before* effects
(5); a skill that is earned, committed, and legible — but not yet swingable — is a
valid intermediate state and matches the World Book's "the sheet is the truth"
posture.

---

## 5. Open questions for the director's redline

- **Breakthrough-choice milestone subset (§2.1):** the proposed set is the 7
  walls/graduations. Tune up (more picks, lighter each) or down (fewer, heavier)?
- **Option count (§2.2):** 2 vs 3. Three gives agency; two gives weight.
- **VOICE at the marquee walls (§2.3):** may the VOICE speak one line at Tower Gate
  / DG-unlock / the 250 cap, or is the WINDOW the *only* voice for every breakthrough?
- **Contract-gated C/B (§1.1):** which C skills are tuition-only vs contract-gated —
  a per-skill catalog flag, set at authoring time.
- **Respec / regret:** the spec assumes grants are permanent (you crossed the line).
  Confirm no respec in Book One.
