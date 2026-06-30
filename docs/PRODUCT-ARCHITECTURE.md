# Inkborne — Two-Product Architecture & Phased Implementation Spec

> **Status: PLANNING ARTIFACT. Spec only — no implementation.** This document is a
> map to build against later. Nothing here authorizes code, app scaffolding, payment
> wiring, or content changes. It is grounded in an audit of the repo at
> `origin/main @ 7273cf9` (June 2026). Where it says "exists," a file/line was
> verified; where it says "must build," nothing exists yet.

## 0. The decision this document specs

We are splitting one codebase into **two products that share one backend and one game
engine**, differentiated by the existing `edition` field:

| | **MAINLINE** | **FORBIDDEN** |
|---|---|---|
| Surface | Native mobile app (iOS + Android, app stores) | Web app (browser, incl. mobile browser) |
| Market | Mass-market | Adult / opt-in |
| Monetization | F2P with caps + rewarded ads + **$9.99** "basic" sub | **$19.99** uncensored tier, **no ads** |
| Distribution | App Store / Play Store | Direct web only — **not** in app stores |
| GM inference | Cheap hosted cloud model | Uncensored model **hosted by us** |
| `edition` value | `"mainline"` | `"forbidden"` |
| Content rating | `teen` | `adult`, age-gated |

The critical, load-bearing fact from the audit: **this split already exists in the
data model.** `EDITIONS = ["mainline", "forbidden"]` (`server/solo/schema.js:4`), the
two policy profiles (`schema.js:1393`, `:1408`), and the model router
(`resolveGmProvider`, `server/ai/openrouter.js:87`) already route mainline→cloud and
forbidden→local-uncensored. We are not inventing the split. We are **productizing a
split the engine was already built around.**

---

## 1. Current-state audit — what's built, what's reusable

### 1.1 Stack at a glance

- **Backend:** plain Node `http` (no Express/Fastify). One server, one dispatcher
  (`handleApi`, `server/index.js:991`), ~2800 lines. Port 4173. WebSocket hub on `/ws`
  (`server/realtime/wsHub.js`).
- **Persistence:** SQLite via `better-sqlite3` (`server/db/database.js`, inline schema).
  One row per solo run (`campaigns` table, `id = runId`, `data = full run JSON blob`).
  Repository keeps an in-memory working set, persists transactionally
  (`server/db/repository.js`, `writeToDisk` `:322`). **Campaign memory** is markdown +
  YAML frontmatter on disk under `data/campaigns/<id>/` (FlexSearch-indexed,
  `server/gm/memoryStore.js`).
  - ⚠️ `server/db/schema.sql` + `seed.sql` are **orphaned** legacy VTT schema (not
    loaded). The live schema is the inline one in `database.js`. Don't build against
    the SQL files.
- **Game engine:** `server/solo/` — a real server-authoritative single-player 5e-ish
  engine. The crown jewels:
  - `actions.js` — action dispatcher (`resolveSoloAction`).
  - `attempt.js` (~1600 lines) — the freeform-intent pipeline: safety screen →
    **authority gate** (`classifyIntentAuthority`, refuses reality-commands, retcons,
    self-deification) → **possession check** (claimed items verified against real
    inventory) → roll → **structured failure-consequence engine**. Server-owned,
    deterministic, fails open.
  - `death.js` (5e lethality), `progression.js` (XP/levels), `rules.js`/`dndData.js`
    (SRD), `scene.js` (frozen scene payload contract, see `server/solo/CONTRACT.md`),
    per-verb resolvers (`movement/talk/search/rest/useItem`).
  - `schema.js` — run-state contract **and the two edition policy profiles.**
- **AI GM layer:** `server/gm/` (prompt pipeline `runGmPipeline` `prompting.js:281`,
  live attempt interpreter, memory store, narration, style). `server/ai/openrouter.js`
  is the model router.
- **Front-end:** **vanilla JS, ES modules, no build step.** `index.html` →
  `src/main.js` → 18 components. One 4061-line stylesheet. The actual game is
  `src/components/soloSceneShell.js` (**4020 lines**). The browser loads raw modules;
  the Node server serves `src/` directly.
