# walk-3 COHERENCE F- FORENSICS (run_eea2d9e4)

Verdicts written BEFORE any fix. Every claim carries a transcript or code receipt.
Transcript: `data/logs/gm-transcripts/run_eea2d9e4-7959-4030-b347-808c08318f45.jsonl`
Run state: `campaigns` row `run_eea2d9e4-7959-4030-b347-808c08318f45`.

---

## V1 — THE FENN INCIDENT

### (a) What "Face The Limping Grey." parsed to

**A generic INT skill check vs DC 12. No combat intent at all.**

Transcript receipt (turn 3 user prompt, verbatim):
> `In the current scene, the player attempts: "Face The Limping Grey.". The attempt FAILS and the situation CHANGES (rolled 4 vs DC 12), The Limping Grey's agitation causes you to become frightened.`

Code receipt: the ordered branch list in `server/solo/actions.js:1068-1259` ends at
`resolveAttemptAction` (`actions.js:1259-1260`). The attack branch (`actions.js:1230`)
never fired because `detectAttackIntent` returned null — `ATTACK_ENTRY_RE`
(`server/solo/combat.js:59-61`) contains `attack|strike|fight|charge|…` but **not**
`face`, `engage`, `confront`, `challenge`, `duel`, `assault`.

Executed against the real module:
```
"Face The Limping Grey."  -> null
"Attack the wolf"         -> {"targetNpcId":"npc_grey"}
"confront the grey"       -> null
```
DC 12 is `classifyIntentDc`'s default (`attempt.js:144-153`); INT is
`abilityFromIntent`'s default (`attempt.js:180`). Neither regex contains "face".

### (b) Is the Grey registered hostile in THIS run — YES

```
npc_limping_grey: hostile=true, statBlockId="limping_grey",
tags=["hostile","wildlife","wolf","chaosling","corrupted"]
```
Registration was never the problem. (Note the prompt still injected
`The Limping Grey: standing neutral` — reputation standing is not wired to the
hostile flag.)

### (c) Where Fenn came from — THE ANTI-INVENTION AUDITOR INVENTED HIM

Not scene-cast injection of an authored NPC. Not raw narrator invention.
**The narrator correctly described the committed wolf, and the invented-agent
auditor committed that description as a NEW PERSON.**

1. Turn 2 narration (receipt): `"A grey shape shifts at the base of a gnarled oak…
   **It is a wolf**, one hind leg held off the ground."` — a correct description of
   the committed Limping Grey.
2. `detectInventedAgents` matched the noun **"wolf"** (in the agent-noun allowlist,
   `server/solo/npcCommit.js:543`). It was not vouched by `knownAgentTokens` because
   the committed display name is "The Limping Grey" — the token "wolf" appears
   nowhere in it.
3. `auditAndCommitInventedAgents` (`npcCommit.js:609`) therefore committed a brand-new
   cast member at `npcCommit.js:625`:
   `commitNarratedNpc(run, { displayName, role: "figure", tags: ["unnamed"] })`
   → id `npc_wolf_25acb38c`, **`tags:["unnamed"]`, no `statBlockId`**. The mint
   discards the very noun it matched on.
4. Naming gate (`server/solo/scene.js:518`) asks only "has a `generatedName`?" — no
   species check. Identity minting assigned **"Fenn"** from the fallback pool
   (`npcIdentity.js:23-26,409`), `he/him` via `genderHintFromName` (`npcIdentity.js:132`),
   a **"learned, precise" voice** (`npcIdentity.js:448`) and the mannerism
   **"folds their arms and then thinks better of it"** (`npcIdentity.js:180`).
   A wolf has no arms to fold.
5. Prompt injection (`server/index.js:1237-1248`, `npcIdentity.js:324`) then faithfully
   broadcast the corrupted record. **The presence filter is CORRECT** —
   `npc.currentLocationId === run.currentLocationId && npc.status !== "gone"`, repeated
   in all four builders (`index.js:946,1002,1033`, `npcIdentity.js:324`). Fenn really
   was co-located. The bug is upstream: *what Fenn is*, not *whether he was filtered*.

