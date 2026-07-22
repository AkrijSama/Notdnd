# Walk-fix: guest door + scene/portrait crop (2026-07-22)

Three walk-blocking findings from the walk-door harness at `0345e21`. All three fixed.

## Job 1 — the guest door (first-user path)

**Was:** `/api/art/library` required auth. A logged-out visitor got 401 and the lobby
silently fell back to `public/assets/art-illustrated.jpg` (the dark-fantasy bust). The
owner saw the Tower only because he was logged in.

**Fix:**
- **1.1 (scoped public read):** `/api/art/library` now serves WITHOUT auth for
  `kind==="world-card"` **and** a PUBLISHED, built-in world (a scenario file exists,
  `loadScenarioFile(world)` truthy). Everything else — every other kind, and every
  non-published/user world — stays **authed** (`resolveAuthUser` for the public case
  returns null for a guest, so `betaThumb` is offered only to a logged-in user). No
  private world art or metadata is exposed to a guest.
- **1.2 (visible failure):** a world card starts with a VISIBLE `data-art-pending` hatch
  (a muted "no art yet" placeholder), never a plausible bundled image. A null/failed
  resolve LEAVES that placeholder — a loud absence, not a silent wrong image. (Chosen
  over a blank empty state so the card still reads as a card.)
- **1.3 (decouple):** `WORLD_SELECT_CARDS` no longer carries a hardcoded `art`.
  `art-illustrated.jpg` keeps its style-picker-sample role and LOSES its card-default
  role — the double duty that let this hide for weeks.
- **1.4 (tests):** `tests/world-select-cards.test.js` no longer asserts the static bust as
  the card art (it did — a test guarding the bug). It now asserts the pending placeholder
  and that no card carries a static `art`. No other test blesses a static-default art path
  (`grep` of `tests/`: only that file, plus the harness's fallback-DETECTION fixture,
  which is correct).
- **1.5 (verify at the door):** the harness's guest replay now gets HTTP 200 → the Tower
  (`0770eaf1`), served == intended.

## Job 2 — scene crop (was 61.7% off the top)

**Was:** scene cooks 1344×768 (7:4), displayed in a VARIABLE full-bleed strip
(aspect ~2.3–4.6 by viewport), `object-fit: cover` → up to ~62% cut off the top.

**Owner ruling (governing):** the ground must ALWAYS be in frame AND nothing gets cut.
The earlier "cut the sky, keep the ground" was an answer to a bad question — never
approval of cropping.

**Fix:**
- **2.1 (cook == display):** the in-game stage box now HOLDS the 1344×768 cook aspect
  (`aspect-ratio: 1344/768`, `max-width: calc(560px*1344/768)`, centered). The image fills
  it EXACTLY — no crop, no letterbox. **1344×768 IS the correct cook dimension**; the box
  now matches it, so the aspect is no longer viewport-dependent. Extremes: on wide
  viewports the banner caps at ~560px tall and centers (~980px wide); on narrow ones it is
  full-width with height following the aspect. No crop at any viewport.
- **2.2 (no silent trim):** `object-fit: cover → contain`. A correct asset fills the box;
  a WRONG-aspect asset letterboxes VISIBLY (a loud absence) instead of silently cropping.
- **2.3 (composition):** the scene prompt still orders "wide establishing shot … ground
  plane visible" (`scripts/art/prompts/scene.json`). That composition was authored FOR
  1.75:1 and the display is now also 1.75:1 — so it still fits. **No prompt change made.**
- **2.4 (stale comments):** corrected `styles.css` — the scene asset is 1344×768 (7:4),
  not the "768×512 (3:2)" / "512×768 / 1024×1024" the comments claimed for years.
- **2.5 (existing assets):** **14 scene assets** in the fridge, **all 1344×768** — they
  fill the new box EXACTLY (nothing cut, no letterbox). No re-cook needed. Nothing
  destroyed or cooked. Owner decides their fate separately.

## Job 3 — portrait crop

**Correction the harness itself needed:** the live comfyui path uses `dimsFor(recipe,kind)`,
which OVERRIDES the imageWorker caller constants. The real portrait cook is **896×1152
(0.778)**, not 512×768/1024×1024 — the earlier harness under-reported the portrait crop.

**The pipeline's portrait dims are INCONSISTENT** across paths: imageWorker constants
(512×768 bust / 1024×1024 player, used by pollinations) vs recipe `dimsFor` (896×1152,
used by comfyui) vs the display frame (512/768 = 2:3). No single cook aspect matches every
path.

**Fix:** `.solo-portrait-img` `object-fit: cover → contain`. A face is never cropped —
the WHOLE face is always in frame whatever the source aspect (nothing cut). A matched cook
fills the frame; a mismatch letterboxes (visible, nothing cut). **Recommendation for the
owner (not done here — a pipeline change):** rationalize portraits to ONE aspect (frame,
recipe `KIND_DIMENSIONS.portrait`, and the imageWorker constants) so a matched cook fills
the frame with no letterbox.

### 3.3 — cook vs display, EVERY image surface (reference 1440×900)

| Surface | Cook (real, dimsFor) | Display box | object-fit | content CUT |
|---|---|---|---|---|
| world-card (lobby) | 1344×768 (1.75) | 100%×150px (~1.73) | cover | ~1% |
| scene | 1344×768 (1.75) | fixed 1.75 (walk-fix) | **contain** | **0%** |
| npc-portrait bust | 896×1152 (0.778) | 2:3 frame (0.667) | **contain** | **0%** (was ~14% cut under cover) |
| player-portrait | 896×1152 comfyui / 1024×1024 pollinations | 2:3 frame | **contain** | **0%** (was 14–33% cut under cover) |
| fullbody / VN sprite | 832×1216 (0.684) | 2:3 (0.684) | cover | 0% |
| enemy-fullbody | 832×1216 (0.684) | 2:3 | cover | 0% |
| item | — (no art) | — | — | — |

After the fix, **no surface cuts content** (all cover-crops eliminated by aligning the
scene box and switching portraits to contain). Residual letterbox on portraits (pipeline
aspect inconsistency) is empty space, not cut content — flagged for the owner to
rationalize.
