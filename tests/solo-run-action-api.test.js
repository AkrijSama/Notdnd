import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "notdnd-solo-action-api-tests-"));
const dbPath = path.join(tmpDir, "solo-action-api.db.json");
const port = 5783 + Math.floor(Math.random() * 1000);
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
      email: "other@notdnd.local",
      password: "demo1234",
      displayName: "Other User"
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

test("POST /api/solo/runs/:runId/actions with move saves updated run", async () => {
  await createRun("api_action_move");

  const payload = await request("/api/solo/runs/api_action_move/actions", {
    method: "POST",
    body: {
      action: {
        type: "move",
        actorId: "player",
        fromLocationId: "start_location",
        toLocationId: "second_location",
        direction: "east"
      }
    }
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.run.currentLocationId, "second_location");
  assert.equal(payload.event.type, "movement");
  assert.equal(payload.memoryFact.type, "location_movement");
  assert.ok(payload.availableMoves.some((move) => move.locationId === "start_location"));
  assert.ok(payload.availableActions.some((action) => action.type === "move"));
});

test("GET /api/solo/runs/:runId after action returns new currentLocationId", async () => {
  const payload = await request("/api/solo/runs/api_action_move");

  assert.equal(payload.run.currentLocationId, "second_location");
});

test("POST action missing run returns 404", async () => {
  const payload = await request("/api/solo/runs/missing_action_run/actions", {
    method: "POST",
    body: {
      action: {
        type: "move",
        toLocationId: "second_location"
      }
    },
    expectedStatus: 404
  });

  assert.equal(payload.ok, false);
  assert.equal(payload.code, "NOT_FOUND");
});

test("POST invalid move returns 400", async () => {
  await createRun("api_action_invalid_move");

  const payload = await request("/api/solo/runs/api_action_invalid_move/actions", {
    method: "POST",
    body: {
      action: {
        type: "move",
        toLocationId: "third_location"
      }
    },
    expectedStatus: 400
  });

  assert.equal(payload.ok, false);
  assert.equal(payload.code, "ACTION_INVALID");
  assert.ok(payload.validationErrors.some((error) => error.path === "action.toLocationId"));
});

test("POST unknown action returns 400", async () => {
  await createRun("api_action_unknown");

  const payload = await request("/api/solo/runs/api_action_unknown/actions", {
    method: "POST",
    body: {
      action: {
        type: "dance"
      }
    },
    expectedStatus: 400
  });

  assert.equal(payload.ok, false);
  assert.equal(payload.code, "ACTION_INVALID");
  assert.ok(payload.validationErrors.some((error) => error.path === "action.type"));
});

test("POST recognized but unimplemented action returns ACTION_NOT_IMPLEMENTED", async () => {
  await createRun("api_action_talk");

  const payload = await request("/api/solo/runs/api_action_talk/actions", {
    method: "POST",
    body: {
      action: {
        type: "talk",
        targetId: "placeholder_npc"
      }
    },
    expectedStatus: 400
  });

  assert.equal(payload.ok, false);
  assert.equal(payload.code, "ACTION_NOT_IMPLEMENTED");
  assert.equal(payload.actionType, "talk");
});

test("POST search action persists search result", async () => {
  await createRun("api_action_search");

  const payload = await request("/api/solo/runs/api_action_search/actions", {
    method: "POST",
    body: {
      action: {
        type: "search",
        actorId: "player"
      }
    }
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.searchResult.found, true);
  assert.equal(payload.event.type, "search");
  assert.equal(payload.memoryFact.type, "search_discovery");
  assert.equal(payload.run.locations.start_location.searchDetails[0].revealed, true);
  assert.ok(payload.availableActions.some((action) => action.type === "search" && action.enabled === true));

  const fetched = await request("/api/solo/runs/api_action_search");
  assert.equal(fetched.run.locations.start_location.searchDetails[0].revealed, true);
  assert.equal(fetched.run.memoryFacts.filter((fact) => fact.type === "search_discovery").length, 1);
});

test("ownership rules match existing solo run route behavior", async () => {
  await createRun("api_action_owned");

  const payload = await request("/api/solo/runs/api_action_owned/actions", {
    method: "POST",
    token: otherAuthToken,
    body: {
      action: {
        type: "move",
        toLocationId: "second_location"
      }
    },
    expectedStatus: 403
  });

  assert.equal(payload.ok, false);
  assert.equal(payload.code, "FORBIDDEN");
});