**Second-order damage — the phantom disarmed the auditor for the real wolf.**
`entityNature({tags:["unnamed"]})` falls through to `kind="human"`
(`entityNature.js:26-34`), so `natureAudit.animalContext` bails at
`natureAudit.js:27-29` (`humansOrAmbiguous.length → return null`) and stops scrubbing
human descriptors off **the actual Limping Grey**. That is why the wolf then *speaks*
("its rough voice… 'You should not have tried that.'") and is called *he* who "had
business at Elkwater Crossing". The phantom granted the real animal immunity.

No species gate exists at any step:
`grep -rn "entityNature|statBlockId" server/solo/npcIdentity.js server/solo/npcCommit.js` → no output.

### (d) Why combat did not fire

**Player-initiated combat entry IS wired** — `actions.js:1230-1236` →
`enterCombatFromAttackIntent` (`combat.js:254`, the only writer of `run.combat` at
`combat.js:308`). "Attack the wolf" enters the CTB engine correctly.

**The failure is self-inflicted.** The server generates the hostile chip itself at
`server/solo/affordances.js:126-129`:
```js
const hostile = npc.flags?.hostile === true;
subjectKind = hostile ? "face" : "approach";
intent = `${hostile ? "Face" : "Approach"} ${name}.`;
```
The only combat-flavored button the UI offers for a hostile emits exactly the one
string the detector does not match. **The game handed him the combat button and that
button was guaranteed not to open the combat door.**

Both adjacent doors were also closed in production:
- Enemy-initiated (C1): `tactics.js:51-55` tests `behaviors.aggressive` / `stalker` /
  `run.flags.provoked`. **Zero shipped stat blocks carry `aggressive` or `stalker`**
  (17 blocks audited in `bestiary.js`), and `commitProvoke` is never called in
  production. The C1 door can never fire for any shipped creature.
- C5 disparity ("contested range always enters the engine"): `disparity.js`
  `mustEnterEngine`/`disparityVerdict` have **zero production callers** — asserted by
  `combat-door.test.js` only.

---

## V2 — VOICE STILL NARRATED

**Verdict: the authored-opening path never touches the VN cast surface. Only the live
path does. W1 shipped a look-alike, and the look-alike is dead three ways over.**

- The opening renders through `renderSoloSceneOpening`
  (`src/components/soloSceneShell.js:392-426`) into **ZONE 2, the scrollable narration
  log** (`soloSceneShell.js:3411-3413`) as `<section role="note">` + `<p>` prose. The
  only "VN-ness" is a class name `solo-opening-vn` and the string "The VOICE speaks".
- The real VN surface is `renderSoloDialogueOverlay`
  (`soloSceneShell.js:3025-3028`) in **ZONE 1, the pinned stage**, gated on
  `state.dialogueActive && state.talkResult`, driven by `scene.vnMode` ← `run.vn`
  (`server/solo/scene.js:1391,1418-1419`).
- **The missing line:** `server/campaign/onboarding.js:1144-1153` sets
  `run.openingBeats` and `run.openingSpeakerId` but **never sets `run.vn`**. So
  `vnMode` is false and the VN surface cannot open for the opening.
- **Portrait key bug:** `scene.js:1448` reads `run.imageAssets[\`img_${sid}\`]`, but
  assets are minted as `img_${npcId}_base` (`repository.js:1180-1183`; the cast roster
  reads them correctly at `scene.js:666`). `portraitUri` is therefore **always null**
  and the avatar branch at `soloSceneShell.js:411` never fires.
- `npc_voice` has **no `locationRef`** in `babel.json:689-701`, so no portrait job is
  ever enqueued for her.
- **No CSS exists** for any W1 class (`solo-opening-vn`, `solo-opening-speaker`,
  `solo-opening-beat`, `solo-opening-paced`) — zero hits in `src/styles.css`.
