import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  verifyLemonSqueezySignature,
  tierForVariant,
  resolveTierChange,
  webhookConfigured,
  createLemonSqueezyWebhookHandler
} from "../server/api/lemonsqueezy.js";
import { TIER_LIMITS } from "../server/auth/entitlements.js";

// PAYMENT RAIL groundwork proof: one paid-tier gate works END-TO-END (signed
// webhook → tier flip → entitlement unlocks) WITHOUT a live processor. The
// signature is computed locally with a test secret; no LemonSqueezy account,
// no network. Also proves the go-live safety: the route is inert until the
// secret is configured.

const SECRET = "whsec_test_deadbeef";
const ADVENTURER_VARIANT = "999001";
const PREMIUM_VARIANT = "999002";
const ENV = {
  LEMONSQUEEZY_WEBHOOK_SECRET: SECRET,
  LEMONSQUEEZY_VARIANT_ADVENTURER: ADVENTURER_VARIANT,
  LEMONSQUEEZY_VARIANT_PREMIUM: PREMIUM_VARIANT
};

function sign(bodyStr, secret = SECRET) {
  return crypto.createHmac("sha256", secret).update(Buffer.from(bodyStr, "utf8")).digest("hex");
}

function webhook({ event, variant = ADVENTURER_VARIANT, status = "active", userId = "usr_1", email = "buyer@example.com" }) {
  return JSON.stringify({
    meta: { event_name: event, custom_data: userId ? { user_id: userId } : {} },
    data: { attributes: { variant_id: variant, status, user_email: email } }
  });
}

// An in-memory user store standing in for the repository.
function fakeRepo(initialTier = "free") {
  const users = { usr_1: { id: "usr_1", email: "buyer@example.com", tier: initialTier } };
  return {
    users,
    setUserTier(userId, tier) {
      if (!users[userId]) throw new Error("User not found.");
      users[userId].tier = tier;
      return users[userId];
    },
    findUserByEmail(email) {
      const u = Object.values(users).find((x) => x.email === String(email).toLowerCase());
      return u || null;
    }
  };
}

// ── signature verification ───────────────────────────────────────────────────
test("signature verify: correct HMAC passes, tampered/short/empty fail", () => {
  const body = webhook({ event: "subscription_created" });
  assert.equal(verifyLemonSqueezySignature(body, sign(body), SECRET), true);
  assert.equal(verifyLemonSqueezySignature(body, sign(body) + "00", SECRET), false, "wrong length");
  assert.equal(verifyLemonSqueezySignature(body, sign(body, "wrong-secret"), SECRET), false, "wrong secret");
  assert.equal(verifyLemonSqueezySignature(body + " ", sign(body), SECRET), false, "tampered body");
  assert.equal(verifyLemonSqueezySignature(body, "", SECRET), false, "empty sig");
  assert.equal(verifyLemonSqueezySignature(body, sign(body), ""), false, "no secret");
});

test("webhookConfigured reflects the secret env", () => {
  assert.equal(webhookConfigured({ LEMONSQUEEZY_WEBHOOK_SECRET: SECRET }), true);
  assert.equal(webhookConfigured({}), false);
  assert.equal(webhookConfigured({ LEMONSQUEEZY_WEBHOOK_SECRET: "  " }), false);
});

// ── variant → tier mapping ───────────────────────────────────────────────────
test("tierForVariant maps configured variants only", () => {
  assert.equal(tierForVariant(ADVENTURER_VARIANT, ENV), "adventurer");
  assert.equal(tierForVariant(PREMIUM_VARIANT, ENV), "premium");
  assert.equal(tierForVariant("someCosmetic", ENV), null);
  assert.equal(tierForVariant("", ENV), null);
});

// ── event interpretation ─────────────────────────────────────────────────────
test("resolveTierChange: granting events → paid tier, revoking → free", () => {
  const created = resolveTierChange(JSON.parse(webhook({ event: "subscription_created" })), ENV);
  assert.deepEqual({ userId: created.userId, tier: created.tier }, { userId: "usr_1", tier: "adventurer" });

  const cancelled = resolveTierChange(JSON.parse(webhook({ event: "subscription_expired" })), ENV);
  assert.equal(cancelled.tier, "free");

  // A subscription_updated with a non-entitling status revokes.
  const pastDue = resolveTierChange(JSON.parse(webhook({ event: "subscription_updated", status: "past_due" })), ENV);
  assert.equal(pastDue.tier, "free");

  // A non-tier variant purchase is ignored (null).
  assert.equal(resolveTierChange(JSON.parse(webhook({ event: "order_created", variant: "cosmetic" })), ENV), null);

  // An unattributable event (no user_id, no email) is ignored.
  const anon = JSON.parse(webhook({ event: "subscription_created", userId: null, email: "" }));
  assert.equal(resolveTierChange(anon, ENV), null);
});