- **Entitlements:** `server/auth/entitlements.js` — tiers `free | adventurer |
  premium`, metered on **images/day (10) and sessions/day (10)**, *not* text/turns.
  BYOK header bypasses caps. Tier set only via an admin stopgap endpoint
  (`POST /api/admin/set-tier`, `index.js:1015`). **No payment processor, no ads, no
  price constants, no age-gate enforcement exist** — all greenfield.
- **Deploy:** single Node process on Fly.io (`fly.toml`, region `iad`), Docker
  (`node:20-alpine`), persistent volume at `/data`. WebSocket + persistent disk
  required.

### 1.2 The edition routing that already maps to the split

```
resolveGmProvider(edition)            server/ai/openrouter.js:87
  edition === "mainline"  → cloud:  resolveLlmBaseUrl() + narrative model + API key
  edition === "forbidden" → local:  http://127.0.0.1:11434 (Ollama), dolphin-llama3:8b,
                                     key:null, local:true   ("content never leaves the box")
  { fallback:true }       → local   (cloud→local recovery, on by default)
```

The two policy profiles already encode distribution and rating intent:

```
mainline  (schema.js:1393)  rating: teen,  ageGate: false, channels: web/play_store/app_store
forbidden (schema.js:1408)  rating: adult, ageGate: true,  channels: web/direct_apk/steam
```

Blocked-tag lists differ (`schema.js:13`): forbidden relaxes `explicit_sexual_content`,
`explicit_anatomy`, `erotic_captivity` — but **both editions still hard-block**
`sexual_violence`, `trafficking`, `sexual_slavery`, `nonconsensual_sexual_content`,
`forced_pregnancy`. (This is a deliberate red-line that survives into Forbidden; see §4
liability.)

### 1.3 Reuse matrix

| System | Files | Serves both as-is? | Notes |
|---|---|---|---|
| Game engine (actions, attempt, authority gate, possession, death, progression, rules, dice) | `server/solo/*`, `server/rules/*` | ✅ **As-is** | Edition-agnostic; passes `edition` as data, doesn't branch behavior. This is the moat — protect it. |
| Edition policy profiles | `server/solo/schema.js:1393-1421` | ✅ **As-is, already branches** | Already the per-product content/rating/channel switch. |
| Model router (cloud vs local-uncensored) | `server/ai/openrouter.js:87` | ✅ **As-is, already branches** | Forbidden hosting is the only real change (§4): move "local" from a dev box to our GPU. |
| AI GM / memory / prompt layer | `server/gm/*` | ✅ **As-is** | Threads `edition`; shared. |
| Persistence (SQLite + markdown memory) | `server/db/*`, `data/campaigns/*` | ✅ **As-is** | One store, both products. |
| HTTP API surface | `server/index.js` | ✅ **Mostly** | Add: ads/IAP receipt verification, real billing, age-gate routes. Remove nothing. |
| Entitlements policy | `server/auth/entitlements.js` | ⚠️ **Rework** | Needs real tiers per product ($9.99 mainline / $19.99 forbidden), ad-grant credits, receipt-backed tier source instead of admin stopgap. |
| Solo game UI shell | `src/components/soloSceneShell.js` (4020 LOC) | ⚠️ **Major responsive rework** | Desktop/ultrawide-first; see §2. Same shell can serve both products. |
| Legacy VTT/dashboard surfaces | `vttTable.js`, `campaignForge.js`, `aiGmConsole.js`, `commandCenter.js`, `compendium.js`, `homebrew*.js` (~2800 LOC) | ❌ **Not needed for mobile mainline** | Product spine already marks these legacy/internal. Don't ship them in the mobile app. |
| Marketing landing page | `notdnd/index.html` (standalone) | ➖ Separate | Independent; fine as-is. |
| Age-gate | *(none — flag only declared, never enforced)* | ❌ **Must build** | `ageGateRequired:true` is set but **no code reads it.** Forbidden cannot ship without this. |
| Payments / ads | *(none)* | ❌ **Must build** | Entirely greenfield; see §4 for the unknowns. |

