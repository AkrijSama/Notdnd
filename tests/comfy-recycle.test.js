// COMFYUI RECYCLE — the decision logic (owner stamp 2026-07-22). The LIVE recycle (real
// restart, real cgroup-leash inspection) is verified by forcing the condition in Job 4;
// these lock the NEVER-MID-COOK guard + the fire/defer/reason decisions deterministically,
// via injected probes (no live ComfyUI needed).
import test from "node:test";
import assert from "node:assert/strict";
import {
  maybeRecycleComfyBeforeCook, comfyRecycleStatus, recycleRssFloorMb,
  __setComfyRecycleTestHooks, __resetComfyRecycleState
} from "../server/ai/comfyRecycle.js";

function withHooks(hooks) { __resetComfyRecycleState(); __setComfyRecycleTestHooks(hooks); }
function teardown() { __setComfyRecycleTestHooks(null); __resetComfyRecycleState(); }

test("NEVER MID-COOK: rss over floor but a job is running → DEFER, no restart (the critical guard)", async () => {
  let restarts = 0;
  withHooks({ rssMb: 25000, queue: { running: 1, pending: 0, reachable: true }, restart: async () => { restarts += 1; } });
  const r = await maybeRecycleComfyBeforeCook("test");
  assert.equal(r.recycled, false, "must not recycle mid-cook");
  assert.equal(r.deferred, true, "must defer");
  assert.equal(restarts, 0, "the restart must NOT be called while a cook runs");
  assert.equal(comfyRecycleStatus().rssRecycleCount, 0, "no recycle counted");
  teardown();
});

test("FIRE: rss over floor and queue idle → recycle, restart called once, count++", async () => {
  let restarts = 0;
  withHooks({ rssMb: 25000, queue: { running: 0, pending: 0, reachable: true }, restart: async () => { restarts += 1; } });
  const r = await maybeRecycleComfyBeforeCook("test");
  assert.equal(r.recycled, true);
  assert.equal(r.reason, "rss_threshold");
  assert.equal(restarts, 1, "the leashed restart runs exactly once");
  assert.equal(comfyRecycleStatus().rssRecycleCount, 1);
  teardown();
});

test("BELOW FLOOR: rss under the floor → no recycle", async () => {
  let restarts = 0;
  withHooks({ rssMb: recycleRssFloorMb() - 1, queue: { running: 0, pending: 0, reachable: true }, restart: async () => { restarts += 1; } });
  const r = await maybeRecycleComfyBeforeCook("test");
  assert.equal(r.recycled, false);
  assert.equal(restarts, 0);
  teardown();
});

test("UNMEASURABLE: no ComfyUI unit (rss null) → never recycle (not our box)", async () => {
  let restarts = 0;
  withHooks({ rssMb: null, queue: { running: 0, pending: 0, reachable: true }, restart: async () => { restarts += 1; } });
  const r = await maybeRecycleComfyBeforeCook("test");
  assert.equal(r.recycled, false);
  assert.equal(r.unmeasurable, true);
  assert.equal(restarts, 0);
  teardown();
});

test("UNRESPONSIVE vs RSS: a wedged ComfyUI (active unit, /queue unreachable) recycles with a DISTINCT reason + counter", async () => {
  let restarts = 0;
  withHooks({ rssMb: 3000, queue: { running: 0, pending: 0, reachable: false }, unitActive: true, restart: async () => { restarts += 1; } });
  const r = await maybeRecycleComfyBeforeCook("test");
  assert.equal(r.recycled, true);
  assert.equal(r.reason, "unresponsive", "a wedge is not counted as a normal leak recycle");
  const s = comfyRecycleStatus();
  assert.equal(s.unresponsiveRecycleCount, 1, "the unresponsive counter is separate so a crash-loop storm is legible");
  assert.equal(s.rssRecycleCount, 0);
  assert.equal(restarts, 1);
  teardown();
});

test("status surface exposes the leak-legibility fields (Job 1.5)", () => {
  __resetComfyRecycleState();
  const s = comfyRecycleStatus();
  for (const k of ["enabled", "rssFloorMb", "rssRecycleCount", "unresponsiveRecycleCount", "lastRecycleAt", "lastReason", "lastRssBeforeMb", "lastRssAfterMb", "lastDowntimeMs"]) {
    assert.ok(k in s, `status must expose ${k}`);
  }
  assert.equal(typeof s.rssFloorMb, "number");
});

test("threshold is env-tunable (Law-6)", () => {
  const prev = process.env.NOTDND_COMFY_RECYCLE_RSS_MB;
  process.env.NOTDND_COMFY_RECYCLE_RSS_MB = "12345";
  assert.equal(recycleRssFloorMb(), 12345);
  if (prev === undefined) delete process.env.NOTDND_COMFY_RECYCLE_RSS_MB; else process.env.NOTDND_COMFY_RECYCLE_RSS_MB = prev;
});
