# Chapter 8 — Life & Death

*The Inkborne System — Core Book*

Vitality is what the world can take out of you. This chapter is the law of
how it takes it, what happens when it takes everything, and what it costs to
rest. One rule stands over all of it, so we'll state it first:

> **The machinery of dying is universal. The meaning of death is the
> world's.** Every world runs the same dying rules — the saves, the
> stabilization, the thresholds below. But whether the dead can *return*,
> and at what price, is **world lore**. Each world book declares its **death
> profile**: a sprawl may sell clone-backups to those who can pay; a
> pilgrim-road may raise the faithful at its shrines; a wasteland may simply
> say *dead is dead*. The core book will never promise you a way back.
> **Permadeath is always possible** — read your world before you gamble.

---

## Hit points and damage

Your **HP** derives from VIT and level (Chapter 2) and recomputes when
either changes. Damage subtracts from it; nothing else about you degrades —
you fight as well at 1 HP as at full. HP is the distance between you and the
floor, not a spiral.

**At 0 HP you fall — you are *dying*.** Unconscious, prone, out of the
fight, and on the clock.

**Instant death:** if a single blow drops you to 0 and the *overflow* —
damage beyond what your HP could absorb — equals or exceeds your maximum HP,
there is no dying state. You are dead where you stood. Big enough violence
skips the clock.

## Dying and death saves

While dying, on each of your turns you make a **death save**: a bare d20,
nothing added — no stats, no training, and no Luck (per the standing rule,
Luck touches crits, evasion, and fortune's verbs — never the door itself).

- **10 or higher** — one success.
- **9 or lower** — one failure.
- **Three successes** — you **stabilize**: still unconscious at 0 HP, but
  the clock stops.
- **Three failures** — you **die**. What that means is your world's death
  profile.
- **Taking any damage while dying** counts as one automatic failure. A
  fight that rolls over your body is a fight that can finish you.

The tallies reset when you stabilize or recover. A stabilized character
wakes at **1 HP after a short rest** — or the moment any healing reaches
them.

**Stabilizing someone else** is an action with stakes and resolves under
Chapter 3's laws: a **Standard (DC 12) check** — VIT or INT, with
proficiency if you're trained in a relevant domain (field-medicine,
ripper-craft, whatever your world calls it) — or the use of an item built
for the job, which needs no roll. On success the dying character
stabilizes. At-cost and failure bands apply as ever: staunching a wound
under fire has costs, and a failed attempt *changes the situation* — it
never simply wastes the turn.

## Rests

**Short rest** — about an hour somewhere you can genuinely stop: you
recover **half of your missing HP** and shake off **one** lingering minor
status, at most **twice between long rests**.

**Long rest** — a full sleep, and here the referee principle bites:

> **A long rest requires a committed-safe location. Safety is a fact the
> server holds, not a thing a player declares.** The engine checks the
> world's actual state — where you are, what threads are hunting you,
> what the ledger says about this place. If a danger thread has your scent,
> the world can *deny the rest*: the fire draws attention, the knock comes,
> the night is interrupted and plays out as fiction. Saying "we camp
> somewhere safe" has never once made a place safe.

A completed long rest restores **full HP**, clears active statuses, and
resets your short rests. Dying characters cannot long-rest; stabilized ones
can, and wake whole enough to be afraid again.

## Statuses — the universal vocabulary

The Inkborne System has exactly **ten mechanical statuses**. Each is an
engine effect with bounded parameters — a world book may set a poison's
potency within limits, but cannot mint an eleventh mechanic:

| Status | Engine effect (bounded parameters in brackets) |
|---|---|
| **Poison** | Lose HP at the start of each of your turns [potency: 1–5% of max HP per tick of it, duration-capped]. |
| **Blind** | Your sight-dependent attacks and checks take **burden**; attacks against you gain **edge** [duration-capped]. |
| **Silence** | Actions tagged *vocal* or *incanted* are locked [duration-capped]. What that tag covers is world-book content. |
| **Slow** | A queue operation — defined once, in the CTB spec (§5), and only there. Your tempo halves. |
| **Haste** | A queue operation — CTB spec §5. Your tempo rises half again. |
| **Stun** | A queue operation — CTB spec §5. You lose exactly one turn of your own tempo. |
| **Sleep** | Incapacitated: no actions, attacks against you gain **edge**. Ends instantly on taking damage, or when the duration does. |
| **Confuse** | At the start of each of your turns, a seeded roll steers you: act freely / act against a random target / lose the turn [distribution bounded; duration-capped]. |
| **Regen** | Recover HP at the start of each of your turns [potency: 1–5% of max HP, duration-capped]. |
| **Shield** | A pool of absorption points that soak incoming damage before HP [pool bounded relative to max HP; expires with duration or when spent]. |

Three of the ten — **haste, slow, stun** — are *queue* effects. Their entire
mechanical definition lives in the CTB turn-engine spec (§5), which this
chapter defers to rather than restates: one definition, one source of truth.
Durations across all ten use the two currencies defined there (§8): effects
on *you* run in your own turns; effects on the *field* run on the world's
clock.

**Worlds rename; the engine doesn't grow.** A world book may call poison
*neurotoxin*, sleep *cryo-lock*, shield *ward-skin* — names are lore. But
every named affliction in every world book must compile down to one of these
ten. If a world needs something these can't express, that's a conversation
with the system, not a new entry in a book. This is what keeps a status icon
readable across every world you'll ever play: you learned the ten once.

---

*The floor is real, the clock is honest, and the way back — if there is
one — belongs to the world you're standing in. Next: what you carry, what
it's worth, and how things get made.*