---

## 2. MAINLINE — the mobile-app path

### 2.1 The path decision: **Capacitor (hybrid wrap of the existing web UI).**

**Recommendation: wrap the existing vanilla-JS SPA in Capacitor.** Not a native
rebuild, not a bare PWA.

**Reasoning:**

1. **The UI is already web and framework-free.** There is no React Native / Flutter
   asset to port and no JS framework lock-in. A native rebuild throws away
   `soloSceneShell.js` (4020 LOC) and reimplements the scene contract, action bar,
   character sheet, map, and VN overlay twice (iOS + Android). That is months of work
   to reproduce something that already renders.
2. **App stores require a store presence + native SDKs for ads and IAP.** A pure PWA
   cannot list in the App Store and has poor/again-restricted access to AdMob and
   StoreKit/Play Billing. Mainline's whole monetization model (rewarded ads + IAP sub)
   **requires native SDK bridges**, which is exactly what Capacitor provides
   (`@capacitor-community/admob`, native IAP plugins) while keeping the web UI.
3. **Backend stays untouched.** Capacitor app talks to the same `/api/*` + `/ws`
   endpoints over HTTPS. No API rewrite.
4. **One UI codebase for both products.** The same responsive shell (once reworked)
   serves the Capacitor mainline app *and* the Forbidden web app — divergence is config
   (`edition`, theme, age-gate), not a fork.

**Rejected alternatives:**
- *Native rebuild (Swift/Kotlin or React Native/Flutter):* highest cost, double the UI
  surface, no reuse of the engine's client. Only justified if we hit a hard
  Capacitor performance wall — we won't, the UI is text/scene/portrait-driven, not a
  60fps game canvas (the only canvas is the optional battle map).
- *Pure PWA:* free, but **cannot satisfy the app-store + rewarded-ads + IAP
  requirements** that define the mainline business model. Viable only if we abandon
  app-store distribution — which contradicts the decision.

> **Trade-off to accept with Capacitor:** app-store IAP takes a **15–30% cut** (see
> §4). That tax is the price of the mass-market store channel. Forbidden (web,
> ~5% MoR) is the hedge.

### 2.2 What of the current UI survives vs needs rework

**Survives (logic intact):**
- The entire scene-contract data flow: `src/api/client.js` REST calls, the scene
  payload shape, action dispatch, character/inventory/journal/map data, VN state
  derivation. None of this cares about viewport.
- `soloSceneShell.js` render functions (template-string → DOM). The *content* is fine.

**Needs mobile-first responsive rework (the honest scope):**

The shell is **explicitly built for ultrawide desktop** and only degrades to ~tablet:

- `.solo-game-shell` is full-bleed `width: 100vw` (`styles.css:1489`), and **locks to
  the viewport with `height:100vh; overflow:hidden` above 1081px** (`styles.css:2537`)
  — a no-scroll desktop cockpit.
- The frame is a **3-column flex row** [character sidebar | scene | rail]
  (`styles.css:1588`): sidebar `clamp(260px,18vw,340px)`, rail `clamp(200px,15vw,280px)`,
  frame `min-height:620px`.
- The Scene tab is itself a **2-column grid** [scene-center | NPC column]
  (`styles.css:2379`).
- Ultrawide gets *extra* side padding above 1600px (`styles.css:2555`).
- The home dashboard is a 3-area grid that only composes above **1400px**
  (`styles.css:3501`).
- **The columns collapse to a single column only at `≤1080px`** (`styles.css:2561`).
  **There is no phone-width (`≤640px`) handling for the game shell at all** — the only
  640px rules touch the VN overlay, onboarding art, and the character wizard. On a
  ~375px portrait phone the sidebar/rail stack but keep `min-width:260px`-class
  minimums and a `620px` min-height: heavy crowding, oversized panels, no thumb
  ergonomics.

So the mainline mobile rework is a **real, scoped front-end project**, not a
`@media` afterthought:

1. **Portrait-first information architecture.** The desktop "everything visible at
   once" cockpit (map + sheet + scene + rail + VN) cannot coexist in a 375×812 viewport.
   Convert the always-on side columns into **bottom-tab / bottom-sheet surfaces** (the
   tab bar already exists in `soloSceneShell.js:1031`: Scene, Actions, Character,
   Inventory, Map, Journal). Scene becomes the default full-screen view; Character and
   the NPC rail become a swipe-up sheet or a tab, not a permanent column.
2. **Drop `height:100vh; overflow:hidden`** on mobile — phones need scroll and must
   tolerate the browser/keyboard chrome and `dvh` quirks. The VN overlay already does
   the right thing (`100dvh` fullscreen at ≤640px, `styles.css:2812`); generalize that
   pattern.
3. **Touch targets & input.** Action bar buttons, dice, and the freeform-intent text
   box need ≥44px targets and keyboard-safe layout. The battle map (`battleMapEngine.js`,
   `vttTable.js`, fixed 5ft tiles) needs pinch-zoom/pan or a simplified mobile map mode —
   it has **no mobile sizing today.**
4. **Map is optional on mobile.** Mainline's loop is scene/narration/relationship, not
   tactical combat. Recommend the map be a **secondary, lazy-loaded tab** on mobile,
   not a first-class column.
5. **Theme/skin system survives** (skins + font sets persist via localStorage,
   `main.js`); just needs mobile type scales.

**Scope estimate (honest):** this is a meaningful slice of work — roughly a
**ground-up responsive rework of the 4020-line shell's layout layer** (not its logic),
plus a Capacitor harness, plus native ad/IAP plugin integration. It is the single
largest engineering line item in the mainline path. It is *not* a rewrite of the game.

### 2.3 What mainline does NOT ship
- Legacy VTT/multiplayer dashboard (`vttTable`, `campaignForge`, `commandCenter`,
  `aiGmConsole`, `compendium`, homebrew studio). Product spine already calls these
  legacy. They bloat the bundle and confuse the mass-market funnel.

---

## 3. FORBIDDEN — the web-app path

### 3.1 What it shares with mainline
- **Everything in the engine and backend.** Same `server/solo/*`, same API, same
  persistence, same memory graph, same authority gate / possession / lethality moat.
- **The same responsive UI shell** (§2.2). Forbidden is a *browser* app (incl. mobile
  browser), so it directly benefits from the same mobile-first rework — but it ships as
  a website, not a Capacitor binary. No app-store packaging.

### 3.2 How it diverges (all already hooks that exist or are thin additions)

| Axis | Mainline | Forbidden | Mechanism |
|---|---|---|---|
| `edition` | `"mainline"` | `"forbidden"` | Run-creation sets it; everything downstream already branches. |
| Content policy | `MAINLINE_BLOCKED_TAGS` (8) | `FORBIDDEN_BLOCKED_TAGS` (5) | `schema.js:13`; `validateEntityAgainstPolicy` already enforced across all resolvers. |
| GM model | cloud (hosted, censored-ok) | **our-hosted uncensored** | `resolveGmProvider` already routes forbidden→local. **The change is hosting** (§4): the "local Ollama" endpoint becomes a real GPU-backed service we operate. |
| Ads | rewarded ads | **none** | Forbidden has no ad SDK at all. |
| Price | $9.99 sub | **$19.99 uncensored tier** | New tier in entitlements. |
| Distribution | app stores | **web only** (no store) | No app-store review = no platform content veto. This is *why* Forbidden is web. |
| Age-gate | none | **required, enforced** | `ageGateRequired:true` exists as data but **must be built** — DOB/affirmation wall + server gate before any forbidden run/scene. |
| Payment rails | store IAP (15–30%) | web Merchant-of-Record (~5%) | Different processors; the MoR/adult-acceptance question is the §4 critical unknown. |

