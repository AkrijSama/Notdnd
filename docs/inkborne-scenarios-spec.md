# Scenario System — Three Genres + Authoring Format (SPEC + one code artifact)

**Status:** Design + scope. The **only** code is the authoring schema validator
(`server/campaign/scenarioSchema.js`) + its tests-of-record
(`tests/scenario-schema.test.js`, 24 tests, green). No gameplay code, no loader,
no `run.threads` wiring — those are D.5 Phase 1. This spec grounds the D.5
narrative substrate (`docs/inkborne-narrative-substrate-d5-spec.md`) in **Dungeon
World Fronts**, a decade-proven implementation of the same thread model, and
proves the one authoring format holds three genres without per-genre special
casing.

**Research basis — Dungeon World Fronts (adopted as hard constraints, enforced
in the validator):**
- **≤3 active fronts, ≤1 foreground** — the anti-noise cap.
- **Each danger = 2–4 grim portents**, ordered, each **observable** (a telegraph)
  and **preventable** (a resolution can pre-empt it).
- **Dual advancement** — **descriptive** (the player's own action caused the next
  portent → commit it, mark it) *and/or* **prescriptive** (fires on a failed roll
  / quiet turn on the clock). Both must exist; a pressure front must offer the
  descriptive path or a busy player starves it. This resolves the D.5 §8
  pacing-starvation risk directly.
- **Secrets** — a pool of tweet-sized discoverable facts tied to fronts (the
  `fact` beat-kind + reveal conditions): the connective tissue that makes a world
  feel *known*.
- **Fronts are a fallback agenda, never a railroad** — matches the existing
  authority-gate / anti-tyranny doctrine.
- **Topology** — simple front = linear (bad→worse→worse); complex front =
  parallel unconnected pathways. The schema supports both, **plus one addition
  the tower forced** (§5).

### Verification notes (claims checked against the repo)

