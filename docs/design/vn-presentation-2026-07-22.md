# VN presentation — build report + the sprite STOP (2026-07-22)

Dispatch: "Build the VN presentation." Owner law: **two boxes, two jobs, always** —
narration ONLY in the bottom log (always present, never hidden); dialogue ONLY in the
VN scene. They never mix.

## Shipped

- **JOB 3.1 — the misfiled dialogue (fixed).** `logNarration` folded ALL `openingBeats`
  into the narration log, including the committed VOICE's SPOKEN beats — a flat violation
  of the two-boxes law (her words are dialogue). Now it logs only the scene-setting
  narration beats (`splitOpeningBeats(...).narration`), mirroring EXACTLY the VN-box
  synthesize path in `loadScene` so conservation is total: narration→log, spoken→VN box,
  never both, never dropped. A non-VN opening (no committed speaker) keeps all beats as
  narration, unchanged. Door-verified: the log shows only "THE GM SETS THE SCENE…" prose;
  the VOICE's `[ YOU ARE HEARD. ]` speech appears in the VN box alone.
- **vn-guard extended** (`scripts/walk-harness/vn-opening-check.mjs`): DOM-level asserts
  that no spoken VOICE line leaks into the log (JOB 3), the narration box is present during
  the VN beat, and the sprite is staged RIGHT when present. Dimming/player-left reported as
  NOTEs, never faked green.

## JOB 2 — the player fullbody does NOT exist (report only)

`scene.vnBodyUri` is resolved EXCLUSIVELY for the active NPC speaker
(`server/solo/scene.js:1221-1231`, keyed on `vnState.speakerId`; no player branch). The
player's only image is a **square 1024×1024 portrait** (`run.player.portraitUri`). A player
fullbody minter exists — `server/solo/tailorFullbody.js` — but is **dormant: called only by
its test**, wired to no route/worker/enqueue. No `player.bodyUri` schema field exists, and
**no player fullbody asset exists on disk for any run** (every `run_*/player/` holds only
`base.*`). There is also **no player-speaking VN beat**: the VN box always shows the NPC's
line; the player types replies inline (a text log entry, never a sprite).

**Consequence:** JOB 1.2 (player fullbody on the LEFT when the player speaks) and JOB 1.3
(dim the non-speaker) are **unbuildable today** — only one sprite (the NPC) ever renders, so
there is no left slot to fill and no non-speaker to dim.

**What renders on the left with no player fullbody (JOB 2.3):** recommend **nothing** (the
current behavior — an empty sprite slot omits its container entirely, no placeholder). A
grey silhouette placeholder is the alternative; it reads as "art still cooking" and invites
"why is the player faceless" — not shipped without a stamp.

**To close the gap** (NOT built this dispatch): wire `tailorFullbody` to a `playerBody`
worker kind + an `img_player_vnBody`-style asset slot + a `player.vnBodyUri` schema field +
a cook trigger (onboarding or first VN beat), then teach the overlay a two-slot stage.

## JOB 1.4 + JOB 1.5 — the sprite STOP (large vs. HUD-clear cannot both hold)

Measured in a real browser, sprite injected at true 832×1216 (2:3), four laptop viewports:

| Viewport | Sprite (WxH) | HUD row | Sprite↔HUD overlap |
|---|---|---|---|
| 1280×720 | 66×96 px  | 417×28 @top62 | 66×28 (full sprite width) |
| 1366×768 | 77×113 px | 417×28 @top62 | 77×28 |
| 1440×820 | 90×131 px | 417×28 @top62 | 90×28 |
| 1440×900 | 109×159 px| 417×28 @top62 | 109×28 |

- **1.4 (large):** the sprite is a **66–109px thumbnail** — the exact "corner thumbnail" the
  owner said it must not be. The stage is ~35vh (252–315px) and the sprite is height-capped
  by it minus the ~156px VN-box reserve, so it cannot grow large without a taller stage.
- **1.5 (HUD-clear):** the sprite's head **fully overlaps** the top-right HUD row at every
  viewport (sprite top y=62 == HUD top y=62; sprite is `z-index:2` behind the `z-index:30`
  HUD, `pointer-events:none` — clicks are safe, but the character's head sits directly
  behind the gear/minimap/clock and peeks through the 8px inter-chip gaps).
- **The conflict:** the sprite is right-anchored and the HUD is pinned top-right; making the
  sprite larger drives its head further UP and LEFT — deeper into the HUD, not out. They
  contend for the same corner. Per JOB 1.5's own STOP clause + the SCOPE LAW, this is not
  mine to resolve unstamped.

### Options (owner picks; costs noted)

1. **Hide/fade the HUD during a VN beat** (recommended). Reuse the existing
   `:has(.solo-scene-drawer.is-open) .solo-stage-hud { display:none }` pattern — add a
   `.solo-stage.vn-active` variant that hides the row while dialogue is live. Gives a large
   right sprite the whole corner. Cost: the clock/map/Cast chips vanish during dialogue (they
   return the instant it ends). A UX change → needs a stamp.
2. **Keep the sprite bottom-anchored, start it BELOW the HUD** (`top: ~44px`). Removes the
   overlap without touching proportions. Cost: the sprite gets ~36px SHORTER — even more of a
   thumbnail, moving AWAY from 1.4. Picks the 1.5 horn at 1.4's expense.
3. **Give VN a taller stage** so the sprite reads large, keep the HUD, accept the top overlap
   as "the HUD floats over the scene." Cost: a stage-proportion change (stamp) AND it does not
   actually resolve 1.5.

Not shipped — reported for the owner's call.

## JOB 4 — background & space

- **4.1:** confirmed — sprites overlay the scene art; there is **no separate VN background**
  to choose (`.solo-stage` comment: "No backdrop: the narration log stays fully visible").
  The `.solo-vn-box` carries a bottom gradient band for text legibility — this is a
  pre-existing textbox scrim, band-limited to the box, NOT a full backdrop and NOT added
  here.
- **4.2:** at all four viewports nothing goes off-screen. Narration-log bottom 517/565/617/697
  vs viewport 720/768/820/900. Strip 252–315px, VN box 162px, narration log 202–319px.

## Pre-mortem

- **(a) large sprite overlaps HUD again** — CONFIRMED as the live conflict (measured), and
  reported as a STOP rather than shipped over.
- **(b) works for the VOICE opening but not a live mid-run NPC beat** — the JOB 3 fix is in
  `logNarration`, the shared per-turn log path (opening AND live turns); live VN turns route
  quotes to the VN box via `splitVnDialogueForScene` (already present). The opening was the
  one leaking path; live turns already split.
- **(c) narration box present but crushed** — ruled out: measured 202–319px tall and fully
  on-screen at every viewport.
- **(d) left side permanently empty** — CONFIRMED (JOB 2): no player fullbody exists; deferred
  to the owner (2.3).
