# Art Pipeline v2 — Four Waiters + One Tailor

> **Status:** groundwork landed (plumbing only, zero generation). The consistency
> engine ("tailor") is **design-logged, NOT built** — gated on the owner's tuned
> per-lane workflows and the IP-Adapter wake-up.
>
> This document is the **anti-sync-loss anchor** for the strategy: it lives in the
> repo so the plan survives context resets and machine hops.

## Owner strategy (canon)

**FOUR specialized generation lanes ("waiters")**, each with its own tuned
workflow per style, plus a **consistency engine ("tailor")** that stitches them
into one persistent visual identity per character.

| Waiter | Produces | Notes |
|---|---|---|
| **portrait** | faces (VN / status framing) | the bust; identity anchor |
| **fullbody** | VN body sprites | tall, standing poses |
| **scene** | locations / environments | see the composition acceptance bar below |
| **item** | weapons / armor / materials / clothing / decor | object on a clean background, so items read as icons and composite later |

`world-card` (the wide world-select cover) is kept as-is and **rides the scene
lane** for routing.

### scene waiter — KNOWN DEFECT (owner verdict) → acceptance bar

Current scene output is **over-zoomed, ignores its frame, has no floor/ground
plane**. The scene workflow needs **composition control**, not just style tuning:

- **wide establishing shots**, full-scene framing;
- a visible **ground/floor plane** and horizon — the scene is a space the action
  sits *inside*, not a zoomed-in texture;
- respects the wide aspect (1344×768) as a real frame, not a crop.

A scene export is **not accepted** until it clears this bar. Style tuning alone
does not close the defect.

### TAILOR (design-logged, NOT built this round)

The tailor stitches the four lanes into one persistent identity per character:

1. **portrait face == fullbody face** — IP-Adapter identity-reference (the dormant
   seam; see `identityRef` + the recipe `identity` block below).
2. **equipped items visible in fullbody** — committed inventory → prompt fragments
   folded into the fullbody generation.
3. **clothing changes re-render** — a wardrobe change invalidates and regenerates
   the affected sprite.

**Gating:** the tailor is built only once the owner ships tuned per-lane workflows
AND the IP-Adapter nodes are wired (the "wake-up"). Until then the seams below
carry data but drive no generation.

## What landed this round (plumbing only)

### 1. Kind vocabulary (2 → 4, + world-card)

`ASSET_KINDS = ["world-card", "scene", "portrait", "fullbody", "item"]`.
Face-checkout (`FACE_KINDS`) now applies to **both `portrait` and `fullbody`** —
the bust and the sprite share one identity, so both check out to an NPC.

Migration (`scripts/art/migrate-kinds.mjs`, one-shot, idempotent):
`npc-body → fullbody`, `npc-portrait → portrait`. Every sidecar is rewritten
through `buildSidecar` so all assets gain the new `identityRef: null` field;
all other fields are preserved. `decor` folds into `item`.

### 2. Routing ladder — `resolveRecipeFile(style, kind)`

For each `(style, kind)`, the ladder is walked in order, first hit wins:

1. **per-kind LANE file** — `<lane>-<styleSlug>.json`
2. **legacy FAMILY file** — `<legacy>-<styleSlug>.json`
   (portrait/fullbody/item → `entity-*`; scene/world-card → `scene-*`)
3. **per-STYLE file** — `<style>.json`
4. **null** (loadRecipe throws)

`styleSlug` collapses the hyphen (`dark-fantasy` → `darkfantasy`) for lane/family
files; the per-style fallback keeps the hyphen (`dark-fantasy.json`). Scene's lane
and legacy family are both `scene`, so its steps 1 & 2 collapse to one entry.

### Filename convention — what the owner exports per lane

Drop tuned ComfyUI API-format exports into `scripts/art/workflows/`:

```
portrait-anime.json      portrait-darkfantasy.json
fullbody-anime.json      fullbody-darkfantasy.json
scene-anime.json         scene-darkfantasy.json
item-anime.json          item-darkfantasy.json
```

Rule: `<lane>-<styleSlug>.json`, `styleSlug` = style with the hyphen removed
(`anime`, `darkfantasy`). Fallback ladder rungs (optional, coarser):
`entity-<slug>.json` (shared face/item recipe) and `<style>.json`
(`anime.json`, `dark-fantasy.json`) — both remain as automatic fallbacks, so
lanes can be filled in one at a time.

Override the workflow directory for testing with `NOTDND_ART_WORKFLOW_DIR`.

### 3. Tailor data seams (data only — zero generation code)

