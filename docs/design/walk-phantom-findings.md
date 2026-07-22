# Walk findings #2, #3, #6 — the phantom/premise/entry pass (CLI-2, 2026-07-21)

Source of truth: the coherence pre-walk report at 7017748. One commit per finding.

---

## Finding #2 — PHANTOM HOSTILE (HIGH, the moat leak) — FIXED

**Root cause (verified, not assumed).** `actions.js resolveSoloAction` runs a chain of
present-target detectors — take → move → search → observe → **attack** — each binding
ONLY committed entities. `detectAttackIntent` (combat.js) returns null when no present
hostile matches; the intent then falls through ALL detectors to `resolveAttemptAction`
(free narration), which manufactures whatever the text names. Not an attack bug — the
whole target-directed verb CLASS shares the fall-through.

### 1.3 — the verb inventory (enumerate before patching)

| Verb | Absent target fell through to free narration? | Now |
|---|---|---|
| attack / strike / kill / engage / face | **YES — the reported bug** | refused if agent-like target & no hostile present (feature target still swings) |
| talk to / speak to / greet | YES | refused when no one present |
| follow / shadow / tail / chase | YES | refused when no one present; **PATH objects excluded** ("follow the trail") |
| steal from / pickpocket / rob | YES | refused when no one present; **CONTAINER objects excluded** ("steal from the chest") |
| give … to / hand … to / offer … to | YES | refused when no recipient present |
| flee from / run from | YES | refused when no threat present |
| ambush / sneak up on | YES | refused when no target present |
| seek / find / look for / search for | YES — but **INTENTIONALLY LEFT** | you may search for the absent; `detectSearchIntent` owns it (honest, non-manufacturing) |

Gate: `detectAbsentTargetRefusal` (server/solo/absentTarget.js), wired before the
free-narration fall-through. Diegetic refusal, no state (no npc/combat/hp/clock), no
stranding (availableActions ride).

### 1.4 — the auditor gap (assessed honestly)

The existing narration-side auditor (`detectPhantomNpcNames`, npcCommit.js) matches
PROPER-NAME actors ("Goran says…") and structurally CANNOT catch an UNNAMED invented
agent ("the wolf lunges"). **This fix does not close that auditor gap — it SIDESTEPS it
for the intent-driven case** by refusing at intent time, upstream of narration, so the
unnamed agent is never seeded. It does NOT catch a GM that spontaneously invents an
unnamed creature the player never named (e.g. a scene-setting "a wolf watches from the
trees" with no committed wolf). Closing THAT would need a narration-side common-noun
creature auditor cross-checked against committed npcs + world fauna — a separate pass,
not claimed here.

### Pre-mortem
- **(a) too aggressive — refuses a present target under an alias.** Ruled out with
  evidence: the gate fires only when no committed agent of the relevant kind is present;
  a present hostile, a name-token match, or a generic reference with any NPC present all
  DEFER. Test `PRE-MORTEM (a)` asserts a present hostile is never refused, and a token
  alias ("the warden" → "Warden Cole") is never refused.
- **(b) a verb slipped.** Ruled out by the 1.3 table + a per-verb regression test. The
  honest residual: the ATTACK arm's "is this an agent?" signal (world fauna + a bounded
  noun set + proper names) can miss an EXOTIC creature word outside all three; the
  AGENT-DIRECTED verbs have no such gap (verb implies agent).

### Route-inventory
Serves the **typed free-text door** (campaign + sandbox). The **chip door** is grounded
by construction — affordance chips are generated only from committed entities, so a chip
never names a phantom.

---

## Finding #3 — FALSE-CANON PREMISE (MEDIUM) — FIXED

**Root cause (verified).** The stateless authority gate's Class C
(`npc_relationship_fiat`, attempt.js) catches THIRD-person fiat via `PROMISE_FIAT_RE`
(`the X | he | she | they … promised/owes … me`) — but NOT the SECOND person. A player
addressing an NPC says "YOU promised me / you owe me", which slips Class C and is graded.

**Fix.** A STATE-AWARE pre-roll gate beside the possession check:
`resolveFalsePremiseClaim` refuses a second-person prior-commitment claim UNLESS a
committed fact backs it (a promise/deal/debt memoryFact or timeline beat). Diegetic, no
roll, no state.

