// PAYMENT RAIL — LemonSqueezy webhook → tier seam (GROUNDWORK, not go-live).
//
// The product plan (docs/PRODUCT-ARCHITECTURE.md) monetizes with a $9.99
// "adventurer" web subscription through a Merchant-of-Record (~5%), and calls
// for replacing the admin `set-tier` stopgap with a RECEIPT-BACKED tier source.
// This module is that source: LemonSqueezy signs each webhook; we verify the
// signature, map the purchased variant to a tier, and flip the buyer's tier.
//
// GO-LIVE SAFETY: the route is DISABLED unless LEMONSQUEEZY_WEBHOOK_SECRET is set
// (webhookConfigured() === false → the index.js route 404s). Wiring one paid-tier
// gate and proving it in test does NOT connect a live processor; that is a launch
// decision (a real LemonSqueezy store, product variants, and the secret in prod).
//
// The $9.99 adventurer tier is NOT adult content, so a MoR will bank it — it is
// buildable now. The $19.99 Forbidden tier is blocked on the PRODUCT-ARCHITECTURE
// §4.1 "will any processor accept adult" unknown and is intentionally NOT wired.

import crypto from "node:crypto";

// LemonSqueezy events that grant/reflect an active paid entitlement vs revoke it.
const GRANTING_EVENTS = new Set([
  "subscription_created",
  "subscription_updated",
  "subscription_resumed",
  "subscription_unpaused",
  "order_created"
]);
const REVOKING_EVENTS = new Set([
  "subscription_cancelled",
  "subscription_expired",
  "subscription_paused"
]);

// Subscription statuses that are actually ENTITLING right now (a cancelled-but-
// not-yet-expired sub still has access until period end; LemonSqueezy sends
// subscription_updated with status "cancelled" while still "on_trial"/"active").
const ACTIVE_STATUSES = new Set(["active", "on_trial", "paused"]);

export function webhookConfigured(env = process.env) {
  return String(env.LEMONSQUEEZY_WEBHOOK_SECRET || "").trim().length > 0;
}

/**
 * Verify a LemonSqueezy webhook signature. LemonSqueezy signs the RAW request
 * body with HMAC-SHA256 (hex) using the store's webhook secret and sends it in
 * the `X-Signature` header. Timing-safe. Never throws.
 * @param {Buffer|string} rawBody the exact bytes received (NOT re-serialized JSON)
 * @param {string} signatureHeader the X-Signature header value
 * @param {string} secret LEMONSQUEEZY_WEBHOOK_SECRET
 * @returns {boolean}
 */
export function verifyLemonSqueezySignature(rawBody, signatureHeader, secret) {
  const key = String(secret || "");
  const provided = String(signatureHeader || "").trim();
  if (!key || !provided) {
    return false;
  }
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""), "utf8");
  const expected = crypto.createHmac("sha256", key).update(body).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  // timingSafeEqual throws on length mismatch — guard so a wrong-length sig is a
  // clean false, not an exception.
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

// Maps a LemonSqueezy variant id to an Inkborne tier. Configured via env so the
// owner binds real store variants at go-live without a code change:
//   LEMONSQUEEZY_VARIANT_ADVENTURER=<variant id for the $9.99 sub>
//   LEMONSQUEEZY_VARIANT_PREMIUM=<variant id, when/if the adult tier ships>
export function tierForVariant(variantId, env = process.env) {
  const id = String(variantId || "").trim();
  if (!id) {
    return null;
  }
  const adventurer = String(env.LEMONSQUEEZY_VARIANT_ADVENTURER || "").trim();
  const premium = String(env.LEMONSQUEEZY_VARIANT_PREMIUM || "").trim();
  if (adventurer && id === adventurer) {
    return "adventurer";
  }
  if (premium && id === premium) {
    return "premium";
  }
  return null;
}

/**
 * Pure. Interpret a parsed LemonSqueezy webhook body into a tier change, or null
 * if it is not a tier-affecting event. Identifies the buyer by the `user_id`
 * passed in checkout custom data (meta.custom_data.user_id — the reliable link),
 * falling back to the buyer email. Returns { userId?, email?, tier, reason }.
 */
export function resolveTierChange(body, env = process.env) {
  if (!body || typeof body !== "object") {
    return null;
  }
  const eventName = String(body?.meta?.event_name || "").trim();
  const attributes = body?.data?.attributes || {};
  const custom = body?.meta?.custom_data || {};
  const userId = typeof custom.user_id === "string" && custom.user_id.trim() ? custom.user_id.trim() : null;
  const email = typeof attributes.user_email === "string" && attributes.user_email.trim() ? attributes.user_email.trim().toLowerCase() : null;
  if (!userId && !email) {
    return null; // cannot attribute the purchase to a user
  }

  if (REVOKING_EVENTS.has(eventName)) {
    return { userId, email, tier: "free", reason: eventName };
  }
  if (GRANTING_EVENTS.has(eventName)) {
    // For subscription events, honor the status (a past_due/expired update should
    // not keep granting). order_created (one-time) has no status → treat as active.
    const status = String(attributes.status || "").trim().toLowerCase();
    const entitled = eventName === "order_created" || !status || ACTIVE_STATUSES.has(status);
    if (!entitled) {
      return { userId, email, tier: "free", reason: `${eventName}:${status}` };
    }
    const tier = tierForVariant(attributes.variant_id ?? attributes.variant_id?.toString?.(), env);
    if (!tier) {
      return null; // a purchase of a non-tier variant (e.g. a cosmetic) — ignore
    }
    return { userId, email, tier, reason: `${eventName}:${status || "one-time"}` };
  }
  return null;
}

/**
 * Handler factory. Dependency-injected (setUserTier, findUserByEmail) so it is
 * unit-testable without the repository or a live processor. Returns an async
 * function (rawBody, signatureHeader) → { status, body } describing the response.
 * The caller (index.js route) writes that to the HTTP response.
 */
export function createLemonSqueezyWebhookHandler({ setUserTier, findUserByEmail, env = process.env } = {}) {
  return async function handle(rawBody, signatureHeader) {
    if (!webhookConfigured(env)) {
      return { status: 404, body: { error: "webhook not configured" } };
    }
    if (!verifyLemonSqueezySignature(rawBody, signatureHeader, env.LEMONSQUEEZY_WEBHOOK_SECRET)) {
      return { status: 401, body: { error: "invalid signature" } };
    }
    let parsed;
    try {
      parsed = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || ""));
    } catch {
      return { status: 400, body: { error: "invalid JSON" } };
    }
    const change = resolveTierChange(parsed, env);
    if (!change) {
      // A valid, signed event we simply don't act on (a non-tier variant, an
      // unattributable purchase). Ack it so LemonSqueezy stops retrying.
      return { status: 200, body: { ok: true, applied: false } };
    }
    // Resolve the user: prefer the checkout-embedded user_id, else email lookup.
    let userId = change.userId;
    if (!userId && change.email && typeof findUserByEmail === "function") {
      const user = findUserByEmail(change.email);
      userId = user?.id || null;
    }
    if (!userId) {
      return { status: 202, body: { ok: true, applied: false, reason: "buyer not matched to a user" } };
    }
    try {
      setUserTier(userId, change.tier);
    } catch (error) {
      return { status: 422, body: { ok: false, error: String(error?.message || "tier update failed") } };
    }
    return { status: 200, body: { ok: true, applied: true, tier: change.tier, reason: change.reason } };
  };
}
