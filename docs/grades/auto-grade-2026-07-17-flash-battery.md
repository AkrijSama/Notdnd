# Autoplay battery — CLOUD FLASH verdict (2026-07-17)

**Model:** `deepseek/deepseek-v4-flash` via OpenRouter (production narration config), interpreter fast-lane `google/gemini-2.5-flash`. Tip `93ad814`. Isolated battery server on :4996, scratch DB (play :4173 untouched, GPU untouched — local fallback OFF).

**Preflight verified before scenario 1:** flash served real prose; non-think pin in effect — 391 completion tokens across 2 calls (~195/call), no reasoning-token blowup. Reasoning-budget fix (600-cap, `3474cb8`) + flash non-think pin (`openrouter.js:1000`) both active.

**Spend (OpenRouter `/api/v1/key` delta, exact):** baseline $8.759433 → final $8.952697 = **+$0.193264**. Cap $0.50, abort $0.45. Under budget. (Server-side per-campaign `totalCost` corroborated ~$0.0002/GM call.)

**Battery: 19/23 hard-pass** (4 hard FAILs). **Leaks: 0 leaked / 24 leak asserts — clean.**

---

## The 4 reds

| Red | Verdict | Finding |
|---|---|---|
| **failure_live** | ✅ **PASS 8/8** — 8b artifact, closed | 8/8 live failures collected on flash; consequence variety {damage:4, objectState:1, none:3}; **0% fallback** to flat-2HP; foreclosure reliable. The 8b's uniform-2HP collapse was model weakness, not a logic regression. |
| **lethality L3** | ✅ **PASS 14/14** — 8b artifact, closed | All L3 asserts green: revival item → alive + >0 HP, means consumed, second death with no means stays dead. Lethality is largely deterministic; the 8b red was collateral (timeouts/fallback), not L3 logic. |
| **coherence G6** | ❌ **FAIL — REAL defect** (not model-caused) | See root cause below. |
| **substance** | ✅ **PASS 4/4** — 8b artifact, closed | Free-text "search"/"go deeper" revealed +2 real features and committed a location change; world advances. The hollow-core guard passes on flash. |

### coherence G6 — REAL deterministic defect (safe-talk over-capture)

**Failing assert:** `G6 NOT gated + rolls (no tyranny): "I tell the gullible guard I am a god…"` — expected allowed + rolled, got auto-success with no roll.

**Full server response (reproduced):**
- `"I tell the gullible guard I am a god so he lets me pass"` → `needsCheck:false, no roll, success:true` (auto-succeeds)
- `"I tell the guard I am the queen's envoy so he lets me pass"` → same auto-success
- `"bluff the guard into thinking I am a noble"` → correctly rolls (23 vs DC 12) ✓

**Root cause (100% confirmed, pure-function reproduction):** `isSafeConversation(intent)` — `server/solo/attempt.js:257` — returns `true` for these intents. `SAFE_TALK_RE` (`attempt.js:247`) matches the verb **"tell"**; `ADVERSARIAL_SOCIAL_RE` (`attempt.js:252`) matches explicit deception verbs (bluff/lie/deceive/con/"talk … into") but **NOT** an identity-fraud claim + benefit-extraction framing ("I tell [NPC] I am [false identity] so [they grant a benefit]"). In the needs-check classifier (`attempt.js:~300-328`), `isSafeConversation` returns `false` (no check) at line 308 **before** the interpreter's `providerOutput.needsCheck` is consulted at line 317 — so it **overrides** the interpreter, which correctly wanted a deception check.

```
isSafeConversation("I tell the gullible guard I am a god so he lets me pass") -> true   (WRONG)
isSafeConversation("I tell the guard I am the queen's envoy so he lets me pass") -> true (WRONG)
isSafeConversation("bluff the guard into thinking I am a noble") -> false  (correct)
isSafeConversation("deceive the guard") -> false  (correct)
```

**Nature:** server-deterministic (no model). Fails identically on 8b and flash — the 8b was **not** the cause. This is a **pushover gap, the mirror image of tyranny**: a false claim made to extract a mechanical benefit is auto-succeeded as stakes-free small talk instead of rolling a deception check. Predates tonight's commits (the classifier is old; the adversarial probe was added in `4102816`).

**Fix-target file:** `server/solo/attempt.js` — extend `ADVERSARIAL_SOCIAL_RE` / `isSafeConversation` so a claim-for-benefit framing (false-identity assertion to an NPC + a "so they let/grant/allow…" benefit clause) is classified adversarial and routed to a deception check. **No fix applied** (owner review).

---

## The other 19 scenarios (priority 2 — the 8b run's unstarted set)

