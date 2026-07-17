// INPUT INTEGRITY — server-side turn idempotency (loss path: resync/resubmit must
// never re-roll or double-commit). Drives the real server over HTTP. ZERO model
// calls: uses a CHECKED SEARCH (a committed searchDetail with a DC), so the SERVER
// rolls a real d20 and appends a timeline event WITHOUT any GM narration/interpreter
// call — a same-turnId replay that returns the SAME roll proves no re-roll.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "notdnd-turn-idem-tests-"));
const dbPath = path.join(tmpDir, "turn-idem.db.json");
const port = 6400 + Math.floor(Math.random() * 1200);
const baseUrl = `http://127.0.0.1:${port}`;

let serverProcess;
let authToken;

async function waitForHealth(timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for test server health.");
}

async function request(pathname, { method = "GET", token = authToken, body, expectedStatus = 200 } = {}) {
  const headers = { "Content-Type": "application/json" };
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

// A run whose start location carries a checked searchDetail — searching rolls a
// real server d20 and commits a timeline event with no model call.
async function createSearchableRun(runId) {
  const created = await request("/api/solo/runs", {
    method: "POST",
    body: { runId, worldSeed: `${runId}_seed` },
    expectedStatus: 201
  });
  const run = created.run;
  // Attach a check to the default searchDetail so a search rolls a real server d20
  // (mirrors tests/solo-run-action-api.test.js; keeps the validated detail shape).
  run.locations.start_location.searchDetails[0].check = { ability: "intelligence", skill: "investigation", dc: 8 };
  await request(`/api/solo/runs/${runId}`, { method: "PUT", body: run });
  return run;
}

const SEARCH = { type: "search", actorId: "player" };

function timelineLen(run) {
  return Array.isArray(run?.timeline) ? run.timeline.length : 0;
}

function rollForTurn(run, turnId) {
  const timeline = Array.isArray(run?.timeline) ? run.timeline : [];
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const ev = timeline[i];
    if (ev && ev.payload && ev.payload.turnId === turnId) {
      const cr = ev.payload.checkResult || ev.payload.searchResult?.checkResult;
      return cr ? (cr.total ?? cr.keptRoll ?? null) : "no-check";
    }
  }
  return null;
}

test.before(async () => {
  serverProcess = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      // Hermetic: no API key + cloud chain off → zero model API calls. A checked
      // search needs none anyway (server-side dice only).
      INKBORNE_LLM_API_KEY: "",
      NOTDND_LLM_API_KEY: "",
      OPENROUTER_API_KEY: "",
      NOTDND_CLOUD_PROVIDER_CHAIN: "off",
      INKBORNE_GM_LOCAL_FALLBACK: "false",
      NOTDND_DB_PATH: dbPath,
      NOTDND_HOST: "127.0.0.1",
      PORT: String(port)
    },
    stdio: ["ignore", "ignore", "ignore"]
  });
  await waitForHealth();
  const registered = await request("/api/auth/register", {
    method: "POST",
    token: "",
    body: { email: `idem_${Date.now()}@notdnd.local`, password: "password123", displayName: "Idem Tester" }
  });
  authToken = registered.token;
});

test.after(async () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
    await new Promise((resolve) => serverProcess.once("exit", resolve));
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("a turnId echoes back and commits exactly one timeline event", async () => {
  await createSearchableRun("idem_echo");
  const before = timelineLen((await request("/api/solo/runs/idem_echo", {})).run);
  const res = await request("/api/solo/runs/idem_echo/actions", { method: "POST", body: { action: SEARCH, turnId: "echo_t1" } });
  assert.equal(res.ok, true);
  assert.equal(res.turnId, "echo_t1", "server echoes the client turnId");
  assert.ok(!res.idempotentReplay, "the first submission is a real commit, not a replay");
  assert.equal(timelineLen(res.run), before + 1, "exactly one new timeline event committed");
});

test("duplicate turnId is idempotent: no re-roll, no double-commit (dice-safe)", async () => {
  await createSearchableRun("idem_dupe");
  const first = await request("/api/solo/runs/idem_dupe/actions", { method: "POST", body: { action: SEARCH, turnId: "dupe_t1" } });
  const len1 = timelineLen(first.run);
  const roll1 = rollForTurn(first.run, "dupe_t1");
  assert.equal(typeof roll1, "number", "the committed search recorded a real d20 roll");

  // Resubmit the SAME turnId (the resync / retry path).
  const second = await request("/api/solo/runs/idem_dupe/actions", { method: "POST", body: { action: SEARCH, turnId: "dupe_t1" } });
  assert.equal(second.idempotentReplay, true, "a committed turnId replays idempotently");
  assert.equal(second.alreadyProcessed, true);
  assert.equal(timelineLen(second.run), len1, "NO double-commit — the timeline did not grow");
  assert.equal(rollForTurn(second.run, "dupe_t1"), roll1, "NO re-roll — the same committed outcome is returned");

  // A DIFFERENT turnId is a genuinely new turn and still commits.
  const third = await request("/api/solo/runs/idem_dupe/actions", { method: "POST", body: { action: SEARCH, turnId: "dupe_t2" } });
  assert.ok(!third.idempotentReplay, "a fresh turnId is not a replay");
  assert.equal(timelineLen(third.run), len1 + 1, "a new turn commits exactly one new event");
});

test("concurrent duplicate turnId commits EXACTLY once (in-flight gate serializes)", async () => {
  await createSearchableRun("idem_race");
  const baseline = timelineLen((await request("/api/solo/runs/idem_race", {})).run);
  // Fire two identical-turnId submissions without awaiting between them.
  const [a, b] = await Promise.all([
    request("/api/solo/runs/idem_race/actions", { method: "POST", body: { action: SEARCH, turnId: "race_t1" } }),
    request("/api/solo/runs/idem_race/actions", { method: "POST", body: { action: SEARCH, turnId: "race_t1" } })
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const after = timelineLen((await request("/api/solo/runs/idem_race", {})).run);
  assert.equal(after, baseline + 1, "exactly ONE commit despite two concurrent same-turnId submits");
  const freshCommits = [a, b].filter((r) => !r.idempotentReplay && !r.processing).length;
  assert.equal(freshCommits, 1, "exactly one of the two concurrent submits is the real commit; the other replays/waits");
});

test("no turnId → today's behavior (each submit commits; backward compatible)", async () => {
  await createSearchableRun("idem_none");
  const first = await request("/api/solo/runs/idem_none/actions", { method: "POST", body: { action: SEARCH } });
  const len1 = timelineLen(first.run);
  assert.equal(first.turnId, null, "no client turnId → null echo");
  const second = await request("/api/solo/runs/idem_none/actions", { method: "POST", body: { action: SEARCH } });
  assert.equal(timelineLen(second.run), len1 + 1, "without a turnId, each submit is a distinct turn (unchanged behavior)");
});
