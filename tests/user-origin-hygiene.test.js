// USER-DATA HYGIENE (2026-07-18): harness-origin classification + tagging + a
// targeted purge, and origin-stamping at creation.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyUserOrigin,
  createGuestUser,
  registerUser,
  tagHarnessUsers,
  purgeUser,
  resetDatabase
} from "../server/db/repository.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-hygiene-tests-"));
process.env.NOTDND_DB_PATH = path.join(tmpDir, "hygiene.db.json");

test("classifyUserOrigin: buckets seed / guest / harness / human", () => {
  assert.equal(classifyUserOrigin({ isAdmin: true, email: "demo@notdnd.local" }), "seed", "admin is seed, not harness");
  assert.equal(classifyUserOrigin({ email: null }), "guest");
  assert.equal(classifyUserOrigin({ origin: "harness", email: "x@y.com" }), "harness", "explicit stamp wins");
  // harness heuristics
  assert.equal(classifyUserOrigin({ email: "diag_1782@inkborne.local" }), "harness", "*.local");
  assert.equal(classifyUserOrigin({ email: "healthbeat-g1ef8i@selfplay.test" }), "harness", "*.test");
  assert.equal(classifyUserOrigin({ email: "h_1782704064524@x.com" }), "harness", "timestamped scratch");
  assert.equal(classifyUserOrigin({ email: "walk_stamsw9@e.com" }), "harness", "walk-gen prefix");
  assert.equal(classifyUserOrigin({ email: "selfplay_1@notdnd.local" }), "harness");
  // human
  assert.equal(classifyUserOrigin({ email: "akrijsama@gmail.com" }), "human");
  assert.equal(classifyUserOrigin({ email: "abd@fuku.me" }), "human");
});

// resetDatabase() preserves existing users (it only clears sessions), so tests in
// this file share a growing user set — assertions below are relative/idempotent, not
// absolute counts. Unique short suffixes avoid email collisions AND the \d{12,}
// harness heuristic (a 13-digit timestamp in a "human" email would misclassify it).
let seq = 0;
const uniq = () => `a${(seq += 1)}`;

test("origin is stamped at creation and preserved", () => {
  const g = createGuestUser({ origin: "harness" });
  assert.equal(g.user.isGuest, true);
  const r = registerUser({ email: `real_${uniq()}@player.com`, password: "password123", displayName: "Real" }, { origin: null });
  assert.match(r.user.email, /@player\.com$/);
  const counts = tagHarnessUsers({ apply: false }).counts;
  assert.ok(counts.harness >= 1, "the harness guest counts as harness");
  assert.ok(counts.human >= 1, "the real registration counts as human");
});

test("tagHarnessUsers({apply}) stamps harness rows + is idempotent; humans untouched; purgeUser removes user + sessions", () => {
  const h = registerUser({ email: `diag_${uniq()}@inkborne.local`, password: "password123", displayName: "Diag" });
  registerUser({ email: `human_${uniq()}@gmail.com`, password: "password123", displayName: "Human" });

  const first = tagHarnessUsers({ apply: true });
  assert.ok(first.tagged >= 1, "at least the new harness row is tagged");
  // idempotent: everything harness is now stamped, so a second apply tags nothing.
  assert.equal(tagHarnessUsers({ apply: true }).tagged, 0);
  // humans are never stamped harness — a human row persists across the apply.
  assert.ok(tagHarnessUsers({ apply: false }).counts.human >= 1, "human rows stay human");

  const purge = purgeUser(h.user.id);
  assert.equal(purge.removedUser, 1);
  assert.ok(purge.removedSessions >= 1, "the account's session(s) are removed too");
  // purging a missing id is a safe no-op
  assert.deepEqual(purgeUser("usr_does_not_exist"), { removedUser: 0, removedSessions: 0 });
});
