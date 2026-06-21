import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "notdnd-solo-gm-api-tests-"));
const dbPath = path.join(tmpDir, "solo-gm-api.db.json");
const port = 7783 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;

let serverProcess;
let authToken;
let otherAuthToken;

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

async function createRun(runId) {
  const payload = await request("/api/solo/runs", {
    method: "POST",
    body: {
      runId,
      worldSeed: `${runId}_seed`
    },
    expectedStatus: 201
  });
  return payload.run;
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

  const registered = await request("/api/auth/register", {
    method: "POST",
    token: "",
    body: {
      email: "gm-other@notdnd.local",
      password: "demo1234",
      displayName: "GM Other"
    }
  });
  otherAuthToken = registered.token;
});

test.after(async () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
    await new Promise((resolve) => serverProcess.once("exit", resolve));
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("GET /api/solo/runs/:runId/gm-scene returns scene and narration", async () => {
  await createRun("api_gm_scene_run");

  const payload = await request("/api/solo/runs/api_gm_scene_run/gm-scene");
  assert.equal(payload.ok, true);
  assert.equal(payload.scene.runId, "api_gm_scene_run");
  assert.equal(payload.gmNarration.ok, true);
  assert.equal(payload.gmNarration.narration.title, "Start Location");
});

test("GET missing GM scene run returns 404", async () => {
  const payload = await request("/api/solo/runs/missing_gm_scene_run/gm-scene", {
    expectedStatus: 404
  });

  assert.equal(payload.ok, false);
  assert.equal(payload.code, "NOT_FOUND");
});

test("GET GM scene ownership rejection matches solo route behavior", async () => {
  await createRun("api_gm_scene_owned");

  const payload = await request("/api/solo/runs/api_gm_scene_owned/gm-scene", {
    token: otherAuthToken,
    expectedStatus: 403
  });

  assert.equal(payload.ok, false);
  assert.equal(payload.code, "FORBIDDEN");
});

test("mainline GM scene response does not include forbidden or blocked content", async () => {
  await createRun("api_gm_scene_policy");

  const payload = await request("/api/solo/runs/api_gm_scene_policy/gm-scene");
  const encoded = JSON.stringify(payload);
  assert.doesNotMatch(encoded, /forbidden_default/);
  assert.doesNotMatch(encoded, /explicit_sexual_content/);
});

test("GM narration has no state mutations", async () => {
  await createRun("api_gm_scene_no_mutation");

  const payload = await request("/api/solo/runs/api_gm_scene_no_mutation/gm-scene");
  assert.deepEqual(payload.gmNarration.stateMutations, []);
});