- **Sidecar `identityRef: null | <assetId>`** — a fullbody generated from a
  portrait reference records which one. `linkIdentity(childId, refId)` sets it
  (both assets must exist).
- **Recipe `identity: { refImage, weight }`** (optional) — the IP-Adapter socket.
  Routing passes it through untouched; `buildGraph` ignores it this round, and a
  workflow that lacks the IP-Adapter nodes simply never reads it. No graph-building
  for it yet.

### 4. Per-kind dimension defaults (`KIND_DIMENSIONS`, one table)

| kind | default [w,h] | shape |
|---|---|---|
| portrait | `1024 × 1024` | square-ish (VN/status face framing) |
| fullbody | `832 × 1216` | tall standing sprite |
| scene | `1344 × 768` | wide establishing shot |
| world-card | `1344 × 768` | wide cover |
| item | `1024 × 1024` | square, clean background (icon-composable) |

Overridable per recipe file via its own `dimensions` map (recipe wins, then the
table, then recipe `default`, then the global `1024²`).

## Dry-run

`node scripts/art/proof-batch.mjs --plan` prints the **assembled positive+negative
prompt** per curated spec AND one exemplar per lane per style (10 plans), plus the
resolved recipe file + dims — without touching ComfyUI (port 8188). The owner
reviews the prompts as text before any batch spends GPU time.

---

# Prompt Contract (templated generation)

> Landed after four-waiter-routing. **Prompts are never freehand sentences.**
> Every generation is assembled from a versioned TEMPLATE with named SLOTS filled
> from committed state or explicit parameters. This is the image pipeline's style
> contract — the enforcement point for the discipline the 14/14 toss batch failed
> (duplicate heads, void floors, framing).

## Rationale

Freehand prompt strings drift: each caller re-improvises framing, quality tags,
and negatives, and a bad image is an opaque sentence with no audit trail. The
contract replaces them with **template + blocks + slots**, so framing/quality/
negatives are fixed once per lane/model and a tossed image points at a specific
slot or template version.

## File layout

```
scripts/art/prompts/
  <lane>.json              portrait | fullbody | scene | item | worldcard
  blocks/<styleSlug>.json  anime | darkfantasy   (per-model tuned vocabulary)
```

**Template** (`<lane>.json`) — `templateVersion`, `lane`, ordered `positive` and
`negative` segment lists, and documented `laneRules`. Each segment is one of:

- `{ "literal": "..." }` — a fixed invariant (lane rules baked as text);
- `{ "block": "<name>" }` — resolved against the active style's block file
  (`quality` | `styleVocab` | `negativeBase`);
- `{ "slot": "<name>", "required": bool, "default"?: "..." }` — a named hole.

**Block** (`blocks/<styleSlug>.json`) — `blockVersion` + the three OWNER-OWNED
vocab strings (`quality`, `styleVocab`, `negativeBase`). Shipped as honest
PLACEHOLDERS (seeded from the legacy recipes) with a `_TODO` marker.

## Assembly — `buildPrompt(lane, style, slotValues, context)`

Returns `{ positive, negative, meta }`. Rules:

- a **required** slot with no value **throws** (never generate underspecified);
- slot values are **plain words** — any prompt-weight / embedding punctuation
  (`()`, `[]`, `<>`, `:digit`) is **rejected**; structure lives in templates only;
- **deterministic**: identical inputs assemble byte-for-byte identically;
- `meta = { templateVersion, blockVersions, slotValues, … }` is written into the
  sidecar alongside `promptUsed`, so a tossed image is auditable to a slot/template.

Callers map **committed state** into slots — never hand-write prose:
`mapNpcToSlots(npc)` (gender ← committed gender/pronouns; hair/build/attire ←
appearance parse-or-passthrough; poseHint ← mannerism) and
`mapLocationToSlots(location)` (timeOfDay ← committed clock phase).

## CANON LAW — diegetic vs promotional

**Diegetic art obeys world geography.** A starter-zone scene renders what a person
standing there would actually see — and in Babel that **never includes the Tower**.
The assembler injects `tower` into the **negative** for any scene whose context
tags include `starter` or `distant-from-tower`.

**The world-card is exempt.** Cover art is *promotional* — it obeys the promise of
the world, not the viewpoint of a person in the starter zone. The Tower is
allowed/encouraged on the cover via the worldcard `horizon` slot (canonical
literal: `"distant impossible tower on the horizon"`). Posters get the Tower;
in-world scenes do not.

## Owner workflow

**Tune blocks in ComfyUI → paste into `blocks/<style>.json` → every future
generation inherits it** — no code change. The three block strings per style are
the only owner-owned surface; templates + assembly are fixed contract.

