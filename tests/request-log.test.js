// HTTP REQUEST LOG (2026-07-18 observability). Auth requests are always captured
// into the in-memory ring for /api/debug/status; static/asset traffic is excluded;
// no token/password/body is ever recorded.
import assert from "node:assert/strict";
import test from "node:test";
import { recordRequest, lastAuthEvents, isAuthPath, shouldLogRequest } from "../server/logging/requestLog.js";

test("path predicates: auth always logged, static excluded", () => {
  assert.equal(isAuthPath("/api/auth/login"), true);
  assert.equal(isAuthPath("/api/state"), false);
  assert.equal(shouldLogRequest("/api/auth/guest"), true);
  assert.equal(shouldLogRequest("/api/state"), true);
  assert.equal(shouldLogRequest("/src/main.js"), false, "static/asset noise excluded");
  assert.equal(shouldLogRequest("/index.html"), false);
});

test("auth events land in the ring with a safe shape (no token/password/body)", () => {
  recordRequest({ method: "POST", path: "/api/auth/login", status: 401, durationMs: 12, userId: null, isGuest: false });
  recordRequest({ method: "POST", path: "/api/auth/guest", status: 200, durationMs: 5, userId: "usr_x", isGuest: true });
  const events = lastAuthEvents();
  assert.ok(events.length >= 2);
  const last = events[events.length - 1];
  assert.equal(last.path, "/api/auth/guest");
  assert.equal(last.status, 200);
  assert.equal(last.who, "usr_x");
  // Safety: only the whitelisted fields exist — never a token/password/body.
  assert.deepEqual(Object.keys(last).sort(), ["at", "method", "ms", "path", "status", "who"]);
  const prior = events[events.length - 2];
  assert.equal(prior.who, "anon", "no userId + not guest → anon");
});

test("non-api traffic is not recorded to the auth ring", () => {
  const before = lastAuthEvents().length;
  recordRequest({ method: "GET", path: "/src/styles.css", status: 200, durationMs: 1 });
  recordRequest({ method: "GET", path: "/api/state", status: 200, durationMs: 3 }); // logged, but not auth
  assert.equal(lastAuthEvents().length, before, "only /api/auth/* enters the auth ring");
});

test("ring is capped at 5 (newest last)", () => {
  for (let i = 0; i < 8; i++) {
    recordRequest({ method: "POST", path: "/api/auth/login", status: 200, durationMs: i });
  }
  const events = lastAuthEvents();
  assert.ok(events.length <= 5, "ring capped");
});
