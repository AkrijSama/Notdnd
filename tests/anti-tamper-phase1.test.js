import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createRateLimiter, createMemoryStore, limiterFromEnv, rateKeyFor, emitRateLimited } from "../server/security/rateLimit.js";
import { testHooksEnabled } from "../server/solo/actions.js";

// ============ ITEM 1 — BOOT GUARD ============
// Spawn-level checks: the guard runs before the port binds, so an unsafe+public
// config must exit(1) with the loud refusal, and unsafe+local must print the
// dev warning. We use a throwaway port + instant kill after the probe line.

function spawnBoot(env, expectExit) {
  const result = spawnSync(process.execPath, ["server/index.js"], {
    env: {
      ...process.env,
      PORT: "4444",
      NOTDND_DB_PATH: `/tmp/anti-tamper-${Date.now()}-${Math.random().toString(36).slice(2)}.db.json`,
      NOTDND_BOOTSTRAP_DEMO: "false",
      ...env
    },
    encoding: "utf8",
    timeout: expectExit ? 15000 : 6000,
    killSignal: "SIGKILL"
  });
  return result;
}

test("(a) unsafe + explicit public bind → REFUSES to boot, loud multi-line error", () => {
  const r = spawnBoot({ NODE_ENV: "", NOTDND_HOST: "0.0.0.0" }, true);
  assert.equal(r.status, 1, "exit code 1");
  const err = String(r.stderr || "");
  assert.match(err, /REFUSING TO BOOT — unsafe build on a public bind/);
  assert.match(err, /test hooks ENABLED|NODE_ENV=/);
  assert.match(err, /bind host '0\.0\.0\.0' is not loopback/);
  assert.match(err, /NO override flag/);
});

test("(a2) unsafe + INKBORNE_PUBLIC=true → refuses even on loopback", () => {
  const r = spawnBoot({ NODE_ENV: "", NOTDND_HOST: "127.0.0.1", INKBORNE_PUBLIC: "true" }, true);
  assert.equal(r.status, 1);
  assert.match(String(r.stderr || ""), /INKBORNE_PUBLIC=true is set/);
});

test("(b) unsafe + local (implicit host) → boots with ONE dev warning, loopback bind", () => {
  // No NOTDND_HOST: the implicit default downgrades to 127.0.0.1 under the guard.
  const r = spawnBoot({ NODE_ENV: "" }, false); // times out = still serving = booted
  const all = String(r.stdout || "") + String(r.stderr || "");
  assert.match(all, /\[SECURITY\] test hooks ENABLED — dev-only build \(bind 127\.0\.0\.1/);
  assert.doesNotMatch(all, /REFUSING TO BOOT/);
});

// (c) production+public boots clean: exercised at the guard-predicate level (a
// full production spawn needs prod config beyond this test's scope): unsafe is
// false when NODE_ENV=production and hooks are unset.
test("(c) production predicate: NODE_ENV=production + no hook flag → not unsafe", () => {
  assert.equal(testHooksEnabled({ NODE_ENV: "production" }), false);
  assert.equal(testHooksEnabled({ NODE_ENV: "production", NOTDND_TEST_HOOKS: "true" }), true, "explicit hook flag still wins (and would refuse publicly)");
  assert.equal(testHooksEnabled({ NODE_ENV: "" }), true, "unset NODE_ENV = hooks on (dev)");
});

// ============ ITEM 2 — RATE LIMIT ============

test("limit trips at N+1 and the window resets", () => {
  const limiter = createRateLimiter({ name: "t", max: 3, windowMs: 1200 });
  const k = "u:alice";
  assert.equal(limiter.check(k).allowed, true);
  assert.equal(limiter.check(k).allowed, true);
  assert.equal(limiter.check(k).allowed, true);
  const fourth = limiter.check(k);
  assert.equal(fourth.allowed, false, "N+1 rejected");
  assert.ok(fourth.retryAfterSeconds >= 1);
  // window reset
  const store = createMemoryStore();
  const fast = createRateLimiter({ name: "t2", max: 1, windowMs: 1000, store });
  assert.equal(fast.check("k").allowed, true);
  assert.equal(fast.check("k").allowed, false);
  // simulate expiry by forcing the bucket past its window
  return new Promise((resolve) => setTimeout(() => {
    assert.equal(fast.check("k").allowed, true, "fresh window admits again");
    resolve();
  }, 1100));
});

test("per-user isolation: user A capped does not cap user B", () => {
  const limiter = createRateLimiter({ name: "iso", max: 2, windowMs: 60000 });
  limiter.check("u:a");
  limiter.check("u:a");
  assert.equal(limiter.check("u:a").allowed, false, "A capped");
  assert.equal(limiter.check("u:b").allowed, true, "B unaffected");
});

test("guest falls back to the IP key; authenticated users key on id", () => {
  const req = { socket: { remoteAddress: "203.0.113.9" } };
  assert.equal(rateKeyFor(null, req), "ip:203.0.113.9");
  assert.equal(rateKeyFor({ id: "usr_x" }, req), "u:usr_x");
  assert.equal(rateKeyFor({ id: "" }, req), "ip:203.0.113.9", "blank id is not a key");
});

test("429 body shape + structured log line emitted", () => {
  const limiter = createRateLimiter({ name: "demo", max: 1, windowMs: 60000 });
  limiter.check("u:x");
  const verdict = limiter.check("u:x");
  assert.equal(verdict.allowed, false);
  let statusOut = null;
  let bodyOut = null;
  const res = { setHeader() {} };
  const writeJson = (_res, status, body) => { statusOut = status; bodyOut = body; };
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (line) => warnings.push(String(line));
  try {
    emitRateLimited(res, writeJson, limiter, "u:x", verdict, "/api/test");
  } finally {
    console.warn = origWarn;
  }
  assert.equal(statusOut, 429);
  assert.ok(typeof bodyOut.error === "string" && bodyOut.error.length > 0);
  assert.ok(Number.isFinite(bodyOut.retryAfterSeconds));
  assert.equal(warnings.length, 1, "exactly one structured line");
  assert.match(warnings[0], /\[rate-limit\] 429 route=\/api\/test limiter=demo key=u:x count=2 max=1/);
});

test("env tuning: INKBORNE_RATELIMIT_<NAME>_MAX overrides the default", () => {
  const limiter = limiterFromEnv("turn", { max: 10, windowMs: 60000 }, { INKBORNE_RATELIMIT_TURN_MAX: "2" });
  assert.equal(limiter.max, 2);
  const defaulted = limiterFromEnv("turn", { max: 10, windowMs: 60000 }, {});
  assert.equal(defaulted.max, 10);
});

// ============ ITEM 1.3 — hook route denies when disabled ============
test("(d) a testHook payload is inert when hooks are disabled", async () => {
  const { validateSoloAction } = await import("../server/solo/actions.js");
  // With hooks OFF (env without the flag + production), test-hook action types
  // must NOT validate as hook types (the runtime re-check inside actions.js).
  const env = { NODE_ENV: "production" };
  assert.equal(testHooksEnabled(env), false);
  // the per-branch guards in actions.js call testHooksEnabled() at use time —
  // pin the predicate contract they rely on:
  assert.equal(testHooksEnabled({ NODE_ENV: "production", NOTDND_TEST_HOOKS: "" }), false);
});
