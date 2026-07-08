import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-entitlement-"));
process.env.NOTDND_DB_PATH = path.join(tmpDir, "entitlement.db.json");
process.env.NOTDND_MEMORY_ROOT = path.join(tmpDir, "campaigns");
delete process.env.OPENAI_API_KEY;

const {
  initializeDatabase,
  resetDatabase,
  registerUser,
  createGuestUser,
  getUserTier,
  setUserTier,
  getDailyUsage,
  incrementImageCount,
  incrementSessionCount,
  incrementTurnCount,
  USER_TIERS
} = await import("../server/db/repository.js");

const {
  canGenerateImage,
  canStartSession,
  canTakeGmTurn,
  entitlementSummary,
  requestHasByokKey,
  FREE_DAILY_IMAGE_LIMIT,
  FREE_DAILY_SESSION_LIMIT,
  GUEST_DAILY_TURN_LIMIT
} = await import("../server/auth/entitlements.js");

let userSeq = 0;
function freshUser() {
  initializeDatabase();
  // resetDatabase preserves users; use a unique email per call so each test gets
  // an isolated account with zeroed daily usage (usage maps are cleared on reset).
  resetDatabase();
  userSeq += 1;
  const { user } = registerUser({
    email: `player${userSeq}@example.com`,
    password: "password123",
    displayName: `Player ${userSeq}`
  });
  return user;
}

test("entitlement: guest GM-turn cap (#67)", async (t) => {
  await t.test("an account is never turn-capped (turns unlimited)", () => {
    const user = freshUser();
    const gate = canTakeGmTurn(user);
    assert.equal(gate.allowed, true);
    assert.equal(gate.unlimited, true);
  });

  await t.test("a guest is capped at GUEST_DAILY_TURN_LIMIT and blocked past it", () => {
    initializeDatabase();
    resetDatabase();
    const guest = createGuestUser();
    const g = guest.user || guest;
    assert.equal(canTakeGmTurn(g).allowed, true, "guest can take a turn initially");
    assert.equal(canTakeGmTurn(g).limit, GUEST_DAILY_TURN_LIMIT);
    for (let i = 0; i < GUEST_DAILY_TURN_LIMIT; i += 1) {
      incrementTurnCount(g.id);
    }
    const capped = canTakeGmTurn(g);
    assert.equal(capped.allowed, false, "guest blocked at the cap");
    assert.equal(capped.remaining, 0);
    assert.equal(entitlementSummary(g).turnCapReached, true);
  });

  await t.test("BYOK bypasses the guest turn cap", () => {
    initializeDatabase();
    resetDatabase();
    const guest = createGuestUser();
    const g = guest.user || guest;
    for (let i = 0; i < GUEST_DAILY_TURN_LIMIT + 5; i += 1) incrementTurnCount(g.id);
    assert.equal(canTakeGmTurn(g, { byok: true }).allowed, true);
  });
});

test("entitlement: tier schema + repository", async (t) => {
  await t.test("new users default to the free tier", () => {
    const user = freshUser();
    assert.equal(user.tier, "free");
    assert.equal(getUserTier(user.id), "free");
  });

  await t.test("setUserTier updates and returns the sanitized user", () => {
    const user = freshUser();
    const updated = setUserTier(user.id, "adventurer");
    assert.equal(updated.tier, "adventurer");
    assert.equal(getUserTier(user.id), "adventurer");
    // Never leaks secrets in the sanitized payload.
    assert.equal(updated.passwordHash, undefined);
  });

  await t.test("setUserTier rejects an invalid tier", () => {
    const user = freshUser();
    assert.throws(() => setUserTier(user.id, "platinum"), /Invalid tier/);
    assert.equal(getUserTier(user.id), "free");
  });

  await t.test("setUserTier 404s an unknown user", () => {
    freshUser();
    assert.throws(() => setUserTier("usr_does_not_exist", "premium"), /User not found/);
  });

  await t.test("getUserTier defaults unknown users to free", () => {
    freshUser();
    assert.equal(getUserTier("usr_nope"), "free");
  });

  await t.test("USER_TIERS exposes the three tiers", () => {
    assert.deepEqual([...USER_TIERS], ["free", "adventurer", "premium"]);
  });
});

test("entitlement: daily usage counters", async (t) => {
  await t.test("usage starts at zero for today (UTC)", () => {
    const user = freshUser();
    const usage = getDailyUsage(user.id);
    assert.equal(usage.images, 0);
    assert.equal(usage.sessions, 0);
    assert.equal(usage.date, new Date().toISOString().slice(0, 10));
  });

  await t.test("incrementImageCount accumulates and persists", () => {
    const user = freshUser();
    assert.equal(incrementImageCount(user.id), 1);
    assert.equal(incrementImageCount(user.id), 2);
    assert.equal(getDailyUsage(user.id).images, 2);
    // Sessions are a separate meter, untouched by image increments.
    assert.equal(getDailyUsage(user.id).sessions, 0);
  });

  await t.test("incrementSessionCount accumulates independently", () => {
    const user = freshUser();
    assert.equal(incrementSessionCount(user.id), 1);
    assert.equal(getDailyUsage(user.id).sessions, 1);
    assert.equal(getDailyUsage(user.id).images, 0);
  });

  await t.test("counters are a no-op for a missing userId", () => {
    freshUser();
    assert.equal(incrementImageCount(""), 0);
    assert.equal(incrementSessionCount(null), 0);
  });
});

