import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createSoloRun,
  getSoloRun,
  getState,
  initializeDatabase,
  listSoloRunsForUser,
  loginUser,
  renameSoloRun,
  resetDatabase,
  saveSoloRun
} from "../server/db/repository.js";
import { validateSoloRun } from "../server/solo/schema.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-solo-persistence-tests-"));
const dbPath = path.join(tmpDir, "solo.db.json");
process.env.NOTDND_DB_PATH = dbPath;

test("repository can create solo run", () => {
  initializeDatabase();
  resetDatabase();

  const run = createSoloRun({
    userId: "user_a",
    runId: "run_a",
    worldSeed: "seed_a",
    now: "2026-01-01T00:00:00.000Z"
  });

  assert.equal(run.runId, "run_a");
  assert.equal(run.userId, "user_a");
  assert.equal(run.worldSeed, "seed_a");
});

test("created run validates", () => {
  initializeDatabase();
  resetDatabase();

  const run = createSoloRun({ userId: "user_a", runId: "run_valid" });
  const validation = validateSoloRun(run);

  assert.equal(validation.ok, true);
  assert.deepEqual(validation.errors, []);
});

test("repository can fetch solo run by runId", () => {
  initializeDatabase();
  resetDatabase();

  createSoloRun({ userId: "user_a", runId: "run_fetch" });
  const fetched = getSoloRun("run_fetch");

  assert.equal(fetched.runId, "run_fetch");
  assert.equal(fetched.userId, "user_a");
});

test("repository returns null for missing run", () => {
  initializeDatabase();
  resetDatabase();

  assert.equal(getSoloRun("missing_run"), null);
});

test("repository can save updated solo run", () => {
  initializeDatabase();
  resetDatabase();

  const run = createSoloRun({ userId: "user_a", runId: "run_save" });
  run.player.gold = 7;
  const saved = saveSoloRun(run);
  const fetched = getSoloRun("run_save");

  assert.equal(saved.player.gold, 7);
  assert.equal(fetched.player.gold, 7);
});

test("save updates updatedAt", async () => {
  initializeDatabase();
  resetDatabase();

  const run = createSoloRun({
    userId: "user_a",
    runId: "run_time",
    now: "2026-01-01T00:00:00.000Z"
  });
  const originalUpdatedAt = run.updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const saved = saveSoloRun(run);

  assert.notEqual(saved.updatedAt, originalUpdatedAt);
});

test("invalid solo run is rejected", () => {
  initializeDatabase();
  resetDatabase();

  const run = createSoloRun({ userId: "user_a", runId: "run_invalid" });
  delete run.player.stats;

  assert.throws(
    () => saveSoloRun(run),
    (error) => {
      assert.equal(error.code, "INVALID_SOLO_RUN");
      assert.ok(error.validationErrors.some((entry) => entry.path === "player.stats"));
      return true;
    }
  );
});

test("listSoloRunsForUser returns only that user's runs", () => {
  initializeDatabase();
  resetDatabase();

  createSoloRun({ userId: "user_a", runId: "run_user_a_1" });
  createSoloRun({ userId: "user_b", runId: "run_user_b_1" });
  createSoloRun({ userId: "user_a", runId: "run_user_a_2" });

  const runs = listSoloRunsForUser("user_a");
  const ids = runs.map((run) => run.runId).sort();

  assert.deepEqual(ids, ["run_user_a_1", "run_user_a_2"]);
});

test("renameSoloRun persists a custom title and survives reload", () => {
  initializeDatabase();
  resetDatabase();

  createSoloRun({ userId: "user_a", runId: "run_rename", now: "2026-01-01T00:00:00.000Z" });
  const updated = renameSoloRun("run_rename", "  The Long Road Home  ");

  // Trimmed, persisted, and still a valid run.
  assert.equal(updated.title, "The Long Road Home");
  assert.equal(validateSoloRun(updated).ok, true);
  // Survives a fresh fetch (i.e. it was written, not just returned).
  assert.equal(getSoloRun("run_rename").title, "The Long Road Home");
});

test("renameSoloRun does NOT bump updatedAt (rename is not play)", () => {
  initializeDatabase();
  resetDatabase();

  const run = createSoloRun({ userId: "user_a", runId: "run_rename_time", now: "2026-01-01T00:00:00.000Z" });
  const before = run.updatedAt;
  renameSoloRun("run_rename_time", "A New Name");

  assert.equal(getSoloRun("run_rename_time").updatedAt, before);
});

test("renameSoloRun with a blank title clears the custom title", () => {
  initializeDatabase();
  resetDatabase();

  createSoloRun({ userId: "user_a", runId: "run_rename_clear" });
  renameSoloRun("run_rename_clear", "Temporary");
  assert.equal(getSoloRun("run_rename_clear").title, "Temporary");

  const cleared = renameSoloRun("run_rename_clear", "   ");
  assert.equal("title" in cleared, false);
  assert.equal("title" in getSoloRun("run_rename_clear"), false);
});

test("renameSoloRun returns null for a missing run", () => {
  initializeDatabase();
  resetDatabase();

  assert.equal(renameSoloRun("nope_missing", "X"), null);
});

test("solo runs are stored separately from campaigns/legacy data", () => {
  initializeDatabase();
  resetDatabase();

  const owner = loginUser({ email: "demo@notdnd.local", password: "demo1234" }).user;
  const before = getState({ userId: owner.id });
  const campaignCount = before.campaigns.length;

  createSoloRun({ userId: owner.id, runId: "run_separate" });
  const after = getState({ userId: owner.id });

  assert.equal(after.campaigns.length, campaignCount);
  assert.equal(after.campaigns.some((campaign) => campaign.id === "run_separate"), false);
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
