import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-image-worker-"));
process.env.NOTDND_DB_PATH = path.join(tmpDir, "image.db.json");
process.env.NOTDND_ASSETS_ROOT = path.join(tmpDir, "assets");
process.env.NOTDND_MOCK_IMAGE = "true";
delete process.env.FAL_API_KEY;

const {
  createSoloRun,
  getSoloRun,
  saveSoloRun,
  initializeDatabase,
  resetDatabase,
  ensureNpcImageAssets,
  updateImageAssetStatus
} = await import("../server/db/repository.js");
const { runImageJob } = await import("../server/solo/imageWorker.js");
const { NPC_EXPRESSIONS } = await import("../server/solo/schema.js");
const { serveStatic } = await import("../server/api/http.js");

function seedRunWithNpc(runId) {
  initializeDatabase();
  resetDatabase();
  createSoloRun({ userId: "user_img", runId, now: "2026-01-01T00:00:00.000Z" });
  const run = getSoloRun(runId);
  run.npcs.tavern_keeper = {
    npcId: "tavern_keeper",
    displayName: "Tavern Keeper",
    role: "Tavern Keeper",
    known: true,
    status: "present",
    memoryFactIds: [],
    tags: [],
    flags: {}
  };
  saveSoloRun(run);
}

test("runImageJob generates base + all expression variants in mock mode", async () => {
  seedRunWithNpc("run_img_a");
  const result = await runImageJob({
    runId: "run_img_a",
    npcId: "tavern_keeper",
    style: "illustrated",
    basePrompt: "a weathered tavern keeper"
  });
  assert.equal(result.ok, true);

  const run = getSoloRun("run_img_a");
  assert.equal(run.npcs.tavern_keeper.imageAssetId, "img_tavern_keeper_base");

  // base + 6 variants all generated, with served uris.
  const baseAsset = run.imageAssets.img_tavern_keeper_base;
  assert.equal(baseAsset.status, "generated");
  assert.equal(baseAsset.uri, "/data/assets/run_img_a/tavern_keeper/base.png");
  assert.ok(fs.existsSync(path.join(process.env.NOTDND_ASSETS_ROOT, "run_img_a", "tavern_keeper", "base.png")));

  for (const expression of NPC_EXPRESSIONS) {
    const assetId = run.npcs.tavern_keeper.expressionVariants[expression];
    assert.equal(assetId, `img_tavern_keeper_${expression}`);
    assert.equal(run.imageAssets[assetId].status, "generated");
    assert.equal(run.imageAssets[assetId].uri, `/data/assets/run_img_a/tavern_keeper/${expression}.png`);
    assert.ok(fs.existsSync(path.join(process.env.NOTDND_ASSETS_ROOT, "run_img_a", "tavern_keeper", `${expression}.png`)));
  }

  // The run is still schema-valid after the narrow worker writes.
  assert.doesNotThrow(() => saveSoloRun(getSoloRun("run_img_a")));
});

test("runImageJob returns not-found for a missing npc and never throws", async () => {
  seedRunWithNpc("run_img_b");
  const result = await runImageJob({ runId: "run_img_b", npcId: "ghost" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not found/);
});

test("ensureNpcImageAssets is idempotent and creates base + 6 variants", () => {
  seedRunWithNpc("run_img_c");
  const first = ensureNpcImageAssets("run_img_c", "tavern_keeper", { style: "pixel" });
  assert.equal(first.base, "img_tavern_keeper_base");
  assert.equal(Object.keys(first.variants).length, NPC_EXPRESSIONS.length);

  const afterFirst = getSoloRun("run_img_c");
  assert.equal(Object.keys(afterFirst.imageAssets).length, NPC_EXPRESSIONS.length + 1);
  assert.equal(afterFirst.imageAssets.img_tavern_keeper_base.status, "queued");
  assert.equal(afterFirst.imageAssets.img_tavern_keeper_base.promptSummary, "style:pixel");

  ensureNpcImageAssets("run_img_c", "tavern_keeper", { style: "pixel" });
  const afterSecond = getSoloRun("run_img_c");
  assert.equal(Object.keys(afterSecond.imageAssets).length, NPC_EXPRESSIONS.length + 1);
});

test("updateImageAssetStatus is a narrow write and reports missing assets", () => {
  seedRunWithNpc("run_img_d");
  ensureNpcImageAssets("run_img_d", "tavern_keeper", {});
  assert.equal(updateImageAssetStatus("run_img_d", "img_tavern_keeper_base", "generated", "/data/assets/run_img_d/tavern_keeper/base.png"), true);
  const run = getSoloRun("run_img_d");
  assert.equal(run.imageAssets.img_tavern_keeper_base.status, "generated");
  assert.equal(run.imageAssets.img_tavern_keeper_base.uri, "/data/assets/run_img_d/tavern_keeper/base.png");
  // other assets untouched (narrow)
  assert.equal(run.imageAssets.img_tavern_keeper_warm.status, "queued");
  assert.equal(updateImageAssetStatus("run_img_d", "does_not_exist", "generated", "/x.png"), false);
});

test("serveStatic serves generated png assets under data/assets (path is covered)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-serve-"));
  const filePath = path.join(root, "data", "assets", "r", "tavern_keeper", "base.png");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from("89504e470d0a1a0a", "hex"));

  const res = new PassThrough();
  let head = null;
  res.writeHead = (code, headers) => {
    head = { code, headers };
    return res;
  };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("serveStatic timed out")), 2000);
    res.on("finish", () => { clearTimeout(timer); resolve(); });
    res.on("end", () => { clearTimeout(timer); resolve(); });
    res.resume();
    serveStatic({ url: "/data/assets/r/tavern_keeper/base.png" }, res, root);
  });

  assert.equal(head.code, 200);
  assert.equal(head.headers["Content-Type"], "image/png");
});
