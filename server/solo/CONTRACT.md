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
{ "xp": 0, "level": 1 }
```

Both numbers. `level` defaults to 1 (pre-existing); `xp` defaults to 0.

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

---

### Validators (schema.js)

`validatePlayerState`: `xp` (optional number), `inventory[]`, `conditions[]`,
`resources.hp` / `resources.mp` gauges — all optional/additive.
`validateSoloRun`: `mode` (optional enum), `battleMap.tokens[]` (optional).
Exposed constants: `RUN_MODES`, `BATTLE_MAP_TOKEN_KINDS`.
