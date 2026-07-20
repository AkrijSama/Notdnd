# CHAOS IS PURPLE — the palette-axis law (sealed 2026-07-20)

Violet is the **world-wide chaos/corruption signature** across Babel/Verdance. The
Goddess register is its mirror (green/gold). This is a canon + code law.

## Canon (see `docs/worlds/babel/verdance-region-v1.md`)

- **Violet = chaos.** Chaosling corruption markers, essence-sight traces, the STATUS
  WINDOW accent, and the rapture / Tower register are all violet.
- **Green / gold = the Goddess.** The counter-register. The war between them is the
  palette axis.

## Code contract

- **Data (per-tier fragments).** `server/campaign/bestiary.js` exports
  `corruptionMarkers(tier)` and `CHAOS_VIOLET_MARKERS`. Each chaosling mint
  (`mintChaosling`) and the authored Limping Grey carry
  `corruption: { palette: "violet", tier, artFragment }`. The fragment SCALES by tier:
  - tier 1 — faint violet in the eyes
  - tier 2 — violet-glowing eyes + thin violet markings
  - tier 3 — glowing eyes + creeping violet veins/markings + a faint glow
  - tier 4 — burning eyes + violet markings across the body + a roiling violet aura
- **UI accent.** The essence-sight trace chips + STATUS WINDOW use `--sight-accent`
  (violet, `src/styles.css`). Per-band freshness colors overlay on top; violet is the
  sight surface's identity tint.
- **CREATURES ONLY — never on humans.** The violet vocabulary is produced *solely* by
  the chaosling mint. A human character never passes through it, so violet cannot leak
  onto a human portrait by construction — the inverse gate to the human-only species
  negatives (a human is never fed the corruption fragment).
- **Guard:** `tests/chaos-is-purple.test.js` (fragments emit per tier; the sight accent
  var is violet; no human-portrait leakage).

## Open seam

The chaosling scene/enemy-body render consuming `corruption.artFragment` lives on the
image path (imageWorker/comfyui). That wiring is owned by CLI 1's art-path work (fenced
this pass); the data + gate ship here so the fragment is ready for it.
