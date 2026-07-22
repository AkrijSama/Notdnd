# BETA THUMB — owner-feedback calibration for the art taster

**Status:** shipped, temporary. **Flag:** `NOTDND_BETA_THUMB` (default ON).
**Dataset:** `data/owner-verdicts.jsonl` (append-only). **Code:** `server/art/ownerFeedback.js`.

## Why this exists (do not lose it)
The auto art taster (`server/solo/fridgeTaster.js`) has never been validated against the
owner's taste. It scored 5/5 on its own small calibration — which proves it can catch a
wrong subject, not that it has taste. The thumb collects the owner's real up/down verdicts
on generated images so the taster can be **scored** against them: *on assets the owner
judged, how often did the taster agree?* **The DATA is the deliverable. The button is
disposable; the verdicts are not.**

## What it records (JOB 2)
Every verdict (`data/owner-verdicts.jsonl`, one JSON per line):
`assetId, uri, kind, world, verdict (up|down), reasons[], recipeVersion, checkpoint,
cook{width,height,steps,cfg,sampler,scheduler,seed}, prompt, style, tasterVerdict,
tasterReason, at, who`.

- **recipeVersion** (non-negotiable): from the sidecar `meta` (`tmplN/blkN/workflow`), or
  for a run-local cook the checkpoint identity. Without it a down goes stale the instant a
  recipe changes and nobody can tell whether it judged the picture or a recipe since fixed.
- **checkpoint + cook params**: parsed from the PNG `prompt` tEXt chunk (the executed
  ComfyUI graph) — works for any generated PNG, past or future, no cook-pipeline change.
- **tasterVerdict** (non-negotiable): the taster's own recorded verdict for that asset (from
  `data/assets/quarantine-verdicts.json`), or `null` if it never judged it. Stored alongside
  so the agreement rate is computable — the entire point.

## Lifecycle (the part that goes wrong) — JOB 3
- **A thumbs-down is a SIGNAL, never a destruction order.** It appends the dataset record and
  sets a sidecar `ownerFeedback` flag. It does **not** set the taster `quarantine` marker
  (which would drop the asset from serve AND feed the 30-day auto-trash sweep) and it does
  **not** change `rating` (stays `keep`).
- **An in-use fridge asset KEEPS SERVING while flagged (3.2).** Because `rating` stays `keep`
  and no `quarantine` marker is set, `resolveLibraryArt`/`keepsFor` still return it. The Babel
  world-card does not go blank on a thumbs-down. (Test: `tests/beta-thumb.test.js`; verified
  live.)
- **The 30-day fuse escalates, never deletes (3.3).** `listOwnerDown` marks a flag older than
  `NOTDND_OWNER_DOWN_ESCALATE_DAYS` (default 30) as `overdue`; the sweep surfaces it LOUDLY
  ("OVERDUE — stamp me", plus an overdue count in the header). Nothing is auto-trashed.
- **Sweep (3.4):** open `/src/art-sweep.html` (owner tool; reads the game's auth token). One
  card per down asset: the image, its reason chips, the taster's verdict, and two buttons —
  **Keep (fridge)** clears the flag (keeps serving); **Destroy (trash)** is the owner stamp,
  the ONLY destruction path (with a confirm). A stray phone tap can never reach it.
- **Orphaned verdicts (3.5):** a verdict is immutable history keyed on
  `(assetId, recipeVersion, at)`. When the asset is **destroyed** (trash stamp) or **redone**
  (a redo makes a fresh-seed asset; the predecessor is superseded), the log line remains as
  valid calibration data — it recorded a real judgment of that specific image. Nothing reads
  it back into a live asset, so it is data, not a crash. When a **recipe changes**, past
  verdicts keep their recorded `recipeVersion`, so the agreement script can filter or slice by
  it and never conflate a judgment of the old recipe with the new one.

## Surfaces the thumb reaches (route-inventory law)
Generated-image kinds and where the thumb mounts:
- **scene** → the scene art banner (`renderSoloSceneArt`, bottom-left; clear of Redo/Save).
- **portrait** → the player portrait dock, and any NPC via the Entity Sheet (inspect).
- **fullbody** → the VN speaker sprite, and the enemy battle body.
- **world-card** → the lobby / world-select cover (`bindWorldCardArt`).
- **item** → *no client surface exists today* — the server threads `item.imageAssetId` but
  nothing renders an item `<img>`. Documented gap; add the thumb when an item-image surface
  ships.

**Deliberately deferred:** the tiny cast-roster and opening-speaker avatars (too small for a
non-intrusive control — the same NPC portraits are thumbable via the Entity Sheet), and the
onboarding portrait DRAFTS (pre-commit, transient; the committed portrait is thumbable). Both
are the `portrait` kind, already collected — no KIND is lost.

**Uploads are skipped** — `member.origin === "user"` (cast) and `portraitMode === "upload"`
(onboarding) mark owner uploads, which are not taster output. *Assuming the in-run player
portrait dock is generated: unverified — no image-provenance flag reaches that surface today,
so an uploaded player portrait would currently be thumbable there. Add a payload flag if that
matters.*

## The payoff (JOB 5)
`node scripts/art/taster-agreement.mjs` — total judged, agreement rate, and the DISAGREEMENT
BREAKDOWN sliced by kind and reason chip. **The FALSE-KEEP rate** (taster kept, owner would
bin) is the number that matters most. It prints a LOUD small-sample warning below
`NOTDND_AGREEMENT_MIN_SAMPLE` (default 30) — a confident rate on a handful of assets is noise.

## Death date (JOB 4) — the removal condition
This control is explicitly temporary. **Turn `NOTDND_BETA_THUMB=false` (one move) only once
BOTH are true:**
1. the taster is **validated** against this dataset (`taster-agreement.mjs`) at a sample
   large enough to matter (≥ `NOTDND_AGREEMENT_MIN_SAMPLE`) **and** a false-keep rate the
   owner accepts, and
2. the auto-sorter's quarantine is **trusted** to catch what the taster waves through.

Killing the flag hides the UI everywhere in one move. It NEVER deletes
`data/owner-verdicts.jsonl` — the dataset outlives the button (JOB 4.2). Removing the code
later: delete the thumb render/handlers, the three `/api/art/thumb*` routes, and this doc's
"temporary" status; keep the dataset and the agreement script as the historical record.

## Known limitation
Toggle state is session-scoped on the client (the durable truth is the sidecar flag + the
JSONL). After a page reload, prior votes are not re-highlighted in-game (the sweep still shows
them). Acceptable for a beta; add per-image state to the scene payload if persistence matters.