- **Why it stayed green:** `tests/voice-cast-member.test.js:33` hand-constructs a
  speaker object with a fabricated `portraitUri` the server can never produce, and
  asserts a CLASS-NAME STRING. It never exercises onboarding → scene payload → render.

---

## V3 — WOLF-FEET SCENE

**Verdict: the composition slots AND the F5 subject injection BOTH rode. The law's
vocabulary loses to the checkpoint — and the law's own words instruct the failure.**

Exact prompt his run sent (sidecar
`live_run_eea2d9e4…_loc_loc_waking_mile`, workflow `scene-anime.json`):
```
(a single wounded grey wolf:1.4), the clear midground subject, a four-legged grey wolf
on all fours standing low on the ground beneath a tree, watchful, unmistakably a wild
animal, violet-glowing eyes, thin violet corruption markings, The Waking Mile, …,
wide establishing shot, no people, anime background art, …, eye-level shot,
ground level view, standing on the ground, foreground detail anchoring the lower third,
A CLEAR SUBJECT in the midground, sky only in the upper third, landscape orientation,
environmental scene, natural depth, a path leading into the scene
```

So no door was skipped. The defect is vocabulary:
- `LOCATION_COMPOSITION` (`imageWorker.js:256-259`) contains **"ground level view"** and
  **"standing on the ground"**. "Ground level view" literally specifies a camera at
  ground level — that IS the wolf-feet shot.
- The F5 subject (`imageWorker.js:1554`) adds **"standing low on the ground"**.
- The subject is **weighted `:1.4` and front-loaded**; every composition token is
  **unweighted and at the tail**, where it has least influence.

Three phrases command a low camera and nothing commands DISTANCE. Kitchen treatment:
state framing positively with distance, weight it, and delete the low-camera words.

### 2-proof result (his location, the Grey present)

Prompt after the fix (reproducible by composing `sceneHostileSubject(run, locId)` +
`artStyleDirection(style,"location")` exactly as `runLocationImageJob` does):
```
(a single wounded grey wolf:1.4), only one grey wolf, the clear midground subject,
a four-legged grey wolf standing under a tree several paces away, seen in full from head
to paws, watchful, unmistakably a wild animal, violet-glowing eyes, thin violet corruption
markings, The Waking Mile, …, (a wide establishing shot of the whole location:1.25),
the subject seen in full at a natural distance in the midground, eye-level camera at
standing height, horizon near the middle, the ground receding into distance,
sky only in the upper third, landscape orientation, environmental scene, natural depth
```
Images: `data/assets/proof-v3/v3_waking_mile_grey_seed{4242,9137}.png`.

**Result:** the paw close-up is dead in both — whole animal head-to-paws, eye-level,
midground, ground-anchored, single subject, environment fully rendered.

**A first pass over-corrected** and is worth recording: stacking THREE weighted framing
clauses (1.3 + 1.2 + a 1.2 on the subject) on top of the 1.4 subject killed the close-up
but STARVED THE ENVIRONMENT — the location collapsed to blank beige texture and a second
wolf appeared. The shipped balance is ONE weighted clause, and it weights the LOCATION
(the thing that was losing), not the subject (already at 1.4).

**Residual, honestly flagged (not fixed here):** the corruption glow renders CYAN, not
the committed VIOLET of the chaos palette law. And seed 4242 grew a modern CAMERA at the
tree base — a world whose tone is literally "modern arcane" pulls modern props; small
modern objects were added to `SCENE_FRAMING_NEGATIVE`, but that fix is unproven by a
further cook.

**Guard note:** the throwaway proof script imported `generateImage` directly and
`tests/art-path-wall.test.js` FAILED THE SUITE for it — the choke-point wall working
exactly as designed. The script was deleted rather than allowlisted; this prompt block
is the reproducible record.

---

## V4 — REDO AVOID-BOX IMPOTENCE

### (a) Do preference slots ride the REDO path — YES

