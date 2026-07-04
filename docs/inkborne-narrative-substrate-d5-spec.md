# D.5 — THE NARRATIVE SUBSTRATE: threads/fronts + scenario seeding (SPEC — no code until owner sign-off)

**Status:** DRAFT for owner review. Design + scope only. This is the biggest
design decision since the coherence moat and is treated that way: every
existing-primitive claim below is verified against the repo, every pathway gets
a coherence audit, and the doc ends with the sign-off decision points.

---

## 0. The problem, evidence-backed

The prose ladder (`docs/prose-ladder-2026-07-03.md`, run against the owner's
fluff-verdict session `run_97e04059`) proved the narrator's ceiling is the
**material, not the model**: the style-contract variant cut mood-only sentences
from 7/24 to 3/23 on the same beats, but honest cells stayed dull because the
server hands the narrator *nothing to be honest about* — and the cells that
read as "fun" got there by fabricating drivers (invented NPCs, a maintenance
drone, phantom stakes). Beats 5–6 of the ladder are the smoking gun: given a
committed-state void, models either confabulate a target or narrate honestly
into emptiness.

The engine's proactive layer today is **momentum**
(`server/solo/momentum.js`) — real, committed, server-owned… and *memoryless
between fires*. Each event is a one-off: the watcher steps into view and is
never heard from again; the fire burns and nothing follows from it. Momentum
gives events. **Nothing gives events meaning across time.** A real DM leads the
plot — has an agenda that was true before the player looked and escalates
whether or not they engage — without hallucinating drivers. That agenda is
what this spec makes into server-owned state.

---

## 1. What already exists (verified) — threads are the generalization, not a new organ

The doctrine and most of the machinery are already in the repo. Threads
generalize five proven primitives:

| Existing primitive | Where (verified) | What threads inherit from it |
|---|---|---|
| **Momentum templates**: server-authored complications; `build(run)` returns a commit payload (`npc` / `objectState` / `quest`); "a template with no committable payload is a bug" | `server/campaign/momentumEvents.js:1-15`, pool at `:110-420` | A momentum event is a **single-beat, anonymous thread**. The beat/payload shape is already designed. |
| **Commit-first adjudication**: payload written to state, `validateSoloRun` gates it, enumerated rollback on failure, *"an invalid event is never narrated"* | `momentum.js:201-260` (`commitMomentumPayload`), rollback `:317-332` | The **beat-commit executor**, reused verbatim (extended with two payload kinds, §2.2). |
| **Pacing clock + yield**: tension builds on quiet turns, bleeds on progress; fires only on a non-progress turn, past cooldown, never while dying — *"never trample an advancing arc"* | `momentum.js:32-38` (tuning), `:379-408` (`advanceMomentum`) | The **scheduler**. Threads do not get a second clock; they plug into this one (§4.2). |
| **Bounded LLM role**: an optional `rankFn` may reorder the server's shortlist; output filtered back against real candidates — *"anything it invents… is discarded"* | `momentum.js:275-291` | The LLM ceiling for threads: **ranking server rows. Nothing else.** |
| **Symbolic authoring + interpolation**: quest templates are data with `{world}`/`{place}` placeholders and symbolic targets (`"second_location"`, `"npc_quest_giver"`) resolved to real run ids at instantiation | `server/solo/quests.js:47-129` (templates), `:192-212` (resolution); tone-keyed flavor maps in `server/campaign/authoredQuests.js:27-38,177-188` | The **scenario authoring format**: declarative data, symbolic refs, interpolation — writable without touching engine code (§3.1). |

Supporting spine, also verified:

- **Quest lifecycle with teeth**: multi-stage arcs, five completion predicates
  (`reach_location`/`talk_beat`/`obtain_item`/`deliver`/`check` —
  `quests.js:308-347`), deterministic roll-binding (`checkRollBinds`,
  `quests.js:280-306`), losable stages (`failOnMiss`, `quests.js:352-362`),
  reward-on-completion (`quests.js:435-449`). Thread beats *instantiate* quests
  (as momentum hooks already do, `momentumEvents.js:85-102`); they do not
  replace the quest engine.
- **Player-authored goals**: `capturePlayerObjective` (`quests.js:579-624`)
  already turns a declared, world-agreed goal into a tracked
  `authoredBy:"player"` quest. This is the birth hook for goal-opposition
  threads (§3.2c).
