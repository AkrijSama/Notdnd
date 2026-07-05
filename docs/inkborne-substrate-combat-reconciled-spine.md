# The Reconciled Spine — D.5 Substrate × D.4 Combat × Scenarios (BUILD ORDER + SEAM CONTRACT)

**Status:** Reconciliation of three specs authored by separate instances, plus
the two contract artifacts already committed on this branch. This document is the
single source of truth the vertical-slice build follows. It resolves every
collision at the **reeve-collector junction** (a D.5 danger-thread beat handing
off to a D.4 combat, and the fight handing back a thread advance), fixes the
runtime vocabulary, and flags what needs owner sign-off.

**Inputs reconciled (all read in full):**
- `docs/inkborne-combat-d4-spec.md` — the combat design (JRPG rounds, positionless).
- `docs/inkborne-combat-d4-phase0-contract.md` (committed `09a85cc`) — the FROZEN
  combat contract + the pure interpreter (`server/solo/combatContract.js`, tested).
- `docs/inkborne-narrative-substrate-d5-spec.md` — the thread model.
- `docs/inkborne-scenarios-spec.md` (committed `000c6bd`) — the authoring schema
  (`server/campaign/scenarioSchema.js`, 24 tests) + `the_shipment` authored in full.

**Already committed on this branch (built against, not rebuilt):**
| Artifact | Commit | Role in the slice |
|---|---|---|
| `server/solo/combatContract.js` (+244 tests) | `09a85cc` | The in-combat interpreter — Layer A, wired into the resolver as-is. |
| `server/campaign/scenarioSchema.js` (+49 tests total w/ combat) | `000c6bd` | The scenario validator — the loader's gate; `the_shipment` authored against it. |
| The production voice (style contract) | `a4cb782` | Combat + thread narration consume it unchanged. |

---

## 1. Vocabulary reconciliation — the one rule that dissolves most collisions

The three specs use **front** and **thread** for what looked like two objects.
They are one object at two lifecycle stages, exactly analogous to a quest:

> **front : thread  ::  questTemplate : questState**

- A **front** is *authoring* — a declarative row in a scenario JSON file, using
  **symbolic refs** (`entityRefs`, `locationRefs`, `questRefs`, `placeAt: "{player_location}"`),
  validated by `scenarioSchema.js` at author/load/CI time.
- A **thread** is *runtime* — a validated record in `run.threads`, using
  **resolved ids** (`entityIds`, `locationIds`, `questIds`), instantiated once at
  run start.
- A **beat** is the same shape in both; the runtime beat additionally carries a
  `status` (`pending | committed | skipped`) and the thread carries `beatIndex`.
- **The loader is the only bridge** (§3.1 flow). It validates the front, resolves
  every symbolic ref against the post-worldgen run, and writes the thread. No
  other code turns a front into a thread; the model never does.

This makes the D.5 §2.1 `thread` shape and the scenarios-spec §1.3 `front` shape
**the same schema at two stages**, not a conflict. `run.threads` is the runtime
projection; the scenario file is the template.

---

## 2. The collisions, resolved (every one)

### C1 — `threat` momentum templates vs danger-thread beats. **RESOLVED (already applied).**
D.4 spec §2.2(2)/§5.3 proposed new `threat` momentum templates as combat's
world-initiated entry. D.5 §7/§9 supersede this: the hostile arrives as a danger
-thread `hostileNpc` beat, *not* a parallel template kind. The Phase 0 contract
(`09a85cc`) already encodes the correction (`docs/…phase0-contract.md` header +
§3.2). **The `threat` templates are not built.** Combat's world-initiated entry
is the reeve-collector `hostileNpc` beat. ✔ no action — carried forward.

### C2 — The Phase-1 enemy: `carrion_hound` (D.4 §6) vs `waylayer` (the collector). **RESOLVED → `waylayer`.**
D.4 §6 names `carrion_hound` as the single Phase-1 enemy — but that was a generic
placeholder written before the grade target was fixed. The vertical slice's
combat is *only ever reached* through the reeve-collector beat, whose
`statBlockId` is `waylayer` (D.5 §3.1.1 rung 2; scenarios-spec §2 `beat_collector`).
Building `carrion_hound` would ship an enemy the slice never fights. **Decision:
the one built enemy is `waylayer`** (the collector), plus the `civilian` default
block for the grounding-safety case (a player attacking any unstatted cast NPC —
D.4 §2.2(1)). This is a deviation from D.4 §6's letter; flagged for ratification
(§5, S6). It honors "one enemy type" (Stage 2.3) with the enemy the grade
actually reaches.

