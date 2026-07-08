// ---------------------------------------------------------------------------
// Entitlement policy — the billing gate.
//
// Images are ~95% of per-user cost, so the free tier is metered on IMAGE
// generations (and, softly, sessions started), NOT on text/turns. The repository
// owns the persisted state (the `tier` field + daily usage counters); this module
// owns the POLICY: per-tier limits, the BYOK bypass, and the allow/deny + remaining
// math the routes and the scene payload consume.
//
// Everything here degrades gracefully — a null/unknown user is treated as a free
// user, and nothing throws. Callers use the booleans to soft-gate (skip an image,
// 429 a new session); gameplay is never hard-blocked beyond that.
// ---------------------------------------------------------------------------

import { getDailyUsage, getUserTier } from "../db/repository.js";

// Free tier: N images/day. N=10 covers roughly one session's worth of art
// (player portrait + location + a few NPC portraits + some expression variants).
// Sessions are capped softly at 10/day, which keeps a heavy free user under the
// upstream LLM provider's daily request ceiling.
export const FREE_DAILY_IMAGE_LIMIT = 10;
export const FREE_DAILY_SESSION_LIMIT = 10;

// GUEST GM-TURN CAP (pre-launch spend guard). Every guest GM turn is a paid cloud
// call, so an anonymous session must not be able to drive unlimited spend. Guests
// get a bounded daily turn budget (a taste across their few sessions), then a soft
// register nudge. Accounts (free/paid) are NOT turn-metered — the existing policy
// meters them on images (95% of cost) + sessions. Env-tunable; never auto-tops-up.
export const GUEST_DAILY_TURN_LIMIT = Math.max(
  1,
  Number(process.env.NOTDND_GUEST_TURN_LIMIT || process.env.INKBORNE_GUEST_TURN_LIMIT || 40)
);

// Per-tier daily limits. Paid tiers are effectively unlimited (Infinity) — the
// flat subscription is the meter, never per-action billing.
export const TIER_LIMITS = Object.freeze({
  // turns: Infinity for accounts — the flat subscription / image-metered free tier
  // is the meter, never per-turn billing. Only GUESTS are turn-capped.
  free: { images: FREE_DAILY_IMAGE_LIMIT, sessions: FREE_DAILY_SESSION_LIMIT, turns: Infinity },
  adventurer: { images: Infinity, sessions: Infinity, turns: Infinity },
  premium: { images: Infinity, sessions: Infinity, turns: Infinity },
  // Guests (no account) get a taste, not a pipeline: enough images for one
  // session's art, a few runs, and a bounded GM-turn budget (paid-spend guard),
  // then the register nudge does its work. "guest" is a POLICY overlay keyed off
  // user.isGuest — the persisted tier on a guest record stays "free", so upgrading
  // to a real account changes nothing.
  guest: { images: 6, sessions: 3, turns: GUEST_DAILY_TURN_LIMIT }
});

// BYOK (bring-your-own-key): a user supplying their own inference key is paying
// their own image cost, so they bypass all image/session limits. The key arrives
// as a request header; we only need its presence here (validation/use happens in
// the provider layer). Two header spellings are accepted for client flexibility.
export const BYOK_HEADERS = Object.freeze(["x-inkborne-byok", "x-byok-key"]);

function limitsForTier(tier) {
  return TIER_LIMITS[tier] || TIER_LIMITS.free;
}

/**
 * True when the request carries a non-empty BYOK key header. Accepts either a
 * Node request (reads `.headers`) or a bare headers object. Never throws.
 * @param {{ headers?: object } | object} reqOrHeaders
 * @returns {boolean}
 */
export function requestHasByokKey(reqOrHeaders) {
  const headers = reqOrHeaders?.headers && typeof reqOrHeaders.headers === "object"
    ? reqOrHeaders.headers
    : reqOrHeaders;
  if (!headers || typeof headers !== "object") {
    return false;
  }
  return BYOK_HEADERS.some((name) => String(headers[name] || "").trim().length > 0);
}

// Normalizes a user argument (sanitized user object, or null) into { id, tier }.
function resolveUser(user) {
  const id = user && typeof user.id === "string" ? user.id : null;
  // Guests get the stricter guest limits. isGuest arrives on the sanitized user
  // from the per-request session lookup, so it is as fresh as a repository read.
  if (id && user?.isGuest === true) {
    return { id, tier: "guest" };
  }
  // Prefer the tier on the passed object; fall back to a fresh repository read so
  // a stale/partial caller object can't grant the wrong entitlement.
  const tier = id ? getUserTier(id) : "free";
  return { id, tier };
}