- **Canon ground truth**: `server/solo/canon.js` — `playerKnowsEntity`
  (`:54-89`), `runHasCanonicalEvent` (`:98-117`) — deterministic predicates
  over `run.memoryFacts` / `run.timeline` / `run.relationships`. This is the
  **callback engine's** query layer (§5.1).
- **Narration fold-in seam**: the per-turn GM message is deterministic
  server-built text (`buildActionGmMessage`,
  `server/gm/actionNarration.js:171`), with committed developments folded in at
  `server/index.js:887-894` (*"a REAL development has just been committed…
  Do NOT invent any other"*) and the scene payload carrying
  `recentDevelopment` while fresh (`server/solo/scene.js:1093`,
  `momentum.js:415-426`). Threads extend this seam; they do not add a channel.
- **Run-start seeding**: `server/campaign/onboarding.js:842-888` hand-wires the
  current authored content — main quest (`createMainQuest`), delivery offer on
  the quest-giver (`buildDeliveryOffer`, `onboarding.js:807-835`), trial quest
  (`buildTrialQuest`, `:882-887`), cast NPCs (`npc_quest_giver` `:690`,
  `npc_far_witness` `:759`). **This block is a hardcoded scenario.** D.5's
  first deliverable is making it *data* (§3.1).
- **Schema pattern for a new first-class record**: `run.quests` etc. validate
  via `validateRecord` (`server/solo/schema.js:1057-1062`); referential
  integrity checks exist (dangling `linkedQuestIds` fail validation,
  `schema.js:1103-1115`). `run.threads` follows the same pattern.

**What genuinely does not exist:** any object that (a) persists an agenda
across multiple fires, (b) orders beats into an escalation, (c) conditions a
beat on what the player previously did, (d) is authorable as data at run start,
or (e) opposes a player-declared goal. That is the whole of D.5.

---

## 2. The thread model

### 2.1 The object — a first-class, validated record (`run.threads`, like `run.quests`)

A **thread** is a committed narrative agenda: a danger, secret, rival agenda,
or consequence-in-motion. It is a row before it is a sentence.

```jsonc
{
  "threadId": "thread_tollreeve",
  "kind": "danger",                    // danger | secret | rival | consequence | opportunity
  "status": "active",                  // dormant | active | resolved | expired | abandoned
  "origin": "scenario",                // scenario | worldgen | momentum | player_goal
  "title": "The Toll-Reeve's Reach",   // internal + journal name (revealed threads only)
  "agenda": "The one closing the roads wants the crate — and to make an example of whoever carries it.",

  // GROUNDING — every ref must exist in run state at commit time (validated,
  // same referential-integrity discipline as dialogueBeats' linkedQuestIds).
  "groundedIn": {
    "entityIds": ["npc_quest_giver"],
    "locationIds": ["second_location", "third_location"],
    "questIds": ["quest_delivery"],
    "factIds": []
  },

  // THE ESCALATION LADDER — ordered beats; each is a momentum-template-shaped
  // commit. beatIndex is the rung the thread stands on.
  "beatIndex": 0,
  "beats": [ /* see §2.2 */ ],

  // PACING — per-thread dormancy/cooldown, scheduled through the ONE momentum clock.
  "clock": { "minTurnsBetweenBeats": 4, "lastFiredTurn": null, "dormantUntilTurn": null },

  // PLAYER-VISIBLE SURFACE (position taken in §5.3):
  "revealState": "hidden",             // hidden | rumored | revealed

  // RESOLUTION — how it ends (any satisfied rule closes it):
  "resolution": [
    { "kind": "quest", "questId": "quest_delivery", "on": "completed", "outcome": "resolved" },
    { "kind": "beat_final", "outcome": "resolved" },              // last rung committed
    { "kind": "ground_lost", "outcome": "resolved" }              // grounding entity removed (e.g. killed)
  ],

  // CALLBACKS — the remembered-forward feel (see §5.1):
  "callbackQuery": { "entityIds": ["npc_quest_giver"], "keywords": ["crate", "delivery", "toll"] },

  "flags": {}
}
```

### 2.2 Beats — momentum templates, generalized and made declarative

A beat is what a momentum template's `build()` *returns* today
(`{ title, brief, decision, npc?, objectState?, quest? }` —
`momentumEvents.js:104-109`), plus a trigger, plus two new payload kinds:

```jsonc
{
  "beatId": "beat_enforcer_arrives",
  "label": "The reeve sends someone",
  // TRIGGER — server-evaluated conditions gating this rung (ALL must hold).
  // Same predicate vocabulary as quest completion where possible.
  "trigger": {
    "minTurn": 8,                                  // absolute pacing floor
    "requiresBeat": "beat_road_tightens",          // ladder ordering (default: previous rung)
    "playerAt": null,                              // optional locationId gate
    "questState": { "questId": "quest_delivery", "status": "active", "minStage": 1 },
    "canon": null                                  // optional { keywords } → runHasCanonicalEvent
  },
  // COMMIT PAYLOAD — declarative; the SAME kinds commitMomentumPayload already
  // writes (npc / objectState / quest), plus two additions:
  //   fact       — write a canonical memoryFact (plumbing exists:
  //                createMomentumMemoryFact, momentum.js:140-159)
  //   hostileNpc — an npc payload carrying statBlockId + hostile flag; the
  //                D.4 combat interface (see §7)
  "payload": {
    "hostileNpc": {
      "npcId": "npc_reeve_enforcer",
      "displayName": "The reeve's collector",
      "role": "enforcer",
      "statBlockId": "waylayer",                   // resolved against the D.4 bestiary at commit
      "placeAt": "{player_location}",
      "dialogueBeats": [ { "label": "Hand it over",
        "text": "\"The reeve says the roads are his now — and so is what moves on them. The crate. Or we take it off what's left of you.\"" } ]
    }
  },
  "brief": "A collector sent by the toll-reeve has found the player — he wants the crate, and he has not come to bargain long.",
  "decision": "Hand over the crate, talk him down, or refuse and face him.",
  "telegraph": null,                               // optional pre-beat rumor line (rumored reveal)
  "status": "pending"                              // pending | committed | skipped
}
```

Rules carried over from momentum verbatim:

- **Commit-first.** The payload lands in state and `validateSoloRun` gates it;
  failure rolls back exactly what was written and the beat is skipped this
  turn, not narrated (`momentum.js:317-332` extended to the two new kinds).
- **No committable payload → invalid content.** A beat that changes nothing is
  rejected at authoring-validation time (a `fact` payload is the minimum).
- Symbolic refs (`{player_location}`, `"second_location"`,
  `"npc_quest_giver"`) and `{world}`/`{place}` string interpolation resolve at
  commit time — the `createMainQuest` resolution pattern
  (`quests.js:199-212`) promoted into a small shared resolver.

**Migration position:** momentum's one-off templates are *not* rewritten. They
remain the filler pool. The engine change is in the scheduler (§4.2): a due
thread beat takes the fire slot first; the legacy pool fires when no thread is
due. A momentum template may carry an optional `spawnsThread` field (phase 2)
so a fired one-off can be *promoted* into a thread (the watcher who returns).

---

## 3. Two seeding strategies, one substrate

### 3.1 (a) Authored scenarios — "the default door"

A **scenario** is a data file: pre-authored thread set + starting cast + stakes
+ opening situation, loaded at run start. It replaces the hand-wired block in
`onboarding.js:686-888` with a loader over data.

**Authoring format (position taken): declarative JSON module under
`server/campaign/scenarios/` — no functions, no code.** Momentum templates get
to keep `build(run)` because they are engine-internal; scenario content is the
UGC surface and must be writable by a human or a CLI without touching the
engine. Everything dynamic is expressed through:

- `{world}` / `{place}` / `{start}` / `{tone}` interpolation
  (existing pattern: `quests.js:192-196`),
- symbolic location/NPC refs resolved by the loader
  (existing pattern: `quests.js:199-212`),
- tone-keyed flavor variants (existing pattern: `TRIAL_FLAVOR` / `DELIVERY_FLAVOR`,
  `authoredQuests.js:27-38,177-188`).

Shape:

```jsonc
{
  "scenarioId": "the_shipment",           // the default door
  "title": "The Shipment",
  "tones": ["any"],                       // or a tone allowlist
  "stakes": "A sealed crate, a road someone is strangling shut, and a vault that gives you one try.",
  "cast": [
    { "npcId": "npc_quest_giver",  "at": "second_location", "role": "stranger",
      "dialogueBeats": [ /* … */ ], "questOffer": "offer_delivery" },
    { "npcId": "npc_far_witness",  "at": "third_location",  "role": "witness",
      "dialogueBeats": [ /* linkedQuestIds: ["quest_main"] */ ] }
  ],
  "questOffers": { "offer_delivery": { /* buildDeliveryOffer's output shape, tone-flavored, as data */ } },
  "quests": { "quest_main": { /* template ref */ }, "quest_trial": { /* as data */ } },
  "threads": [ /* §3.1.1 */ ],
  "opening": { "questObjectiveFrom": "quest_main" }
}
```

Loader contract: validates every symbolic ref against the (post-worldgen) run,
instantiates cast → quests → threads in that order, and **fails the load
loudly** on a dangling ref — a scenario that references a location the world
graph doesn't have is a content bug at load time, never a runtime surprise.

#### 3.1.1 The existing arc re-expressed as the first scenario

Everything the onboarding block hand-wires today becomes three threads plus
cast. Threads 1–2 are re-expressions (same committed outcomes as today); thread
3 is the **new villain-shaped pressure** the current game lacks:

**Thread 1 — `thread_shipment` (kind: `opportunity`, revealState: `revealed`).**
The delivery arc (`buildDeliveryOffer`, `authoredQuests.js:200-304`) as a
single-beat thread: beat 0 commits the quest-giver's `questOffer` (offer →
crate → road-hazard check stage → deliver, all already proven predicates).
Resolution: `quest_delivery` completed/failed. Grounding: `npc_quest_giver`,
`second_location`, `third_location`.

