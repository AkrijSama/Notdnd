# The Walk-Door Harness — verifying the door, not the layer beneath it

**Ratified 2026-07-22 (CLI-2, HIGH seat).** Four owner walks died on defects the
auto-harness should have caught. The harness was tightened after each and kept missing
the next. That is the signal that its SHAPE was wrong, not its strictness.

**GOVERNING DIAGNOSIS (owner):** the harness verified the layer BENEATH the player.
Function-verified is not door-verified; server-truth is not pixel-truth. Class-5 (the
Babel world card served a bundled default for weeks) passed every check because the
checks called `resolveLibraryArt` in Node — they never issued the request a browser
issues, without its auth token.

Files: `scripts/walk-harness/model.mjs` (registry + pure checks), `scripts/walk-harness/coherence.mjs`
(in-process coherence, $0), `scripts/walk-door-harness.mjs` (the runner),
`tests/walk-door-harness.test.js` (the harness's own self-tests).

Run: `node scripts/walk-door-harness.mjs` (against a running build; `--json` for machine
output). Env: `NOTDND_HARNESS_BASE_URL` (default `http://127.0.0.1:4173`),
`NOTDND_HARNESS_LIB_ROOT` (default the real library on disk). **Zero paid cost** — no
turn narration, no cook; art/scene structure touches no AI.

---

## JOB 1 — the inventory (reported before building)

### 1.1 The verification layers (weakest → strongest)

| # | Layer | Catches | Cannot catch |
|---|---|---|---|
| 0 | `function` (Node call) | a resolver's logic in isolation | HTTP, auth, the client fetch, served bytes, render |
| 1 | `server-state` | run/db state after an op | HTTP delivery, the door's auth, client, render |
| 2 | `http-authed` | an authed endpoint's payload when a token IS sent | what a GUEST / raw client fetch (no token) receives — **the class-5 shape** |
| 3 | `http-guest` | the auth-gate divergence: a 401 for the request the CLIENT actually issues | how bytes are displayed, the DOM |
| 4 | `served-bytes` | the WRONG asset / a silent fallback actually reaching the door (sha256) | how those bytes are laid out (crop/CSS/composition) |
| 5 | `rendered-dom` | whether the swap/CSS class actually applied in a browser | actual pixels / composition / taste |
| 6 | `pixels` | the visual result a human sees | nothing structural — but not taste/fun |

**Before this harness, the existing checks stopped at layers 0–2 for every art surface.**
`smoke.mjs` is function + http-authed (never reads image bytes). `e2e.mjs` is http-authed
+ rendered-DOM text (never reads image bytes). String-match tests assert the *static*
HTML (they actively bless the bug — `tests/world-select-cards.test.js:32` asserts the
`art-illustrated.jpg` default is present).

### 1.2 Per-surface stop layer (BEFORE this harness)

| Surface | Client resolution | Old stop layer | Door-verified? |
|---|---|---|---|
| **world-card** | separate raw fetch `/api/art/library` (NO auth) | **function** (`resolveLibraryArt` in Node) | **NO — the hole** |
| scene | authed payload `scene.locationImageUri` | http-authed | route only, bytes no |
| npc-portrait | authed payload `scene.cast[].portraitUri` | http-authed | route only, bytes no |
| player-portrait | authed payload `scene.player.portraitUri` | http-authed | route only, bytes no |
| fullbody | authed payload `scene.vnBodyUri` | http-authed | route only, bytes no |
| enemy-fullbody | authed payload `enemies[].bodyUri` | http-authed | route only, bytes no |
| item | text only (no art) | n/a | n/a |

### 1.3 The five confirmed misses × the layer that would have caught them

| Miss | Class | Layer that catches it | Layer the check used |
|---|---|---|---|
| 1. Player combat entry had no route | route absent | server-state / http (a real intent turn) | function (unit on a helper) |
| 2. VOICE narrated as prose, not routed to VN cast | routing | server-state (scene.vnMode / speaker) | function |
| 3. Authored NPC name overwritten by a procedural pass | authored-integrity | server-state (post-`runIdentityJob` diff) | none until `authored-cast-identity-law.test.js` |
| 4. Named-but-absent creature fabricated, fought, killed | prose-vs-commit | prose-vs-commit reconciliation on a live turn | none (transcript looked fine) |
| 5. World card served a bundled default for weeks | door / served-bytes | **http-guest + served-bytes** | **function (`resolveLibraryArt` in Node)** |

The pattern is one line: **each miss lived one or more layers ABOVE where the check
stopped.** Class 5 is the purest — a two-layer gap (function → served-bytes).

### 1.4 The size of the hole

**One** player-facing surface (world-card) was verified only at the FUNCTION layer —
two layers below its door. Five more were byte-unverified (route-only). This harness
moves the world-card to `served-bytes` (where the defect is now RED) and the five to
`http-authed` (their adequate door — the URI rides the authed payload, so no
guest-divergence class exists), leaving their byte-level as an honest, non-blocking gap.

---

## Architecture — the route-inventory, made explicit

The core is `SURFACES` in `model.mjs`: every player-facing art surface, HOW the client
resolves it (`separate-fetch` vs `authed-payload` vs `static`), whether that request
carries auth, its deceptive fallback (if any), its cook dims, its display box, and the
layer its check reaches. **A surface not in this registry is a surface no one watches**
— the self-test fails if the world-card ever loses its class-5 shape or another surface
grows a deceptive fallback.

**The kind determines the adequate door:**
- `separate-fetch` (only the world-card) → must reach **served-bytes** via the client's
  actual request. A divergence AND a deceptive fallback are both possible.
- `authed-payload` (everything else) → **http-authed** is adequate: the URI rides the
  authed payload the browser already receives, the byte serve (`/data/assets/library/*.png`)
  is public, so there is no guest-divergence class and (verified) no deceptive fallback.

## Job 3.3 — measured crop (never measured before), reference 1440×900

| Surface | Cook | Display box | Crop |
|---|---|---|---|
| scene | 1344×768 (1.75) | full-bleed strip ~4.57 | **61.7% top/bottom** ⚠ |
| player-portrait | 1024×1024 (1.0) | frame 2:3 (0.67) | **33.3% sides** ⚠ |
| world-card (lobby) | 1344×768 (1.75) | 100%×150px (~1.73) | ~1% (fine) |
| npc-portrait bust | 512×768 (0.67) | frame 2:3 | 0% |
| fullbody / enemy | 832×1216 (0.68) | vn-sprite 2:3 | 0% |

Threshold: a crop > 20% is a FINDING (keeps the run non-green), not a note.

## Job 4 — silent fallbacks; only ONE is deceptive

`SILENT_FALLBACKS` catalogues six. **One is `deceptive`** (a finished-looking substitute
indistinguishable from success): `world-card-401-static`. The other five are `honest`
(spinner / initial-letter glyph / empty) — visible not-ready states, fine as-is.

**Recommendation (Job 4.3 — needs owner stamp, not implemented here):** the world-card
fallback must become loud. Either (a) `bindWorldCardArt` uses the auth-wrapped client so
the token rides, or (b) `/api/art/library` world-card reads become PUBLIC (a lobby card
is pre-login content); and on a non-ok response the client surfaces a visible "art
unavailable" state instead of silently keeping a subject-wrong default.

## Job 6.3 — what this harness structurally CANNOT catch

- Rendered-DOM defects (no jsdom/playwright): whether the `img.src` swap or a CSS class
  actually applied in a live browser.
- Actual pixels / composition: crop is COMPUTED here, not seen.
- Taste, fun, pacing, prose quality — outside any structural harness.
- Long-session coherence that only emerges across many turns.
- Paid-model narration quality (turns run deterministic/placeholder at $0).

**A green run means the doors are not broken and the authored world is coherent. It does
NOT mean "the owner will enjoy the walk."**