### 3.3 What Forbidden must build that mainline doesn't
1. **Real age-gate enforcement** (data flag exists, enforcement doesn't). At minimum:
   a hard 18+ affirmation + DOB wall before account/run creation, server-side gate on
   every `edition:"forbidden"` route, and a stored, auditable consent record. Possibly
   third-party age verification depending on jurisdiction (flag — legal decision).
2. **Hosted uncensored inference** (§4) — the GPU/model service, content isolation, and
   the cost model behind it.
3. **Adult-tier billing** through a processor that will accept adult content (§4 — the
   single biggest unknown).

---

## 4. Open questions & risks — **owner/external decisions, not solved here**

These are flagged, not answered. Each blocks or reshapes a downstream phase.

### 4.1 🔴 CRITICAL — Will any payment processor accept the Forbidden adult tier?
**This is the load-bearing unknown for the entire $19.99 product.** Stripe and most
mainstream processors **prohibit or restrict explicit adult content.** Adult-friendly
rails exist (e.g. specialist MoRs / adult-payment providers) but carry higher fees,
stricter onboarding, reserve requirements, and chargeback scrutiny. **If no processor
will bank Forbidden, the $19.99 product has no revenue path regardless of how good the
engine is.** → **Decide/validate this BEFORE building Forbidden billing or even
committing to the Forbidden launch.** This is a go/no-go gate, not an implementation
detail.

### 4.2 🟠 App-store cut (15–30%) vs web Merchant-of-Record (~5%)
Mainline IAP through Apple/Google takes **15% (small-business / post-year-1 sub) to
30%**. Forbidden web billing via a MoR is **~5–8% all-in** (incl. tax/VAT handling).
This materially changes unit economics and may argue for steering price-sensitive users
to web. → Owner/finance decision on pricing and whether to surface a web purchase path.
(Note Apple/Google anti-steering rules constrain how much the app can *say* about
cheaper web pricing.)

### 4.3 🟠 Hosting + liability of serving uncensored content from our servers
Today forbidden inference runs on a **local box** ("content never leaves the box",
`openrouter.js:55`). Productizing Forbidden means **we host the uncensored model and
serve adult content from our infrastructure.** Implications to decide: jurisdiction of
hosting, 2257-style record-keeping exposure (US), the EU/UK adult-content + age-
verification regimes, the hard red-lines we keep even in Forbidden
(`FORBIDDEN_BLOCKED_TAGS` already keeps sexual-violence/CSAM-adjacent/trafficking
blocks — **these must never relax**), DMCA/abuse handling, and content-moderation
liability. → Legal + infra-owner decision.

### 4.4 🟠 Forbidden GPU / inference cost
An uncensored open model served by us (vs. a free hosted cloud key for mainline) means
**we own the GPU bill** for every Forbidden turn. Need: model choice, tokens/turn
estimate, GPU host (rented vs. serverless GPU), and the cost-per-active-subscriber that
makes $19.99 sustainable. → Infra/finance modeling. Feeds directly into §4.1's pricing.

### 4.5 🟡 Ad-SDK options on the Capacitor path
Rewarded ads on Capacitor: AdMob via `@capacitor-community/admob` is the default;
alternatives (ironSource/AppLovin MAX mediation) affect fill rate and eCPM. → Decision
on ad network + mediation, and on the rewarded-ad grant model (what an ad-view buys:
image credits? a session? — see §5 entitlement rework).

### 4.6 🟡 Age-gate sufficiency / jurisdiction
Whether a self-attested 18+ wall is legally sufficient or whether hard age verification
(ID/third-party) is required varies by jurisdiction and is tightening (US state laws,
UK OSA, EU). → Legal decision; affects Forbidden launch geos.

---

## 5. Phased roadmap — today → shipped

**Dependency-ordered. The gate in Phase 0 is non-negotiable.**

```
        ┌─────────────────────────────────────────────────────────────┐
        │ PHASE 0 — CORE-IS-GOOD GATE  (must pass before ANY pivot work)│
        └─────────────────────────────────────────────────────────────┘
                                   │ (gate)
        ┌──────────────────────────┼───────────────────────────┐
        │                          │                           │
   PHASE 1                    PHASE 2 (parallel)          PHASE 3 (parallel,
 Responsive UI rework      Business/legal de-risk         after Ph1 lands)
 (serves BOTH products)    (§4 decisions)                 Capacitor + ads + IAP
        │                          │                           │
        └──────────┬───────────────┴───────────┬───────────────┘
                   │                            │
            PHASE 4 MAINLINE launch      PHASE 5 FORBIDDEN launch
            (mobile, app stores)         (web, age-gate, hosted uncensored)
                                         — gated on §4.1 payment go/no-go
```

### Phase 0 — **CORE-IS-GOOD GATE (manual play-verification). BLOCKING.**
**Nothing in the pivot starts until this passes.** Before spending a dollar on mobile
packaging, ads, payments, or GPU hosting, **prove the game is worth shipping.**
- **Manual playthrough:** a human plays multiple full solo campaigns end-to-end
  (onboarding → multi-session run → consequence/lethality/relationship payoff) and
  judges: *is the core loop actually good?* Does the world remember? Do choices matter?
  Is the GM coherent? (This is the product-spine MVP goal, not a metric.)
- **Automated backstops already exist** — keep them green as the floor, not the bar:
  `scripts/selfplay.mjs` (6 invariants: CONSEQUENCE, LETHALITY, GATING, COHERENCE,
  PERSISTENCE, GM HEALTH), `tests/solo-authority-gate.test.js`,
  `solo-possession-check.test.js`, `solo-lethality.test.js`, state-contract test.
- **Recall the memory note:** "GM goes quiet" is recurringly a *config* issue (live
  LLM key/model/quota), not a code bug — verify the hosted GM is actually answering
  during the playthrough before judging quality.
- **Exit criterion:** owner says "the core is good" on real play. ❌ If not → fix the
  loop (the moat is the engine; polish it) before pivoting. **Do not build mobile/ads/
  payments on top of a core that isn't fun.**

### Phase 1 — Mobile-first responsive UI rework *(parallelizable across the two products; serves both)*
- Rework `soloSceneShell.js` layout layer for portrait/touch (§2.2): bottom-tab IA,
  drop desktop viewport-lock on mobile, touch targets, map → optional tab.
- Keep all engine/data flow untouched. Verify on real phone browsers (this *is*
  Forbidden's shippable UI, and mainline's web view).
- **Output:** one responsive web UI that both products consume.

### Phase 2 — Business/legal de-risk *(parallel with Phase 1; mostly non-engineering)*
- Resolve §4.1 (adult payment processor — **go/no-go for Forbidden**), §4.3 (hosting/
  liability), §4.4 (GPU cost model), §4.2 (pricing vs store cut), §4.6 (age-gate
  sufficiency).
- **These are owner/legal/finance decisions and gate Phases 4–5.** Start them at the
  same time as Phase 1 so engineering isn't blocked waiting on legal later.

### Phase 3 — Mainline packaging: Capacitor + ads + IAP *(after Phase 1 UI lands)*
- Wrap the responsive UI in Capacitor (iOS + Android shells).
- Integrate rewarded-ads SDK (§4.5) and store IAP for the $9.99 sub.
- **Entitlement rework** (`server/auth/entitlements.js`): real tier source backed by
  IAP receipt verification (replace the admin `set-tier` stopgop), ad-view → credit
  grant model, $9.99 mainline tier.
- App-store metadata, review prep, privacy labels.

### Phase 4 — **MAINLINE launch** (app stores)
- Ship Capacitor app, F2P caps + rewarded ads + $9.99 sub. Cloud GM.
- Mass-market funnel; legacy VTT surfaces excluded.

### Phase 5 — **FORBIDDEN launch** (web) — *gated on §4.1*
- Build **age-gate enforcement** (the missing piece — flag exists, code doesn't).
- Stand up **hosted uncensored inference** (§4.3/§4.4): move forbidden routing from the
  dev-box Ollama to a real GPU service; preserve content isolation and the non-relaxing
  red-lines.
- Wire **adult-tier billing** ($19.99) through the validated processor (§4.1). No ads.
- Ship as web app (incl. mobile browser), no app store.

**Parallelizable:** Phase 1 ∥ Phase 2. After Phase 1: Phase 3 (mainline packaging) ∥
Forbidden's age-gate + hosting prep. **Strictly serial:** Phase 0 gates everything;
§4.1 gates Phase 5.

---

## 6. What NOT to build yet (and why)

1. **Don't touch the game engine (`server/solo/*`).** It's the moat and it's
   edition-agnostic already. Stability here is the whole asset. No "refactor for the
   split" — the split needs no engine change.
2. **Don't build payments/billing before §4.1 is answered.** Building Forbidden billing
   before confirming a processor will bank adult content risks building a checkout with
   no bank behind it. Confirm the rail first.
3. **Don't build the age-gate or hosted uncensored inference before Phase 0 passes.**
   These are Forbidden-only, expensive, and pointless if the core loop isn't good.
4. **Don't do a native (Swift/Kotlin/RN/Flutter) rebuild.** Capacitor reuses the web
   UI; a native rebuild doubles the UI surface for no engine benefit. Revisit only if a
   hard perf wall appears (it won't, for a text/scene/portrait game).
5. **Don't port the legacy VTT/dashboard surfaces** (`vttTable`, `campaignForge`,
   `commandCenter`, `aiGmConsole`, `compendium`, homebrew studio) into either product.
   They're marked legacy; they dilute both funnels.
6. **Don't relax `FORBIDDEN_BLOCKED_TAGS`.** "Uncensored" means model-side latitude on
   adult/explicit *consensual* content — it does **not** mean removing the
   sexual-violence/trafficking/non-consensual red-lines. Those stay blocked in both
   editions for legal survival.
7. **Don't optimize GPU cost / pick the final uncensored model before §4.4 modeling.**
   Premature infra commitment ahead of the cost-per-subscriber math.
8. **Don't build a real-time/multiplayer or human-NPC layer.** Out of scope for both
   products at launch (product spine: future premium layer only).

---

## 7. Key recommendations (summary)

1. **Capacitor for mainline** — wrap the existing vanilla-JS web UI; do not rebuild
   native. It's the only path that reuses the engine client *and* unlocks app-store
   ads + IAP.
2. **One responsive UI shell serves both products** — the mobile-first rework of
   `soloSceneShell.js` is Forbidden's shippable website *and* mainline's Capacitor web
   view. Do it once (Phase 1).
3. **The split is already in the data model** — `edition` + the two policy profiles +
   `resolveGmProvider` do the routing today. Productizing = adding age-gate, billing,
   ads, and hosted inference *around* an engine that already branches correctly.
4. **Phase 0 is a hard gate** — manually verify the core loop is good before any pivot
   spend. The engine is the moat; don't bolt monetization onto an unproven core.
5. **The largest single eng item is the responsive UI rework**, not the split itself.

## 8. Critical open questions needing owner decision before implementation

1. 🔴 **Will a payment processor bank the Forbidden adult tier?** Go/no-go for the
   entire $19.99 product. Validate first. (§4.1)
2. 🟠 **Hosting jurisdiction + legal liability** for serving uncensored content from our
   servers (records/age-verification regimes; keep red-lines). (§4.3)
3. 🟠 **GPU/inference cost model** that makes $19.99 sustainable. (§4.4)
4. 🟠 **Pricing strategy** given app-store 15–30% cut vs web MoR ~5%. (§4.2)
5. 🟡 **Age-gate sufficiency** (self-attestation vs hard verification) per launch geo.
   (§4.6)
6. 🟡 **Ad network + rewarded-ad grant model** for mainline. (§4.5)

---
*Audit basis: `server/ai/openrouter.js`, `server/auth/entitlements.js`,
`server/solo/schema.js`, `server/solo/attempt.js`, `server/index.js`,
`src/components/soloSceneShell.js`, `src/styles.css`, `fly.toml`, and the existing
`docs/inkborne-*.md` product spine. Verified at `origin/main @ 7273cf9`.*