### 2.2 — approach and its limits (not a keyword blacklist)
The REFUSAL is **state-gated**, not a phrase list: a committed prior event makes the
same words legitimate (the 2.3 distinction, tested both directions). Honest limits:
1. **Detection** is a bounded second-person pattern set — a premise phrased outside it is
   a false NEGATIVE (slips), never a false refusal.
2. **Backing** is CATEGORY-level, not claim-specific — if the run holds ANY committed
   promise/deal/debt, a DIFFERENT fabricated one is not caught. Lenient BY DESIGN, to
   protect 2.3 (a real reference must never be refused). The robust claim-specific
   version (bind the asserted premise to a specific committed fact/NPC) is out of scope
   for this pass.

### Pre-mortem (c) — fires on legitimate references
Ruled out by state-gating + the 2.3 test: a committed backing fact defers the gate.
Residual risk: a real promise made in dialogue that never became a memoryFact/timeline
beat would be refused; mitigated by scanning BOTH memoryFacts and timeline, and by the
lenient category-level match.

### Lifecycle (both #2 and #3 refusals)
The turn is NOT consumed as a fake success: no roll, no clock tick, no substantive
state. #2 records nothing on the run (read-only refusal); #3 records the transcript beat
that the claim was made and did not land (in-transcript, like the unpossessed-item
refusal). Both return `availableMoves`/`availableActions`, so the player is never
dead-ended — they can act again immediately.

---

## Finding #6 — INTERMITTENT COMBAT-ENTRY MISS (LOW) — NOT REPRODUCED + nature leak FIXED

### 3.1–3.3 — the entry miss: NOT REPRODUCED
Combat entry is **deterministic pre-model binding**: `detectAttackIntent` (combat.js)
runs BEFORE any model call. There is NO model in the entry decision, so a same-phrasing
"1 in 6" is not possible in this code.

**Attempts:** all 6 walked phrasings, at `loc_waking_mile` with the Limping Grey
committed — `draw my weapon and attack the limping grey` (the one the walk saw miss),
`attack the limping grey`, `strike the limping grey`, `I attack the grey`, `swing at the
limping grey`, `kill the limping grey`. **Every one HITS `detectAttackIntent` AND
`enterCombatFromAttackIntent` returns ok AND `resolveSoloAction` sets
`enteredCombatViaIntent`.** Deterministic, 100%.

**Most probable original cause:** a pre-walk-3 tip. `ATTACK_ENTRY_RE` (combat.js:60-67)
documents that walk-3 ADDED the engagement verbs and the `draw .*weapon` clause for the
SAME incident (`run_eea2d9e4`); before that, "draw my weapon and attack" missed. At
7017748 it is covered. Per 3.3 this is NOT closed on non-recurrence — instead the six
phrasings are LOCKED by `tests/combat-entry-nature.test.js` so a future narrowing of the
entry regex turns the net RED.

**3.2 answer:** the miss, if any, is NOT model-interpretation — the fix (deterministic
pre-model binding) is ALREADY the architecture. No prompt change is warranted.

### 3.4 — the SEPARATE "fist/club" nature leak: TRACED + FIXED
Does the nature constraint reach the free-text narrator? **Yes, via the post-narration
scrubber** `scrubNatureContradiction` (natureAudit.js), applied to ALL `gmNarration`
(index.js:2469 — includes the free-text attempt path). Trace result:
- **"fist" was ALREADY covered** (`HUMAN_HANDS_RE` → forepaw/claw).
- **"club" (a MANUFACTURED WEAPON wielded by the beast) was NOT** — no pattern covered
  tools/weapons. **This is the leak that reached the owner.** Now closed:
  `BEAST_WEAPON_POSS_RE` / `BEAST_WEAPON_WIELD_RE` scrub a possessive ("its club") or an
  explicitly-wielded ("swings a club") weapon → "its claws". The player's own weapon
  ("your sword") and a scene-object weapon ("an axe lies in the mud") are NOT touched.
- **Known limitation (reported, not fixed):** the scrubber is gated to ANIMAL-ONLY scenes
  (`animalContext` returns null if any human NPC is present) because it de-humanizes
  pronouns, which is unsafe with a real human in the scene. In a MIXED human+animal
  scene, a nature violation on the animal is not scrubbed. Closing that safely needs
  subject-scoped scrubbing (bind each descriptor to its entity) — a separate pass.
