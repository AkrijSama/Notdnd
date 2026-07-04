# D.4 Phase 0 — The Combat Contract (FROZEN — doc + tests-of-record, no gameplay code)

**Status:** Phase 0 deliverable of the approved D.4 spec
(`docs/inkborne-combat-d4-spec.md` §6). This document is the contract Phase 1
builds against. It ships with one pure, unwired contract module
(`server/solo/combatContract.js`) and its tests-of-record
(`tests/combat-contract.test.js`). **No gameplay code:** no `run.combat` schema
wiring, no `server/solo/combat.js`, no reroute-chain edits, no scene-payload
field. Those are Phase 1. Everything below is verified against the repo at the
line references given.

**D.5 correction applied (owner directive).** The D.4 spec's momentum-side entry
(spec §2.2(2) and §5.3 — a new `threat` momentum template kind) is **superseded**
by the narrative-substrate spec (`docs/inkborne-narrative-substrate-d5-spec.md`
§7, §9 combat note): the hostile arrives as a **danger-thread `hostileNpc`
beat** — the reeve's collector (D.5 §3.1.1 rung 2) — not a parallel template
kind. The `threat` templates are **not built**. This contract carries forward
only the two entries that survive: the **player attack intent** (combat Phase 1)
and the **thread `hostileNpc` beat** (lands with D.5 Phase 1, against the
bestiary this contract defines). See §3.2.

---

## 0. What Phase 0 freezes vs defers

| Frozen here (contract) | Deferred to Phase 1 (behavior) |
|---|---|
| The in-combat action space (closed set) — §1.1 | The resolver that rolls attack/defend/flee/stunt (`combat.js`) |
| The free-text → action mapping table + cost rules — §1.2/§1.3 | Wiring `classifyCombatInput` into `resolveSoloAction` |
| The reroute-chain change list (entry + interception) — §1.5 | Editing `server/solo/actions.js` to add the two seams |
| The `run.combat` shape + validators-to-write — §3.1 | The `schema.js` validator + `scene.js` `combat` field |
| Combat entry interfaces (attack intent; `hostileNpc` beat) — §3.2 | `enterCombatFromAttackIntent` / `enterCombatFromHostileBeat` |
| The momentum×dying freeze — §2 | (nothing — the freeze is already true; §2 locks it) |
| The `statBlockId` string contract D.5 consumes — §3.4 | `server/campaign/bestiary.js` content |
| The per-round narration payload shape — §4 | `buildCombatGmMessage` |
| `classifyCombatInput` + `validateCombatMapping` (pure) — §1.6 | The optional LLM classifier that feeds `validateCombatMapping` |

The one executable artifact Phase 0 ships is the **pure interpreter contract**
(§1.6): the deterministic classifier and the LLM filter-back firewall, wired
into nothing, pinned by tests-of-record so Phase 1 cannot drift the seam the
owner flagged as the hard condition.

---

## 1. The in-combat interpreter contract (the hard condition)

> *A mis-route in a turn machine corrupts initiative.* Routing an intended flee
> as an attack traps the player in a fight they tried to leave; routing a
> question as an action burns a turn they never spent; routing a colorful attack
> *around* the combat resolver reopens the generic-check bypass and double-hits.
> This seam gets the M.1/A1 treatment: deterministic, grounded, word-boundary
> anchored, and **failing safe to a no-cost clarification, never to a wrong
> committed action.**

### 1.1 The constrained action space

While `run.combat.status === "active"`, `getAvailableSoloActions`
(`server/solo/actions.js:269`) returns the **combat menu** instead of the
exploration menu. The legal set is closed (`COMBAT_ACTIONS` in
`server/solo/combatContract.js`):

| Action | Resolves as | Turn cost |
|---|---|---|
| **attack** | d20 + prof + STR/DEX vs enemy AC; damage = weapon die + mod (Phase 1 `combat.js`) | spends turn |
| **defend** | attacks against the player at disadvantage (`kl1`, `dice.js:43`) until their next turn | spends turn |
| **flee** | contested check → **real** movement resolver (`getAvailableMoves`, M.1 discipline `actions.js:578`) | spends turn |
| **use_item** | the existing `use_item` resolver unchanged (`useItem.js:250`) | spends turn |
| **stunt** | a normal `resolveAbilityCheck`; success buys ONE `COMBAT_STUNT_EFFECTS` boon; never damage, never a win | spends turn |
| **hold_on** *(dying only)* | roll the death save (the dying-turn rule, `actions.js:353`) | spends turn (rolls the save) |

