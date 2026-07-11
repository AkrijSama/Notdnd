// RATE-LIMIT SKELETON (anti-tamper phase 1, item 2) — the wallet-attack wall.
// The expensive surfaces are LLM turns and (soon) image generation; this is the
// mechanism, with numbers deliberately env-tunable (owner-table, economy-law
// Law 6) and generous dev defaults.
//
// DESIGN CHOICE: FIXED WINDOW. Chosen over sliding-window because it is the
// simplest correct wallet defense: O(1) memory per active key, trivially
// reasoned about, and the known burst-at-boundary caveat (up to 2x limit
// straddling a window edge) is acceptable when the numbers themselves are
// spend-guards, not fairness guarantees. If boundary bursts ever matter,
// swap the store math for a sliding log behind the same interface.
//
// STORE INTERFACE (multi-instance scale note): the limiter takes any object with
//   incr(key, windowMs) -> { count, resetAtMs }
// which is exactly the shape a Redis INCR+PEXPIRE (or any shared KV) implements.
// The default MemoryStore is per-process; at multi-instance scale, replace the
// store — nothing else changes. No external deps now, interface only.

export function createMemoryStore() {
  const buckets = new Map(); // key -> { count, resetAtMs }
  return {
    incr(key, windowMs) {
      const now = Date.now();
      const existing = buckets.get(key);
      if (!existing || now >= existing.resetAtMs) {
        const fresh = { count: 1, resetAtMs: now + windowMs };
        buckets.set(key, fresh);
        return { ...fresh };
      }
      existing.count += 1;
      return { count: existing.count, resetAtMs: existing.resetAtMs };
    },
    // test/ops helper — not part of the required interface
    _reset() {
      buckets.clear();
    },
    _size() {
      return buckets.size;
    }
  };
}

/**
 * @param {{ name: string, max: number, windowMs: number, store?: object }} config
 * @returns {{ check(key: string): { allowed: boolean, count: number, remaining: number, retryAfterSeconds: number }, name: string, max: number, windowMs: number }}
 */
export function createRateLimiter({ name, max, windowMs, store }) {
  const backing = store || createMemoryStore();
  const limit = Math.max(1, Number(max) || 1);
  const win = Math.max(1000, Number(windowMs) || 60000);
  return {
    name: String(name || "limit"),
    max: limit,
    windowMs: win,
    check(key) {
      const k = String(key || "anon");
      const { count, resetAtMs } = backing.incr(k, win);
      const allowed = count <= limit;
      return {
        allowed,
        count,
        remaining: Math.max(0, limit - count),
        retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - Date.now()) / 1000))
      };
    }
  };
}

// Env-tunable construction: INKBORNE_RATELIMIT_<NAME>_MAX / _WINDOW_MS override
// the generous dev defaults. All numbers are owner-table placeholders.
export function limiterFromEnv(name, defaults, env = process.env) {
  const upper = String(name || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const max = Number(env[`INKBORNE_RATELIMIT_${upper}_MAX`]);
  const windowMs = Number(env[`INKBORNE_RATELIMIT_${upper}_WINDOW_MS`]);
  return createRateLimiter({
    name,
    max: Number.isFinite(max) && max > 0 ? max : defaults.max,
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : defaults.windowMs,
    store: defaults.store
  });
}

// The rate-limit key: authenticated userId, else the socket IP (guests). The
// x-forwarded-for header is deliberately NOT trusted here (spoofable); when a
// proxy fronts the server, swap this for a trusted-proxy resolution.
export function rateKeyFor(user, req) {
  if (user && typeof user.id === "string" && user.id.trim()) {
    return `u:${user.id}`;
  }
  const ip = req?.socket?.remoteAddress || "unknown";
  return `ip:${ip}`;
}

// Shared 429 emission + the structured detection footprint: one greppable line
// per rejection. Repeat offenders surface via scripts/security/audit-offenders.
export function emitRateLimited(res, writeJson, limiter, key, verdict, route) {
  try {
    // eslint-disable-next-line no-console
    console.warn(
      `[rate-limit] 429 route=${route} limiter=${limiter.name} key=${key} count=${verdict.count} max=${limiter.max} retryAfterSeconds=${verdict.retryAfterSeconds}`
    );
  } catch {
    // logging is best-effort
  }
  try {
    res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
  } catch {
    // header best-effort (mock responses in tests)
  }
  writeJson(res, 429, {
    error: "Rate limit exceeded. Slow down and retry shortly.",
    retryAfterSeconds: verdict.retryAfterSeconds
  });
}
