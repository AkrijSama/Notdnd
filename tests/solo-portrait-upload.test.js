import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-portrait-"));
process.env.NOTDND_DB_PATH = path.join(tmpDir, "portrait.db.json");
process.env.NOTDND_ASSETS_ROOT = path.join(tmpDir, "assets");
process.env.NOTDND_MOCK_IMAGE = "true";
delete process.env.FAL_API_KEY;

const { detectImageExt, parseMultipartFile } = await import("../server/api/http.js");
const {
  createSoloRun,
  getSoloRun,
  saveSoloRun,
  initializeDatabase,
  resetDatabase,
  ensureNpcImageAssets,
  updateImageAssetStatus
} = await import("../server/db/repository.js");
const { writeUploadedBasePortrait, runImageJob } = await import("../server/solo/imageWorker.js");
const { NPC_EXPRESSIONS } = await import("../server/solo/schema.js");

// A valid 1x1 PNG (correct magic bytes).
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);

test("detectImageExt recognizes png/jpg/webp by magic bytes and rejects others", () => {
  assert.equal(detectImageExt(PNG), "png");
  assert.equal(detectImageExt(JPG), "jpg");
  assert.equal(detectImageExt(WEBP), "webp");
  assert.equal(detectImageExt(Buffer.from("this is definitely not an image")), null);
  assert.equal(detectImageExt(Buffer.from([0x00, 0x01])), null);
});

test("parseMultipartFile extracts the first file part", () => {
  const boundary = "----notdndtest";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="hero.png"\r\nContent-Type: image/png\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, PNG, tail]);

  const parsed = parseMultipartFile(body, `multipart/form-data; boundary=${boundary}`);
  assert.ok(parsed);
  assert.equal(parsed.filename, "hero.png");
  assert.equal(parsed.contentType, "image/png");
  assert.ok(parsed.data.equals(PNG));
});

test("parseMultipartFile returns null without a boundary", () => {
  assert.equal(parseMultipartFile(PNG, "application/json"), null);
});

function seedRunWithNpc(runId) {
  initializeDatabase();
  resetDatabase();
  createSoloRun({ userId: "user_portrait", runId, now: "2026-01-01T00:00:00.000Z" });
  const run = getSoloRun(runId);
  run.npcs.guard = {
    npcId: "guard",
    displayName: "Guard",
    role: "Guard",
    known: true,
    status: "present",
    memoryFactIds: [],
    tags: [],
    flags: {}
  };
  saveSoloRun(run);
}

test("uploaded base is reused (not regenerated) and variants generate from it", async () => {
  seedRunWithNpc("run_up_a");

  const { uri } = writeUploadedBasePortrait("run_up_a", "guard", "png", PNG);
  assert.equal(uri, "/data/assets/run_up_a/guard/base.png");
  assert.ok(fs.existsSync(path.join(process.env.NOTDND_ASSETS_ROOT, "run_up_a", "guard", "base.png")));

  const linked = ensureNpcImageAssets("run_up_a", "guard", { style: "illustrated" });
  updateImageAssetStatus("run_up_a", linked.base, "generated", uri);

  let run = getSoloRun("run_up_a");
  assert.equal(run.imageAssets[linked.base].status, "generated");
  assert.equal(run.imageAssets[linked.base].uri, uri);
  assert.equal(run.npcs.guard.imageAssetId, "img_guard_base");

  const result = await runImageJob({ runId: "run_up_a", npcId: "guard", style: "illustrated" });
  assert.equal(result.ok, true);
  assert.equal(result.base.reused, true, "base should be reused, not regenerated");

  run = getSoloRun("run_up_a");
  // Base uri unchanged (upload preserved, not overwritten by a generated base.png record).
  assert.equal(run.imageAssets[linked.base].uri, uri);
  // All variants generated from the uploaded base.
  for (const expression of NPC_EXPRESSIONS) {
    const assetId = run.npcs.guard.expressionVariants[expression];
    assert.equal(run.imageAssets[assetId].status, "generated");
  }
});
