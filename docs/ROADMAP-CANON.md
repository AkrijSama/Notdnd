# Inkborne — Roadmap Canon

**Single source of truth for Inkborne's direction.** This document supersedes all
scattered roadmap references. When another doc, comment, or memory disagrees with
this file, this file wins.

**Decision-status tags** — every item carries exactly one:

- **[LOCKED]** — the director explicitly decided this; non-negotiable.
- **[PENDING]** — direction agreed, but a specific decision is still owed by the
  director; the exact open question is stated inline.
- **[PARKED]** — deferred to a later phase; the gate that reactivates it is stated
  inline.

> Recording a **[PENDING]** item as **[LOCKED]** corrupts the canon. When a status
> is ambiguous, it is tagged **[PENDING]** with the open question named — not guessed
> into LOCKED.

_Last updated: 2026-07-05._

---

## 1. THE PIVOT

This is the current active direction. It supersedes the prior "MVP" plan.

- **[LOCKED] Proprietary IP layer.** Keep 5e's uncopyrightable d20 math / resolver /
  coherence spine; replace the WotC-flavored **content** with a proprietary rulebook
  (stats, races, items, weapons, backgrounds, crafting, laws) expressed as **data the
  engine reads**, expansion-book-ready. Model: Naruto-5e homebrew — the engine is the
  system, the rulebook is swappable content.

- **[LOCKED] Universal stat spine.** `STR / DEX / VIT / Spirit / INT / Luck`. Derived
  combat stats (Attack, Evasion, Accuracy, turn-speed, Crit) compute from these.

- **[LOCKED] Race contract.** Race = a stat boost + a feat; the rest is flavor. Race
  **content** is per-world; the race **contract** (stat-budget + feat reference) is
  universal.

- **[PENDING — BLOCKS THE ENTIRE ACTIVE TRACK] Turn economy.** FF speed-based turn
  frequency **vs** 5e single-initiative. **Owed by the director.** Rulebook Ch.2+, the
  power system, feats, classes, and the D.4 combat rework **all** depend on this.
  This is the highest-priority open decision in the project.

- **[LOCKED] Build sequence (strict order):**
  1. **Rulebook / Player's Handbook**, chapter by chapter, with the **Isekai world as
     the first reskin target**.
  2. **"Law of Creating Worlds" spec** — the valid-world schema (factions, figures,
     artifacts, power-systems, background) + UGC submission rules.
  3. **Author 3 worlds** — Isekai-tower, Cyberpunk, and the director's post-apoc IP.
  4. **Full onboarding REWORK** — a rebuild, not patchwork.

- **[LOCKED] GM pacing fix.** Turn-1 delivers an **in-fiction lore-dump via a
  quest-giver** (player wakes with amnesia; establish the land, the conflict, the
  player's role, and why they're here). After that, NPCs + player agency drive it, with
  the GM as **"paintbrush not hammer."** Add an **OOC channel** — no competitor has this.

---

## 2. REWORKED ONTO THE NEW LAYER

Built already; the architecture survives, the content changes.

- **[LOCKED] D.5 narrative substrate (threads / fronts).** Re-pointed at the new
  world / rulebook layer.

- **[PENDING] D.4 turn-based positionless combat.** Partially reworked by the
  turn-economy decision — cannot be finalized until that [PENDING] item in §1 is
  resolved. (Open question: same as the turn-economy blocker.)

- **[LOCKED] `the_shipment`** becomes **one story inside the cyberpunk world**, not the
  standalone unit.

---

## 3. SHELVED

- **[PARKED] Grading the current build.** Moot until the slice is reworked onto the new
  layer. **Reactivation gate:** a rebuilt slice exists on the new world/rulebook layer.

---

## 4. POST-VALIDATION ROADMAP

**Gate for this entire section:** a functioning, validated MVP.

- **[PARKED] 2nd / 3rd genre scenarios** — acquisition lever.
- **[PARKED] Community / UGC world submission** — the content flywheel; seed =
  authorable JSON + the world-law schema.
- **[PARKED] Ruleset choice as an advanced option.**
- **[PARKED] Per-world stat systems.**
- **[PARKED] Romance / Tier-2 mature line** — fade-to-black; researched, ready.
- **[PARKED] Multiplayer** — FnF home turf; re-examine pricing/positioning on activation.
- **[PARKED] Rulebook ingestion (any-system)** — furthest from revenue.

---

## 5. FORBIDDEN MODE

**Its own regulated business — NOT a subscription tier.**

- **[PARKED] Web-only, direct-pay, high-risk processor.**
  **Gate:** post-mainline-revenue **and** an explicit director decision.

  **Recorded cost reality (so it is not re-litigated on the cheap-setup illusion):**
  - True cost is **10.8–14.5% per transaction** (~3× mainline).
  - **5–20% rolling reserves**, held **90–180 days**.
  - **14–21 day underwriting.**
  - A **compliance / age-verification operational function** is required.
  - The ~$500 setup fee is **not** the real cost — the above is.

---

## 6. OPEN BUGS / DEBT

Non-blocking, logged.

- **Images broken in-session** — diagnosis was dispatched but never ran; genuinely open.
- **Model-display UI panel** — requested twice, deferred.
- **Payment rail groundwork + whale-cap-to-token-budget verification** — gated on MVP.
- **C.23** — acquisition-verb intent auto-succeeds with no delta.
- **C.24** — plural goal phrasings create no objective.
- **Consequence selfplay scenario red** — fallback move → `ACTION_INVALID`, engine
  layer, needs owner.

---

## 7. STRATEGIC NOTES

Recorded honestly — no editorializing into false confidence.

- The pivot places most **money-gating** items (payment, distribution, first
  fun-verdict) **behind** a full rulebook + worlds rebuild — pushing "first revenue" and
  "first stranger plays it" meaningfully later. This is a **deliberate director
  tradeoff**: proprietary-IP foundation before fun-validation.
- **Distribution is 0%.** Nobody outside the director knows the project exists.
  First-100-users is an unsolved problem for post-validation.
- **Human-validated fun remains 0%** and unmeasured on any build.

---

## DECISIONS OWED BY THE DIRECTOR

Every **[PENDING]** item, as a checklist. The turn-economy decision is the blocker at
the top.

- [ ] **Turn economy — FF speed-based turn frequency vs 5e single-initiative.**
      _(§1)_ **BLOCKS THE ENTIRE ACTIVE TRACK** — Rulebook Ch.2+, the power system,
      feats, classes, and the D.4 combat rework all depend on it. Highest priority.
- [ ] **D.4 turn-based positionless combat — final rework shape.** _(§2)_ Blocked on
      the turn-economy decision above; cannot be finalized until it lands.
