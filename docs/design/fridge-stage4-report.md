# FRIDGE / TASTER — Stage 4 report (2026-07-21)

Owner-facing. Four deliverables: taster salvage, the 11-quarantine verdict table, the
exemplar re-shoot decision, and wiring Babel's card to the Antarctica Tower render.
**Total taster spend: $0.00486** (calibration $0.00142 + dry-run $0.00344), fence $0.05.

## 1. TASTER BRAIN — SALVAGE (validated, no redo)

Ran `scripts/art/taste-quarantine.mjs --calibrate` (real vision, `gemini-2.5-flash-lite`)
against the live library. **5/5 correct, 0 wrong:**
- 3 known-good keeps → **pass** (`w7_player_illustrated_exemplar`,
  `babel-portrait-courier-realistic`, `w7_player_cinematic_exemplar`).
- 1 planted wrong-subject (a marketplace declared, a wolf shown) → **suspect** (caught).
- 1 real modern-intrusion keep (`babel-scene-hollow-pine-anime`) → **suspect** — the
  taster flagged power-lines/utility-poles in a scene that should carry no modern
  infrastructure. (A live "keep" the owner may want to re-review — the brain caught what
  the earlier rating missed.)

Verdict is **derived, not trusted** (any failed check → suspect regardless of the model's
own verdict field), and both the sync/async wrappers **fail closed to quarantine**. The
brain is sound — **SALVAGE, no redo needed.**

## 2. QUARANTINE VERDICT TABLE (owner-stamped resolution required)

Dry-run over the quarantine pen (12 assets — the manifest's 11 + one newly-quarantined
live scene). **MUTATES NOTHING** — the tool presents; `--apply` is owner-stamped by law.
**11 → fridge · 1 → trash.**

| asset | kind | verdict | recommend | taster observed |
|---|---|---|---|---|
| `babel-scene-green-static-fringe-anime` | scene | pass | **fridge** | luminous stylized lamp post in a green forest clearing |
| `babel-worldcard-anime-live` | world-card | pass | **fridge** | a stone tower in a sunlit field, a person nearby |
| `live_run_61fb9c16…_loc_loc_waking_mile` | scene | pass | **fridge** | hooded figure on a rocky path, sun-drenched |
| `live_run_bbcb7b08…_loc_loc_waking_mile` | scene | pass | **fridge** | robed person in a grassy field, mountains behind |
| `live_run_bbcb7b08…_npc_creature_5b9e3030_base` | portrait | pass | **fridge** | blue-skinned humanoid, glowing eyes, cracked skin |
| `live_run_bbcb7b08…_npc_mile_defc1ab5_base` | portrait | pass | **fridge** | young woman, long pink hair, purple eyes |
| `live_run_bbcb7b08…_npc_wolf_1d2f6f0a_base` | portrait | pass | **fridge** | wolf, glowing orange eyes, scar on forehead |
| `live_run_bbcb7b08…_npc_wolf_4a10ecce_base` | portrait | pass | **fridge** | black wolf, glowing orange eyes |
| `live_run_bbcb7b08…_npc_wolf_92bd8ca1_base` | portrait | pass | **fridge** | black wolf, glowing orange eyes |
| `live_run_bbcb7b08…_player` | portrait | pass | **fridge** | a man in a white t-shirt |
| `live_run_eea2d9e4…_loc_start_location` | scene | **suspect** | **trash** | a dark truck on a dirt road in a forest (modern intrusion) |
| `worldcard-exemplar-realistic-live` | world-card | pass | **fridge** | frontier village in a forest clearing, central wooden tower |

The one **trash**: `live_run_eea2d9e4…_loc_start_location` — a scene of "The Green Static,
Fringe" that rendered a **modern truck** on a dirt road (modern-intrusion, exactly the
class the taster is built to catch). To act on the table:
`node --env-file=.env scripts/art/taste-quarantine.mjs --apply accept-recommendations`
(or per-id `--apply <id>=fridge,<id>=trash`). Verdicts JSON:
`data/assets/quarantine-verdicts.json`.

## 3. EXEMPLAR RE-SHOOT — NOT NEEDED (skipped, correctly)

`worldcard-exemplar-realistic-live` was to be re-shot "to card aspect." Verified its PNG
IHDR: it is **already 1344×768** — the exact world-card aspect — and it **passes taste**
(row above). A re-shoot would produce nothing new. The resource gate was checked and read
**OK** (6879/8188 MiB VRAM free, only 928 used), so the GPU was not held at check-time —
but with CLI-1's freeze-salvage in flight and the standing 8GB-shared-card freeze hazard,
cooking a redundant image would be pure downside. **Skipped as unnecessary; no cook
dispatched.** If the owner still wants a fresh exemplar, cook a `kind:"world-card"` spec
(resolves 1344×768 from the style recipe) behind `assertCookResources("reshoot")`.

## 4. BABEL CARD → ANTARCTICA TOWER — WIRED + VERIFIED

The obsidian-Tower render (`w7_worldcard_obsidian_tower_anime` — a colossal impossible
Tower on an antarctic obsidian plain, authored in the library under its own world
`antarctica-obsidian`) is now Babel's lobby cover, via an **owner pin** in
`server/solo/artLibrary.js` (`WORLD_CARD_PIN`). The pin overrides the newest-keep pick and
binds only when the asset is present and keep-rated; the asset keeps its own provenance (no
retag). **Verified against the live library:** `resolveLibraryArt({world:"babel",
kind:"world-card"})` → `/data/assets/library/w7_worldcard_obsidian_tower_anime.png`.
Test net: `tests/art-library-game.test.js` (pin wins over own newest keep). The home/
catalogue client already fetches `/api/art/library?world=babel&kind=world-card`, so the
card now shows the Tower with no client change.