/**
 * Can this user generate another image right now? Folds tier limit, today's usage,
 * and the BYOK bypass into a single decision plus the remaining count the client
 * uses for the soft upgrade prompt.
 * @param {object|null} user sanitized user ({ id, tier })
 * @param {{ byok?: boolean }} [opts]
 * @returns {{ allowed: boolean, byok: boolean, unlimited: boolean, tier: string, limit: number, used: number, remaining: number }}
 */
export function canGenerateImage(user, { byok = false } = {}) {
  const { id, tier } = resolveUser(user);
  const limit = limitsForTier(tier).images;
  const unlimited = limit === Infinity;

  if (byok || unlimited) {
    return { allowed: true, byok: Boolean(byok), unlimited, tier, limit, used: 0, remaining: Infinity };
  }

  const used = id ? getDailyUsage(id).images : 0;
  const remaining = Math.max(0, limit - used);
  return { allowed: remaining > 0, byok: false, unlimited: false, tier, limit, used, remaining };
}

/**
 * Can this user start another session (create a run) right now? Same shape as
 * canGenerateImage but metered on sessions/day.
 * @param {object|null} user sanitized user ({ id, tier })
 * @param {{ byok?: boolean }} [opts]
 * @returns {{ allowed: boolean, byok: boolean, unlimited: boolean, tier: string, limit: number, used: number, remaining: number }}
 */
export function canStartSession(user, { byok = false } = {}) {
  const { id, tier } = resolveUser(user);
  const limit = limitsForTier(tier).sessions;
  const unlimited = limit === Infinity;

  if (byok || unlimited) {
    return { allowed: true, byok: Boolean(byok), unlimited, tier, limit, used: 0, remaining: Infinity };
  }

  const used = id ? getDailyUsage(id).sessions : 0;
  const remaining = Math.max(0, limit - used);
  return { allowed: remaining > 0, byok: false, unlimited: false, tier, limit, used, remaining };
}

/**
 * Can this user take another GM turn right now? Only guests are metered (accounts
 * are turns:Infinity). BYOK bypasses (they pay their own inference). Same shape as
 * canGenerateImage/canStartSession so the route can soft-gate a guest at the cap
 * WITHOUT firing the paid GM call. Never throws.
 * @param {object|null} user sanitized user ({ id, tier, isGuest })
 * @param {{ byok?: boolean }} [opts]
 * @returns {{ allowed: boolean, byok: boolean, unlimited: boolean, tier: string, limit: number, used: number, remaining: number }}
 */
export function canTakeGmTurn(user, { byok = false } = {}) {
  const { id, tier } = resolveUser(user);
  const limit = limitsForTier(tier).turns ?? Infinity;
  const unlimited = limit === Infinity;

  if (byok || unlimited) {
    return { allowed: true, byok: Boolean(byok), unlimited, tier, limit, used: 0, remaining: Infinity };
  }

  const used = id ? getDailyUsage(id).turns : 0;
  const remaining = Math.max(0, limit - used);
  return { allowed: remaining > 0, byok: false, unlimited: false, tier, limit, used, remaining };
}

// JSON-safe remaining value (Infinity does not survive JSON.stringify → null).
function jsonRemaining(remaining) {
  return remaining === Infinity ? null : remaining;
}

/**
 * Compact entitlement summary for the /scene payload, so the client can show a
 * soft upgrade prompt as a user approaches their free limit. Unlimited remaining
 * is serialized as null (JSON has no Infinity). Never throws.
 * @param {object|null} user sanitized user ({ id, tier })
 * @param {{ byok?: boolean }} [opts]
 * @returns {object}
 */
export function entitlementSummary(user, { byok = false } = {}) {
  const image = canGenerateImage(user, { byok });
  const session = canStartSession(user, { byok });
  const turn = canTakeGmTurn(user, { byok });
  return {
    tier: image.tier,
    byok: Boolean(byok),
    unlimited: image.unlimited,
    image: { limit: jsonRemaining(image.limit), used: image.used, remaining: jsonRemaining(image.remaining) },
    session: { limit: jsonRemaining(session.limit), used: session.used, remaining: jsonRemaining(session.remaining) },
    turn: { limit: jsonRemaining(turn.limit), used: turn.used, remaining: jsonRemaining(turn.remaining) },
    // Convenience fields the soft-prompt reads directly.
    imageQuotaRemaining: jsonRemaining(image.remaining),
    sessionLimitReached: !session.allowed,
    // Only ever true for a guest at the cap — the client shows the register nudge.
    turnCapReached: !turn.allowed
  };
}

// Re-export the repository counters so the rest of the server imports all
// entitlement surface from one module.
export { incrementImageCount, incrementSessionCount, incrementTurnCount } from "../db/repository.js";
