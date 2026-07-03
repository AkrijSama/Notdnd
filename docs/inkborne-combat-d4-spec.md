# D.4 — Positionless Turn-Based Combat (SPEC — no code until owner approval)

**Status:** DRAFT for owner review. Design + scope only. Nothing in this document is built.

**Direction (owner decision, logged):** JRPG-style round structure — turn-based,
initiative-ordered, **no positioning, no movement economy, no grid**. This
permanently supersedes the tactical-grid plan. The existing `battleMap` token
scaffolding (state contract §5) is retained as *scene decoration / roster
display only*; the client `src/components/battleMapEngine.js` reachability code
goes dormant and plays no combat role.

**IP discipline:** style inspiration only. Zero named mechanics, terms, tables,
or licensed text from any commercial system beyond the 5e SRD basis the engine
already uses. All enemy names, condition names, and intent labels in this spec
are original.

---

## 1. Inventory — what the server already owns vs what is genuinely missing

### 1.1 Already built (the 5e spine) — verified against the repo

| Primitive | Where | State |
|---|---|---|
| d20 roller with fixed-roll/rng injection | `server/rules/dice.js:20` (`rollD20`) | Done, test-injectable |
| Dice expressions incl. advantage/disadvantage (`kh1`/`kl1`) | `server/rules/dice.js:126` (`rollDice`) | Done |
| Ability checks (adv/disadv, 18 SRD skills, proficiency) | `server/solo/rules.js:98` (`resolveAbilityCheck`); skill projection `server/solo/characterBuild.js:152-159` | Done, live in every attempt |
| **Attack-vs-AC + damage resolver** | `server/rules/engine.js:21` (`resolveAttack`) | Built but **not wired to solo** — its only consumer is the legacy multiplayer command-center op (`server/db/repository.js:2351` `case "resolve_attack"`), a different product track |
| Player HP (canonical gauge + mirrors) | `server/solo/death.js:56-96` (`getHp`/`setHp` over `player.resources.hitPoints`) | Done |
| Player AC | `server/solo/characterBuild.js:90` (`derivedStats.armorClass = 10 + dex`), surfaced `server/solo/scene.js:686` | **Computed but read by nothing** — no resolution path uses AC today |
| Initiative modifier | `server/solo/characterBuild.js:92` (`derivedStats.initiative = dex mod`) | **Computed but never used** |
| Damage → dying → death saves → permadeath | `server/solo/death.js:305` (`applyDamage`: dying at 0, instant death on overkill ≥ max HP, save-failures on damage at 0, crit = 2 failures), `death.js:406` (`rollDeathSave`: nat 20 / nat 1 / DC 10), `death.js:268` (`markDead`, terminal `run.status="dead"`) | Done — the headline product identity |
| Possession-gated revival | `server/solo/death.js:190` (`findRevivalMeans`: item / companion / divine), consumed once | Done |
| Dying-turn loop | `server/solo/actions.js:353-362` (any non-`use_item` action while dying rolls a death save); terminal gate `actions.js:620` (`RUN_TERMINAL`) | Done |
| Conditions (labels) | Contract §4 (`player.conditions[]`); `server/solo/attempt.js:987` (`addPlayerCondition`, idempotent) | Shape done; **no condition has mechanical effect** — nothing reads them |
| Structured failure consequences (damage/condition/objectState/resource) | `server/solo/attempt.js:1047` (`enforceFailureConsequence`) | Done |
| Retry foreclosure on degraded objects | `server/solo/attempt.js:951` (`resolveRetryForeclosure`) | Done |
| Sealed effect allowlist | `server/solo/attempt.js:35` (`ALLOWED_EFFECT_TYPES = timeline_event, memory_fact, narration, damage`); provider `stateMutations` rejected `attempt.js:692` | Done — stays sealed (see §3) |
| Authority gate + possession check (pre-roll) | `server/solo/attempt.js:1192` (`classifyIntentAuthority`), `attempt.js:1404` (`resolvePossessionClaim`) | Done |
| Action economy (one action per HTTP turn) | `server/solo/actions.js:606` (`resolveSoloAction`); action types `actions.js:55` | Done — but **no rounds, no non-player turn owner** |
| Free-text → mechanic reroutes (the pattern combat entry copies) | `actions.js:786-896` (`detectQuestAcceptIntent`, `detectTakeIntent`, `detectMoveIntent`, `detectSearchIntent`), ask≠act guard `actions.js:72` | Done — proven pattern |
| Momentum engine (server-authored events, seeded selection, commit-first, bounded LLM ranker) | `server/solo/momentum.js:269` (`fireMomentumEvent`), ranker filter-back `momentum.js:275-291`; template kinds `arrival`/`hazard`/`hook` in `server/campaign/momentumEvents.js` | Done — the combat-initiation seam |
| Healing / revival items | `server/solo/useItem.js:293-316` (`revive`, `recover_resource`); `use_item` exempt from the dying-turn save (`actions.js:635-639`) | Done |
| Rest recovery | `server/solo/rest.js:242-253` | Done |
| XP / level-ups | `server/solo/progression.js:48` (`awardXp`); award table `progression.js:14` | Done — **no combat awards in the table** |
| Item grant primitive | `grantItemToRun` (`server/solo/search.js`, shared by `take.js:256` and the `grant_item` test hook) | Done — loot drops reuse it |
| Deterministic test hooks (`damage`, `death_save`, `revive`, `grant_item`; scripted attempt rolls) | `server/solo/actions.js:64,503`, `withScriptedAttemptOptions` `actions.js:483` | Done — the harness spine combat tests extend |
| GM narration seam (server facts → prompt; timeout → deterministic template) | `server/gm/actionNarration.js:171` (`buildActionGmMessage`), `server/index.js:858` (`narrateActionWithGm`), consequence directive `index.js:791-819` | Done — combat adds one branch |

