# Payment Rail — Groundwork, Caps Gap, and Whale-Defense Spec

**Status:** Groundwork wired + report. One paid-tier gate (LemonSqueezy webhook →
tier) is built, signature-verified, config-gated-off, and proven end-to-end in
test — **no processor is live**. The token-budget cap is a spec (design +
numbers), not built. Nothing here authorizes go-live.

## 1. What the entitlement caps actually meter (verified)

`server/auth/entitlements.js` + `server/db/repository.js`:

| Dimension | Metered? | Where |
|---|---|---|
| Images / day | **Yes** — free = 10/day | `TIER_LIMITS`, `getDailyUsage().images` |
| Sessions / day | **Yes** — free = 10/day | `TIER_LIMITS`, `getDailyUsage().sessions` |
| **Turns / GM calls / tokens** | **No — not metered at all** | — |
| Paid tiers (adventurer/premium) | **`Infinity` on both** | `TIER_LIMITS` |

So the meter is images + sessions per UTC day, persisted per user
(`db.dailyUsageByUser`). **Text/tokens are unmetered, and paid tiers are
unbounded** — a paid user can consume unlimited GM inference. The daily counter
is the only billing-grade persisted usage; there is no per-user token/spend
ledger anywhere (the in-memory `usageByCampaign` in `openrouter.js` resets on
restart and is per-campaign, not per-user).

## 2. The caps gap (the whale exposure)

Marginal cost is **text tokens**, which nothing caps. Measured (see the
unit-economics instruments, `scripts/econ-measure.mjs`): **$0.109 / 35-turn
session** all-llama-70b, **$0.052** routed (70b narration + 8b utility). A $9.99
sub nets ~$8.99 after LemonSqueezy (5% + $0.50).

| Sessions/mo | Spend (all-70b) | Margin | Spend (routed) | Margin |
|---|---|---|---|---|
| 30 | $3.27 | $5.72 | $1.56 | $7.43 |
| 60 | $6.54 | $2.45 | $3.12 | $5.87 |
| ~83 | $9.05 | **underwater** | — | healthy |
| ~170 | — | — | $8.84 | **underwater** |

A normal user is deeply profitable. The gap is the **abuser/whale**: an
`adventurer` at `Infinity` sessions can script 500 sessions/mo → ~$54 (all-70b),
$45 underwater on a $9 sub. Nothing stops it today.

## 3. Whale-defense spec — a per-user token budget (NOT built)

Cap the *thing that costs money* (tokens), not sessions, with a rolling monthly
per-user budget that guarantees margin. Mirrors the existing daily-usage counter.

- **Ledger primitive** (new, mirrors `incrementImageCount`): `recordTokenUsage(userId, {prompt, completion})` and `getMonthlyTokenUsage(userId)`, persisted in `db.tokenUsageByUser` keyed by `userId` + UTC month. The write point already exists: `requestViaCloudChain` returns `tokensUsed` on every GM call — increment there, attributed to the acting user (thread `actorUserId` already flows to the GM layer).
- **Budget per tier** (guarantees ≥50% margin at the measured routed cost):
  - `adventurer` soft cap **≈ 8M tokens/month** (~150 sessions routed ≈ $4.30 spend, ~52% margin). Hard cap **≈ 12M** (~breakeven).
  - `free` is already bounded by the 10 sessions/day cap; a token cap is belt-and-suspenders.
- **At the soft cap:** transparently **downgrade routing to the cheap lane** (force 8b utility + keep 70b narration, or 8b-only past the hard cap) rather than hard-blocking play — the user keeps playing, the margin holds. Surface a soft "unusually high usage" notice (the `entitlementSummary` pattern).
- **At the hard cap:** soft-block *new sessions* for the rest of the month (existing sessions finish), same 429+upsell shape as `enforceSessionEntitlement`.

This is a spec: the ledger + budget enforcement is go-live work (§5), deliberately
not wired into the hot GM path now.

## 4. The paid-tier gate that IS wired (groundwork, tested)

`server/api/lemonsqueezy.js` + `POST /api/webhooks/lemonsqueezy`
(`tests/payment-webhook.test.js`, 12 tests green):

- **Receipt-backed tier source** replacing the admin stopgap the plan flags
  (`PRODUCT-ARCHITECTURE.md:110,364`): a signed LemonSqueezy webhook flips the
  buyer's tier via `setUserTier` — `subscription_created/updated/resumed/order_created` → the mapped tier; `cancelled/expired/paused`/non-entitling status → `free`.
- **HMAC-SHA256 signature verification** against the raw body (timing-safe); a bad
  signature is 401 and never changes a tier.
- **Buyer match:** checkout `custom_data.user_id` first, email fallback
  (`findUserByEmail`). Unmatched → 202 ack (no change); bad user_id → 422.
- **Go-live safety:** the route is **404/disabled unless `LEMONSQUEEZY_WEBHOOK_SECRET` is set.** The admin `set-tier` stopgap remains for manual grants.
- **Variant→tier** via `LEMONSQUEEZY_VARIANT_ADVENTURER` / `_PREMIUM` env, so the
  owner binds real store variants at launch without a code change.

Proven end-to-end without a live processor: signed `subscription_created` →
`free`→`adventurer` (unlimited); signed `subscription_expired` → back to `free`;
tampered signature → rejected; no secret → inert.

## 5. What "go-live" requires (owner/launch decisions)

1. **Create the LemonSqueezy store + the $9.99 "adventurer" product variant**, set `LEMONSQUEEZY_WEBHOOK_SECRET` + `LEMONSQUEEZY_VARIANT_ADVENTURER` in prod, and point the store's webhook at `/api/webhooks/lemonsqueezy`. (The $19.99 Forbidden/premium tier is **blocked** on `PRODUCT-ARCHITECTURE.md` §4.1 — will any MoR bank adult content — and is intentionally not wired.)
2. **Build the token-budget ledger + enforcement** (§3) — the whale-defense; unbounded paid inference is the one real financial risk once payments are on.
3. **A checkout entry point** in the client (a "Go Adventurer" button → LemonSqueezy hosted checkout with `custom_data.user_id`), and surfacing `subscription` state in `entitlementSummary`.
4. **Harden the free tier before strangers** (from the earlier ship-delta audit): `NODE_ENV=production` (test hooks off), per-user rate limiting on the LLM routes, email-verified registration — none are payment code, but all gate whether open registration + payments is safe.
5. **Dunning/lifecycle**: handle `subscription_payment_failed` (grace vs immediate downgrade) — currently a failed payment only downgrades on `expired`.

Item 2 (the ledger) is the one that protects margin; everything else is store
config and UX.