Exploration actions (`move`, `search`, `inspect`, `talk`, `rest`) are **illegal
while combat is active** and are rejected without spending the turn
(`ACTION_ILLEGAL_IN_COMBAT`) — a combat-aware client never offers them, but a
free-text client can still send them, and the turn machine must not consume a
round on one. `use_item` is the sole exploration verb that stays legal (it is on
the combat menu). Positionless combat means there is **no mid-combat `move`** —
the only relocation is Flee, which is a combat action, not an exploration move.

### 1.2 The mapping table (free text → action)

The deterministic classifier (`classifyCombatInput`, §1.6) applies these rules
**in precedence order**. Precedence is chosen so the costliest mis-maps are
foreclosed first (escape before aggression), mirroring how the reroute chain
orders quest-accept before the directional fallback (`actions.js:786-896`).

| # | Signal | Routes to | Grounding requirement |
|---|---|---|---|
| 0 | empty / blank | **clarify** | — |
| 1 | interrogative (`INTERROGATIVE_RE`, the A1 guard `actions.js:72`) | **clarify** (answer from state) | — |
| 2a | dying + use-verb + **held** item | **use_item** | item really in inventory |
| 2b | dying + anything else | **hold_on** (roll death save) | — |
| 3 | flee verb (`FLEE_RE`, high precision) | **flee** | — |
| 4 | defend verb (`DEFEND_RE`) | **defend** | — |
| 5 | use-verb + **held** item | **use_item** | item really in inventory (else → clarify) |
| 6a | attack verb **+ a stunt cue** (blind/trip/taunt/environment: "kick sand in its eyes") | **stunt** (low-confidence) | — — a maneuver, not a bare strike; buys a boon, never damage |
| 6b | attack verb + **resolvable living enemy** | **attack** | present, living target; never minted (else → clarify) |
| 7 | actionable but off-menu ("topple the brazier onto it") | **stunt** (low-confidence) | — |

Row 6a is the honest boundary case the owner's hard condition names: an
aggressive-sounding input whose object is the *environment* or whose verb is
*disabling* (blind, trip, distract) is a **stunt** (enumerated boon, never direct
damage), not a second damage path. A bare "kick the hound" still reads as attack
(6b); only an instrument/environment object or a disabling verb trips 6a. These
are marked low-confidence, so Phase 1's optional LLM layer (§1.4) may refine
them — but the deterministic default already fails safe to the boon path, never
to an unintended extra strike.

Grounding discipline is the `detectTakeIntent`/`resolvePossessionClaim`
precedent (`actions.js:823`, `attempt.js`): the classifier **never mints a
target and never conjures an item**. An attack verb with no resolvable enemy, or
a use-verb naming an item the player does not hold, does **not** silently spend
the turn on nothing — it clarifies.

### 1.3 What an unmappable input costs (the cost table)

This is the owner's explicit Phase-0 question. The answer is a two-value cost
(`COMBAT_TURN_COSTS`):

| Input class | Cost | Rationale |
|---|---|---|
| A **question** ("how hurt is it? what's it about to do?") | **none** — free clarification, answered from committed state (enemy hp band, telegraph); the round does **not** advance, no enemy acts | ask ≠ act (A1). Punishing the player for asking would defeat the telegraph system, which exists to be asked about. |
| An **ungrounded** action (attack no-one-present; use an item not held) | **none** — clarify which target/item; round does not advance | The reroute firewall: never mint a target/item; a typo must not burn a turn. |
| A **creative, off-menu, but actionable** attempt ("topple the brazier onto it") | **turn** — resolves as a **stunt**: an ability check whose success buys one enumerated boon, whose failure spends the turn | The honest path between two failures: it does not tyrannize creative play (no auto-fail) and does not reopen the bypass (no direct damage, no win outside the resolver). |
| A **grounded menu action** (attack/defend/flee/use_item) | **turn** — resolves and the round advances | The normal case. |