- **Genre.** The brief calls `the_shipment` a "Night City / cyberpunk" arc. Precise
  truth: the engine is a **multi-tone generator** (`server/solo/worldGen.js:64-225`,
  nine `TONE_ARCHETYPES`) that **defaults to dark-fantasy**
  (`DEFAULT_TONE_KEY = "dark_fantasy"`; the narrator voice is hardcoded
  dark-fantasy across `index.js:670`, `actionNarration.js:21`, `styleConfig.js:278`).
  **Cyberpunk already exists** as one archetype (`worldGen.js:205-224` — "neon-drowned
  sprawl", "the corps own the sky"), and the delivery/trial arc *already carries
  cyberpunk flavor rows* (`authoredQuests.js:37,187` — "ICE-locked vault node",
  "shielded data-case", "a checkpoint scans every courier crossing the sector
  line"). So `the_shipment`-cyberpunk **promotes existing content**, not new
  invention — the brief's instinct is right. There is **no "Night City" named
  content** (that IP name is avoided per D.4 §IP discipline; we use an original
  sprawl). The one real consequence, raised as a sign-off (§8), is that
  tone-locking the default door to cyberpunk overrides the dark-fantasy default
  every new player currently lands in.
- **Primitives.** Momentum payload shape `{title, brief, decision, npc?,
  objectState?, quest?}` (`momentumEvents.js:104-109`); `commitMomentumPayload`
  today commits `npc` / `objectState` / `quest` only (`momentum.js:201-260`) —
  the `fact` and `hostileNpc` kinds this schema authors are the D.5 §2.2 additions
  the D.5 Phase 1 executor adds. `objectState` shape is `{key, locationId, state,
  retryEffect(blocked|harder|none), reason}` (`momentum.js:219-243`). Quest
  interpolation `{world}/{place}/{start}` + symbolic targets `second_location` /
  `npc_quest_giver` (`quests.js:192-212`). Validator house style `{ok, errors}` +
  `push(errors, path, message)` (`schema.js:348`, `:111-120`). Scenario loader and
  `run.threads` confirmed **non-existent** (D.5 Phase 1 builds them).

---

## 1. The authoring schema (the UGC boundary)

A **scenario** is declarative JSON — no `build()` functions, no code (D.5 sign-off
#3). A **front** (authoring) instantiates a **thread** (runtime `run.threads`, D.5
§2.1), exactly as a quest template instantiates a quest state:
`front : thread :: questTemplate : questState`. The validator is the only code;
it runs at author time, at load time, and in CI, and **fails loud on any dangling
ref** so a broken scenario never reaches a player (D.5 §6.2).

### 1.1 The scenario object

```jsonc
{
  "substrate": 1,                       // UGC vocabulary lock (D.5 §8)
  "scenarioId": "the_shipment",
  "title": "The Shipment",
  "genre": "cyberpunk",                 // metadata label (any string)
  "tones": ["cyberpunk"],               // tone allowlist — drives flavor + narrator voice
  "stakes": "A sealed data-case, a sector someone is quietly closing, and a fixer whose cut prices in your funeral.",
  "opening": { "questObjectiveFrom": "offer_courier", "startLocationRef": "start", "situation": "…" },

  "locations": [ /* optional: ordered symbolic ids, e.g. a tower's floors */ ],
  "cast": [ { "npcId": "npc_quest_giver", "at": "second_location", "role": "fixer", "questOffer": "offer_courier", "dialogueBeats": [ … ] } ],
  "questOffers": { "offer_courier": { /* buildDeliveryOffer output, as data */ } },
  "quests": { "quest_delivery": { /* template ref / data */ } },

  "fronts":  [ /* ≤3, ≤1 foreground — §1.3 */ ],
  "secrets": [ /* non-empty pool — §1.5 */ ]
}
```

### 1.2 Constraints the validator enforces (DW → code)

| DW constraint | Schema rule (enforced) |
|---|---|
| ≤3 fronts, 1 foreground | `fronts.length ≤ 3`; `count(foreground===true) ≤ 1` |
| 2–4 grim portents | linear/parallel front: `2 ≤ beats ≤ 4`; **gated-sequence exempt** (§5) |
| observable | every beat requires a `telegraph` |
| preventable | danger fronts must carry a `resolution` that can pre-empt; may not resolve solely by `expiry` |
| committable | every beat commits **exactly one** payload kind (`fact` is the minimum) |
| dual advancement | a `danger`/`rival`/`consequence` front must offer **descriptive** advancement on ≥1 beat |
| secrets pool | scenario requires a non-empty `secrets`; each ≤280 chars, tied to a real front |
| grounded, no railroad | every ref (grounding, payload, trigger, callback, resolution) resolves to a symbolic token or a scenario-declared id, else fail-loud |

### 1.3 The front object

```jsonc
{
  "frontId": "front_collector",
  "kind": "danger",                     // danger | secret | rival | consequence | opportunity
  "foreground": true,                   // ≤1 across the scenario
  "topology": "linear",                 // linear | parallel | gated-sequence  (§5)
  "title": "The Collector's Cut",
  "agenda": "The one closing the sector wants the case — and to make an example of the courier.",
  "revealState": "hidden",              // hidden | rumored | revealed (D.5 §5.3)
  "groundedIn": {                       // every ref must exist at commit (D.5 §2.1)
    "entityRefs": ["npc_quest_giver"],
    "locationRefs": ["second_location", "third_location"],
    "questRefs": ["quest_delivery"]
  },
  "beats": [ /* ordered ladder — §1.4 */ ],
  "resolution": [                       // D.5 §5.2
    { "kind": "quest", "questRef": "quest_delivery", "on": "completed", "outcome": "resolved" },
    { "kind": "ground_lost", "outcome": "resolved" }
  ],
  "callbackQuery": { "entityRefs": ["npc_quest_giver"], "keywords": ["case", "cordon", "collector"] }
}
```

### 1.4 The beat object — dual triggers, observable, preventable

```jsonc
{
  "beatId": "beat_collector",
  "label": "The collector arrives",
  "telegraph": "A gonk in corp leathers is asking your face by name.",   // OBSERVABLE
  "brief": "A collector sent by the one closing the sector has found the courier — he wants the case.",  // committed, rides narrativeDriver
  "decision": "Hand it over, talk him down, or refuse and face him.",     // always present (D.5 §4.1)
  "trigger": {
    // PRESCRIPTIVE — fires on the momentum clock (quiet/failed turn) when these hold
    "prescriptive": { "requiresBeat": "beat_cordon", "minTurn": 8,
      "questState": { "questRef": "quest_delivery", "status": "active", "minStage": 1 } },
    // DESCRIPTIVE — fires immediately when the player's OWN action matches (never starves)
    "descriptive": { "onCanon": { "keywords": ["refused the toll", "burned the checkpoint"] } }
  },
  "payload": { "hostileNpc": { "npcId": "npc_collector", "statBlockId": "waylayer", "placeAt": "{player_location}",
    "dialogueBeats": [ { "label": "Hand it over", "text": "\"The case. Or we take it off what's left of you.\"" } ] } }
}
```

Prevention is the union of the beat's `telegraph` (you *see* it coming) and the
front's `resolution` (delivering the case / killing the collector pre-empts later
rungs). Payload kinds: `fact` (canonical memoryFact), `npc`, `objectState`
(`{key, locationId, state, retryEffect, reason}`), `quest` (`questRef`/inline),
`hostileNpc` (D.4 combat entry — `statBlockId` validated as a string, bestiary
owns resolution).

### 1.5 The secrets pool

```jsonc
"secrets": [
  { "secretId": "secret_engram",
    "text": "The case isn't cargo. It's someone's engram backup — that's why the tax, and why the collector won't stop.",
    "frontRef": "front_collector",
    "reveal": { "onEntityKnown": "npc_far_witness" } }   // onLocation | onEntityKnown | onCanon | onBeat
]
```

A revealed secret writes a canonical `fact` (the existing `fact` payload channel),
so it becomes callback material for later beats — the connective tissue. Each is
tweet-sized (≤280) and tied to a real front, so secrets always *illuminate an
agenda*, never float free.

### 1.6 Additions over the D.5 §2.2 vocabulary (flagged for sign-off)

The schema is D.5's thread/beat vocabulary plus **four** authoring-level additions,
each a DW constraint made declarable:

1. **`topology` on the front** — `linear | parallel | gated-sequence`. D.5 beats
   are implicitly ordered (`beatIndex`, `requiresBeat`); this names the shape so
   the validator can enforce the right cap. **`gated-sequence` is the one that
   relaxes an existing rule** (§5) — the material finding.
2. **`trigger.descriptive`** — a first-class descriptive-advancement mode. D.5
   §4.2.4 already anticipated it ("a rung whose trigger names a hard player-borne
   condition may fire on that turn's finalize step even without tension"); this
   promotes it to an authored field and **requires** it on pressure fronts, which
   is what actually closes the D.5 §8 starvation risk.
3. **`secrets`** at the scenario level — D.5 has the `fact` payload kind but no
   scenario-level pool; DW makes secrets a first-class authoring surface.
4. **`foreground`** on the front + the ≤3 cap — DW's anti-noise discipline, which
   D.5 stated as doctrine (§0) but did not encode as a schema limit.

### 1.7 Validator + tests-of-record

`server/campaign/scenarioSchema.js` (pure, wired into nothing): `validateScenario`
→ `{ok, errors}`, plus the frozen enums (`FRONT_KINDS`, `FRONT_TOPOLOGIES`,
`BEAT_PAYLOAD_KINDS`, `RESOLUTION_KINDS`, `SCENARIO_SUBSTRATE_VERSION`).
`tests/scenario-schema.test.js` pins the happy path (a full cyberpunk scenario),
the 3-front/1-foreground caps, the topology-conditional beat cap (incl. the 6-rung
gated-sequence tower passing and a broken total-order failing), observable/
committable/preventable, dual-advancement anti-starvation, referential integrity,
the secrets pool, and the UGC version lock — 24 tests, green.

---

## 2. Scenario 1 — `the_shipment` (CYBERPUNK, parallel, **build-first**)

The richest scenario, because it is the D.5 Phase 1 build-and-grade target. It
**promotes the existing arc**: the cyberpunk delivery + trial flavor already in
`authoredQuests.js:37,187` become authored fronts, and the toll-reeve danger
(D.5 §3.1.1, which the engine does *not* yet have) becomes the foreground front.
**Zero new world structure** — three quest predicates, three payload kinds, all
already proven; only the surface is pinned to the cyberpunk tone. Topology:
**parallel / complex** — three independent pressures running at once.

**Opening.** A fixer's booth in the night market; a sealed data-case on the table;
the objective from the courier contract. Tone: `cyberpunk`.

**Cast.** `npc_quest_giver` = **Vesa, a fixer** (`at: second_location`, offers
`offer_courier`). `npc_far_witness` = **a ripperdoc who patched the last courier
who didn't come back** (`at: third_location`).

**Front 1 — `front_courier` (opportunity, revealed, parallel).** The job.

| Rung | Trigger | Payload | Screw |
|---|---|---|---|
| 0 `beat_contract` | descriptive: quest accepted | `quest` (offer_courier → case → checkpoint-hazard check stage → deliver) | The run is live. |
| 1 `beat_drop_moves` | descriptive: `onQuestStage` deliver ≥1 · prescriptive: quiet ≥3 | `fact`: "The drop point shifted — the client is spooked." | The finish line moves. |

**Front 2 — `front_vault` (secret, rumored, linear 2-beat) — the trial + the
faction simmer merged.** The "one-try vault" is a corp's black-ICE site; probing
it is what makes the owning corp *notice you* (the city-faction simmer).

| Rung | Trigger | Payload | Screw |
|---|---|---|---|
| 0 `beat_vault_rumor` | prescriptive: minTurn 2 | `fact`: "Runners talk of a vault under the dead Arasaka substation — one jack-in, no second try." | A discovery, not a pre-existing chip. |
| 1 `beat_vault_open` | descriptive: `onPlayerAt: fourth_location` · prescriptive: requiresBeat rung 0 | `quest` (check-gated, losable netrun — the trial) | The one-try test, and the corp logs your jack-in. |

**Front 3 — `front_collector` (danger, HIDDEN, foreground, linear 4-beat) — the
villain-shaped pressure.** The toll-reeve reflavored: someone with pull on the
sector grid taxes the couriers.

| Rung | Trigger | Payload | Screw |
|---|---|---|---|
| 0 `beat_flagged` | descriptive: `onQuestStage` delivery accepted | `fact`: "The sector grid flagged the courier the moment the case changed hands." | The world noticed. |
| 1 `beat_cordon` | prescriptive: requiresBeat 0, ≥3 turns, case still held | `objectState`: `{key:"the-cordon", locationId:"third_location", state:"hardened", retryEffect:"harder"}` | Passage is mechanically harder. |
| 2 `beat_collector` | prescriptive: requiresBeat 1, ≥4 turns · **descriptive**: `onCanon:["refused the toll"]` | `hostileNpc` (`statBlockId: waylayer`) + demand beat | The agenda walks up and speaks. Refusal = D.4 combat entry. |
| 3 `beat_boss_named` | descriptive: rung 2 resolved either way | `fact` + `quest` (confrontation hook) | A nameable antagonist to pursue — or ignore, and `expiry`+consequence fact closes it. |

Delivering the case before rung 2 short-circuits to rung 3's naming beat (the
`quest:completed` resolution → the boss's *reaction* fact) — the front reacts to
the player winning.

**Secrets pool** (tweet-sized, each tied to a front):
- `secret_engram` → `front_collector`: *"The case isn't cargo. It's someone's engram backup — that's why the tax, and why the collector won't stop."* (reveal: `onEntityKnown: npc_far_witness`)
- `secret_vesa_cut` → `front_courier`: *"Vesa's cut is triple the going rate. She's not being generous — she's pricing in the funeral."* (reveal: `onCanon:["haggled","asked the pay"]`)
- `secret_neural_fuse` → `front_vault`: *"The substation 'lock' is a neural fuse, not ICE. 'One try' means one brain."* (reveal: `onLocation: fourth_location`)

This is buildable in D.5 Phase 1: three fronts, three payload kinds (`fact`,
`objectState`, `hostileNpc`, `quest`), all against primitives the engine has or
D.5 Phase 1 adds (`fact`/`hostileNpc` executor).

---

## 3. Scenario 2 — `isekai_tower` (LINEAR / **gated-sequence** — the stress test)

A modern protagonist pulled into a demon high-fantasy world; the only way up (and
maybe home) is the Tower. Its job is to **break** the schema if a vertical,
floor-gated escalation can't be expressed — and it did force the one addition (§5).
Topology: **gated-sequence** on the ascent front; **linear** and **rumored** on the
others.

**Opening.** A summoning circle's afterglow; a demon patron's offer you didn't ask
for; the Tower's first sealed stair. Tone: `high_fantasy` / `mythic` (existing
archetypes). `locations`: an ordered symbolic chain `floor_1_location …
floor_6_location`.

**Front 1 — `front_ascent` (consequence, foreground, GATED-SEQUENCE, 6 rungs).**
Each floor is a beat, gated on *reaching* that floor. Because it is a strict total
order, only one rung is ever live — so 6 > 4 is legal (§5).

| Rung | Trigger (both modes) | Payload | Per-floor pressure |
|---|---|---|---|
| 1 `beat_floor1` | descriptive: `onPlayerAt: floor_1_location` | `fact`: "The gate sealed behind you — there is no floor below the first." | No retreat (consequence). |
| 2 `beat_floor2` | descriptive: requiresBeat 1, `onPlayerAt: floor_2_location` · prescriptive: linger ≥4 → patrol | `objectState`: `{key:"the-warden-2", state:"roused"}` | A floor-warden stirs. |
| 3 `beat_floor3` | descriptive: requiresBeat 2, `onPlayerAt: floor_3_location` | `hostileNpc` (`statBlockId: ruin_creeper`) | A toll of blood to pass. |
| 4 `beat_floor4` | descriptive: requiresBeat 3, `onPlayerAt: floor_4_location` | `fact`: "The demon lord felt a stranger cross the fourth seal." | You are noticed from above. |
| 5 `beat_floor5` | descriptive: requiresBeat 4, `onPlayerAt: floor_5_location` | `quest` (a trial gate — losable) | The gauntlet floor. |
| 6 `beat_summit` | descriptive: requiresBeat 5, `onPlayerAt: floor_6_location` | `hostileNpc` (`statBlockId: hollow_husk`, the boss) | The summit and the way out. |

Floor-gating **is** descriptive advancement: the Tower only escalates because the
player climbs (never nags a player who lingers on floor 1), with a prescriptive
backup so lingering *on* a floor still bites. The gated-sequence total order means
the player faces exactly one floor's pressure at a time — no noise, despite 6 rungs.

**Front 2 — `front_patron` (rival, hidden, linear 3-beat).** The demon who
summoned you has a reason: your ascent trips seals that free *it*.

| Rung | Trigger | Payload | Screw |
|---|---|---|---|
| 0 `beat_patron_gift` | descriptive: quest_ascent accepted | `fact`: "Your patron's 'blessing' hums whenever a seal breaks." | A gift with a price. |
| 1 `beat_patron_slip` | descriptive: `onCanon:["broke a seal"]` · prescriptive: ≥6 turns | `fact`: "The patron is stronger since the last seal. So are you. Coincidence?" | The pattern shows. |
| 2 `beat_patron_turn` | prescriptive: requiresBeat 1, summit reached | `hostileNpc` (`statBlockId: waylayer`) or `quest` (the betrayal) | The patron collects. |

**Front 3 — `front_the_truth` (secret, rumored, linear 2-beat).** What the Tower is.

**Secrets pool:**
- `secret_tower_purpose` → `front_the_truth`: *"The Tower doesn't reach heaven. It reaches the summoning circle — the way out is also the way THEY get in."* (reveal: `onPlayerAt: floor_4_location`)
- `secret_patron_name` → `front_patron`: *"Your patron isn't a guide. It's the thing the seals were built to hold."* (reveal: `onEntityKnown: npc_quest_giver`)
- `secret_no_return` → `front_ascent`: *"No one descends the Tower. The stairs only go one way — by design, not by magic."* (reveal: `onLocation: floor_1_location`)

---

## 4. Scenario 3 — `bordermarch` (MEDIEVAL DND, parallel / regional baseline)

Traditional fantasy in a border hold: a rival, a regional danger, a local secret —
the "does the format hold the *native* genre without special-casing?" control.
Uses the shipped **`dark_fantasy` / `sword_sorcery`** tones as-is. Topology:
**parallel** (three regional simmers).

**Opening.** A rain-slick border hold; a reeve's plea; the barrow-line on the ridge.
Tone: `dark_fantasy`.

**Cast.** `npc_quest_giver` = the hold's **reeve** (`at: second_location`).
`npc_far_witness` = a **hedge-witch** on the barrow road (`at: third_location`).

**Front 1 — `front_rival` (rival, revealed, parallel 3-beat).** A rival free-company
after the same barrow-prize.

| Rung | Trigger | Payload | Screw |
|---|---|---|---|
| 0 `beat_rival_seen` | descriptive: `onPlayerAt: third_location` · prescriptive: minTurn 2 | `npc` (the rival captain) | Competition has a face. |
| 1 `beat_rival_ahead` | prescriptive: requiresBeat 0, quiet ≥3 · descriptive: `onCanon:["let the rival pass"]` | `objectState`: `{key:"the-barrow-door", state:"forced", retryEffect:"harder"}` | They got there first; the way is spoiled. |
| 2 `beat_rival_deal` | descriptive: requiresBeat 1 | `quest` (parley-or-fight hook) | Ally, rob, or bury them. |

**Front 2 — `front_barrow` (danger, foreground, linear 4-beat).** The barrow-thing
wakes.

| Rung | Trigger | Payload | Screw |
|---|---|---|---|
| 0 `beat_cold` | descriptive: `onPlayerAt: third_location` | `fact`: "The barrow-line runs cold in daylight now." | Something stirs. |
| 1 `beat_stock` | prescriptive: requiresBeat 0, quiet ≥3 · **descriptive**: `onCanon:["opened the barrow"]` | `objectState`: `{key:"the-barrow-mouth", state:"open", retryEffect:"none"}` | It has a door now. |
| 2 `beat_walker` | prescriptive: requiresBeat 1, ≥4 turns | `hostileNpc` (`statBlockId: hollow_husk`) | It walks. |
| 3 `beat_named` | descriptive: rung 2 resolved | `fact` + `quest` (the barrow-lord named) | A pursuable evil — or `expiry`+consequence if abandoned. |

**Front 3 — `front_reeve_secret` (secret, rumored, linear 2-beat).** The reeve's own
grievance (the prize is his bastard's inheritance).

**Secrets pool:**
- `secret_reeve_blood` → `front_reeve_secret`: *"The reeve doesn't want the barrow closed. He wants what's in it — it's his blood-right, and he'd rather you die owed than paid."* (reveal: `onEntityKnown: npc_quest_giver`)
- `secret_rival_debt` → `front_rival`: *"The free-company isn't here for coin. They're here to bury a name, same as you."* (reveal: `onCanon:["spoke with the rival"]`)
- `secret_barrow_bargain` → `front_barrow`: *"The thing in the barrow doesn't want out. It wants company — and it's patient."* (reveal: `onLocation: third_location`)

---

## 5. Genre-agnosticism report — does one schema hold all three?

**Yes — with exactly one schema addition, forced by the tower, reported loudly.**

### 5.1 The one material concession: `gated-sequence` topology (the tower)

**The problem.** DW caps a danger at 2–4 grim portents; the D.5 ladder inherits it
(`beatIndex`, ordered). A **floor-gated tower with 6 floors modeled as 6 beats
exceeds the cap.** Three ways out were considered:

- **(a) No schema change — act-level portents.** Model the ascent as one front with
  2–4 *act-level* portents ("the seal weakens", "the lord notices", "the summit
  opens") and floors as gated *quest/location content*. Faithful to DW, but it
  **drops the per-floor pressure** the genre wants — each floor stops being a
  front-beat.
- **(b) Multiple fronts.** One front per act. Burns the ≤3-front budget instantly
  and re-introduces noise. Rejected.
- **(c) `gated-sequence` topology (adopted).** Recognize that **the 2–4 cap is an
  anti-*noise* cap on *concurrent* pressure**, not a budget on total rungs. A
  strictly totally-ordered chain (each beat gates on its predecessor) surfaces
  **exactly one live rung at a time**, so it creates no noise even at 6+ rungs. The
  schema adds `topology: "gated-sequence"`, exempts it from the flat 2–4 limit, and
  the validator instead enforces the **total order** (every non-first beat gates on
  the immediately prior beat). The cap becomes "≤4 *concurrently-eligible* beats" —
  automatically satisfied by the total order.

This is the finding the tower's job was to surface, and it's a *clean generalization*,
not a hack: linear and parallel fronts keep the flat 2–4 cap; only a provably
one-active chain is exempt, and the validator proves it (`tests/scenario-schema.test.js`:
a 6-rung gated-sequence passes; a gated-sequence with a broken total order fails).

### 5.2 A secondary, non-schema finding: the world graph

A floor-gated tower needs the **world graph** to be a linear vertical chain of
locations (`floor_1 … floor_6`). The current `TONE_ARCHETYPES` generator
(`worldGen.js`) produces exploration graphs, not guaranteed linear chains. The
scenario schema expresses the tower via an ordered `locations` list that the loader
binds, but **whether worldgen can *produce* a vertical chain is a worldgen concern,
flagged for D.5/worldgen, not a scenario-schema gap.** The schema holds; the graph
generator may need a `linear`/`layered` layout mode when the isekai scenario is
actually built (post-validation).

### 5.3 Everywhere else: no per-genre special-casing

| Dimension | Cyberpunk | Isekai-tower | Medieval | Special-cased? |
|---|---|---|---|---|
| Front kinds used | opportunity / secret / danger | consequence / rival / secret | rival / danger / secret | No — same 5-kind enum |
| Topology | parallel | gated-sequence + linear | parallel + linear | No — same 3-value enum |
| Payload kinds | fact / objectState / hostileNpc / quest | fact / objectState / hostileNpc / quest | npc / fact / objectState / hostileNpc / quest | No — same 5 kinds |
| Dual advancement | descriptive on the danger | descriptive = floor-climb | descriptive on the barrow | No — same trigger model |
| Secrets | engram / cut / fuse | tower-purpose / patron / no-return | reeve-blood / rival-debt / barrow | No — same pool shape |
| statBlockId | `waylayer` | `ruin_creeper`/`hollow_husk` | `hollow_husk` | No — D.4 string contract |

Genre lives entirely in **flavor strings + the `tones`/`genre` metadata + which
`statBlockId`s the beats name.** The *structure* — fronts, ladders, triggers,
secrets, resolution — is identical across all three. The format is **not
medieval-shaped**; the medieval scenario is just one more instance, and the native
tone (dark-fantasy) gets no privileges the others lack.

**Verdict:** one schema, three genres, one honest addition (`gated-sequence`) and
one flagged downstream concern (worldgen linear layout). No rewrite risk.

---

## 6. Coherence — all three honor the D.5 sign-offs

| D.5 coherence rule | How all three scenarios honor it |
|---|---|
| Threads born only from server events (§6.3) | Every front is authored data loaded by the server; **no model output creates a front.** The validator is the only code path that admits a front. |
| Hidden fronts absent from the prompt (§4.1, sign-off #5) | `front_collector` (cyberpunk), `front_patron` (isekai), `front_barrow` rung 0 (medieval) are `hidden`; the loader/fold-in never puts a hidden front's agenda in the GM context — the player feels the effect (a cordon, a cold barrow), never the named plot. |
| Callbacks are server-selected canonical facts (§5.1, sign-off #8) | `callbackQuery` selects verbatim canonical fact text via `canon.js` predicates; no scenario asks the model to "recall" anything. Secrets write facts, so later beats call back through the same channel. |
| Declarative data only, no `build()` (sign-off #3) | Enforced structurally: a scenario is JSON; the validator rejects nothing executable because there is nowhere to put code. |
| `ground_lost` resolves by default (sign-off #7) | Every danger front carries a `ground_lost` resolution (kill the collector / the barrow-walker → the front resolves), and the validator forbids a danger resolving *solely* by expiry. |
| No LLM flavor-fill (sign-off #8) | Beat `brief`/`telegraph`/secret `text` are authored strings; the schema has no flavor-fill slot. |
| ≤1 narrative driver/turn, one clock (sign-off #2) | Scenarios author fronts; the D.5 scheduler (one momentum clock) still picks ≤1 driver/turn. The schema cannot smuggle a second clock — there is no per-front clock field beyond D.5's pacing. |

---

## 7. Scope

- **`the_shipment` (cyberpunk) is the D.5 Phase 1 build target**, grade-gated: it
  is authored here in full and is the scenario the fluff-verdict graded session
  measures. Its fronts use only primitives the engine has or D.5 Phase 1 adds
  (`fact`/`hostileNpc` executor, the loader).
- **`isekai_tower` and `bordermarch` are AUTHORED, not built** — proof-of-format
  only. Do **not** build their content (worldgen layouts, bestiary tiers, flavor
  packs) until the cyberpunk graded session validates the format. They exist in
  this doc to prove genre-agnosticism and to surface the `gated-sequence` finding
  *before* it could become a rewrite.
- **The only code shipped now** is the validator + tests. The loader, the
  `fact`/`hostileNpc` executor, `run.threads`, and the scheduler integration are
  D.5 Phase 1.

---

## 8. Sign-off points

1. **`gated-sequence` topology is adopted** — the 2–4 grim-portent cap is
   re-scoped as an anti-*concurrency* cap; a strictly one-active-rung chain is
   exempt, validator-enforced by a total-order check. (§5.1) *This is the one
   schema concession a genre forced.*
2. **The schema adds four declarable fields over D.5 §2.2** — `topology`,
   `trigger.descriptive` (required on pressure fronts), scenario-level `secrets`,
   and `foreground`+the ≤3 cap. All four encode DW constraints; none adds a
   code-only capability to scenario content (UGC line held, D.5 §8). (§1.6)
3. **`the_shipment` ships tone-locked to cyberpunk**, which **flips the default
   door's tone** from the current dark-fantasy default. Options: **(A)** the
   default door becomes cyberpunk (genre-agnosticism proven by the buildable one;
   every new player lands in the sprawl), or **(B)** `the_shipment` stays a
   tone-locked scenario the player *chooses*, and the dark-fantasy default door is
   a separate `bordermarch`-shaped scenario. Recommend **(A)** for the graded
   session (it's the sharpest agnosticism proof and the arc's cyberpunk flavor
   already exists), with the tone as one metadata field either way. (§0, §2)
4. **Descriptive advancement is mandatory on pressure fronts** — the validator
   rejects a danger/rival/consequence front that can only advance on the clock.
   This is the concrete resolution of the D.5 §8 starvation risk; confirm it's the
   intended hard rule, not a warning. (§1.2)
5. **Secondary finding accepted as downstream:** the isekai tower needs a worldgen
   *linear/layered layout mode* to produce its floor chain; that's a worldgen task
   for when the isekai scenario is built, not a scenario-schema gap. (§5.2)

*The one code artifact — `server/campaign/scenarioSchema.js` + its 24 green
tests-of-record — is committed local. No gameplay code, no loader, no push.*