### C3 — Combat entry: "player attack intent only" (D.4 Phase 1) vs "entered via the reeve-collector thread beat" (task). **RESOLVED — they compose.**
These are not alternatives; they are two halves of one flow:
1. The danger thread's rung-2 beat commits a `hostileNpc` payload → the executor
   places the collector as a **present, committed, hostile-capable cast NPC**
   carrying its `statBlockId`, telegraphed with a demand ("hand it over"), **not
   instant combat** (D.5 §2.2, agency preserved).
2. The player *engages* — an attack intent aimed at the now-present collector.
   `detectAttackIntent` grounds on it (never minted, because the beat committed
   it) and calls `enterCombatFromAttackIntent` — **D.4 Phase 1's only built
   entry**.

So the beat is the *necessary cause* of the fight (no beat → no collector → no
combat), and the attack-intent is the *trigger*. "Entered via the reeve-collector
beat" and "player-attack entry" are the same event described from the content
side and the mechanism side. The distinct `enterCombatFromHostileBeat`
(refuse-the-demand routes straight into combat without an explicit attack verb) is
the D.5-Phase-1 nicety the Phase 0 contract defers (§3.2(2)); the slice covers the
junction with attack-intent entry. Flagged (§5, S7).

### C4 — Beat trigger vocabulary: D.5 flat vs scenarios-spec split. **RESOLVED → split is canonical.**
D.5 §2.2 wrote a flat trigger (`{minTurn, requiresBeat, playerAt, questState, canon}`);
the scenarios spec §1.4 split it into `{prescriptive, descriptive}` to make dual
advancement first-class (and `scenarioSchema.js` already validates the split
form). **The runtime trigger is the split form.** D.5's flat fields are the
*contents of `prescriptive`*. The reconciled runtime trigger vocabulary (closed;
§3-seam and the schema pin it):
- `prescriptive` (fires on the momentum clock): `minTurn`, `requiresBeat`,
  `questState {questRef, status, minStage}`, `minTurnsSinceBeat`.