The invariant: **the turn is consumed only when the player took a real, grounded
action or a stunt.** Questions and ungrounded inputs are free. Nothing that
fails to map ever silently resolves as the wrong action — a mis-route is
strictly worse than a no-op in a turn machine, so the classifier is biased
toward `clarify` (no cost) and `stunt` (a safe, enumerated real action) over
guessing a menu action.

### 1.4 Two layers: deterministic-first, LLM-optional, filter-back firewalled

The in-combat interpreter is exactly the momentum-ranker pattern
(`momentum.js:275-291`) applied to classification:

1. **Layer A — deterministic (always runs, no network).**
   `classifyCombatInput` returns a concrete, safe routing decision for every
   input. High-confidence rows (0–6) resolve directly. Row 7 (off-menu
   actionable) returns `{ route: "stunt", confidence: "low" }`.
2. **Layer B — LLM (optional, only on `confidence: "low"`).** Phase 1 *may*
   consult the in-combat interpreter to instead map a low-confidence input onto
   a menu action (a floridly-described attack the regex missed). The model's
   proposal passes through **`validateCombatMapping` and nothing else**: any
   route outside `{attack,defend,flee,use_item,stunt}` is discarded; a proposed
   `attack` whose target is not a present living enemy is discarded; a proposed
   `use_item` whose item is not held is discarded; a proposed stunt effect
   outside `COMBAT_STUNT_EFFECTS` is dropped to "no boon". On any rejection the
   **deterministic Layer-A decision stands.** The model can never widen the
   action space, mint a target/item, deal damage, or end combat, because those
   proposals do not survive the firewall.

**The model classifies; it never adjudicates.** The interpreter's only combat
roles are (a) classification onto the legal menu and (b) the optional enemy
intent ranker (§4) — both filter-back validated, both degrade to a seeded/
regex default when absent. Mechanics (the roll, the damage, the state change)
are resolver output, exactly as movement is today (coherence leak #1, §5).

### 1.5 The reroute-chain changes (enumerated)

Two distinct, independently-testable insertion points in `resolveSoloAction`
(`server/solo/actions.js:606`). The existing chain is unchanged in order; combat
adds one detector to it and one interception before it.

**Change A — combat ENTRY (out of combat → in). One new detector in the
attempt-branch reroute chain (`actions.js:786-896`).** Insert
`detectAttackIntent(run, intent)` **after** the ask≠act interrogative guard
(`actions.js:818`) and after the take/move/search detectors, immediately before
the fall-through to `resolveAttemptAction` (`actions.js:904`):

```
attempt branch, in order (existing → NEW):
  detectQuestAcceptIntent      (actions.js:791)   unchanged
  [interrogative = isInterrogativeIntent]  (:818)  unchanged  ← questions never start a fight
  detectTakeIntent             (:823, gated by !interrogative)  unchanged
  detectMoveIntent             (:849, gated)       unchanged
  detectSearchIntent           (:879, gated)       unchanged
  detectAttackIntent           (NEW, gated by !interrogative)   ← fires only when combat is NOT active
  → resolveAttemptAction       (:904)              unchanged fall-through
```

`detectAttackIntent` fires only when **all** hold: `run.combat` is not active; the
intent is a clear attack verb (`ATTACK_RE` — the aggressive subset of
`CONTESTED_INTENT_RE`, `attempt.js:172`); and it grounds on a **present,
resolvable** hostile-capable NPC (never minted — `detectTakeIntent` precedent).
On fire it calls the Phase 1 entry function (§3.2). An aggressive verb with **no
present target** does **not** enter combat — it falls through to
`resolveAttemptAction` and resolves as today's generic contested check (a swing
at air), so legacy behavior is preserved exactly where no enemy exists.

**Change B — in-combat INTERCEPTION (already in combat).** A single guard at the
top of `resolveSoloAction`, before the existing type branches:

```
if (combatActive(run)) {
  if (normalized.type === "use_item") { /* existing resolver, counts as the combat turn */ }
  else if (normalized.type === "attempt") return resolveCombatInput(run, normalized, options);   // Phase 1
  else return { ok:false, code:"ACTION_ILLEGAL_IN_COMBAT", ... };   // move/search/talk/inspect/rest: no turn spent
}
```

