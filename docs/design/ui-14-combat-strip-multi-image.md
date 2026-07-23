# UI-14 — Combat scene strip renders multiple images side-by-side (handoff to CLI 2)

**Status:** FINDING ONLY. CLI 1 traced it; it lives in CLI 2's combat surface, so CLI 1 did **not** touch it. CLI 2 owns the fix.

## Owner evidence
A combat screenshot showed the scene strip with **three separate cooked images tiled horizontally** (two wolf variants + a tree), the enemy portrait card layered behind with its label "The Limping Grey" clipped, and the left ~40% of the strip empty black.

## Mechanism (traced)
`renderSoloBattleSurface` renders **one image card per enemy**, laid out horizontally:

- `server/../src/components/soloSceneShell.js:2985` — `const cards = enemies.map((e) => { … })`
- `:2993` — each card emits its own `<img class="solo-battle-enemy-img" src="${bodyUri}">`
- `:2996-3003` — `.solo-battle-enemy-card` → `.solo-battle-enemy-art` + meta, one per combatant

So with multiple enemies (or enemy variants) the strip shows N images in a row — that is the "three images side by side." The "portrait card behind + clipped label + empty left 40%" are the battle-surface's card layout/z-order/overflow, all inside `renderSoloBattleSurface` and its combat CSS.

This is **distinct from the aspect problem** (UI-5/JOB-1: "one image doesn't fill the strip"). UI-14 is "several images are laid out in a row."

## What CLI 2 needs to decide/fix (not prescribed by CLI 1)
- Whether combat should show **one** scene/backdrop image (the location) with enemies as sprites/tokens over it, vs. one card per enemy.
- The card layout: the clipped "The Limping Grey" label, the layered portrait card, and the empty left band.

## Boundary
CLI 1 stayed off `renderSoloBattleSurface`, `ctb.js`, and the combat CSS per the coordination rule. This doc is the handoff so CLI 2 can act. No code was changed for UI-14.