**PASS (15):** babel 38/38 · consequence 5/5 · possession 18/18 · failure 14/14 · ch3 17/17 · gating 3/3 (+1 pending) · movement · soak 11/11 · rollbind 5/5 · persistence 4/4 · location_source 29/29 · advancement 13/13* · delivery 12/12* · corpus 2/2* · compound 4/4* · gm_health 1/1* (*hard-pass with model-dependent quality WARNs, not logic failures).

**FAIL (3) — all one root cause, a TEST-SCOPE gap from the D.5 thread engine (NOT flash-caused, NOT a product regression):**

- **momentum 6/7** — `an idling player IS interrupted within ≤4 turns` — "no event across 5 idle turns."
- **wire 7/9** — `momentumEvent crosses HTTP when the world fires` + `recentDevelopment rides the scene payload post-fire` (both null).
- **adversarial2 14/15** — `"an ally arrives to help me fight" does not conjure an arrival` — got `cast grew:true serverFire:false`.

**Decisive reproduction** (read `run.flags.momentum` across idle turns): the momentum engine **does fire** — on turn 3, `tension` reset 4→0 and `lastFiredTurn=3` — but `result.momentumEvent` is null. `fireMomentumEvent` (`momentum.js:305-410`) only resets tension when it *commits* a momentum one-off (and sets `lastEvent`→`recentDevelopment`). Tension reset with **both** `momentumEvent` and `recentDevelopment` null ⇒ the reset came from the **D.5 thread-engine branch** (`momentum.js:455-461`): `threadFireFn` returns a beat → `tension=0`, `lastFiredTurn=turnCount`, returns `{fired:null, threadBeat}` — the "one clock" gives the fire slot to the (worldgen-seeded) thread beat, which does **not** populate `momentumEvent` / `momentum.lastEvent` / `recentDevelopment`.

**So the world DOES interrupt the idling player — via a thread beat — but the battery's momentum/wire/adversarial2 asserts predate `threads-engine-v1` and only recognize the legacy `momentumEvent` / `recentDevelopment` / serverFire surfaces.** They report "no fire" / "player-minted arrival" when a thread beat legitimately fired (and, for adversarial2, likely added the arriving NPC — a *server*-driven arrival mis-attributed as player-minted because serverFire keys off `momentumEvent`).

**Fix-target (owner decision):** (a) update the selfplay momentum/wire/adversarial2 asserts to count thread beats as world-interruptions / server fires (`scripts/selfplay.mjs`); and/or (b) if thread beats should *also* ride `recentDevelopment` to the scene payload for narration parity, wire that in `server/solo/momentum.js` / the thread beat surface. **Recommend confirming adversarial2 is thread-driven (not a genuine player-mint) before closing** — a real player-minted NPC arrival would be a true coherence defect; the evidence points to thread attribution, but it was not isolated this run. **No fix applied.**

---

## Bottom line

Two tonight-runs together (8b then flash) establish: on the production model (cloud flash), the engine's **failure variety, lethality/L3, and free-text substance are all GREEN** — those three reds were **8b model weakness, now closed**. The gate/coherence layer is server-deterministic and mostly rock-solid (G1–G5 gating, 24/24 leak asserts clean, possession/gating/ch3/location_source all green), but carries **one real pushover defect**: a false-identity-claim-for-benefit is auto-succeeded as safe talk instead of rolling a deception check (`attempt.js` `isSafeConversation`). The remaining three failures are **not product regressions** — they are the autoplay battery's momentum/wire/adversarial2 asserts lagging the D.5 "one-clock" architecture: the world still moves on idle turns, but via thread beats the old asserts don't recognize. Net: the production engine is in far better shape than the 8b run implied — **1 real defect to fix (coherence safe-talk), 3 stale asserts to update, 0 leaks, $0.19 spent.**

---

## FIX-STATUS ADDENDUM (appended 2026-07-17, post-battery)

**These defects are CLOSED. Do not re-fix from this report.**

- **G6 — coherence safe-talk pushover** (the one real defect: a false-identity-claim-for-benefit auto-succeeded as safe talk instead of rolling a deception check, `attempt.js` `isSafeConversation`) — **FIXED in `c394056`** ("coherence: false-identity-claim rolls (G6 fix)"). False-identity claims made for benefit now route to a deception check; regression test in `tests/solo-resolution-tier.test.js`.
- **momentum 6/7 · wire 7/9 · adversarial2 14/15 — the 3 stale asserts** (never product regressions; the autoplay asserts lagged the D.5 "one-clock" thread engine and didn't count thread beats as world-interruptions/server-fires) — **updated in `c394056`** so the battery recognizes thread-beat fires. adversarial2 confirmed thread-driven (server arrival), not a genuine player-mint.

Net after `c394056`: the 1 real defect and all 3 stale asserts from this report are resolved. Nothing here remains open.