`resolveCombatInput` (Phase 1) is the only new resolver; it calls
`classifyCombatInput` (Layer A), optionally escalates through
`validateCombatMapping` (Layer B), then dispatches to the attack/defend/flee/
stunt/use_item/hold_on resolver. Because the whole round resolves inside this one
HTTP action, the one-action-per-turn architecture
(`resolveSoloAction` → clone → validate → persist) is unchanged — a combat round
is a fatter action result (D.4 spec §2.3).

**Interaction with the dying-turn loop.** The existing dying-turn rule
(`finalizeQuestProgress`, `actions.js:353`: any non-`use_item` action while dying
rolls a death save) is **not modified**. In combat, `classifyCombatInput`
surfaces it as the `hold_on` route (row 2b); the underlying save is still rolled
by the same code. The `use_item` exemption (`actions.js:353`, documented
`:635-639`) composes unchanged.

### 1.6 The pure contract module + tests-of-record

`server/solo/combatContract.js` (shipped in Phase 0, **wired into nothing**):

- `COMBAT_ACTIONS`, `COMBAT_STUNT_EFFECTS`, `COMBAT_TURN_COSTS` — the sealed enums.
- `classifyCombatInput(intent, context)` — Layer A (pure; §1.2/§1.3).
- `validateCombatMapping(candidate, context, fallback)` — Layer B firewall (pure; §1.4).
- `isInterrogativeCombatInput(intent)` — the A1 guard, reused verbatim.

`tests/combat-contract.test.js` pins the mapping table and the cost rules as
tests-of-record: attack-verb+enemy→attack; attack-verb+no-target→clarify(none);
flee→flee; defend→defend; drink+held→use_item, drink+not-held→clarify(none);
interrogative→clarify(none); off-menu-actionable→stunt(turn); dying+item→use_item,
dying+other→hold_on, dying+question→clarify; and the firewall rejecting an
off-menu route, a minted target, an unheld item, and an invented stunt effect.

---

## 2. Momentum × dying (the second condition) — the freeze

> *What does the clock do while the player is at 0 HP / in death saves? Who owns
> the turn, what may fire, what must not.*

**This is already true in the code; §2 locks it against future change.** The
momentum/thread clock is **frozen** from the instant the player reaches 0 HP
until they are stabilized (back above 0) or dead.

**Verified mechanism.** `advanceMomentum` (`momentum.js:379`) only fires when its
guard holds (`momentum.js:397-406`):

```js
if (
  cls !== "progress" &&
  momentum.tension >= tuning.fireAt &&   // fireAt: 6
  cooledDown &&                          // cooldownTurns: 3
  run.status === "active" &&
  !playerIsDying(run)                    // ← the freeze
) { … }
```

`playerIsDying` (`momentum.js:135-138`) is true when `run.player.status` is
`"dying"` or `"dead"`. D.5 reaffirms the same gate for thread beats (D.5 §4.2:
fire needs "active run, not dying"). Therefore:

| Question | Contract answer |
|---|---|
| **Who owns the turn while dying?** | The **player**, exclusively — their `hold_on` (roll the save) or `use_item` (play a held heal/revival, the exemption). Nothing server-initiated takes a turn. |
| **What MAY fire?** | Nothing server-initiated. Not a momentum one-off, not a thread beat, not a new hostile, not a combat entry. The only counterplay is the player's own `use_item` (possessed-means revival, `death.js findRevivalMeans`). |
| **What MUST NOT fire?** | A thread `hostileNpc` beat placing a new enemy on a downed player (a death sentence with no counterplay); any momentum hazard; any combat entry (`detectAttackIntent` / the beat executor) — all blocked by `!playerIsDying`. |
| **Does combat keep running while dying?** | **No.** Per D.4 spec §2.4, combat ends the moment the player drops (`status: "lost"`) and `run.combat` clears. The death-save aftermath happens **out of combat**, in the ordinary dying-turn loop, with the clock frozen. There is no "enemy turn against a downed player": the `vicious` parting blow (D.4 §2.4) is a **one-time** event at the drop, not a per-round attack. |
| **Does tension still accrue while dying?** | Irrelevant to the guarantee: even at max tension the `!playerIsDying` clause blocks the fire. The contract guarantees **nothing fires while dying**, regardless of the tension counter's value. |

