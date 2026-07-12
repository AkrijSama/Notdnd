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

`node scripts/art/proof-batch.mjs --plan` prints what WOULD generate per curated
spec (resolved recipe file + dims) plus a four-waiter routing matrix — without
touching ComfyUI (port 8188). Use it to confirm every lane resolves before a
real GPU window.
