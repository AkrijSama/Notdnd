import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addCampaignMember,
  applyOperation,
  getState,
  getUserBySessionToken,
  initializeDatabase,
  loginUser,
  registerUser,
  resetDatabase
} from "../server/db/repository.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-auth-tests-"));
const dbPath = path.join(tmpDir, "auth.db.json");
process.env.NOTDND_DB_PATH = dbPath;

test("auth register/login/session lookup works", () => {
  initializeDatabase();
  resetDatabase();

  const registered = registerUser({
    email: "alice@example.com",
    password: "Password123",
    displayName: "Alice"
  });
  assert.ok(registered.token);
  assert.equal(registered.user.email, "alice@example.com");

  const logged = loginUser({
    email: "alice@example.com",
    password: "Password123"
  });
  assert.ok(logged.token);

  const me = getUserBySessionToken(logged.token);
  assert.equal(me.email, "alice@example.com");
});

test("campaign permissions enforce write access", () => {
  initializeDatabase();
  resetDatabase();

  const owner = loginUser({ email: "demo@notdnd.local", password: "demo1234" }).user;
  const bob = registerUser({
    email: "bob@example.com",
    password: "Password123",
    displayName: "Bob"
  }).user;

  const ownerState = getState({ userId: owner.id });
  const campaignId = ownerState.selectedCampaignId;
  assert.ok(campaignId);

  assert.throws(
    () =>
      applyOperation(
        "increment_campaign_readiness",
        { campaignId, amount: 5 },
        {
          actorUserId: bob.id
        }
      ),
    /write access/
  );

  addCampaignMember(
    {
      campaignId,
      email: "bob@example.com",
      role: "editor"
    },
    {
      actorUserId: owner.id
    }
  );

  const result = applyOperation(
    "increment_campaign_readiness",
    { campaignId, amount: 5 },
    {
      actorUserId: bob.id
    }
  );
  assert.equal(result.campaignId, campaignId);
});

test("state version conflict is detected", () => {
  initializeDatabase();
  resetDatabase();

  const owner = loginUser({ email: "demo@notdnd.local", password: "demo1234" }).user;
  const before = getState({ userId: owner.id });

  applyOperation(
    "add_book",
    {
      title: "Conflict Book",
      type: "Homebrew",
      tags: ["test"],
      chapters: ["One"]
    },
    {
      actorUserId: owner.id,
      expectedVersion: before.stateVersion
    }
  );

  assert.throws(
    () =>
      applyOperation(
        "add_book",
        {
          title: "Stale Version Book",
          type: "Homebrew",
          tags: [],
          chapters: []
        },
        {
          actorUserId: owner.id,
          expectedVersion: before.stateVersion
        }
      ),
    /State version conflict/
  );
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