**The load-bearing invariant for Phase 1:** a combat round is implemented as a
"fat action," and a future author could be tempted to let enemies keep acting on
a downed player within that fat action. **The contract forbids it.** Combat ends
at the drop; the momentum×dying freeze then owns the turn. The alternative
(fights to the corpse) is one flag away (`vicious` on everything, D.4 §2.4) but
is explicitly *not* the default, and even then it routes through the one-time
parting-blow event, never a sustained clock.

---

## 3. The `run.combat` state machine

### 3.1 Shape (contract-frozen, additive, validated like every first-class record)

`run.combat` is a new **optional** field on the persisted run (legacy runs stay
valid; the scene payload emits `combat: null` when absent — the
`armorClass ?? null` pattern at `scene.js:686`). It is validated in `schema.js`
by a new `validateCombatState`, called from the `validateRecord` band
(`schema.js:348` definition; call sites `:1057-1062`), with the same referential
integrity discipline that rejects dangling `linkedQuestIds`
(`schema.js:1103-1118`): every `combatants[].npcId` must exist in `run.npcs`,
and every `statBlockId` must be a non-empty string (bestiary resolution is
combat's job, not the schema's — §3.4). The shape is D.4 spec §2.1 verbatim
(`combatId`, `status`, `round`, `turnOrder`, `turnIndex`, `combatants`,
`enemyIntents`, `startedAt`, `endedAtRound`, `outcome`).

**Design invariant carried from the spec (§2.1):** player HP/AC/conditions are
**never** duplicated into `run.combat`. Damage to the player routes through
`death.js applyDamage` (`death.js:305`) exactly as today, so the entire death
spine composes with zero new lethality code: dying at 0, instant death on
overkill ≥ max HP (`death.js:353`), crit = 2 save-failures (`death.js:382`),
`rollDeathSave` nat20-revive / nat1-double-fail / DC-10 (`death.js:406`),
possessed-means revival, permadeath via `markDead`/`resolveLethal`
(`death.js:268`/`:281`). Enemy HP lives on the combatant entry; an enemy at 0 HP
is dead or broken — **enemies get no death saves.**

### 3.2 Entry (two survivors of the D.5 correction)

1. **Player attack intent** — `detectAttackIntent` (§1.5 Change A) →
   `enterCombatFromAttackIntent(run, intent, target)`. **This is combat Phase 1's
   only entry.** Instantiate the enemy combatant from the bestiary, roll
   initiative, write `run.combat`, resolve the declared attack as round 1's
   player action if they won initiative (else the enemy's first intent resolves
   first).
2. **Thread `hostileNpc` beat — the reeve's collector (canonical).** *Not* a
   `threat` momentum template (D.5 correction). D.5's danger-thread rung 2
   (`beat_enforcer_arrives`, D.5 §3.1.1) commits a `hostileNpc` payload carrying
   `statBlockId` + a demand dialogue beat, **telegraphed, not instant combat**
   (D.5 §2.2). Combat starts on the player's *engagement* (refusing the demand
   routes into `enterCombatFromHostileBeat(run, beatPayload)`), preserving
   agency. **Build order:** this entry lands with **D.5 Phase 1**, against the
   bestiary this contract defines; combat Phase 0–1 does not build it. Combat
   Phase 0's obligation is only to freeze the entry-function signature and the
   `statBlockId` string contract (§3.4) so the two sides compose without
   rework.
3. **NPC hostility from fiction** — deferred to combat Phase 3 (D.4 spec §2.2(3));
   requires interpreter judgment out of scope for the first slice.

### 3.3 Initiative, rounds, turn ownership, resolution states

- **Initiative** uses the already-computed modifiers: player d20 +
  `derivedStats.initiative` (`characterBuild.js:92`, dex mod), enemy d20 +
  stat-block dex mod, via the injectable `rollD20` (`dice.js:20`). Rolled once at
  entry. **Ties → player** (solo protagonist).
- **Round / turn ownership.** One HTTP action = one full round: the player's
  chosen action resolves, then every living enemy executes its committed intent
  in initiative order, all inside the single action result. Turn owner within the
  round is initiative order; the player never loses ownership of *their* slot to
  the server (the server owns only enemy slots).
