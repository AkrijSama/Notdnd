# Solo Run — State Contract (frozen)

The shared data shape three parallel tracks build against. **Additive + tolerant:**
every field is optional on a persisted run (legacy runs predate them and still
validate); the **scene payload** always emits a concrete, defaulted value.

- Persistence + validation: `server/solo/schema.js`
- Scene payload emission: `server/solo/scene.js` (`buildSoloScenePayload`)
- Do **not** change these shapes without re-freezing this doc.

## 1. `player.resources` — HP / MP gauges

Scene payload (`payload.player.resources`):

```jsonc
{ "hp": { "current": 10, "max": 10 },
  "mp": { "current": 0,  "max": 0  } }
```

A gauge is `{ current: number, max: number }`. **Persistence note:** HP stays
canonically on `player.resources.hitPoints` (what `applyFailureDamage` mutates,
kept in sync with `player.health`); the payload mirrors it as `resources.hp`. MP
prefers `player.resources.mp`/`.mana`, else the `stamina` gauge, else `{0,0}`.
A resolver may also write `player.resources.hp` / `.mp` directly — both validate.

## 2. `player.inventory` — carried items (array)

Scene payload (`payload.player.inventory`) is an **array**:

```jsonc
[ { "id": "field_ration", "name": "Trail Loaf", "qty": 1, /* …extra fields ok */ } ]
```

Required per entry: `id` (string), `name` (string). Optional: `qty` (number,
default 1) + arbitrary extra fields. Source: an explicit `player.inventory` array
if present, else projected from the persisted `run.inventory` object (keyed by
`itemId`). Resolver appends; UI renders.

## 3. `player.xp` + `player.level`

```jsonc
{ "xp": 0, "milestone": 1, "level": 1 }
```

All numbers. `xp` defaults to 0. **`milestone` (1..20) is the server's one
progression truth** (Ch7 milestone track, `docs/specs/milestone-engine-delta.md`);
`level` is its computed **display mirror** — under the default identity mapping
they always coincide, so every existing surface emits unchanged numbers. Legacy
saves lack `milestone` until the lazy migration (`ensureMilestone`,
`progression.js`) writes `min(20, level)` on first award/gate touch — keep-and-
floor, never revoked.

**Tier-gate law:** content-gating code MUST call `meetsTier(player, tierBand)`
(`progression.js`), which reads `player.milestone` only. `player.level` is
presentation-layer data — **server logic is forbidden to branch on it.** A world
book cannot fake a Tier-IV door open by inflating its display numbers.

## 4. `player.conditions` — array

Scene payload (`payload.player.conditions`):

```jsonc
[ { "id": "downed", "name": "Downed", /* …extra fields ok */ } ]
```

Required per entry: `id` (string), `name` (string). Defaults to `[]`.

## 5. `scene.battleMap` — per-scene tokens (every scene, not just combat)

Scene payload (`payload.battleMap`), **always populated**:

```jsonc
{ "width": 12, "height": 12,
  "tokens": [
    { "entityId": "player:player", "kind": "player", "x": 6, "y": 6 },
    { "entityId": "npc:npc_hale",  "kind": "npc",    "x": 7, "y": 6 }
  ] }
```

Token: `{ entityId: string, kind: 'player'|'npc'|'item', x: number, y: number }`
(+ extra fields ok). `entityId` matches the visible-entity scheme:
`player:<id>`, `npc:<id>`, `player_asset:<id>`. Emitted for the player and every
NPC / player-asset **co-located in the current location**. Persisted positions on
`run.battleMap.tokens` win; otherwise deterministic placement (player centred,
others spiralling out). This is scaffolding — **tactical/movement logic is a
resolver track, not part of the contract.**

## 6. `run.mode` — `'campaign' | 'sandbox'`

Scene payload (`payload.mode`), defaults to `"campaign"`. Field + default only;
no behavior in the contract layer.

## 7. Death State (STEP 0.5 — 5e lethality)

Shape + defaults only. The dying-turn loop, death-save rolls, instant-death, and
revival mechanics are **Track A logic**, not the contract.

### `player.status` — lifecycle enum

```jsonc
"status": "alive"   // "alive" | "dying" | "stable" | "dead"
```

- `alive` — normal (default).
- `dying` — at 0 HP, making death saves each turn.
- `stable` — stabilized at 0 HP (3 successes / a heal), unconscious but not rolling.
- `dead` — TERMINAL. The character is gone.

Legacy values `active` / `downed` remain valid (runs persisted before STEP 0.5);
new code should use the four canonical values. Scene payload defaults to `"alive"`.

### `player.deathSaves` — 5e death-save tally

```jsonc
"deathSaves": { "successes": 0, "failures": 0 }   // each an integer 0..3
```

3 successes ⇒ stabilized, 3 failures ⇒ dead (logic is Track A). Validator rejects
non-integers and values outside `0..3`. Scene payload defaults to `{0,0}`.

### `run.status` — terminal **dead** is non-resumable

`run.status` enum is now `active | completed | abandoned | dead`. **`dead` is a
terminal DEFEAT status, distinct from `completed`** (a victory/normal end). A
`dead` run **cannot be continued/resumed** — the home screen must show a
death/review screen, not Continue.

Scene payload surfaces this:

```jsonc
"runStatus": "dead",      // the run.status value
"resumable": false,       // true only while status is active (or unset)
"isDead": true            // run.status === "dead" || player.status === "dead"
```

> **Resume-card reconcile (Track B / PM):** the saved-campaigns card currently
> treats only `completed`/`abandoned` as finished. It MUST also treat `dead` as
> finished (non-resumable) so a dead run never offers Continue. Contract defines
> the field; the card update is a UI change outside this step.

### Revival item shape (capability marker only)

An inventory item is a **revival means** if either:

```jsonc
{ "use": { "effectType": "revive" } }     // structured effect (new enum value)
// …or…
{ "tags": ["revival"] }                    // free-tag convention
```

Track A gates revival-on-death on possession of such an item (consumed once);
the contract only defines the marker. `ITEM_EFFECT_TYPES` now includes `revive`.

---

### Validators (schema.js)

`validatePlayerState`: `xp` (optional number), `inventory[]`, `conditions[]`,
`resources.hp` / `resources.mp` gauges, `status` enum, `deathSaves` (0..3) — all
optional/additive. `validateSoloRun`: `mode` (optional enum), `battleMap.tokens[]`
(optional), `status` enum (incl. terminal `dead`). Exposed constants: `RUN_MODES`,
`BATTLE_MAP_TOKEN_KINDS`. Revival marker: `use.effectType: "revive"` or
`tags: ["revival"]`.
