import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateSoloRun } from "../server/solo/schema.js";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "notdnd-solo-api-tests-"));
const dbPath = path.join(tmpDir, "solo-api.db.json");
const port = 4783 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;

let serverProcess;
let authToken;
let createdRun;

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

async function request(pathname, { method = "GET", token = authToken, body, expectedStatus = 200 } = {}) {
  const headers = {
    "Content-Type": "application/json"
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json();
  assert.equal(response.status, expectedStatus, `${method} ${pathname}: ${payload?.error || response.status}`);
  return payload;
}

test.before(async () => {
  serverProcess = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      NOTDND_DB_PATH: dbPath,
      NOTDND_HOST: "127.0.0.1",
      PORT: String(port)
    },
    stdio: ["ignore", "ignore", "ignore"]
  });

  await waitForHealth();
  const login = await request("/api/auth/login", {
    method: "POST",
    token: "",
    body: {
      email: "demo@notdnd.local",
      password: "demo1234"
    }
  });
  authToken = login.token;
});

test.after(async () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
    await new Promise((resolve) => serverProcess.once("exit", resolve));
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("POST /api/solo/runs returns created valid run", async () => {
  const payload = await request("/api/solo/runs", {
    method: "POST",
    body: {
      runId: "api_run_created",
      worldSeed: "api_seed"
    },
    expectedStatus: 201
  });

  createdRun = payload.run;
  assert.equal(payload.ok, true);
  assert.equal(createdRun.runId, "api_run_created");
  assert.equal(createdRun.worldSeed, "api_seed");
  assert.equal(validateSoloRun(createdRun).ok, true);
});

test("GET /api/solo/runs/:runId returns created run", async () => {
  const payload = await request("/api/solo/runs/api_run_created");

  assert.equal(payload.run.runId, "api_run_created");
});

test("GET missing solo run returns 404", async () => {
  const payload = await request("/api/solo/runs/missing_run", {
    expectedStatus: 404
  });

  assert.equal(payload.ok, false);
  assert.equal(payload.code, "NOT_FOUND");
});

test("PUT /api/solo/runs/:runId saves valid run", async () => {
  const next = {
    ...createdRun,
    player: {
      ...createdRun.player,
      gold: 12
    }
  };
  const payload = await request("/api/solo/runs/api_run_created", {
    method: "PUT",
    body: next
  });

  assert.equal(payload.run.player.gold, 12);
  assert.equal(validateSoloRun(payload.run).ok, true);
  createdRun = payload.run;
});

test("PUT rejects mismatched runId", async () => {
  const payload = await request("/api/solo/runs/api_run_created", {
    method: "PUT",
    body: {
      ...createdRun,
      runId: "different_run"
    },
    expectedStatus: 400
  });

  assert.equal(payload.ok, false);
  assert.equal(payload.code, "RUN_ID_MISMATCH");
});

test("PUT rejects invalid run body with validation errors", async () => {
  const invalid = {
    ...createdRun,
    player: {
      ...createdRun.player
    }
  };
  delete invalid.player.stats;

  const payload = await request("/api/solo/runs/api_run_created", {
    method: "PUT",
    body: invalid,
    expectedStatus: 400
  });

  assert.equal(payload.ok, false);
  assert.equal(payload.code, "INVALID_SOLO_RUN");
  assert.ok(payload.validationErrors.some((entry) => entry.path === "player.stats"));
});