### Block placeholders awaiting the owner's workbench values

Both `blocks/anime.json` and `blocks/darkfantasy.json` ship placeholder
`quality` / `styleVocab` / `negativeBase` (seeded from the legacy per-style
recipes) marked with `_TODO`. Replace each with the workbench-tuned value and bump
`blockVersion`; the template literals + lane invariants stay put.

---

# Realistic lane + The Butler + Style Lock Law

## Style vocabulary (canonical)

The player-facing, run-locked, butler-resolved style set is **`anime` |
`dark-fantasy` | `realistic`** (= the library / block / workflow vocab).
`realistic` is first-class as of this round: it shares the **Juggernaut** cookbook
with `dark-fantasy` (same checkpoint) and diverges only in its `styleVocab` block
(`blocks/realistic.json`, `_TODO` for the owner's Juggernaut Chunk-1 findings). A
per-style `workflows/realistic.json` exists so `<lane>-realistic.json` routes via
the normal ladder.

### The mapping table (engine ↔ canonical), verbatim

The legacy **engine** vocab (`illustrated | anime | cinematic`) still drives the
live path (`artStyleDirection`, `ai/comfyui` `STYLE_PRESETS`). The single table in
`server/solo/artStyle.js`:

| engine | → canonical | canonical | → engine | cookbook |
|---|---|---|---|---|
| illustrated | `dark-fantasy` | anime | `anime` | Illustrious |
| anime | `anime` | dark-fantasy | `illustrated` | Juggernaut |
| cinematic | `realistic` | realistic | `cinematic` | Juggernaut |

`cinematic → realistic` is the **changed** row this round (was `dark-fantasy`):
`cinematic` is realistic's nearest engine key now that realistic is first-class.

## The Butler — `styleForRun(run, world)`

One function, one module (`server/solo/artStyle.js`), consulted by **every**
art-request site (library query **and** generation dispatch). Data-driven,
deterministic, unit-tested per rung. Resolution chain:

1. **`run.flags.artStyle`** — the player's LOCKED choice (accepts either vocab);
2. **`run.edition === "forbidden"`** — a forbidden-mode run with no lock prefers
   `realistic` (this is the forbidden-mode flag that exists today — `run.edition`,
   from `schema.js` `EDITIONS`; there is no `flags.mode/tier`);
3. **`world.artStyleOptions.default`** (then legacy `world.artStyle`, resume-safety);
4. **house fallback: `dark-fantasy`** (today's production-quality lane).

Returns a canonical style. `engineStyleForRun(run, world)` maps that result into
engine vocab for the live `imageWorker` / `comfyui` path — the same single chain,
engine output. All art sites now call these; no site reads `artStyle` /
`artStyleOptions` directly anymore.

## Style Lock Law (owner ruling, verbatim)

> "Art style is chosen at run creation and LOCKED for the campaign. Mid-campaign
> style switching is a premium (Ink-priced) service — repricing reflects real cost:
> a switch invalidates the run's cached art and face-checkouts and triggers
> regeneration."

**Enforcement:** `run.flags.artStyle` is written **once** at onboarding via the
guarded setter `lockRunArtStyle(run, style)`, validated against
`world.artStyleOptions.allowed`. Any later write that **changes** the style throws
unless an explicit `{ grant: true }` styleSwitch is passed (the Ink-purchase hook —
**guarded setter only**; no purchase flow, no UI, price is owner-table per Law 6).
A same-style re-write is an idempotent no-op.

**Onboarding chip status (honest):** the art-style chip is *wired* (click →
`onWorldField("artStyle")` → `/api/onboarding/world/field`), but it is authored in
`src/components/onboardingFlow.js` (excluded from this round) and still offers the
**legacy engine ids** (`illustrated | anime | cinematic`) hardcoded, rather than
rendering `world.artStyleOptions.allowed`. The **server** now locks + validates
whatever the chip sends (engine ids are normalized to canonical, so the legacy chip
still produces a valid lock). **FLAGGED / STOPPED:** updating the chip to render
`world.artStyleOptions.allowed` (and to show the three canonical styles incl.
`realistic`) requires `src/**` work beyond the chip's existing handler — out of
scope for this dispatch.

---

# Session state — realistic lanes exported + workflow intake wired (2026-07-12)

**Status: the four REALISTIC lanes are exported and owner-verified; the intake that
drives the owner's real ComfyUI graphs is built.**

## Tuned parameters (owner-verified, realistic lane)

- **Checkpoint:** `Juggernaut-XI-byRunDiffusion.safetensors`
- **Sampler:** `KSamplerAdvanced` — `euler_ancestral` / `normal` / **26 steps** / **cfg 5.2**
- **No quality block** on the realistic lane (`blocks/realistic.json`: `quality: ""`,
  `styleVocab: ""`) — Juggernaut-XI keeps in its native register; a quality block hurt it.
- **Per-lane dims (the spec `KIND_DIMENSIONS`; injection overrides an off-spec export
  and WARNS):** portrait **896×1152**, fullbody **832×1216**, scene **1344×768**,
  item **1024×1024**. (Owner exports carried fullbody at 896×1152 and scene at
  1024×1024 → the intake warns and injects the spec.)

## The intake (`scripts/art/validateWorkflow.mjs` + `generate.mjs`)

- `validateWorkflow` / `identifyWorkflowRoles` confirm API format and identify the
  driveable sockets **BY GRAPH SHAPE, not titles**: the sampler is the node wiring
  positive+negative+latent; its `.positive`/`.negative` refs ARE those CLIP encodes;
  its seed field (`seed` | `noise_seed`) is the seed socket; checkpoint / VAE-decode /
  save by class family. Malformed exports are rejected with an error that names the fix.
- `injectWorkflow` writes the assembled prompt / spec dims / seed into the identified
  node ids (deep-cloned; `batch_size`→1). `generateImage` uses it for owner API graphs,
  and `buildGraph` (legacy recipe format) otherwise.
- The scene lane accepts the owner's `landscape-*.json` filename (routing alias).
- `--plan` (`node scripts/art/generate.mjs --plan`) prints the assembled prompt +
  resolved workflow file + dims per lane, no GPU.
- Owner exports are **git-ignored** (`scripts/art/workflows/*-realistic.json`); the
  committed per-style recipes are not.

## Laws learned live (baked into `scripts/art/prompts/<lane>.json` v2 — never re-learn)

- **NO FISHEYE, EVER** (owner ruling) — scene negative: `fisheye, wide angle
  distortion, curved horizon, barrel distortion`.
- **NO PALE WASH** — scene negative: `washed out, pale, faded, low contrast, hazy,
  overexposed, flat lighting`; positive asserts `dramatic lighting, rich saturated
  color, deep shadows, high contrast, moody atmosphere`.
- **WEARABLES SHOW NO PERSON** — item negative: `person, human, face, mannequin,
  model, body, worn by person`; positive `flat lay, empty garment` (a face appeared
  in a cloak shot until this was added).
- **WHOLE FIGURE IN FRAME** — fullbody positive `full figure visible from head to
  feet`; negative `cropped, out of frame, feet cut off, close-up, portrait`.
- **ERA LAW (all entity lanes)** — a clothing/gear slot MUST carry an era qualifier or
  the model defaults to modern dress (a "wool robe" → a bathrobe). `mapNpcToSlots`
  injects `world.era` onto the attire slot when present. **WORLD-DATA GAP (flagged,
  owner's hands):** no world currently carries an `era` field (only `tone`/`flavor`);
  the era injection is a no-op until the world data grows the field. NOT invented here.

## What remains

- **anime lane** — needs LoRAs (the recipe supports a `lora` chain; none tuned yet).
- **dark-fantasy + sketch lanes** — no cookbook yet (owner shopping for checkpoints).
- **TAILOR (Chunk 7)** — IP-Adapter identity seams already in place (`identityRef` on
  the sidecar, `linkIdentity`); the consistency engine wakes when the per-lane
  workflows carry the IP-Adapter nodes. Not built this round.

---

# Session state — Chunk-6 intake: anime rescued, painted lane born (2026-07-13)

**Status: two lanes advanced to owner-verified cookbooks; two utility-LoRA laws
ruled; sketch lane staged as a placeholder pending ratification.** All results below
are owner-verified LIVE this session. Zero LLM / zero generation spent by the intake.

## The four verdicts (owner-verified live)

1. **ANIME LANE RESCUED** — new checkpoint `JANKUTrainedChenkinNoobai_v777.safetensors`
   replaces Illustrious as the anime cookbook. Bare-checkpoint output beat *tuned*
   Illustrious decisively. Sampler = the house standard
   (`euler_ancestral` / `normal` / **26** / **cfg 5.2**).
2. **PAINTED DARK-FANTASY LANE BORN** — checkpoint
   `sdxlUnstableDiffusers_nihilmania.safetensors` (YamerMIX) + LoRA
   `hkstyleV5.safetensors` (XL Fantasy Knights) + LoRA `add-detail-xl.safetensors`
   (Detail Tweaker XL).
3. **DETAIL TWEAKER XL CONFIRMED KEEP** for realistic PORTRAITS @ **0.75** (sharper
   hair/skin/fabric, owner-verified side-by-side).
4. **SKETCH LANE PENDING** — Grainyboyz @ 1.0 on Juggernaut, trigger words required;
   owner test not yet ratified. Staged as a placeholder only (block + recipe, both
   `blockVersion: 0` / `_TODO`).

## Proven prompt requirements per lane (verbatim — never re-learn)

### anime (JANKU)
- **Quality vocab (TRAINED family vocab):** `amazing quality, extremely detailed,
  very detailed`. WITH it → full saturation/punch; WITHOUT it → soft/muted.
- Lives in `blocks/anime.json` (`quality`, `blockVersion` 2). `styleVocab` remains an
  unproven placeholder (owner to tune).

### dark-fantasy (nihilmania / YamerMIX)
- **(a) Paint words LEAD the positive:** `oil painting, painterly, fantasy
  illustration, visible brushstrokes, traditional media` (in `blocks/darkfantasy.json`
  `styleVocab`).
- **(b) Photo-ban WITH WEIGHTS in the negative:** `(photograph:1.3),
  (photorealistic:1.3), photo, dslr, skin pores, glossy` (appended to the block
  `negativeBase`; weights are legal in a block — the injection guard applies to
  template *slots* only, not blocks).
- **(c) AGE LAW (this checkpoint):** age must be stated WITH WEIGHT or the model
  defaults to ~22yo — `(middle-aged woman:1.3), (aged face:1.2)` in the positive plus
  `young, youthful` in the negative. Documented as a lane rule in the block
  (`laneRule`). NOTE: template slots are plain-word only, so the weighting is carried
  in the owner's exported graph and the block negative, not via a slot.

## Two laws ruled this session

- **PER-LANE OPT-IN for utility LoRAs (owner law):** a utility LoRA proven in one lane
  is adopted in that lane ONLY. Every other lane tests it independently before adoption
  — never assume. (Detail Tweaker XL is confirmed for realistic PORTRAIT; it is NOT
  applied to realistic fullbody/scene/item until each is tested.)
- **AGE LAW** (dark-fantasy / nihilmania) — see (c) above.

## Registry changes (committed, tracked recipes)

| lane | checkpoint | lora | note |
|---|---|---|---|
| anime (`workflows/anime.json`) | `JANKUTrainedChenkinNoobai_v777` (was Illustrious) | — | coarse fallback; proven tune rides `portrait-anime.json` |
| dark-fantasy (`workflows/dark-fantasy.json`) | `sdxlUnstableDiffusers_nihilmania` (was Juggernaut) | `hkstyleV5 @0.5`, `add-detail-xl @0.74` | coarse fallback; proven portrait tune rides `portrait-darkfantasy.json` |
| realistic (`workflows/realistic.json`) | `Juggernaut-XI` (unchanged) | — | — |
| sketch (`workflows/sketch.json`, NEW) | `Juggernaut-XI` | — (Grainyboyz pending) | placeholder, unratified |

## FLAGGED / STOPPED (owner's hands)

- **realistic PORTRAIT add-detail-xl @0.75** — has NO committable home. The only
  portrait-scoped target is `portrait-realistic.json`, which is **git-ignored**
  (`*-realistic.json`, machine-specific owner export). Per the per-lane-opt-in law it
  must NOT go into the legacy `realistic.json` fallback (that would leak the LoRA to
  fullbody/scene/item, and the export wins for portrait anyway). **Owner: bake one
  `LoraLoader` (add-detail-xl, strength_model/clip 0.75) into your local
  `portrait-realistic.json`** — wire it exactly as `portrait-darkfantasy.json` does
  (checkpoint → LoraLoader → CLIP encodes + sampler read the LoRA's model/clip; VAE
  stays on the checkpoint).
- **dark-fantasy fallback LoRA strengths** — the legacy `dark-fantasy.json` uses the
  dispatch values (hkstyleV5 @0.5); the owner's `portrait-darkfantasy.json` export uses
  hkstyleV5 @0.68/0.70. Owner to confirm whether the coarse fallback should mirror the
  export.
- **Coarse-fallback samplers unchanged** — the legacy per-style recipes keep their
  prior samplers (anime 28/5.0, dark-fantasy dpmpp_2m/karras/30/6.0); the proven
  26/cfg-5.2 tune lives in the tracked exports. Retune the fallbacks only if you want
  them to mirror.
