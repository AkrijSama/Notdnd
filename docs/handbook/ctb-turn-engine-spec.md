# CTB Turn Engine — Design Spec

*Inkborne System — mechanical core for Handbook Ch. 2/4 and the contract for
the D.4 combat rework.*

**Status:** implements the [LOCKED] CTB turn-economy decision (ROADMAP-CANON
§1). Positions on unlocked details are marked **[PROPOSED]**. Both former
**[DIRECTOR]** flags were resolved by director ruling (see §10) and are now
**[LOCKED]**. This is a design spec, not player prose.

---

## 1. Model

Combat runs on a **discrete, server-computed turn queue** (FFX-style CTB —
Conditional Turn-Based). There are no rounds and no initiative roll. Instead:

- Time is measured in integer **ticks**. Ticks are queue currency only —
  they never map to real seconds and nothing happens "between" turns.
- Every combatant `i` has a `next_tick[i]` — the tick at which they next act.
- The combatant with the **lowest `next_tick`** acts. After acting, their
  `next_tick` increases by a **delay** determined by their Speed and the
  weight of the action they chose. Repeat.
- The queue is **fully deterministic**: given the same combat state and the
  same choices, the same turn order always results. Fast characters act more
  often as a *consequence of the math*, not a per-round bonus.

## 2. Speed and the tick formula

### 2.1 Speed **[PROPOSED]**

```
speed(i) = clamp(10 + dexMod(i), 8, 16)
dexMod   = floor((DEX − 10) / 2)        // existing d20 modifier math, retained
```

Speed is a **derived stat** (per the locked stat spine: turn-speed derives
from DEX). Status effects multiply it (§5) before the clamp; the clamp always
applies last.

**[LOCKED] Luck is permanently excluded from queue math.** Speed is DEX-only,
forever. Luck's combat surface is: **crit chance, lucky-evade, and fortune's
verbs (steal / loot / flee)** — nothing that moves `next_tick`. Rationale
(director ruling): the forecast must never lie. If Luck could perturb the
queue, the player-facing turn preview (§6) would be probabilistic — either
dishonest or unreadable. Every input to the queue is deterministic and
visible; fortune lives in outcomes, not in tempo.

### 2.2 Delay **[PROPOSED]**

```
BASE = 1200
delay(i, action) = max(1, round( (BASE / speed(i)) × weight(action) ))
next_tick[i] += delay(i, action)         // applied when the action resolves
```

`BASE = 1200` is chosen so a Speed-12 character (DEX 14, the typical trained
adventurer) has a standard delay of exactly **100** — a clean anchor for
tuning and for reading logs.

### 2.3 The math at sample spreads (standard actions, weight 1.0)

| DEX | mod | Speed | Delay | Turns per 1200 ticks |
|----:|----:|------:|------:|---------------------:|
|  8  | −1  |  9    | 133   | 9  |
| 14  | +2  | 12    | 100   | 12 |
| 18  | +4  | 14    |  86   | 13 |