**Thread 2 — `thread_trial` (kind: `secret`, revealState: `rumored`).**
The trial (`buildTrialQuest`, `authoredQuests.js:97-154`) as a two-beat thread:
beat 0 (telegraph rumor: a `fact` payload — *"travelers speak of a sealed
vault below {place}"*), beat 1 commits the check-gated, losable quest itself.
Net-new over today: the rumor beat gives the trial a discovery moment instead
of silently pre-existing in the quest list.

**Thread 3 — `thread_tollreeve` (kind: `danger`, revealState: `hidden`) — the
villain-shaped pressure, with a second-act escalation.** Grounded in what
already exists: the road hazard the delivery quest teaches (*"toll-takers watch
the only road"*) stops being ambient flavor and becomes someone's agenda.

| Rung | Trigger | Commit payload | The screw turning |
|---|---|---|---|
| 0 `beat_eyes_on_the_road` | `quest_delivery` accepted | `fact` (canonical): "Word moves ahead of you — the one who runs the tolls knows a courier took the job." | The world noticed. |
| 1 `beat_road_tightens` | rung 0 + ≥3 turns + quest still active | `objectState` on the route location: `the-road-watch / manned / retryEffect: harder` (consequence-spine shape — composes with foreclosure, `momentum.js:219-244`) | Passage is mechanically harder; the hazard check DC pressure is real. |
| 2 `beat_enforcer_arrives` | rung 1 + ≥4 turns + crate still held | `hostileNpc` (statBlockId `waylayer`) placed at the player's location, with a demand beat | **Second-act escalation**: the agenda walks up and speaks. Refusal is the D.4 combat entry (§7). |
| 3 `beat_reeve_named` | rung 2 resolved either way | `fact` + `quest` (hook): the reeve is named; a confrontation hook instantiates | The thread resolves into a nameable antagonist the player can pursue — or ignore, and `expired` closes it with a consequence fact. |

Delivering the crate before rung 2 short-circuits to rung 3's naming beat
(resolution rule `quest:completed` → the reeve's *reaction* fact instead) —
threads react to the player winning, which is exactly the "meaning across
time" momentum can't express.

### 3.2 (b) Sandbox runtime seeding — same object, different birth

No scenario file; threads are born at runtime from three server-owned sources:

**(a) Worldgen.** At run creation, 1–2 `dormant` threads seeded from a
tone-keyed thread-template pool (the `TONE_ARCHETYPES` pattern,
`worldGen.js:64-225` — each archetype gets 2–3 thread skeletons whose symbolic
refs resolve against the generated graph). Seeded-deterministic on `worldSeed`.
Dormant threads do nothing until their rung-0 trigger holds — a world with an
agenda it hasn't shown yet.

**(b) Momentum promotion.** A fired one-off template with `spawnsThread`
instantiates the thread behind the event (the watcher becomes a `rival` thread
whose rung 1 is "the watcher reports to someone"). Selection stays seeded;
promotion is a property of the server-authored template, never a runtime
decision by the model.

**(c) Player-goal opposition — the marquee sandbox feature.** When
`capturePlayerObjective` creates a player-authored goal (`quests.js:579-624`),
the server *may* (seeded roll + cadence gate) instantiate one **opposition
thread** from a small `OPPOSITION_TEMPLATES` pool matched on goal keywords
(claim/hold ground → a prior claimant emerges; build/restore → scavengers strip
what you raise; avenge/hunt → the quarry learns it is hunted). Grounding rule:
the opposition must be built **only from entities/locations that exist** (the
current location, an existing NPC, the goal quest record) — never a minted
faction. The declared goal's own text supplies interpolation material; the
thread's `groundedIn.questIds` links it to the goal quest, and resolving the
goal resolves or flips the opposition.

Sandbox doctrine preserved: the procedural spine stays suppressed
(`quests.js:391-399,473`); threads in sandbox are born only from the three
sources above — an *open* world with pressure, not an assigned plot.

---

## 4. The narration contract feed

### 4.1 What rides the GM context (the payload CLI 1's contract-voice consumes)

Per turn, **at most one narrative driver** rides the GM message, selected
server-side (§4.2). The fold-in generalizes the momentum block at
`server/index.js:887-894` — same "a REAL development has just been committed…
invent nothing else" framing — with a richer, still-fully-committed payload:

```jsonc
"narrativeDriver": {
  "source": "thread",                      // thread | momentum | quest_advance
  "threadId": "thread_tollreeve",          // omitted for legacy one-offs
  "threadKnown": false,                    // revealState !== "hidden" → the GM may name the pattern
  "beat": {
    "title": "The reeve sends someone",
    "brief": "A collector sent by the toll-reeve has found the player…",   // committed, grounded sentence
    "decision": "Hand over the crate, talk him down, or refuse and face him."
  },
  "committed": { "npcIds": ["npc_reeve_enforcer"], "objectStateKeys": [], "questIds": [], "factIds": ["fact_…"] },
  "callbacks": [                            // §5.1 — verbatim canonical fact text, server-selected
    "You took the courier's job at Ashenmoor Market — the crate is the reeve's grievance."
  ],
  "escalation": "second"                    // first | second | final — lets the voice pitch intensity
}
```

Contract guarantees to the narrator (and to CLI 1's style contract):

- every noun in `beat.brief` / `callbacks` exists in committed state **this
  turn** — the prose-ladder's phantom-ref class is structurally impossible to
  need;
- `decision` is always present — the contract-voice's "end on pressure /
  decision" clause always has true material;
- `threadKnown:false` means the GM narrates the *event*, never the *pattern*
  (the hidden agenda is not leaked by the prompt — it is not in the prompt).

The scene payload's `recentDevelopment` (`scene.js:1093`) generalizes to carry
the same record while fresh (fired turn + next, `momentum.js:415-426`
unchanged), so the *next* scene still stands on it.

### 4.2 Selection + pacing — one clock, strict yield

Position taken: **threads do not get their own clock.** They plug into
momentum's proven cadence so there is exactly one source of world-initiated
pressure per turn:

1. `advanceMomentum` ticks tension exactly as today
   (`momentum.js:379-408`: quiet +2, fail +1, progress −1; fire needs
   tension ≥ 6, cooldown > 3 turns, active run, not dying, **never on a
   progress turn** — the yield rule, reused verbatim).
2. When the clock fires, the slot is offered **first to the thread engine**:
   the due-beat shortlist is every `active` thread whose next rung's trigger
   holds and whose per-thread `clock` allows. Selection among due beats is
   seeded (`hashSeed(worldSeed|threads|turn)`, the `momentum.js:293` pattern);
   an optional `rankFn` may reorder the shortlist under the same filter-back
   discipline (`momentum.js:275-291`).
3. No due beat → the legacy one-off pool fires exactly as today.
4. Independent of the clock, a rung whose trigger names a **hard player-borne
   condition** (e.g. `playerAt` — the player walked into the reeve's watch-post)
   may fire on that turn's finalize step even without tension — but still never
   on a `progress`-classified turn and still ≤1 driver per turn (a quest
   advance outranks it; it waits).

Priority when several sources want the same turn:
`quest_advance` (engaged arc, already folded at `index.js:877-882`) >
due thread beat > legacy momentum one-off. Rationale: never trample the arc
the player is actively moving; threads are pressure, not interruption.

---

## 5. Lifecycle, callbacks, and the player-visible surface

### 5.1 Callbacks — remembering forward

The callback is what makes a DM feel like it *remembers*: the new development
explicitly stands on what the player did. Deterministic, zero model judgment:

- At beat-fire time, the server evaluates the thread's `callbackQuery` against
  canonical state using the existing canon machinery: facts linking the
  player and the thread's grounded entities (`playerKnowsEntity` walk,
  `canon.js:54-89`) and keyword-matched canonical facts / timeline events
  (`runHasCanonicalEvent`, `canon.js:98-117`).
- The 1–2 most recent matching facts' **verbatim text** rides
  `narrativeDriver.callbacks`. The GM is instructed to ground the beat in
  them — it never *searches* memory itself and never paraphrases state it
  wasn't handed.
- Beats themselves write canonical facts (`fact` payloads), so later rungs
  call back to earlier rungs through the same channel — the ladder is
  self-documenting in `run.memoryFacts`.
- Trigger-side: a rung may gate on canon (`trigger.canon.keywords` →
  `runHasCanonicalEvent`), so *"the reeve learned you killed his collector"*
  fires only when that is literally on record.

### 5.2 Resolution

A thread closes when any resolution rule matches (evaluated in the same
finalize pass that runs `advanceQuests`, `actions.js:363`):

- **`quest`** — a linked quest hits a status (`completed`/`failed`); the
  delivery thread resolves when the delivery resolves.
- **`beat_final`** — the last rung committed.
- **`ground_lost`** — a grounding entity leaves play (killed NPC, per D.4
  combat outcomes). Position: `ground_lost` *resolves* the thread by default
  (killing the collector before rung 3 ends the reeve's reach — a real,
  legible consequence of violence); a template may instead declare a
  `regroundBeat` (the agenda finds another instrument) — authored, never
  improvised.
- **`expiry`** — `opportunity`-kind threads with a declared shelf life close as
  `expired`, optionally committing one consequence fact ("the cache was dug up
  by someone else"). Dangers never silently expire — they resolve or escalate.

Resolved/expired threads persist (status flipped) — they are canon, and future
threads may call back to them.

### 5.3 Player-visible surface — position taken: no new UI in the critical path

`revealState` governs the *GM context*, not a new panel:

- **hidden** — never in the prompt (§4.1). The player experiences effects
  (harder road, an enforcer) without the pattern being named.
- **rumored** — the telegraph line may ride as a `fact` payload / dialogue
  beat; the GM can voice the rumor, not the truth behind it.
- **revealed** — `threadKnown:true`; the GM may name the agenda; the thread's
  title/agenda become fair narration material.

Everything the player *sees* arrives through existing surfaces: instantiated
quests (chips), committed NPCs/dialogue, canonical facts, timeline events. A
"Rumors & Threads" journal panel is explicitly **phase 4 UI** — worth having,
never load-bearing. Rationale: the prose-ladder problem is what the *narrator*
is handed, not what the client renders; UI can trail validation.

---

## 6. Coherence audit (mandatory) — where each pathway would leak, and the row-first prevention

Doctrine restated: **threads are rows before they are sentences** — the
momentum doctrine (`momentumEvents.js:5-15`) applied to multi-beat agendas.
LLM's maximum role anywhere in this system: **ranking server shortlists.**

| # | Pathway | Naive leak | Prevention (designed in) |
|---|---|---|---|
| 1 | Scenario authoring | Scenario files carry `build()` functions → UGC is arbitrary code execution | Scenario content is **declarative JSON only** (§3.1); dynamic behavior exists solely as interpolation + symbolic refs + the trigger/payload vocabulary. The loader is the only code. |
| 2 | Scenario loading | Dangling refs surface at runtime as half-committed beats | Load-time referential validation, fail-loud (§3.1) — the `linkedQuestIds` integrity pattern (`schema.js:1103-1115`) applied to the whole scenario before the run starts. |
| 3 | Thread birth (all sources) | The model "notices" a pattern and proposes a thread ("a cult is after you") → minted agenda | Threads are born from exactly four server-owned events: scenario load, worldgen seed, `spawnsThread` on a fired server template, goal-capture opposition. There is **no API by which model output creates a thread.** |
| 4 | Beat firing | The GM narrates escalation that hasn't fired ("you feel the net tightening") because the prompt names the agenda | Hidden threads are absent from the prompt (§4.1/§5.3). The narrator cannot leak state it was never handed; commit-first means it is never asked to foreshadow uncommitted rows. |
| 5 | Beat content | Provider proposes beat payloads (the `proposedEffects` slot creeps wider) | Beat payloads come from authored data; `ALLOWED_EFFECT_TYPES` (`attempt.js:35`) is untouched; the attempt provider's contract gains **no fields**. The only new prompt content is the fold-in of already-committed facts. |
| 6 | Enemy/threat beats | Narration mints hostiles (prose-ladder beat 6's confabulated target class) | `hostileNpc` payloads resolve against the D.4 bestiary at commit; unknown `statBlockId` → commit fails adjudication → beat skipped, not narrated (rollback discipline, `momentum.js:317-332`). |
| 7 | Goal opposition | LLM invents the opposing force for a declared goal | Opposition comes from the server `OPPOSITION_TEMPLATES` pool, keyword-matched (the `detectPlayerGoal` regex discipline, `quests.js:510-530`), grounded only in existing entities; seeded selection; `rankFn` may reorder, never add. |
| 8 | Callbacks | Model asked "what does the player's history suggest?" → confabulated memory | Callbacks are server-selected canonical fact text, verbatim (§5.1), via `canon.js` predicates. The model receives memories; it never retrieves or invents them. |
| 9 | Pacing | Model decides when the world escalates (agenda-as-vibes) | Firing is the deterministic clock + trigger predicates (§4.2). The model's entire pacing influence is `rankFn` order within an already-due shortlist. |
| 10 | Flavor drift | Letting the model "polish" beat briefs introduces new nouns pre-commit | Position: **no flavor-fill slot in phases 0–3.** Beat text is authored data, interpolated. A future flavor-fill pass would run *post-commit*, sanitized, with a no-new-proper-nouns validator — deferred until graded sessions demand it. |

---

## 7. Interface to D.4 combat (Phase 0 dispatches immediately after this spec)

Threads are the delivery mechanism for combat's momentum-side entry
(D.4 spec §2.2's `threat` templates should be **authored as danger-thread
beats**, not a parallel template kind). Combat Phase 0 needs from D.5, and
D.5 needs from combat:

1. **`statBlockId` is a string contract.** The bestiary
   (`server/campaign/bestiary.js`, D.4 Phase 0) owns resolution; the thread
   schema validates `payload.hostileNpc.statBlockId` only as a non-empty
   string. Loose coupling: threads never embed stats.
2. **`hostileNpc` beat payload kind** (this spec, §2.2) = D.4's telegraphed
   combat entry: it commits the hostile NPC + demand beat; combat starts on the
   player's engagement per D.4 §2.2(2) — beats place threats, the combat
   machine owns the fight.
3. **Combat outcomes feed thread lifecycle:** enemy death/flee/surrender writes
   timeline + (Phase 1 combat) a canonical fact — which `ground_lost`
   resolution and `trigger.canon` gates consume (§5.2). No new plumbing; both
   sides speak `memoryFacts`/`timeline`.

Build-order note: combat Phase 0–1 does **not** block on threads (its entry is
the player attack intent); the thread engine's `hostileNpc` payload lands with
D.5 Phase 1 and simply targets the bestiary that already exists by then.

---

## 8. Scope — phased build for the solo-dev + CLI pipeline

**Phase 0 — contract (~1 session).**
`run.threads` validator (`validateRecord` pattern), beat/trigger/payload
validators with referential integrity, scenario-file validator, CONTRACT.md
re-freeze (additive). Scene payload emits `threads: []` summary (id/status/
revealState only). No behavior.

**Phase 1 — the authored door (~3–4 sessions). Smallest slice that answers the
owner's gripe.**
Thread engine core: trigger evaluation, beat commit (generalized
`commitMomentumPayload` + `fact` payload; `hostileNpc` behind the bestiary
landing), scheduler integration (§4.2), narration fold-in + `recentDevelopment`
generalization, callbacks v1 (`callbackQuery` → verbatim facts). **The
`the_shipment` scenario** re-expressing delivery + trial + the toll-reeve
pressure thread (§3.1.1), loaded by onboarding in place of the hand-wired
block (`onboarding.js:686-888`) behind a flag, default-on for campaign runs.
Harness: replay battery asserting every narrated driver has a same-turn
committed row (the anti-void guard doctrine), rung-order and yield tests with
scripted clocks. *Exit criterion: a graded human session on `the_shipment` —
this phase exists to be measured against the fluff-verdict baseline.*

**Phase 2 — sandbox runtime seeding (~2–3 sessions).**
Tone-keyed worldgen thread skeletons (seeded, dormant), momentum
`spawnsThread` promotion, expiry/`ground_lost` lifecycle completeness,
rumored-reveal telegraphs.

**Phase 3 — goal opposition (~2 sessions).**
`OPPOSITION_TEMPLATES` + capture-hook integration (§3.2c), opposition↔goal
resolution coupling. Gated on Phase 1 grading — if authored threads don't move
the fun needle, sandbox opposition won't either, and we stop and rethink
before building it.

**Phase 4 — surface + UGC (post-validation).**
Journal/rumor panel, scenario authoring docs + a second scenario written
entirely as data by a non-engine session (the UGC dry run), optional
post-commit flavor-fill with the no-new-nouns validator.

**UGC-authorability (owner requirement, answered now):** the shape that
survives to UGC without rework is locked in Phase 0 — declarative JSON, symbolic
refs, interpolation, trigger/payload vocabulary versioned in the scenario file
(`"substrate": 1`). Nothing a scenario can express requires code review;
everything it can commit passes the same `validateSoloRun` gate as engine
content. The Phase 4 dry run (author a scenario without touching `server/`)
is the acceptance test, but nothing in phases 1–3 may add a code-only
capability to scenario content without also adding its declarative form.

**Riskiest seam (named): pacing composition — §4.2.** The clock is proven for
one-shot spice; threads make it carry *plot*. Two failure modes pull opposite
directions: beats land as spam (the world nags) or threads starve behind the
progress-yield rule and the agenda never shows (a busy player literally never
sees rung 1 — tension only builds on quiet/fail turns, `momentum.js:384-391`).
The hard-condition path (§4.2.4) is the pressure valve, but the tuning is
real design work and **only graded human sessions can measure it** — per the
validation baseline, agent autoplay cannot score "does this feel like a DM
leading." Mitigation: pacing counters (`turnsSinceAnyBeat`, per-thread
starvation age) ship in Phase 1's instrumentation from day one, and Phase 1's
exit criterion is a graded session, not a green battery.

Second risk: the trigger vocabulary quietly becoming a programming language
(condition creep until scenarios are code again). Mitigation: the Phase 0
vocabulary above is closed; new predicates require a spec addendum, and each
must map to an existing server-evaluable primitive.

---

## 9. Decision points requiring owner sign-off

1. **Threads are first-class validated state** (`run.threads`, schema-gated,
   CONTRACT re-freeze) — not a convention inside `run.flags`. (§2.1)
2. **One clock:** threads schedule through momentum's existing
   tension/cooldown/yield engine — no second pacing system; ≤1 narrative
   driver per turn, quest-advance outranks threads outranks one-offs. (§4.2)
3. **Scenario content is declarative data only** — no `build()` functions in
   scenario files ever; momentum keeps its internal functions. This is the UGC
   line in the sand. (§3.1, §6.1)
4. **The first scenario is `the_shipment`** — the existing delivery + trial
   re-expressed, plus the toll-reeve danger thread with the rung-2 enforcer
   escalation, replacing the hand-wired onboarding block behind a flag. (§3.1.1)
5. **Hidden threads are absent from the prompt** — the GM narrates committed
   effects, never unnamed agendas; reveal is a state transition, not a vibe.
   (§4.1, §5.3)
6. **No new player-facing UI in Phases 1–3** — threads surface through quests,
   NPCs, facts, and prose; the journal panel waits for validation. (§5.3)
7. **`ground_lost` resolves by default** — killing the agenda's instrument ends
   the thread unless the template authored a re-ground beat. Violence is a
   legible answer to pressure. (§5.2)
8. **No LLM flavor-fill in Phases 0–3** — beat text is authored data; the
   model's only substrate role is shortlist ranking. (§6.10)
9. **Phase gating:** Phase 1 exits through a graded human session against the
   fluff-verdict baseline; Phase 3 (goal opposition) is conditional on that
   grade. (§8)

*Combat note: D.4 Phase 0 dispatches immediately; its only D.5-facing
obligations are the `statBlockId` string contract and writing combat outcomes
as canonical facts (§7). The `threat` momentum templates proposed in the D.4
spec are superseded by danger-thread beats and should not be built.*