- `descriptive` (fires on the player's own action, on finalize): `requiresBeat`,
  `onPlayerAt {locationRef}`, `onQuestAccepted`, `onQuestStage {questRef, minStage}`,
  `onQuestState {questRef, status}`, `onCanon {keywords}`.

### C5 — "Never on a progress turn" (D.5 §4.2) vs "descriptive never starves" (scenarios §1.6.2). **RESOLVED — the rule is scoped to the clock.**
The apparent contradiction is a scoping question. Resolution:
- The **never-on-progress-turn** rule and the tension gate govern the
  **prescriptive** (clock) path *only*. Prescriptive beats fire when
  `advanceMomentum` fires (tension ≥ 6, cooled down, not dying, **not a progress
  turn**).
- **Descriptive** advancement fires in the finalize pass on the player's *own*
  committed action, **regardless of tension or turn class** — that is the whole
  point of dual advancement (a busy player who keeps making progress must still
  trip the beats their actions cause, or a pressure front starves; scenarios §1.6.2).
- The `≤1 driver/turn` cap and priority still bind both: **quest_advance >
  descriptive thread beat > prescriptive thread beat > legacy momentum one-off.**
  If the turn already produced a quest advance, a due descriptive beat *waits* one
  turn (never double-drives). Per-thread `clock.minTurnsBetweenBeats` still gates.

This is the anti-starvation mechanism and the pacing crux; the build instruments
it (`turnsSinceAnyBeat`, per-thread starvation age) from day one.

### C6 — "Rung 2 resolved either way" (a combat outcome) but beat `status` has no `resolved`. **RESOLVED via the canon channel.**
Rung 3 (`beat_boss_named`) triggers on "rung 2 resolved either way" — i.e. the
collector fight ended (killed / fled / talked down) *or* the case was delivered
first. The beat status enum is `pending|committed|skipped` with no `resolved`, and
adding cross-beat resolution machinery is more than the slice needs. Both sides
already **speak `memoryFacts`/`timeline`** (D.4 §3.4, D.5 §7.3), so:
- Combat close writes a canonical `memory_fact` with stable keywords naming the
  defeated NPC + outcome (e.g. *"The collector who came for the case is dead."*).
- Rung 3's **descriptive** trigger is `onCanon {keywords:["collector"]}` **OR**
  `onQuestState {questRef:"quest_courier", status:"completed"}` (the delivery
  short-circuit). Either canonical fact satisfies it → rung 3 fires the next
  driver slot → commits its `fact`+`quest` → `beat_final` resolves the thread.

No new beat-resolution status is introduced for the slice. A first-class
`beatResolved` concept is a clean post-slice generalization, flagged (§5, S8) but
not built.

### C7 — Two new first-class run records land together. **No collision — additive, disjoint.**
`run.combat` (D.4, `validateCombatState`) and `run.threads` (D.5,
`validateThreadState`) both follow the `validateRecord` pattern and the dangling
-ref integrity discipline (`schema.js` `linkedQuestIds` precedent). They touch
disjoint state and disjoint scene fields (`combat`, `threads`). Legacy runs stay
valid (both emit `null`/`[]` when absent).

---

## 3. The seam contract (the three the task named)

### 3.1 Thread beat → combat: the `statBlockId` handoff
```
danger thread, rung 2 beat_collector fires (descriptive onCanon OR prescriptive clock)
  → beat executor commits payload.hostileNpc {npcId, displayName, role,
       statBlockId:"waylayer", placeAt:"{player_location}", dialogueBeats:[demand]}
  → resolveSymbolicRefs: {player_location} → run.location.id
  → commit NPC into run.npcs / cast, marked hostile, CARRYING statBlockId + demand beat
  → validateSoloRun gates the commit; on failure → rollback + beat SKIPPED, not narrated
  → narrativeDriver folds in the committed beat (brief/decision/telegraph) — voice narrates the ARRIVAL
[player turn later] intent "attack the collector" / "I draw and cut him down"
  → detectAttackIntent grounds on the present, living, hostile collector (never minted)
  → enterCombatFromAttackIntent reads statBlockId OFF the committed NPC (else "civilian")
  → bestiary.resolveStatBlock("waylayer") → combatant {hp, ac, dexMod, attacks, intents, behaviors}
  → initiative rolled, run.combat written, round 1 resolves
```
**Contract points:** `statBlockId` is a *non-empty string* on both sides (D.4
§3.4); the bestiary owns resolution; the thread schema never embeds stats; an
unknown `statBlockId` fails the commit and the beat is skipped (never a narrated
phantom — coherence leak #9).

### 3.2 Combat outcome → canonical facts → thread advancement (the write-back)
```
combat closes (won | lost | fled)
  → combat.js writes:  (a) timeline event_combat summary
                       (b) canonical memory_fact, stable keywords: the NPC + outcome
                           won:  "The collector who came for the case is dead."
                           fled: "The collector broke off and vanished into the sprawl."
  → run.combat cleared to null
[finalize pass, same as advanceQuests]
  → thread resolution rules evaluated:
       ground_lost   → if the defeated NPC ∈ a thread's groundedIn.entityIds → resolve
       quest:completed (delivery) → short-circuit resolution
  → descriptive triggers re-evaluated against the new canonical fact:
       rung 3 onCanon {keywords:["collector"]} now holds → rung 3 due
  → scheduler (≤1 driver, quest_advance outranks) fires rung 3 next eligible turn
  → rung 3 commits fact("the reeve is named…") + quest(confrontation hook)
  → beat_final resolution → thread status → "resolved" (persists as canon)
```
**Contract point:** no new plumbing — the fact the fight writes is the same
`memory_fact` channel the thread trigger reads. The junction closes the loop
**threads → escalate → combat → resolve → advance** entirely through committed
state.

### 3.3 The in-combat interpreter (free-text ↔ menu seam — the owner's hard condition)
This seam is **already built and frozen** as `combatContract.js` (`09a85cc`,
tested). The build *wires* it; it does not re-derive it.

**The owner's hard condition, stated:** the game's identity is free text — **even
inside the combat state machine the player types prose, never merely clicks a
menu.** The menu is a scaffold the client may render, not a cage the engine
imposes. Two failure modes are forbidden with equal force:
- **Tyranny of the menu** — creative, off-menu-but-actionable input ("topple the
  gantry onto him") must NOT auto-fail; it resolves as a **stunt** (an ability
  check whose success buys one enumerated `COMBAT_STUNT_EFFECTS` boon, never
  damage, never a win).
- **Reopening the generic-check bypass** — a colorful attack must resolve
  *through* the combat attack resolver (vs AC, the death spine), never *around*
  it as a second damage path; and the model **classifies only, never
  adjudicates** (the roll/damage/state-change are resolver output).

Because a mis-route in a turn machine corrupts initiative, the classifier is
biased to **`clarify` (no turn cost)** for questions/ungrounded input and
**`stunt` (a safe, enumerated real action)** for off-menu-actionable input, over
guessing a menu action. Wiring:
```
resolveSoloAction: if combatActive(run):
   use_item → existing resolver (counts as the combat turn)
   attempt  → resolveCombatInput → classifyCombatInput(intent, {isDying, enemies, heldItems})
                → route ∈ {attack, defend, flee, use_item, stunt, hold_on, clarify}
                → dispatch; clarify costs no turn; everything else spends the turn
   move/search/talk/inspect/rest → ACTION_ILLEGAL_IN_COMBAT (no turn spent)
```
Layer B (the optional LLM classifier behind `validateCombatMapping`) is **not
wired in the slice** — Phase 1 ships Layer A only (deterministic, tested). The
firewall exists for when it is.

---

## 4. The reconciled build order (dependency-ordered; the vertical slice ONLY)

Build sequentially, testing at each step. Each item names the coherence
invariant(s) it must preserve.

**B0 — Bestiary (content; combat's `statBlockId` resolution + D.5's hostile target).**
`server/campaign/bestiary.js`: `waylayer` (12 HP / AC 13 / +3 / 1d6+2, parleys at
broken morale) + `civilian` default block (6/10/+1/1d4). `resolveStatBlock(id)` →
block | null (null → caller skips the beat / uses civilian). *Invariant: enemies
exist only as server bestiary rows (leak #3).*

**B1 — Schema: two additive first-class records.**
`server/solo/schema.js`: `validateCombatState` (D.4 §3.1 shape, `npcId` referential
integrity, `statBlockId` string) + `validateThreadState` (D.5 §2.1 shape, resolved
-id grounding integrity, beat status enum, trigger vocabulary). Both in the
`validateRecord` band; both optional (legacy tolerance). Scene payload
(`scene.js`) emits `combat: run.combat ?? null` and `threads` summary (id/kind/
status/revealState only — **hidden threads' agenda never emitted**). *Invariant:
hidden threads absent from the prompt (leak #4); combat state server-owned.*

**B2 — Combat resolver.**
`server/solo/combat.js`: initiative (player d20+`derivedStats.initiative`, enemy
d20+dexMod, ties→player), one-round-per-action, resolvers for
attack/defend/flee/use_item/hold_on/stunt (dispatching on `classifyCombatInput`),
seeded telegraphed intents, won/lost/fled close, the player-drop rule (combat ends
at 0 HP → dying loop owns aftermath; momentum×dying freeze). Player damage routes
through `death.js applyDamage` (no new lethality code). Writes the combat-close
canonical fact (§3.2). *Invariants: combat mutations resolver-only (leak #2,
`ALLOWED_EFFECT_TYPES` untouched); flee→real movement resolver (leak #5); enemy
rolls server-seeded (leak #6); nothing fires while dying (leak #10).*

**B3 — Reroute seams (`server/solo/actions.js`).**
Change A: `detectAttackIntent` after the ask≠act guard + take/move/search
detectors, before `resolveAttemptAction` — fires only when `!combatActive`,
attack verb, present resolvable hostile-capable NPC. Change B: the in-combat
interception at the top of `resolveSoloAction` (§3.3). `getAvailableSoloActions`
becomes combat-aware. *Invariant: attempt intercepted before the provider
adjudicates (leak #1).*

**B4 — Combat narration + XP.**
`server/gm/actionNarration.js`: `buildCombatGmMessage` (the `combatRound` payload,
D.4 §4 — `hpBand` not raw enemy HP, `nextIntents` telegraphs) + deterministic
round fallback (no silent turns). `XP_AWARDS.combat_won`. **Consumes the shipped
style contract (`styleSuffix`) unchanged.** *Invariant: narrated numbers can't
drift from rolled (leak #4).*

**B5 — Thread engine.**
`server/solo/threads.js`: trigger evaluation (dual — descriptive on finalize,
prescriptive on clock), the beat-commit executor (generalize
`commitMomentumPayload` + the `fact` and `hostileNpc` kinds, commit-first +
rollback), scheduler integration into `advanceMomentum` (one clock, offer the
slot to due threads first, ≤1 driver/turn, quest_advance outranks — §C5),
callbacks v1 (`callbackQuery` → verbatim canonical facts via `canon.js`),
`narrativeDriver` fold-in (`index.js`) generalizing the momentum block +
`recentDevelopment`. Max 3 active threads. *Invariants: threads born only from
server events (leak #3/#7 — the executor is the only birth path); callbacks are
server-selected verbatim facts (leak #8); pacing is the deterministic clock (leak
#9).*

**B6 — Scenario loader + `the_shipment`.**
`server/campaign/scenarioLoader.js`: `validateScenario` gate → resolve refs
(cast → quests → threads, in order) → instantiate into the run, fail-loud on a
dangling ref. `server/campaign/scenarios/the_shipment.json` — the 3-front cyberpunk
scenario (scenarios-spec §2), authored to pass `scenarioSchema.js`. *Invariant:
load-time referential validation (leak #2).*

**B7 — Onboarding wiring.**
`server/campaign/onboarding.js`: load `the_shipment` via the loader in place of
the hand-wired block, behind a flag, default-on for the grade target. *Invariant:
declarative data only, no `build()` in scenario content (sign-off #3).*

**B8 — Tests + battery + live proof.** Unit (combat battery over real HTTP with
scripted rolls; thread rung-order/yield/dual-advancement with scripted clocks;
scenario-load referential integrity) + the existing battery (narration-adjacent +
coherence must hold) + the free-text live proof of the full junction.

**Out of scope (do NOT build — gated on the grade):** `carrion_hound` and the rest
of the bestiary; momentum `spawnsThread` promotion; sandbox worldgen thread
seeding; goal-opposition (`OPPOSITION_TEMPLATES`); the isekai/medieval scenarios;
Layer-B LLM combat classifier; morale/multi-enemy/spells; payment; images;
mature-themes; the journal UI.

---

## 5. Owner sign-off flags

Carried from the specs (already positioned, restated for one place):
- **S1** Telegraphed intents by default (D.4 §2.3). — building as specified.
- **S2** Combat ends when the player drops; `vicious` parting blow is a one-time
  event, not a per-round attack (D.4 §2.4, Phase 0 §2). — building as specified;
  `waylayer` is not `vicious`, so no parting blow in the slice.
- **S3** `gated-sequence` topology adopted (scenarios §5.1). — not exercised by
  `the_shipment` (which is parallel/linear); the validator supports it.
- **S4** Descriptive advancement mandatory on pressure fronts (scenarios §1.2). —
  enforced by the validator; the reconciled scheduler (§C5) honors it.
- **S5** Default-door tone flip to cyberpunk (scenarios §8.3): option **A** (every
  new player lands in the sprawl) vs **B** (`the_shipment` is a *chosen*
  cyberpunk scenario, dark-fantasy stays the default door). **Recommendation for
  the slice: B** — `the_shipment` loads behind a flag for the grade target;
  the default door is not silently flipped for every new player mid-grade. The
  tone is one metadata field, trivially switched to A on the owner's word.

New, surfaced by this reconciliation (need ratification):
- **S6** The one Phase-1 enemy is **`waylayer`** (the collector the slice
  reaches), not D.4 §6's placeholder `carrion_hound` (§C2).
- **S7** Combat entry for the slice is **attack-intent on the beat-placed
  collector**; the distinct `enterCombatFromHostileBeat` (refuse-as-entry) stays
  deferred (§C3).
- **S8** The rung-3 advance-after-combat rides the **canon channel** (combat
  writes a fact; rung 3 `onCanon`), not a new `beatResolved` beat status (§C6). A
  first-class beat-resolution concept is a clean post-slice generalization.

---

*This spine is committed before any Stage-2 code. The build follows §4 in order;
the four coherence invariants named in the brief — `ALLOWED_EFFECT_TYPES` sealed,
threads born only from server events, hidden threads absent from the prompt,
combat mutations resolver-only — are verified at their build steps (B2/B5) and
re-verified in B8.*