First 12 turn slots of a three-way fight (A = DEX 18, B = DEX 14, C = DEX 8;
everyone's first turn comes at one full delay, §2.4):

```
tick:  86  100  133  172  200  258  266  300  344  399  400  430
actor:  A    B    C    A    B    A    C    B    A    C    B    A
```

A acts 5 times, B 4, C 3. The DEX-18 character is visibly, meaningfully
faster (~1.55× the DEX-8 character's tempo) — but **no double-turn spam**: A
takes two consecutive turns only occasionally, when phase drift lines up
(e.g. slots 200→258→266), never as a steady rhythm.

**Degeneracy bound (invariant):** because Speed is clamped to [8, 16], the
worst possible delay ratio is 150/75 = **2.0**. Therefore **no combatant can
ever take three turns between another combatant's two** — even a hasted
DEX-20 character against a slowed DEX-6 one. At realistic unbuffed spreads
(DEX 8–18) the ratio stays ≤ 1.55 and double-turns are occasional, not
structural. This invariant MUST hold after every status effect; that is why
the clamp applies after status multipliers.

### 2.4 Combat start **[PROPOSED]**

`next_tick[i] = delay(i, standard)` for all combatants at tick 0. No
initiative roll. The fastest combatant simply acts first; ties per §7.
Ambush/surprise is not an initiative concept: a surprised combatant enters
the queue with `next_tick[i] = 2 × delay(i, standard)` (they've lost exactly
one turn of tempo, scaled to their own speed).

## 3. Action costs **[PROPOSED]**

Position taken: **yes, heavier actions delay your next turn more.** Weight
multiplies the post-action delay (§2.2):

| Class | Weight | Examples (world books map concrete actions onto these) |
|---|---:|---|
| **Light** | 0.75 | use a quick item, short reposition, a called shout, drop/ready |
| **Standard** | 1.0 | attack, most powers, full defend, interact |
| **Heavy** | 1.5 | charged/big powers, all-out attacks, complex multi-step acts |

Justification: weight is the price axis that makes CTB a *decision system*
rather than a prettier initiative list. A heavy hit that costs 1.5× tempo is
a real trade (damage now vs. turns later); a light action at 0.75× lets a
fast character weave utility between an enemy's turns. Without weights, the
queue is static and the forecast (§6) never moves — the system loses its
tactical layer. Three coarse classes (not per-action values) keep it
learnable and keep world-book authoring cheap: every authored action declares
`light | standard | heavy`, nothing else.

Weight applies to the delay **after** the action resolves — choosing a heavy
action never postpones the current turn.

## 4. Queue recomputation on speed change

When `speed(i)` changes mid-combat (status applied/expired, gear, script):

```
remaining      = next_tick[i] − now            // now = tick of the causing event
new_remaining  = max(1, round( remaining × (old_speed / new_speed) ))
next_tick[i]   = now + new_remaining
```

The **pending wait rescales proportionally**; delays already served are never
retroactively adjusted, and turns already taken are never revisited. Getting
hasted while 60 ticks from acting at Speed 12→16 moves you to 45 ticks out.
Rescaling only ever touches `i`'s own entry; all other combatants are
unaffected. Recomputation is atomic per causing event and processes multiple
same-tick events in event order (§7).

## 5. Haste, slow, stun — as queue operations **[PROPOSED]**

All three are defined *only* in terms of Speed and `next_tick`. No skip
flags, no lost-turn markers — the queue itself is the status effect.

| Effect | Operation | Net feel |
|---|---|---|
| **Haste** | `speed ×= 1.5`, **then** clamp per §2.1, rescale pending wait per §4. Lasts its stated duration. | ~50% more turns while it lasts; hitting the 16 clamp preserves the 2.0 bound. |
| **Slow** | `speed ×= 0.5`, **then** clamp, rescale per §4. | Pending wait roughly doubles; tempo halves until it expires (clamp floor 8 keeps the victim in the fight). |
| **Stun** | `next_tick[i] += delay(i, standard)` — one full standard delay added, once, at application. Speed untouched. | The victim loses **exactly one turn of their own tempo**. |

Stun scaling to the *victim's own* delay is deliberate: a flat tick penalty
would tax fast characters more (100 ticks ≈ 1.16 of a fast character's turns
but only 0.75 of a slow one's). "One of your own turns" is equal in the
currency that matters. Stacked stuns add — two stuns = two lost turns — and
the engine caps consecutive stun-lock: a combatant whose `next_tick` is
pushed twice without acting is immune to further stun until they act
**[PROPOSED — anti-stunlock rule]**.

Haste and slow on the same combatant multiply (1.5 × 0.5 ≈ net 0.75 — slow
mostly wins) rather than cancel-by-fiat; the clamp bounds every stack.

**Clamp ordering is load-bearing — this is normative, not stylistic:** the
[8, 16] clamp of §2.1 applies **after** all status multipliers, on the final
effective Speed, on every recomputation. The 2.0 degeneracy bound ("no
combatant ever takes three turns between another's two") holds *only* under
this ordering — clamping base Speed before multiplying would let haste push
effective Speed to 24 against a slowed floor of 4, a 6.0 ratio. An
implementation that clamps before multiplying is nonconforming even if it
passes at unbuffed spreads. Test-of-record: hasted DEX 20 vs slowed DEX 6
must never produce a triple-turn.

## 6. The visible forecast (player-facing queue preview)

The queue is not hidden information — **the forecast is the tactical UI**.

- The server computes the next **8 turn slots** by simulating the queue
  forward, assuming every combatant takes **standard-weight** actions and no
  status changes. This forecast ships in the combat state payload every turn.
- **[LOCKED] Order-only, player-facing.** Each slot carries `actorId`,
  `displayName`, `isPlayer`, and `slotIndex`. Raw tick numbers are **never**
  shown to the player — order is the interface (director ruling: rhythm, not
  spreadsheet). Ticks remain available in a **debug view** (dev/diagnostic
  surface only, never the player UI).
- **[LOCKED] The forecast shows ALL revealed combatants — including
  enemies.** Seeing *when* enemies act is half the decision space, alongside
  their telegraphed intents: "the collector moves twice before my ally" is
  exactly the information the action-weight economy trades in. Hiding enemy
  slots would reduce CTB to initiative-with-extra-steps.
- **Ambush-integrity rule:** combatants that are **hidden or unrevealed are
  absent from the forecast** — the forecast never leaks an ambush, a
  reinforcement wave, or a stalker the fiction hasn't surfaced. Unrevealed
  combatants are not queue members at all; they are staged outside it. On
  **reveal** (mid-fight or otherwise), the queue is **recomputed at that
  moment**: the revealed combatant is inserted with
  `next_tick = now + delay(i, standard)` — an ambusher who opens the fight
  by striking is inserted *and acts* as one event; a combatant revealed
  while surprised is inserted at `now + 2 × delay(i, standard)` (the §2.4
  surprise rule). From that update onward they occupy honest forecast
  slots. Net law: the forecast never shows a slot for someone the player
  can't see, and never shows a wrong slot for someone they can. Filtered
  truth, never altered truth.
- **Live preview delta:** while the player is choosing an action, the client
  may request the forecast recomputed under each action weight ("if I use
  the heavy swing, my next turn falls from slot 3 to slot 6"). This is a
  pure function of visible state — no information leak — and it is the
  moment the action-weight economy becomes *legible*: the player watches
  their own marker slide down the queue as they hover the heavy option.
- The narrator receives the same forecast and may describe tempo in fiction
  ("the collector is fast — you'll get one move before he's on you again"),
  but prose never contradicts the queue: **the forecast is truth, the
  narration is voice** (server-as-referee, per Ch. 1).

## 7. Determinism and seeding

- **Integer ticks only.** All delay math rounds at the operation (§2.2, §4,
  §5); no floats persist in state.
- **Tie-break, in order:** (1) lower `next_tick`; (2) higher Speed;
  (3) stable seeded order — a per-combat `queueSeed` hashed with actor IDs at
  combat start fixes a total order used for all remaining ties. No rerolls,
  no wall-clock, no insertion-order dependence.
- **Reproducibility:** the queue's full evolution is a pure function of
  `(initial combat state, queueSeed, ordered action log)`. Replaying the log
  reproduces the identical turn sequence — required for the selfplay
  harness, for bug reports, and for the narrator contract (prose is generated
  *after* adjudication, from committed queue truth).
- The queue is **server truth**. The client renders it; nothing about turn
  order is ever computed client-side.

## 8. Durations **[PROPOSED]**

Two duration currencies, chosen by what the effect is attached to:

- **Self-attached effects** (buffs, stances, stun immunity): measured in the
  affected combatant's **own turns** ("for your next 3 turns"). Intuitive,
  and immune to tempo exploits.
- **Field/scene effects** (zones, hazards, scripted arrivals): measured in
  **absolute ticks**, authored in standard-turn units (300 ticks ≈ "about
  three turns"). Fast characters genuinely get more actions inside a
  window — that's CTB working as intended, not a bug.

## 9. D.4 REWORK DELTA

What changes in the existing combat slice, exactly.

### Removed
- **The initiative roll** (d20 + DEX at combat start) — gone entirely, no
  vestige. §2.4 replaces it.
- **Round structure**: the round counter, "start of round" / "end of round"
  hooks, and the fixed rotation within a round.
- Any "once per round" phrasing — re-expressed as "once per own turn" or as
  a tick-window (§8).

### Replaced
- **Turn scheduler**: fixed rotation → tick queue (§1–§2). This is the core
  D.4 surgery; the scheduler is the only combat module that is rewritten
  rather than edited.
- **Round-keyed durations** → the two currencies of §8.
- **Combat state payload**: gains `queue` (the §6 forecast), `tick` (current
  queue clock), and per-combatant `speed`; drops `round` and
  `initiativeOrder`.

### Survives untouched
- **Positionless design** — no grid, no movement economy; CTB is orthogonal
  to positioning and D.4's positionless lock stands.
- **Attack resolution** — d20 vs derived Evasion, damage math, VIT-derived
  HP. (Attack/Evasion/Accuracy/Crit derivation is Ch. 2 scope; this spec
  consumes them as given.)
- **Three-band outcomes** in combat narration (Ch. 3 Law 2 applies to combat
  checks unchanged).
- **Action intents / menu semantics** — what a player can *declare* is
  unchanged; each intent additionally declares a weight class (§3), default
  `standard`, so existing content is valid with zero edits.
- **Enemy statblocks** — schema unchanged; Speed derives from the DEX they
  already carry. Existing statblocks (e.g. `waylayer`) need no edits.
- **Victory/defeat handling, flee/negotiate exits, the narrator contract.**

### New (small)
- `queueSeed` in combat init; forecast simulation (§6); the anti-stunlock
  counter (§5).
- **[PROPOSED]** Named bosses may hold **two queue entries** (offset half a
  delay apart) instead of inflated Speed — this produces "the boss acts
  twice" *without* violating the Speed clamp or the 2.0 invariant, and the
  forecast shows both entries honestly. Off by default; a world-book flag.

## 10. Director rulings (both former flags resolved — now [LOCKED])

1. **[LOCKED] Luck and the queue.** Luck is **permanently excluded from
   queue math**. Its combat surface is exactly: **crit chance, lucky-evade,
   and steal / loot / flee**. Nothing Luck touches may move `next_tick`.
   Governing principle: **the forecast must never lie** — every queue input
   stays deterministic and visible (§2.1).
2. **[LOCKED] Forecast presentation.** **Order-only** to players; raw ticks
   live in a debug view only. The forecast shows **all revealed combatants
   including enemies** — enemy timing plus telegraphed intents is the
   decision space. Hidden combatants are absent until revealed
   (ambush-integrity rule, §6).

Everything still marked **[PROPOSED]** (band-anchor BASE=1200, Speed clamp
[8,16], weights 0.75/1.0/1.5, haste/slow/stun operation constants,
anti-stunlock, duration currencies, boss dual-entry) is ready to build
against and cheap to retune — each is a constant or a local rule, none is
architectural.