- **Resolution states** (`status`): `active → won | lost | fled`.
  - **won** — all enemies dead/broken/fled; outcome `{result:"won", defeated, xp,
    loot}` via `awardXp` (`progression.js:48`, new `XP_AWARDS.combat_won`) and
    `grantItemToRun` loot.
  - **lost** — player dropped to 0 HP; combat ends immediately (§2), aftermath in
    the dying-turn loop.
  - **fled** — player Flee succeeded; combat closes, enemy left alive, location
    hostile-flagged; movement through the real resolver (M.1).
- `run.combat` clears to `null` on close; a one-line `event_combat` summary plus
  the ordinary attempt/damage timeline events are the canonical record.

### 3.4 The `statBlockId` string contract (what D.5 consumes)

Loose coupling, frozen here (D.5 §7.1): **`statBlockId` is a non-empty string.**
The bestiary (`server/campaign/bestiary.js`, combat Phase 1) owns resolution;
`run.combat` validation and the D.5 thread schema validate it **only** as a
string — threads never embed stats. An unknown `statBlockId` at commit time →
combat entry adjudication fails → the beat is **skipped, not narrated**
(momentum rollback discipline, `momentum.js:317-332`; coherence leak #6, §5).
Combat outcomes (enemy death/flee/surrender) write timeline + a canonical
`memory_fact`, which D.5's `ground_lost` resolution and `trigger.canon` gates
consume (D.5 §7.3) — no new plumbing; both sides speak `memoryFacts`/`timeline`.

---

## 4. Enemy intent selection + per-round narration payload

**Intent selection (server-side, seeded, telegraphed-by-default).** At round
start, for each living enemy the server picks one intent from its stat block's
weighted list, seeded exactly like momentum:
`hashSeed(\`${worldSeed|combatId|round}\`)` (the `momentum.js:293` pattern;
`hashSeed` at `momentum.js:69`). An optional `rankFn` LLM slot may reorder the
shortlist under the **same filter-back validation** as `momentum.js:275-291`
(anything invented is discarded). **Intents are telegraphed by default** (D.4
spec §2.3 position): the telegraph ("the hound coils to lunge") is a committed
fact, so prose and mechanics cannot diverge; stat blocks may mark specific
intents `hidden: true` (ambush openers) as spice, not the default.

**Per-round narration payload** (`combatRound`, the record the Phase 1 resolver
attaches for `buildCombatGmMessage` — D.4 spec §4 verbatim): initiative-ordered
`actions[]` with committed facts only (roll, hit/crit, damage,
`targetTransition`), `playerHp` from the canonical gauge, `enemies[]` with
**`hpBand`** (fresh/bloodied/broken — never raw enemy numbers), and
`nextIntents[]` (the telegraphs for the round ahead — what makes rounds
narratable *forward*). Deterministic fallback narration composes from the same
record on the offline/timeout path (no silent turns — FIX K). Death narration on
a combat kill reuses `narrateDeathWithGm` (`index.js:825`) unchanged. This
payload consumes CLI 1's shipped style contract; no prompt content is defined
here.

---

## 5. Coherence — server truth, sealed narrator

The rule everything obeys: **combat state is server-owned truth; the LLM
narrates rounds and never adjudicates them.** The six leak pathways from D.4 spec
§3, each with its prevention named, plus the interpreter- and D.5-specific ones
this contract adds:

| # | Leak | Prevention (frozen) |
|---|---|---|
| 1 | Attempt provider adjudicates combat (proposes DC/damage) | While combat is active the attempt is intercepted **before** the provider is consulted for mechanics (§1.5 Change B). The interpreter only *classifies* (§1.4). |
| 2 | Widening `ALLOWED_EFFECT_TYPES` (`attempt.js:35`) with `attack`/`kill_enemy`/`end_combat` | **Unchanged — stays `{timeline_event, memory_fact, narration, damage}`.** Combat mutations are resolver output, like movement. Stunt boons come from the sealed `COMBAT_STUNT_EFFECTS`. |
| 3 | LLM-minted enemies ("a dragon lands") | An enemy exists only as a committed `run.combat.combatants` entry from the server bestiary (commit-first, `momentum.js:26`). The style contract already forbids inventing entities (`actionNarration.js:21`). |
| 4 | Narrated numbers drift from rolled numbers | The per-round payload carries exact committed facts; the style rule "do not restate dice/mechanics" keeps prose qualitative (`hpBand`, not raw HP) while the client renders true numbers from state (§4). |
| 5 | Flee-as-teleport / flee-as-fiat | Flee is a rolled contested check whose success routes through the **real** movement resolver to a real connected location (M.1, `actions.js:578`). |
| 6 | Enemy mercy / enemy fiat | Enemy intents and rolls are server-selected + server-rolled (seeded + injectable). The model is never asked whether the hound spares you. |
| 7 *(interpreter)* | A colorful attack resolves *around* the combat resolver and double-hits; or creative play auto-fails | The interpreter maps free text onto the legal menu or onto a **stunt** (enumerated boon, never damage) — never a second damage path, never an auto-fail (§1.3). |
| 8 *(interpreter)* | The LLM classifier widens the action space / mints a target / invents a boon | `validateCombatMapping` filter-back (§1.4): off-menu route, unpresent target, unheld item, and non-`COMBAT_STUNT_EFFECTS` boon are all discarded; the deterministic decision stands. |
| 9 *(D.5)* | A thread beat mints a hostile (prose-ladder beat-6 confabulation class) | `hostileNpc` payloads resolve `statBlockId` against the bestiary at commit; unknown → commit fails → beat skipped, not narrated (§3.4, rollback `momentum.js:317-332`). |
| 10 *(dying)* | Enemies keep attacking a downed player; a beat lands a new hostile at 0 HP | Combat ends at the drop; the momentum×dying freeze blocks every server-initiated fire while `playerIsDying` (§2). |

---

## 6. Phase 1's smallest slice (the greenlight ask)

Phase 1 builds the **smallest playable vertical** against this frozen contract —
one enemy, one entry, the deterministic interpreter only:

1. **`run.combat` in `schema.js`** — `validateCombatState` in the `validateRecord`
   band, referential-integrity on `npcId`/`statBlockId`; `scene.js` emits
   `combat: run.combat ?? null`; append **CONTRACT.md §8 (combat)** (the file
   ends at §7 today; this is additive) and extend `tests/state-contract.test.js`
   with the additive combat assertions.
2. **`server/campaign/bestiary.js`** — the single `carrion_hound` stat block
   (D.4 §5.1) + the `civilian` default block, `statBlockId`-validated.
3. **`server/solo/combat.js`** — initiative, rounds, the attack/defend/flee/
   use_item/hold_on resolvers sharing `rules/dice.js`; telegraphed intents
   (seeded, no `rankFn` yet); won/lost/fled close; the player-drop rule (§2).
4. **Wire the two reroute seams (§1.5)** — `detectAttackIntent` into the attempt
   chain; the in-combat interception calling `resolveCombatInput`, which uses the
   **already-tested** `classifyCombatInput` (Layer A only — no LLM escalation in
   Phase 1) and dispatches. Stunts resolve; the optional LLM classifier and
   `COMBAT_STUNT_EFFECTS` beyond a default boon wait for Phase 2.
5. **`buildCombatGmMessage`** + deterministic round-narration fallback (§4);
   `XP_AWARDS.combat_won`.
6. **Hostile battery** — a `tests/solo-combat-*.test.js` section driving a whole
   fight over real HTTP with scripted rolls (the `fixedRolls` test-hook extended
   through a round), asserting: initiative order, one-round-per-action, attack vs
   AC, the player-drop→dying handoff, flee→real-move, and **every combat-input
   mapping matches `classifyCombatInput`** (the contract this doc froze).

**Explicitly out of Phase 1** (per D.4 §6): no spells/MP, no `hostileNpc` thread
entry (waits for D.5 Phase 1), no momentum entry, no multi-enemy fight, no LLM
classifier escalation, no morale/surrender. The riskiest seam — the free-text ↔
combat-machine mapping — ships already pinned by Phase 0's tests-of-record, so
Phase 1 wires a known-good classifier rather than inventing one inside a state
machine.

> **Greenlight ask:** approve Phase 1 as the six-item slice above against this
> frozen contract — one enemy, player-attack entry, deterministic interpreter,
> real-HTTP combat battery.