### 1.2 Genuinely missing for a full combat loop

1. **Enemy stat blocks.** NPCs are narrative-only: `validateNpc`
   (`server/solo/schema.js:699`) validates identity, dialogue, portrait fields —
   **no HP, no AC, no attacks, nothing anywhere in solo state has hit points
   except the player.** A grep for hostile/enemy/monster concepts in
   `server/solo/` finds none.
2. **A combat state machine.** No `run.combat`, no rounds, no initiative order,
   no turn owner other than the player.
3. **Attack resolution against a target.** An attack intent currently matches
   `CONTESTED_INTENT_RE` (`attempt.js:172` — `fight|attack|strike|…`) and
   resolves as a *generic one-off ability check vs DC* with a failure
   consequence — the fallback the owner just hit. Nothing rolls vs AC, nothing
   tracks the target being hurt, and the target never acts back.
4. **Enemy actions.** The only way the world damages the player today is the
   failure-consequence path and test hooks. Nothing initiates or sustains
   violence.
5. **Victory / defeat / flee as structured outcomes**, and combat XP/loot.
6. **Player weapon mapping.** `startingEquipment` is name strings only
   (`characterBuild.js:96-99`); no weapon stats exist.
7. **Spellcasting.** MP gauges exist in the contract (§1) but nothing spends
   them offensively. (Deliberately out of the first slice — see §6.)

---

## 2. The loop

### 2.1 Combat state — server-owned, contract-frozen, additive

New optional field on the persisted run (legacy runs stay valid; scene payload
emits `combat: null` when absent), validated in `schema.js` like every other
contract field:

```jsonc
"combat": {
  "combatId": "cbt_…",
  "status": "active",              // active | won | lost | fled
  "round": 1,                      // 1-based
  "turnOrder": ["player", "enm_hound_1"],   // initiative-sorted combatant ids
  "turnIndex": 0,                  // whose turn within the round
  "combatants": {
    "player": { "kind": "player" },        // HP/AC stay canonical on run.player — never copied
    "enm_hound_1": {
      "kind": "enemy",
      "npcId": "npc_hound_1",              // the cast entry (portrait, identity)
      "statBlockId": "carrion_hound",      // bestiary reference
      "hp": { "current": 11, "max": 11 },
      "ac": 12,
      "initiative": 14,                    // rolled at entry, stored for the round display
      "conditions": [],                    // same {id,name} shape as player.conditions
      "morale": "steady"                   // steady | shaken | broken (drives flee/surrender)
    }
  },
  "enemyIntents": {                        // selected at round start, BEFORE the player acts
    "enm_hound_1": { "intentId": "lunge", "telegraph": "coils low, hackles up", "hidden": false }
  },
  "startedAt": "…", "endedAtRound": null,
  "outcome": null                          // structured victory/defeat/flee record on close
}
```

Design invariants:

- **Player HP/AC/conditions are never duplicated into combat state.** Damage to
  the player routes through `death.js applyDamage` exactly as today, so the
  entire death spine (dying, saves, instant death, possessed-means revival,
  permadeath) composes with zero new lethality code.
- Enemy HP lives on the combatant entry (enemies are disposable; the cast NPC
  record stays narrative). An enemy at 0 HP is dead or broken — enemies get no
  death saves.
- `run.combat` is cleared to `null` on close; the structured outcome is written
  to the timeline (an `event_combat` per round is optional — one summary event
  per combat plus the ordinary attempt/damage events is enough).

### 2.2 Combat entry

Three entrances, all server-adjudicated:

1. **Player attack intent** (replaces the generic-check fallback). A new
   `detectAttackIntent(run, intent)` joins the existing reroute chain in the
   attempt branch (`actions.js:823-896`, after the ask≠act interrogative guard
   at `actions.js:818` — questions about attacking never start a fight). It
   fires only when the intent is a clear attack verb aimed at a **present,
   resolvable NPC** (same grounding discipline as `detectTakeIntent` /
   `detectMoveIntent`: never mints a target). On fire: instantiate the enemy
   combatant (statBlock from the bestiary; an unstatted story NPC gets the
   `civilian` default block — attacking anyone is *allowed*, this is the lethal
   game; the quest engine's existing failure states, `quests.js:402`, absorb a
   murdered quest-giver), roll initiative, write `run.combat`, and resolve the
   player's declared attack as round 1's player action if they won initiative —
   otherwise the enemy's first intent resolves first.
2. **Momentum events.** A new template kind `threat` in
   `campaign/momentumEvents.js` (alongside `arrival`/`hazard`/`hook`). Commit-first
   discipline unchanged (`momentum.js:201`): the committed payload spawns the
   hostile NPC **with a telegraphed-arrival beat, not instant combat** — the
   event's `decision` offers fight / withdraw / parley, and combat starts next
   turn only if the player engages or stands their ground. (Momentum already
   never fires while dying, `momentum.js:135`.) This preserves agency and
   reuses the existing arrival plumbing.
3. **NPC hostility from fiction** (e.g. a talk gone catastrophically wrong) —
   *deferred to Phase 3*; requires interpreter judgment we don't want in the
   first slice.

### 2.3 Round structure (JRPG-style, positionless)

Each combat round, in order:

1. **Intent selection (round start, server).** For every living enemy, the
   server picks one intent from its stat block's weighted intent list —
   seeded-deterministic exactly like momentum
   (`hashSeed(worldSeed|combatId|round)`, cf. `momentum.js:293`). An optional
   `rankFn` LLM slot may reorder the shortlist with the same filter-back
   validation as `momentum.js:275-291` (anything invented is discarded).
   **Position taken — intents are telegraphed by default.** Positionless combat
   has exactly one decision axis: what you do this turn. A visible telegraph
   ("the hound coils to lunge") is what makes that decision informed rather than
   a slot machine, and it hands the narrator concrete forward-looking material
   every round. Stat blocks may mark specific intents `hidden: true` (ambush
   openers, a surprise reveal) — spice, not the default.
