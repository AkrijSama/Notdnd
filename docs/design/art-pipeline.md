# Art Pipeline — Phase 1 (library + local ComfyUI)

**Status:** Phase 1 built. Wiring generated images INTO the UI is **phase 2** (not this round).
**Scope:** `scripts/art/**`, the asset library (`data/assets/library/`, gitignored), the Babel world-data style policy, and the asset read path. The GM pipeline / resolver / classifier / `src/**` rendering are untouched.

Related: economy-law Law 4 (crafting-as-generation) and Law 5 (asset library) — [`economy-law.md`](./economy-law.md).

---

## 1. Asset library (`scripts/art/library.mjs`)

One JSON sidecar per image: `<id>.png` + `<id>.json`. The sidecar is canon (Law 5); the PNG is runtime data — `data/assets/` is gitignored, so images never enter version control.

**Sidecar schema** (every field always present; `creator`/`origin` are load-bearing for the future multiplayer economy even while default now):

| field | meaning |
|---|---|
| `id`, `createdAt` | identity |
| `origin` | `authored` \| `generated` \| `player-commissioned` (default `generated`) |
| `creator` | `null` now — multiplayer creator tag later |
| `world` | e.g. `babel`, or `null` = world-agnostic |
| `style` | e.g. `anime` \| `dark-fantasy` |
| `kind` | `world-card` \| `scene` \| `npc-body` \| `npc-portrait` \| `item` \| `decor` |
| `tags` | part-tags (subject, pose, expression, hair, clothing, setting, time-of-day) |
| `checkout` | `{runId, npcId}` when a **face** is claimed; `null` = available |
| `rating` | owner keep/toss: `keep` \| `toss` \| `null` |
| `workflow` | recipe that cooked it |
| `promptUsed` | full positive prompt, verbatim |

**Face-checkout rule (Law 5):** only `npc-body`/`npc-portrait` may check out, and each holds **at most one** `{runId, npcId}`; scenery never checks out. `queryAssets` always excludes `toss`-rated images. Functions: `addAsset`, `queryAssets`, `getAsset`, `tagAsset`, `checkoutFace`, `releaseFace`, `rateAsset`. Tests: `tests/art-library.test.js` (checkout uniqueness + toss exclusion enforced).

---

## 2. Style-per-world as data

Babel world data lives in **`server/campaign/scenarios/babel.json`** (`world` object).

**Added:** `world.artStyleOptions = { "default": "anime", "allowed": ["anime", "dark-fantasy"] }` — the isekai world is anime-first (owner ruling; the dark-fantasy lock was the defect). Style names map to workflow files (`scripts/art/workflows/<style>.json`), never hardcoded in engine logic.

> **Reconciliation note (flag for phase 2):** the existing `world.artStyle` is a **string** (`"modern arcane"`) that the engine already reads as a render-style key in ~10 places (`server/solo/schema.js` `validateOptionalString`, `imageWorker.js`, `scenarioLoader.js`, `worldGen.js`). Restructuring that string into `{default, allowed}` would break `scenario-schema` validation and the image path — **out of scope this round** (engine untouched). So the policy was added as the **new** `artStyleOptions` field alongside the legacy string. Phase 2 should migrate the engine's style consumers to read `artStyleOptions.default` (and the phase-2 style-choice UI to read `.allowed`), then retire the legacy string. Note the engine's `ART_STYLES` enum is `["illustrated","anime","cinematic"]` — `dark-fantasy` is **not** an engine art-style today; it exists as a **workflow/library** style only until phase 2 reconciles the vocabularies.

---

## 3. Generation pipeline (`scripts/art/generate.mjs` + `workflows/`)

Talks to local ComfyUI (`127.0.0.1:8188`) over its HTTP API. Style **recipes** are JSON in `scripts/art/workflows/`:

- `anime.json` → `Illustrious-XL-v2.0.safetensors`
- `dark-fantasy.json` → `Juggernaut-XI-byRunDiffusion.safetensors`

Each recipe carries sampler settings, a positive suffix, a negative, per-`kind` dimensions (world-card/scene **wide** 1344×768; npc-body **tall** 832×1216; etc.), and an **empty `lora: []` slot** (LoRA chaining is a documented seam; the owner tests LoRA combos himself later). `generateImage()` builds an SDXL txt2img graph, cooks one image, lands it in the library with a fully-tagged sidecar, and is **idempotent by id** (a resumed batch skips images already on disk). Seeds are derived from the id (reproducible).

Checkpoints verified on disk: `/home/akrij/ComfyUI/models/checkpoints/{Illustrious-XL-v2.0, Juggernaut-XI-byRunDiffusion}.safetensors`.

---

## 4. HARD GPU safety (freeze history: 3 prior hangs, 8GB card)

Enforced by `assertSafeWindow()` + `runBatch()`:

1. **ComfyUI launches with `--novram`** (proven safe on this card): `cd ~/ComfyUI && ./venv/bin/python main.py --listen --novram`.
2. **No batch while the play server served a turn in the last 10 min** (owner may be playing) — checked via `/api/debug/status` `turnTiming`. If recent: abort, "authorize batch window".
3. **Free VRAM ≥ 1GB** before start and **between every chunk** (chunks ≤ 10, `nvidia-smi`). Abort if it drops below.
4. **ComfyUI is stopped at the end of every batch** (`stopComfy()`, kill-by-port) — it never idles.

The gate is loud by construction — `assertSafeWindow` throws with the exact reason.

---

## 5. Proof batch + review (`proof-batch.mjs`, `review.mjs`)

`node scripts/art/proof-batch.mjs` cooks exactly **14** curated candidates (4 world-card anime wide · 6 scene: 3 anime + 3 dark-fantasy of the same subjects · 4 npc-body anime tall, faces tagged to seed the checkout pool), gated and chunked as above, resume-safe.

`node scripts/art/review.mjs` serves a dead-simple local page (`http://127.0.0.1:8791`) showing every library image with **Keep / Toss / Clear** buttons that write straight into the sidecar. Toss-rated images stay on disk but are excluded from engine queries.

---

## 6. 8GB-card constraints for phase 2 (sprite batches keyed off `spokenTo`)

- With a game or the play server loaded, **free VRAM routinely sits under 1GB** — an SDXL cook needs headroom, so sprite batches must run only in an authorized idle window, `--novram`, small chunks.
- SDXL at 832×1216 on `--novram` trades speed for safety (slower per image); a face-per-`spokenTo`-NPC batch should be queued lazily and run off the hot path, never during play.
- The face-checkout pool means the sprite generator should **prefer the library first** (a free tagged `npc-body`) and only cook when the pool can't satisfy the requested tags — cheapest path first, exactly like Law 4's library-first → generate ladder.