test("entitlement: image generation policy", async (t) => {
  await t.test("free user is allowed until the daily image cap", () => {
    const user = freshUser();
    const first = canGenerateImage(user);
    assert.equal(first.allowed, true);
    assert.equal(first.limit, FREE_DAILY_IMAGE_LIMIT);
    assert.equal(first.remaining, FREE_DAILY_IMAGE_LIMIT);

    for (let i = 0; i < FREE_DAILY_IMAGE_LIMIT; i += 1) {
      incrementImageCount(user.id);
    }
    const after = canGenerateImage(user);
    assert.equal(after.allowed, false);
    assert.equal(after.remaining, 0);
    assert.equal(after.used, FREE_DAILY_IMAGE_LIMIT);
  });

  await t.test("BYOK bypasses the image cap entirely", () => {
    const user = freshUser();
    for (let i = 0; i < FREE_DAILY_IMAGE_LIMIT + 5; i += 1) {
      incrementImageCount(user.id);
    }
    const gate = canGenerateImage(user, { byok: true });
    assert.equal(gate.allowed, true);
    assert.equal(gate.byok, true);
    assert.equal(gate.remaining, Infinity);
  });

  await t.test("paid tiers are unlimited", () => {
    const user = freshUser();
    for (const tier of ["adventurer", "premium"]) {
      const updated = setUserTier(user.id, tier);
      for (let i = 0; i < FREE_DAILY_IMAGE_LIMIT + 50; i += 1) {
        incrementImageCount(user.id);
      }
      const gate = canGenerateImage(updated);
      assert.equal(gate.allowed, true, `${tier} should be unlimited`);
      assert.equal(gate.unlimited, true);
      assert.equal(gate.remaining, Infinity);
    }
  });

  await t.test("a null user degrades to a permissive free default", () => {
    freshUser();
    const gate = canGenerateImage(null);
    assert.equal(gate.allowed, true);
    assert.equal(gate.tier, "free");
  });
});

test("entitlement: session policy", async (t) => {
  await t.test("free user is allowed until the daily session cap", () => {
    const user = freshUser();
    assert.equal(canStartSession(user).allowed, true);
    for (let i = 0; i < FREE_DAILY_SESSION_LIMIT; i += 1) {
      incrementSessionCount(user.id);
    }
    const gate = canStartSession(user);
    assert.equal(gate.allowed, false);
    assert.equal(gate.remaining, 0);
  });

  await t.test("BYOK and paid tiers bypass the session cap", () => {
    const user = freshUser();
    for (let i = 0; i < FREE_DAILY_SESSION_LIMIT + 3; i += 1) {
      incrementSessionCount(user.id);
    }
    assert.equal(canStartSession(user, { byok: true }).allowed, true);
    const paid = setUserTier(user.id, "premium");
    assert.equal(canStartSession(paid).allowed, true);
  });
});

test("entitlement: BYOK header detection", async (t) => {
  await t.test("detects either accepted header spelling", () => {
    assert.equal(requestHasByokKey({ headers: { "x-byok-key": "sk-123" } }), true);
    assert.equal(requestHasByokKey({ headers: { "x-inkborne-byok": "sk-123" } }), true);
  });

  await t.test("treats empty / missing keys as no BYOK", () => {
    assert.equal(requestHasByokKey({ headers: { "x-byok-key": "   " } }), false);
    assert.equal(requestHasByokKey({ headers: {} }), false);
    assert.equal(requestHasByokKey(null), false);
  });

  await t.test("accepts a bare headers object too", () => {
    assert.equal(requestHasByokKey({ "x-byok-key": "sk-123" }), true);
  });
});

test("entitlement: scene payload summary", async (t) => {
  await t.test("summary is JSON-safe and reports remaining quota", () => {
    const user = freshUser();
    incrementImageCount(user.id);
    const summary = entitlementSummary(user);
    assert.equal(summary.tier, "free");
    assert.equal(summary.imageQuotaRemaining, FREE_DAILY_IMAGE_LIMIT - 1);
    assert.equal(summary.sessionLimitReached, false);
    // Round-trips through JSON without Infinity surprises.
    assert.deepEqual(JSON.parse(JSON.stringify(summary)), summary);
  });

  await t.test("unlimited tiers serialize remaining as null", () => {
    const user = freshUser();
    const paid = setUserTier(user.id, "adventurer");
    const summary = entitlementSummary(paid);
    assert.equal(summary.unlimited, true);
    assert.equal(summary.imageQuotaRemaining, null);
    assert.equal(summary.image.remaining, null);
  });

  await t.test("flags the session cap once it's reached", () => {
    const user = freshUser();
    for (let i = 0; i < FREE_DAILY_SESSION_LIMIT; i += 1) {
      incrementSessionCount(user.id);
    }
    assert.equal(entitlementSummary(user).sessionLimitReached, true);
  });
});