Redo is not a separate endpoint: `redoDraftPortrait` (`src/main.js:1173-1183`) bumps a
nonce and re-enters the same request, whose body includes `appearance`/`avoid`
(`src/main.js:1139-1140`). Wiring was **not** the redo failure.

Two other routes DO drop them:
| Route | appearance | avoid | proof |
|---|---|---|---|
| draft generate | YES | YES | main.js:1139 → index.js:3374 → imageWorker.js:1853 → comfyui.js:732 |
| **redo** | **YES** | **YES** | main.js:1173-1183 |
| `/edit` refine | **DROPPED** | **DROPPED** | client.js:385-389, index.js:3412-3419 |
| live player job | **DROPPED** | **DROPPED** | imageWorker.js:1240 |

### (b) Are avoid phrases translated — NO. This is the actual cause.

`server/solo/portraitPreferences.js:52-61` is a bare split/trim/join:
```js
const avoidTerms = sanitizeSlot(avoid).split(",").map(s=>s.trim()).filter(Boolean)
  .filter((term) => !AVOID_SAFETY_DENY.test(term));
outNegative = negative ? `${negative}, ${avoidTerms.join(", ")}` : avoidTerms.join(", ");
```
`sanitizeSlot` only strips punctuation. There is **zero** normalization.

He typed `cut-off shoulders, floating, no arms`. CLIP has no negation operator, so
**"no arms" appended to a NEGATIVE prompt embeds the *arms* concept and steers away
from arms → armless.** "cut-off shoulders" pushes *shoulders* out of frame. He phrased
the defects as prohibitions; the pipeline negated the prohibition and produced exactly
the defects. Only "floating" worked — it was already phrased as the defect.

The team already knew this failure mode for positive-only providers
(`portraitPreferences.js:10-12`, the elf-ears lesson) but never handled the symmetric
case: a negated phrase typed into a field that is itself a negation.

Two aggravating hazards:
- The client dedupe key (`main.js:1102`) and the server draft id (`imageWorker.js:896`)
  both **omit the pref boxes** → editing avoid alone never regenerates, and two
  different avoid strings collide on one `draftId` and re-serve the cached image.
- **No test ever exercised a negated avoid phrase or the redo route.** Every avoid
  fixture in both preference tests is a bare noun (`glasses`, `hat`, `shirt`) —
  precisely the shape that happens to work.

---

## V5 — PATTERN AUTOPSY

In all four, a real door was built and the player walked through a different one.
**V1:** combat entry was built for typed `attack/strike/charge`; he walked through the
chip the server itself generates, `Face X`, which the detector does not match — the
built door and the offered door were never checked against each other.
**V2:** VN-as-cast was built on the live-turn path (`run.vn` → stage overlay); he walked
the authored-opening path, which renders in a different DOM zone and never sets
`run.vn`.
**V3:** the composition law was written for the prompt *builder*; he walked the
*checkpoint*, where an unweighted tail loses to a 1.4-weighted head and three of the
law's own phrases command a low camera.
**V4:** preference slots were built for the generate route with bare-noun fixtures; he
walked the redo route with negated phrases, and the transform that would make them
work was never written.
Every one is a ROUTE gap, not a logic gap — and every one had a green test, because each
test exercised the built door rather than enumerating the doors a player can reach.

### THE ROUTE-INVENTORY LAW (inspector charter extension)

A feature is not "shipped" when one route works. Reachability checks MUST enumerate
every PLAYER-FACING ROUTE and assert the feature on each:
- **opening path vs live path** (authored zero-LLM beats vs GM turns)
- **chip vs typed** (server-generated affordance strings vs free text)
- **draft vs redo vs refine vs committed/live** (every regeneration route)
- **each art lane** (anime / illustrated / cinematic)

Corollary — **generator/detector pairing:** when the server GENERATES the strings a
player can submit (affordance chips), a test must assert every generated string is
matched by the detector that is supposed to consume it. A chip whose own intent string
its detector rejects is the V1 bug class, mechanically preventable.
