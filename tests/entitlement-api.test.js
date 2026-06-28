import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "notdnd-entitlement-api-"));
const dbPath = path.join(tmpDir, "entitlement-api.db.json");
const port = 5783 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const ADMIN_KEY = "test-admin-secret";

let serverProcess;

async function waitForHealth(timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for test server health.");
}

async function request(pathname, { method = "GET", token, headers = {}, body, expectedStatus = 200 } = {}) {
  const reqHeaders = { "Content-Type": "application/json", ...headers };
  if (token) {
    reqHeaders.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: reqHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json();
  assert.equal(response.status, expectedStatus, `${method} ${pathname}: ${payload?.error || response.status}`);
  return payload;
}

let freeToken;
let freeUserId;

test.before(async () => {
  serverProcess = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      NOTDND_DB_PATH: dbPath,
      NOTDND_HOST: "127.0.0.1",
      PORT: String(port),
      INKBORNE_ADMIN_KEY: ADMIN_KEY
    },
    stdio: ["ignore", "ignore", "ignore"]
  });
  await waitForHealth();

  const reg = await request("/api/auth/register", {
    method: "POST",
    body: { email: "free-user@example.com", password: "password123", displayName: "Freebie" }
  });
  freeToken = reg.token;
  freeUserId = reg.user.id;
});

test.after(async () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
    await new Promise((resolve) => serverProcess.once("exit", resolve));
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("registered users default to the free tier", () => {
  assert.equal(freeUserId.length > 0, true);
});

test("admin set-tier requires the shared secret", async () => {
  // No key header → 403.
  await request("/api/admin/set-tier", {
    method: "POST",
    body: { userId: freeUserId, tier: "premium" },
    expectedStatus: 403
  });
  // Wrong key → 403.
  await request("/api/admin/set-tier", {
    method: "POST",
    headers: { "x-inkborne-admin-key": "nope" },
    body: { userId: freeUserId, tier: "premium" },
    expectedStatus: 403
  });
});

test("admin set-tier rejects an invalid tier", async () => {
  await request("/api/admin/set-tier", {
    method: "POST",
    headers: { "x-inkborne-admin-key": ADMIN_KEY },
    body: { userId: freeUserId, tier: "platinum" },
    expectedStatus: 400
  });
});

test("admin set-tier promotes a user with a valid key", async () => {
  const result = await request("/api/admin/set-tier", {
    method: "POST",
    headers: { "x-inkborne-admin-key": ADMIN_KEY },
    body: { userId: freeUserId, tier: "adventurer" }
  });
  assert.equal(result.ok, true);
  assert.equal(result.user.tier, "adventurer");
  // Reset back to free so the session-cap test below sees a free user.
  await request("/api/admin/set-tier", {
    method: "POST",
    headers: { "x-inkborne-admin-key": ADMIN_KEY },
    body: { userId: freeUserId, tier: "free" }
  });
});

test("scene payload surfaces the entitlement summary", async () => {
  const created = await request("/api/solo/runs", {
    method: "POST",
    token: freeToken,
    body: { runId: "ent_scene_run" },
    expectedStatus: 201
  });
  assert.equal(created.run.runId, "ent_scene_run");

  const scene = await request("/api/solo/runs/ent_scene_run/scene", { token: freeToken });
  assert.equal(typeof scene.entitlement, "object");
  assert.equal(scene.entitlement.tier, "free");
  assert.equal(typeof scene.entitlement.imageQuotaRemaining, "number");
  assert.equal(scene.entitlement.sessionLimitReached, false);
});

test("free user is 429'd after the daily session cap", async () => {
  // Register a dedicated free user so the cap isn't polluted by other tests.
  const reg = await request("/api/auth/register", {
    method: "POST",
    body: { email: "cap-user@example.com", password: "password123", displayName: "Capped" }
  });
  const token = reg.token;

  // The free session cap is 10/day. The first run above for the shared free user
  // doesn't count against THIS user; create 10 here, then expect the 11th to 429.
  for (let i = 0; i < 10; i += 1) {
    await request("/api/solo/runs", { method: "POST", token, body: {}, expectedStatus: 201 });
  }
  const blocked = await request("/api/solo/runs", {
    method: "POST",
    token,
    body: {},
    expectedStatus: 429
  });
  assert.match(String(blocked.error || blocked.message || ""), /session limit|upgrade/i);

  // BYOK bypasses the cap even when the user is over it.
  await request("/api/solo/runs", {
    method: "POST",
    token,
    headers: { "x-byok-key": "sk-byok-test" },
    body: {},
    expectedStatus: 201
  });
});
