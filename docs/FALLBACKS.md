# Fallback / Degraded-Mode Map — ground truth

Audited against code at commit `0cc0e0c` (local; 2 commits ahead of pushed `21a98b0`).
Re-verified by reading each path; visibility checked by `console.warn` presence.

This documents **every degraded-mode / fallback path** in the system: what fires
it, what it falls back to, whether it fails toward **availability** (keep the game
running) or toward an **integrity** stance (refuse to let invalid input become
canon), and — most importantly — whether it is **SILENT** or logged. Silent
fallbacks on player-reachable paths are the dangerous class (the "GM goes quiet"
failure that looks like working software); they are flagged explicitly.

## Two philosophies

- **Availability** ("still functions"): GM/LLM/image/provider failures degrade to
  deterministic content so the turn always resolves. Correct direction throughout
  — the only risk is *visibility*, not direction.
- **Integrity** ("the world doesn't bend to invalid input"): the authority gate,
  possession check, and NPC-canon guard. These **fail OPEN to player freedom**
  (anti-tyranny) on uncertainty, and refuse only on a clear, server-verifiable
  violation. No integrity check fails *closed into tyranny*; no availability path
  fails *open into a broken turn*.

---

## Complete table

| # | Where (file:fn) | Trigger | Falls back TO | Direction | Visibility | Live-reachable |
|---|---|---|---|---|---|---|
| 1 | `ai/openrouter.js:requestWithFallback` | cloud preferred model throws (any non-2xx incl. 402/429, network, parse) | cloud *fallback* tier model → then LOCAL `inkborne-gm:8b` | availability | **LOUD** `[GM] cloud GM call failed (…); falling back to LOCAL …` | yes |
| 2 | `ai/openrouter.js:requestOpenRouter` | any `!response.ok` from a provider | throws (caught by #1) | — | **LOUD** `[GM] LLM <status> from <base> (model)…` | yes |
| 3 | `ai/openrouter.js:requestWithFallback` | LOCAL fallback also throws | rethrows the cloud error | availability (gives up) | **LOUD** `[GM] LOCAL fallback also failed…` | yes |
| 4 | `ai/openrouter.js:requestOpenRouter` | `mockModeEnabled()` (`INKBORNE_/NOTDND_MOCK_OPENROUTER=true`) | canned tavern/lock text | n/a | silent | **mock-only** (off by default) |
| 5 | `index.js:withGmTimeout` → `narrateActionWithGm`/`narrateDeathWithGm`/`narrateVictoryWithGm` | GM narration call > `GM_ACTION_TIMEOUT_MS` (12s) **or rejects** | `null` → route keeps the deterministic mechanical template line | availability | **SILENT** ⚠️ | yes |
| 6 | `index.js` action route | `gmNarration === null` (from #5) | keep `attemptResult/talkResult/…` template line | availability | **SILENT** ⚠️ (rides #5) | yes |
| 7 | `solo/talk.js:resolveTalkAction` | no authored beat / GM unavailable | template line ("turns to regard you…") | availability | **SILENT** ⚠️ (rides #5/#6) | yes |
| 8 | `solo/attempt.js:resolveAttemptAction` | provider narration empty | `intentPhrase` line ("…doesn't come together") | availability | **SILENT** (deterministic) | yes |
| 9 | `campaign/onboarding.js:generateOpeningNarration` | 15s race timeout / pipeline rejects | `buildOpeningFallback` deterministic opening | availability | **SILENT** ⚠️ | yes (every new run) |
| 10 | `solo/gmProvider.js:resolveGmNarration` (gm-scene endpoint) | provider disabled / invalid output / exception | `safePlaceholder` + warning code on payload (`gmStatus`) | availability | **payload warning only** (no console) | yes |
| 11 | `solo/attempt.js:resolveProviderOutput` | provider output fails `validateAttemptProviderOutput` | `defaultProviderOutput` + `warnings:["ATTEMPT_PROVIDER_FALLBACK"]` (→ legacy flat-2HP) | availability | **payload warning only** (no console) | yes (~17–25% on local) |
| 12 | `gm/attemptInterpreter.js:interpretAttemptWithGm` | empty / timeout / unparseable / exception | `return null` → `buildLiveAttemptOptions` returns `{}` → engine uses #11 | availability | **SILENT** ⚠️ (server) | yes |
| 13 | `gm/attemptInterpreter.js:coerceInterpreterOutput` | parsed JSON has no actionable signal | `return null` (→ #12/#11) | availability | **SILENT** | yes |
| 14 | `solo/attempt.js:classifyIntentAuthority` | empty intent / classifier exception | `{verdict:"legitimate"}` (allow + roll) | **integrity → fail-OPEN to player freedom** | **SILENT** catch | yes |
| 15 | `solo/attempt.js:resolvePossessionClaim` | non-specific / generic word / any held match / no claim words | `{refuse:false}` (proceed to roll) | **integrity → fail-OPEN (anti-tyranny)** | n/a (deterministic) | yes |
| 16 | `gm/actionNarration.js:buildNpcCanonGuard` | no established `run.relationships`/shared facts for the NPC | "stranger / does NOT know the player" prompt stance | **integrity → fail-skeptical on canon** | n/a (prompt build, no log) | yes |
| 17 | `solo/worldGen.js:generateWorld` | `generateWithProvider` throws | `synthesize(parseWorld(null))` deterministic world | availability | **SILENT** ⚠️ catch | yes (run creation) |
| 18 | `solo/worldGen.js:synthesize/fallbackField` | any blank field after AI/player | deterministic tone-keyed defaults | availability | silent (by design) | yes |
| 19 | `solo/suggestions.js` (multiple catches) | LLM call / parse fails | deterministic 3 scene-aware suggestions | availability | **SILENT** ⚠️ catch | yes |
| 20 | `solo/imageWorker.js:runImageJob` | `generateImage` throws (Pollinations down/4xx/quota provider error) | asset → `"failed"`, scene shows placeholder art | availability | **LOGGED** `[imageWorker] slot … failed` | yes |
| 21 | `index.js` scene route (`canGenerateImage`) | free user past daily image quota & no BYOK | skip image enqueue → placeholder art (text intact) | availability (policy) | not logged (expected) | yes |
| 22 | `solo/scene.js:buildPlayerPayload` | no `resources.mp/mana/stamina` source | MP gauge `{current:0, max:0}` | availability | **SILENT** (benign default) | yes |
| 23 | `ai/providers.js:fetchText` | reference-image fetch throws | `""` | availability | **SILENT** (benign) | yes |
| 24 | `solo/actions.js:withScriptedAttemptOptions` + `testHooksEnabled` | `NODE_ENV !== "production"` **or** `NOTDND_TEST_HOOKS=true`, with `action.testHook` | scripted provider/roll bypasses live interpreter | n/a (test) | silent | **reachable in any non-prod build** ⚠️ (see deploy note) |
| 25 | `api/client.js:request` | server > 25s / network (AbortController) | reject → #26/#27 | availability | error surfaced to UI | yes (client) |
| 26 | `soloSceneShell.js:loadScene` (initial) | scene fetch rejects | `state.error` full screen: "Solo Scene Unavailable" + Retry + Return home | availability | **VISIBLE** | yes |
| 27 | `soloSceneShell.js:loadScene` (reload) | scene fetch rejects on reload | `state.banner` error, keep current scene | availability | **VISIBLE** | yes |
| 28 | `soloSceneShell.js:loadScene` (gm sub-fetch) | `fetchSoloGmScene` rejects | swallow (ambient narration is optional) | availability | **SILENT** (client) | yes |
| 29 | `soloSceneShell.js` render | payload lacks `player` | `SOLO_SAMPLE_CHARACTER` | availability | **SILENT** (benign) | edge |
| 30 | `api/client.js` | `localStorage` throws (SecurityError) | in-memory degrade | availability | **SILENT** (benign) | yes |

> Note (`0cc0e0c`, Opus 1): authority-gated attempts now also **short-circuit the
> live GM narration call** in the route — a refused/impossible intent pays no model
> latency. This changes *when* #5/#6 are reachable (not on gated turns), it does not
> add a new fallback.

> Note (`cc40a29`, Opus 1): possession (#15) and canon (#16) now have a deterministic
> **server-truth** layer (checked vs real inventory / run-state history), so they no
> longer depend on the model emitting the right flag — model-independent integrity.

---

## SILENT fallbacks on player-reachable paths (the dangerous class)

These degrade **without any server log**. A real outage here looks like working
software.

| # | Silent path | Should it warn? |
|---|---|---|
| **5 / 6** | **GM narration timeout/reject → mechanical template.** The single most dangerous one — every narratable turn, on the default local-model path; a 12s timeout serves a flat line with **zero log** (non-2xx is loud via #2, but a *timeout* logs nothing). This is the "GM goes quiet" class. | **YES** — add `[GM] action narration timed out/failed → template`. |
| **7 / 8** | talk / attempt template lines | Covered by fixing #5. |
| **9** | onboarding opening → deterministic fallback | **YES (low pri)** — a timed-out opening silently serves canned prose at the most-noticed moment. |
| **11 / 12 / 13** | interpreter null / fallback (legacy flat-2HP) | **PARTIAL** — measurable via `ATTEMPT_PROVIDER_FALLBACK` in the payload (and selfplay), but console-silent; a rate that jumped to 100% would not surface in logs. At least a debug/aggregate log. |
| **14** | authority-gate `catch → fail-open` | **YES (minor)** — fail-open is correct, but a *thrown* classifier is a bug; the exception should warn even though the action is allowed. |
| **17 / 19** | worldGen / suggestions provider catch | **YES (low pri)** — silently means "AI text gen is down"; one warn each surfaces a misconfigured provider instead of permanent deterministic output. |
| 22 / 23 / 28 / 29 / 30 | MP {0,0}; fetchText ""; client gm sub-fetch; sample char; localStorage | **NO** — benign contract defaults / genuinely-optional. |

### Could currently MASK a real failure (silent AND player-reachable)
1. **#5/#6** — GM narration timeout → template. Top risk; on the default local model 12s timeouts are plausible under load.
2. **#11/#12** — interpreter fallback (currently ~17–25% on local); only the response carries the signal.
3. **#9** — onboarding opening; hides a GM outage at first impression.
4. **#17/#19** — worldGen/suggestions; hides a down/misconfigured provider.

None of these is a *wrong-direction* failure — they all keep the game running. The
gap is **observability**, not correctness. (Fixes belong in `server/index.js` /
`server/gm` and are out of scope for this docs sweep — flagged for the owner.)