// ── THE END-TO-END GATE: signed webhook flips tier, entitlement unlocks ───────
test("PAID GATE E2E: a signed subscription_created upgrades free→adventurer and unlocks the caps", async () => {
  const repo = fakeRepo("free");
  // The tier semantics the flip unlocks: free is capped (10/10), adventurer is
  // unlimited on both metered dimensions. (canGenerateImage reads tier from the
  // live repository via getUserTier, so we assert the tier→limit mapping here and
  // the persisted tier flip below — together that is the end-to-end gate.)
  assert.deepEqual(TIER_LIMITS.free, { images: 10, sessions: 10 });
  assert.equal(TIER_LIMITS.adventurer.images, Infinity);
  assert.equal(TIER_LIMITS.adventurer.sessions, Infinity);

  const handler = createLemonSqueezyWebhookHandler({ ...repo, env: ENV });
  const body = webhook({ event: "subscription_created" });
  const result = await handler(body, sign(body));

  assert.equal(result.status, 200);
  assert.deepEqual({ applied: result.body.applied, tier: result.body.tier }, { applied: true, tier: "adventurer" });
  assert.equal(repo.users.usr_1.tier, "adventurer", "receipt-backed tier flip persisted — the buyer is now unlimited");
});

test("PAID GATE E2E: buyer matched by EMAIL when checkout omits user_id", async () => {
  const repo = fakeRepo("free");
  const handler = createLemonSqueezyWebhookHandler({ ...repo, env: ENV });
  const body = webhook({ event: "subscription_created", userId: null, email: "buyer@example.com" });
  const result = await handler(body, sign(body));
  assert.equal(result.body.applied, true);
  assert.equal(repo.users.usr_1.tier, "adventurer");
});

test("REVOCATION E2E: an expiry webhook downgrades a paid user back to free", async () => {
  const repo = fakeRepo("adventurer");
  const handler = createLemonSqueezyWebhookHandler({ ...repo, env: ENV });
  const body = webhook({ event: "subscription_expired" });
  const result = await handler(body, sign(body));
  assert.equal(result.body.applied, true);
  assert.equal(repo.users.usr_1.tier, "free");
});

// ── security + go-live safety ─────────────────────────────────────────────────
test("SECURITY: an invalid signature is rejected 401 and never changes a tier", async () => {
  const repo = fakeRepo("free");
  const handler = createLemonSqueezyWebhookHandler({ ...repo, env: ENV });
  const body = webhook({ event: "subscription_created" });
  const result = await handler(body, "not-a-valid-signature");
  assert.equal(result.status, 401);
  assert.equal(repo.users.usr_1.tier, "free", "no tier change on bad signature");
});

test("GO-LIVE SAFETY: with no secret configured, the webhook is disabled (404)", async () => {
  const repo = fakeRepo("free");
  const handler = createLemonSqueezyWebhookHandler({ ...repo, env: {} });
  const body = webhook({ event: "subscription_created" });
  const result = await handler(body, sign(body));
  assert.equal(result.status, 404, "inert until an explicit launch decision configures the secret");
  assert.equal(repo.users.usr_1.tier, "free");
});

test("a signed but unmatched buyer (no user_id, email not found) is acked (202) without a tier change", async () => {
  const repo = fakeRepo("free");
  const handler = createLemonSqueezyWebhookHandler({ ...repo, env: ENV });
  const body = webhook({ event: "subscription_created", userId: null, email: "nobody@example.com" });
  const result = await handler(body, sign(body));
  assert.equal(result.status, 202);
  assert.equal(result.body.applied, false);
});

test("a webhook naming a nonexistent user_id is a clean 422 (never a silent success)", async () => {
  const repo = fakeRepo("free");
  const handler = createLemonSqueezyWebhookHandler({ ...repo, env: ENV });
  const body = webhook({ event: "subscription_created", userId: "usr_ghost", email: "" });
  const result = await handler(body, sign(body));
  assert.equal(result.status, 422);
  assert.equal(repo.users.usr_1.tier, "free");
});

test("malformed JSON with a valid signature is a clean 400", async () => {
  const repo = fakeRepo("free");
  const handler = createLemonSqueezyWebhookHandler({ ...repo, env: ENV });
  const bad = "{not json";
  const result = await handler(bad, sign(bad));
  assert.equal(result.status, 400);
});
