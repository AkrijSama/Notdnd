import assert from "node:assert/strict";
import test from "node:test";
import { getBuildInfo, isTrackedSourceDirty } from "../server/runtimeStatus.js";

test("isTrackedSourceDirty: untracked + runtime churn never dirty; tracked source does", () => {
  // untracked noise (campaign dirs, logs, grade reports) — never dirty
  assert.equal(isTrackedSourceDirty("?? data/campaigns/cmp_x/\n?? docs/grades/auto-grade-x.md"), false);
  // the perpetually-churned runtime db — not dirty
  assert.equal(isTrackedSourceDirty(" M server/db/waitlist.json"), false);
  // anything under data/ — not dirty
  assert.equal(isTrackedSourceDirty(" M data/logs/runs/run_x.log"), false);
  // mixed churn only — not dirty
  assert.equal(isTrackedSourceDirty(" M server/db/waitlist.json\n?? data/campaigns/x/"), false);
  // a TRACKED source file modified — dirty
  assert.equal(isTrackedSourceDirty(" M server/index.js"), true);
  assert.equal(isTrackedSourceDirty("M  scripts/autoGrade.mjs"), true);
  // churn + one real source change — dirty (the real change wins)
  assert.equal(isTrackedSourceDirty(" M server/db/waitlist.json\n M src/main.js"), true);
  // a rename judges the destination path
  assert.equal(isTrackedSourceDirty("R  server/old.js -> server/new.js"), true);
  assert.equal(isTrackedSourceDirty("R  data/a.log -> data/b.log"), false);
  // empty/blank — clean
  assert.equal(isTrackedSourceDirty(""), false);
  assert.equal(isTrackedSourceDirty(null), false);
});

test("getBuildInfo: returns a real sha/branch and a stable startedAt", () => {
  const a = getBuildInfo();
  assert.ok(a.sha && a.sha !== "unknown", "sha resolved from git");
  assert.ok(a.branch && a.branch !== "unknown");
  assert.equal(typeof a.dirty, "boolean");
  const b = getBuildInfo();
  // within the TTL the object is cached; startedAt must never drift per call
  assert.equal(b.startedAt, a.startedAt);
});