2. **Turns resolve in initiative order.** Initiative: one d20 +
   `derivedStats.initiative` for the player (`characterBuild.js:92`), d20 +
   stat-block dex modifier per enemy, rolled once at combat entry via the
   existing injectable `rollD20`. Ties go to the player (solo game; the player
   is the protagonist).
3. **Player turn — the action menu.** Surfaced through
   `getAvailableSoloActions` (`actions.js:269`) which becomes combat-aware:
   while `combat.status === "active"` it returns the combat menu instead of the
   exploration menu:
   - **Attack** *(new resolver)* — d20 + proficiency + STR-or-DEX mod (finesse
     picks the better for light weapons) vs enemy AC; damage = weapon die + mod.
     Weapon derived from carried items by a small `WEAPON_TABLE` keyed on
     category nouns (the `ITEM_CATEGORY_NOUNS` approach, `attempt.js:1342`);
     no weapon → unarmed (1 + STR mod). Crit on nat 20 doubles the damage dice.
     Implemented in solo (a new `server/solo/combat.js`), sharing
     `rules/dice.js` primitives; `rules/engine.js resolveAttack` stays where it
     is serving the legacy track — solo needs the richer record (crit flag,
     death-spine integration), not that thin wrapper.
   - **Use item** — the existing `use_item` resolver unchanged
     (`useItem.js:250`); consumes the combat turn.
   - **Defend** *(new, trivial)* — until the player's next turn, attacks
     against them roll at disadvantage (two d20 keep-lowest — `kl1` already
     exists, `dice.js:43`).
   - **Flee** — a contested check (player DEX/athletics-or-stealth vs a DC from
     the fastest living enemy's stat block). Success → combat closes as
     `fled`, and the player moves through the **real movement resolver** to a
     connected location they choose (`getAvailableMoves`; M.1 discipline —
     fleeing never teleports, `actions.js:578`). Failure → the turn is spent
     and enemies act. A fled combat leaves the enemy alive and the location
     hostile-flagged (re-entering can re-trigger).
   - **Free-text (attempt) stays available** — the game's identity is free
     text. In combat, an `attempt` is first mapped by the interpreter onto the
     legal menu (an attack phrased colorfully resolves as Attack, etc.). If it
     maps to nothing, it resolves as a **stunt**: a normal
     `resolveAbilityCheck` whose *success* buys one boon from a server-owned
     enumerated set — `COMBAT_STUNT_EFFECTS = { advantage_next_attack,
     enemy_disadvantage, enemy_intent_disrupted, apply_condition }` — never
     direct damage, never an instant win. Failure spends the turn (and may eat
     a normal failure consequence). The authority gate and possession check run
     unchanged before any of this.
   - While **dying** in combat, the menu collapses to **Use item** (the
     existing exemption, `actions.js:635-639`) or **Hold on** (roll the death
     save — the existing dying-turn rule, `actions.js:353`, applies verbatim).
4. **Enemy turns (server-rolled, same turn's response).** Each living enemy
   executes its committed intent: attack rolls vs the player's real AC
   (`derivedStats.armorClass` — finally load-bearing), damage through
   `death.js applyDamage` (crit passes `{crit:true}`, so the
   two-failures-at-0-HP rule is already implemented). Non-attack intents
   (defend, howl-for-morale, hidden reveals) mutate only combat state.
5. **Round end.** Morale check for enemies at/below half HP (`cowardly` blocks
   flee earlier, `vicious` never breaks); status evaluation; next round's
   intents selected; scene payload updated.

Because the whole round resolves inside one HTTP action (the player's), the
one-action-per-turn architecture (`resolveSoloAction` → clone → validate →
persist) is unchanged — a combat round is just a fatter action result.

### 2.4 Victory, defeat, death

- **Won:** all enemies dead, broken (surrendered), or fled. Combat closes with
  a structured outcome `{ result: "won", defeated: [...], xp, loot }`. XP via
  new `XP_AWARDS.combat_won` per stat-block XP value through the existing
  `awardXp` (`progression.js:48`); loot rolled from the stat block's loot list
  through `grantItemToRun` (`search.js`). Both ride the existing
  `finalizeQuestProgress` surfaces so the GM can name them.
- **Player drops to 0 HP** — *position taken:* **combat ends** (`status:
  "lost"`) the moment the player drops. A `vicious`-flagged enemy deals one
  parting blow before leaving (one `applyDamage` at 0 HP = one or two
  death-save failures — already implemented, `death.js:374-391`); default
  enemies take spoils (a loot-loss record: coin/one carried item — a real cost)
  and withdraw. Then the existing dying-turn loop owns the aftermath
  exactly as today: death saves, stabilization, possessed-means revival, or
  permadeath. Rationale: keeping enemies attacking a downed player every round
  converts every knockdown into near-certain death — permadeath stays the
  headline through the honest save math and instant-death rule, without making
  every loss a guaranteed grave. The alternative (fights to the corpse) is one
  flag away (`vicious` on everything) if play proves too soft.
- **Instant death** (overkill ≥ max HP, `death.js:353`) and **three failures**
  end the run through `markDead` — permanent, non-resumable, unchanged.

---

## 3. Coherence — server truth, sealed narrator

The rule everything above obeys: **combat state is server-owned truth; the LLM
narrates rounds and never adjudicates them.**

Where a naive build would leak authority, and how this design forecloses each:

1. **Letting the attempt provider adjudicate combat.** Naive: attack intents
   keep flowing through `resolveAttemptAction`, where the provider proposes DC,
   success prose, and a `damage` effect — the model effectively referees.
   Design: while `run.combat` is active (or `detectAttackIntent` fires), the
   attempt branch **reroutes before the provider is consulted for mechanics**
   (same seam as the move/take/search reroutes, `actions.js:823+`). The
   interpreter's only combat roles are *classification* (map free text onto the
   legal menu) and the *bounded ranker* — both filter-back validated, both
   optional (regex + seeded default when absent, degraded-mode honest).
2. **Widening the effect allowlist.** Naive: add `attack`, `kill_enemy`,
   `end_combat` to `ALLOWED_EFFECT_TYPES` so the model can propose them.
   Design: **`ALLOWED_EFFECT_TYPES` (`attempt.js:35`) does not change.** Combat
   mutations are never provider effects; they are resolver output, like
   movement. Stunt boons come from the server-enumerated
   `COMBAT_STUNT_EFFECTS`, mirroring how `FAILURE_CONSEQUENCE_TYPES`
   (`attempt.js:55`) admits only typed, validated proposals.
3. **LLM-minted enemies.** Naive: the GM narrates "a dragon lands" and the
   engine backfills it. Design: an enemy exists only as a committed
   `run.combat.combatants` entry instantiated from the server-authored bestiary
   — the momentum commit-first discipline (`momentum.js:26`: *nothing is
   narrated that was not committed*). The narration payload carries the
   committed roster; the style contract already forbids inventing entities
   (`actionNarration.js:21`).
4. **Narrated numbers drifting from rolled numbers.** Naive: hand the GM a vibe
   ("the player is hurt"). Design: the per-round payload (§4) carries the exact
   committed facts (rolls, damage, HP transitions); the existing style rule
   "do not restate dice or mechanics" (`actionNarration.js:22`) keeps prose
   qualitative while the client renders the true numbers from state — same
   split the attempt path uses today.
5. **Flee-as-teleport / flee-as-fiat.** Naive: the model narrates escape.
   Design: flee is a rolled, contested action whose success routes through the
   real movement resolver to a real connected location (M.1 precedent,
   `actions.js:578` — no known path, no escape prose).
6. **Enemy mercy / enemy fiat.** Enemy intents and rolls are server-selected
   and server-rolled (seeded + injectable for tests). The model cannot decide
   the hound spares you, because the model is never asked.

---

## 4. Narration seam (consumes CLI 1's style contract — payload only, no prompt content here)

A new `buildCombatGmMessage(run, resolved)` branch in
`server/gm/actionNarration.js` (alongside the `attempt`/`move`/`talk` branches,
`actionNarration.js:171`), fed by a structured **round record** the resolver
attaches to the action result:

```jsonc
"combatRound": {
  "combatId": "cbt_…", "round": 2, "status": "active",
  "location": { "locationId": "…", "name": "…" },
  "actions": [                                  // initiative order, committed facts only
    { "actor": "player", "kind": "attack", "target": "enm_hound_1",
      "roll": { "total": 18, "vs": "ac", "dc": 12, "hit": true, "crit": false },
      "damage": { "amount": 6, "type": "slashing" },
      "targetTransition": "bloodied" },          // null | bloodied | broken | dead
    { "actor": "enm_hound_1", "kind": "attack", "intentId": "lunge",
      "roll": { "total": 9, "vs": "ac", "dc": 14, "hit": false },
      "damage": null, "targetTransition": null }
  ],
  "playerHp": { "current": 7, "max": 12, "status": "alive" },   // from the canonical gauge
  "enemies": [ { "id": "enm_hound_1", "name": "Carrion Hound", "hpBand": "bloodied", "morale": "steady" } ],
  "nextIntents": [                               // the telegraphs for the round ahead
    { "id": "enm_hound_1", "telegraph": "circles for your throat" }   // hidden intents emit a neutral tell or nothing
  ],
  "outcome": null                                // the structured close record on the final round
}
```

Notes for the CLI 1 integration:

- `hpBand` (fresh/bloodied/broken) not raw enemy numbers — the narrator speaks
  in wounds, the client UI shows the player's own true numbers from the scene
  payload as today.
- `nextIntents` is what makes rounds narratable *forward* (the telegraph is a
  committed fact, so prose and mechanics can't diverge — the ITEM-3
  discipline, `attempt.js:365-388`).
- Deterministic fallback narration per round (offline/timeout path) composes
  from the same record, exactly like `composeAttemptNarration` — no silent
  turns (FIX K).
- Death narration on a combat kill reuses `narrateDeathWithGm`
  (`server/index.js:825`) unchanged.

---

## 5. Content — minimum enemy model + starter bestiary

### 5.1 Stat block (server-authored, `server/campaign/bestiary.js`, schema-validated)

```jsonc
{
  "statBlockId": "carrion_hound",
  "name": "Carrion Hound",
  "tier": 1,                        // scaling knob; tier 1 ≈ a level-1 fight
  "maxHp": 11, "ac": 12, "dexMod": 2,
  "xp": 50,
  "attacks": [ { "attackId": "bite", "toHit": 3, "damage": "1d6+1", "damageType": "piercing" } ],
  "intents": [                      // weighted; server picks per round
    { "intentId": "lunge",  "kind": "attack", "attackId": "bite", "weight": 3, "telegraph": "coils low, hackles up" },
    { "intentId": "circle", "kind": "defend", "weight": 1, "telegraph": "circles, looking for an opening" }
  ],
  "behaviors": { "vicious": false, "cowardly": true },   // cowardly: morale breaks at ≤ half HP
  "loot": [ { "itemId": "hound_fang", "name": "Cracked Fang", "chance": 0.5 } ],
  "tags": ["beast"]
}
```

### 5.2 Starter enemies (original names, dark-fantasy generic, fit the existing worldGen ruins/wilds)

| Stat block | Concept | HP / AC / hit / dmg | Behavior |
|---|---|---|---|
| `carrion_hound` | scavenging beast around ruins | 11 / 12 / +3 / 1d6+1 | cowardly |
| `waylayer` | desperate human bandit | 12 / 13 / +3 / 1d6+2 | parleys at broken morale (surrender, not death) |
| `ruin_creeper` | vermin swarm in collapsed places | 9 / 11 / +4 / 1d4+2 | never parleys; cowardly |
| `hollow_husk` | slow undead remnant | 15 / 11 / +2 / 1d8+1 | **vicious** (parting blow on a downed player) |
| `civilian` (default block) | any unstatted cast NPC the player attacks | 6 / 10 / +1 / 1d4 | flees at first blood |

Numbers are 5e-plausible for a level-1 character (max HP ~9-13, AC 10-13):
winnable, genuinely lethal on bad dice — matching the validated
gate/failure spine.

### 5.3 Momentum initiation

Two `threat` templates in the first content pass (same builder shape as the
existing `arrival_*` templates, `momentumEvents.js:113+`):

- `threat_stalker` — a `carrion_hound` commits to the cast, telegraphed
  ("something has been pacing you"); decision: face it / move on (moving on
  clears it; staying or engaging starts combat next turn).
- `threat_waylay` — a `waylayer` demands toll (composes with the existing
  `hook_tollman`); refusal starts combat, payment resolves peacefully (a real
  resource cost through the existing spine).

---

## 6. Scope honesty — phased build for a solo-dev + CLI pipeline

**Phase 0 — contract (small: ~1 session).**
`run.combat` + stat-block validators in `schema.js`, CONTRACT.md re-freeze
(additive §8), scene payload emits `combat`. No behavior.

**Phase 1 — smallest playable slice (the bulk: ~3-4 focused sessions).**
One enemy (`carrion_hound`), entry via player attack intent only,
`server/solo/combat.js` (initiative, rounds, attack/defend/flee/use_item,
telegraphed intents, victory/defeat/flee close, morale off), player-drop rule,
combat menu in `getAvailableSoloActions`, deterministic round narration
fallback, `buildCombatGmMessage`, `XP_AWARDS.combat_won`, test-hook extension
(`fixedRolls` scripting through a whole round), hostile-battery tests through
real HTTP (the existing harness pattern: `tests/solo-run-actions.test.js` et
al). **No spells, no stunts, no momentum entry, one enemy per fight.**

**Phase 2 — the game (~2-3 sessions).**
Full starter bestiary, morale/surrender, `threat` momentum templates,
free-text stunt mapping (`COMBAT_STUNT_EFFECTS`), loot drops, multi-enemy
fights (turnOrder already supports it), suggestions surface combat options,
civilian default block + quest-failure composition.

**Phase 3 — depth (post-validation only).**
Spells/MP spend, companion NPCs fighting alongside, hidden intents, conditions
with mechanical teeth (a `bleeding` that ticks, a `stunned` that costs the
turn), fiction-triggered hostility from talk.

**Riskiest piece (flagged):** the **free-text ↔ combat-machine seam** — mapping
an arbitrary attempt onto the legal combat menu without either (a) tyrannizing
creative play (everything unmappable auto-fails) or (b) reopening the
generic-check bypass (a colorful attack resolving outside the combat resolver
and double-hitting). It is the same class of problem as the reroute chain, but
inside a state machine where a mis-route corrupts turn order. Mitigation:
Phase 1 ships with the menu + a *strict* mapper (unmappable → stunt check with
enumerated boons, never damage), and the hostile battery gets a dedicated
"combat coherence" section before Phase 2 widens anything.

Second risk: **narration cost/latency per round** — a combat round is the
fattest narration payload yet; it must fit the existing per-turn GM timeout
(`narrateActionWithGm` ceiling) or degrade to the deterministic template. The
unit-economics instruments (committed in `feat(instruments)`) should get a
combat-round scenario before Phase 2.

---

*Approval gate: no code until the owner signs off on this spec — specifically
the positions taken in §2.3 (telegraphed intents by default), §2.4 (combat ends
when the player drops; vicious parting blow), and the Phase 1 cut list.*
