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
const { runImageJob, runVariantImageJob, runVnBodyImageJob, artStyleDirection } = await import("../server/solo/imageWorker.js");
const { NPC_EXPRESSIONS } = await import("../server/solo/schema.js");
const { resolveVnBodyUri } = await import("../server/solo/scene.js");
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

test("runImageJob generates ONLY the base; expression variants are DISABLED (reuse base, no fresh gen)", async () => {
  seedRunWithNpc("run_img_a");
  const result = await runImageJob({
    runId: "run_img_a",
    npcId: "tavern_keeper",
    style: "illustrated",
    basePrompt: "a weathered tavern keeper"
  });
  assert.equal(result.ok, true);

  let run = getSoloRun("run_img_a");
  assert.equal(run.npcs.tavern_keeper.imageAssetId, "img_tavern_keeper_base");

  // Base generated, with served uri...
  const baseAsset = run.imageAssets.img_tavern_keeper_base;
  assert.equal(baseAsset.status, "generated");
  assert.equal(baseAsset.uri, "/data/assets/run_img_a/tavern_keeper/base.png");
  assert.ok(fs.existsSync(path.join(process.env.NOTDND_ASSETS_ROOT, "run_img_a", "tavern_keeper", "base.png")));

  // ...and NO expression variants are generated at all — every variant slot
  // stays queued (the slots remain for the dormant reference seam), so the UI
  // reuses the single cached BASE portrait for every expression.
  for (const expression of NPC_EXPRESSIONS) {
    const assetId = run.npcs.tavern_keeper.expressionVariants[expression];
    assert.equal(assetId, `img_tavern_keeper_${expression}`);
    assert.equal(run.imageAssets[assetId].status, "queued", `${expression} should stay queued (no gen)`);
  }

  // Requesting a variant is now a NO-OP: it skips generation and the caller
  // falls back to the cached base portrait (stable, recognizable face).
  const warmResult = await runVariantImageJob({
    runId: "run_img_a",
    npcId: "tavern_keeper",
    expression: "warm",
    style: "illustrated"
  });
  assert.equal(warmResult.ok, true);
  assert.equal(warmResult.skipped, true);

  run = getSoloRun("run_img_a");
  const warmId = run.npcs.tavern_keeper.expressionVariants.warm;
  // No fresh generation: the slot stays queued and no variant file is written.
  assert.equal(run.imageAssets[warmId].status, "queued");
  assert.ok(!fs.existsSync(path.join(process.env.NOTDND_ASSETS_ROOT, "run_img_a", "tavern_keeper", "warm.png")));

  // The run is still schema-valid after the base-only worker writes.
  assert.doesNotThrow(() => saveSoloRun(getSoloRun("run_img_a")));
});

test("runImageJob returns not-found for a missing npc and never throws", async () => {
  seedRunWithNpc("run_img_b");
  const result = await runImageJob({ runId: "run_img_b", npcId: "ghost" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not found/);
});

test("ensureNpcImageAssets is idempotent and creates base + 6 variants + vnBody", () => {
  seedRunWithNpc("run_img_c");
  const first = ensureNpcImageAssets("run_img_c", "tavern_keeper", { style: "pixel" });
  assert.equal(first.base, "img_tavern_keeper_base");
  assert.equal(Object.keys(first.variants).length, NPC_EXPRESSIONS.length);
  // New full-body VN sprite slot, distinct from the bust + variants.
  assert.equal(first.vnBody, "img_tavern_keeper_vnBody");

  const afterFirst = getSoloRun("run_img_c");
  // base + 6 expression variants + 1 vnBody.
  assert.equal(Object.keys(afterFirst.imageAssets).length, NPC_EXPRESSIONS.length + 2);
  assert.equal(afterFirst.imageAssets.img_tavern_keeper_base.status, "queued");
  assert.equal(afterFirst.imageAssets.img_tavern_keeper_base.promptSummary, "style:pixel");
  // vnBody starts as a queued placeholder (no image until lazily generated).
  assert.equal(afterFirst.imageAssets.img_tavern_keeper_vnBody.status, "queued");
  assert.equal(afterFirst.imageAssets.img_tavern_keeper_vnBody.uri, null);

  ensureNpcImageAssets("run_img_c", "tavern_keeper", { style: "pixel" });
  const afterSecond = getSoloRun("run_img_c");
  assert.equal(Object.keys(afterSecond.imageAssets).length, NPC_EXPRESSIONS.length + 2);
});

test("runVnBodyImageJob generates the full-body sprite into a slot distinct from the bust", async () => {
  seedRunWithNpc("run_vn_a");
  // Pre-generate the bust so we can prove vnBody is additive (bust untouched).
  await runImageJob({ runId: "run_vn_a", npcId: "tavern_keeper", basePrompt: "a keeper" });
  let run = getSoloRun("run_vn_a");
  const bustUri = run.imageAssets.img_tavern_keeper_base.uri;
  assert.equal(run.imageAssets.img_tavern_keeper_base.status, "generated");
  // vnBody slot exists but is not yet generated (lazy).
  assert.equal(run.imageAssets.img_tavern_keeper_vnBody.status, "queued");

  const result = await runVnBodyImageJob({ runId: "run_vn_a", npcId: "tavern_keeper", basePrompt: "a keeper" });
  assert.equal(result.ok, true);
  assert.equal(result.vnBody.ok, true);

  run = getSoloRun("run_vn_a");
  const vnAsset = run.imageAssets.img_tavern_keeper_vnBody;
  assert.equal(vnAsset.status, "generated");
  assert.match(vnAsset.uri, /\/tavern_keeper\/vnBody\.(png|jpe?g|webp)$/);
  // Distinct slot: vnBody uri != bust uri; the bust is untouched (additive).
  assert.notEqual(vnAsset.uri, bustUri);
  assert.equal(run.imageAssets.img_tavern_keeper_base.uri, bustUri);
  // The on-disk file exists at the vnBody path.
  const onDisk = path.join(process.env.NOTDND_ASSETS_ROOT, "run_vn_a", "tavern_keeper", path.basename(vnAsset.uri));
  assert.ok(fs.existsSync(onDisk));
});

test("runVnBodyImageJob is generate-once / cache-forever", async () => {
  seedRunWithNpc("run_vn_b");
  const first = await runVnBodyImageJob({ runId: "run_vn_b", npcId: "tavern_keeper" });
  assert.equal(first.ok, true);
  assert.notEqual(first.vnBody.reused, true);
  const firstUri = getSoloRun("run_vn_b").imageAssets.img_tavern_keeper_vnBody.uri;

  const second = await runVnBodyImageJob({ runId: "run_vn_b", npcId: "tavern_keeper" });
  assert.equal(second.ok, true);
  assert.equal(second.vnBody.reused, true);
  assert.equal(second.vnBody.uri, firstUri);
});

test("runVnBodyImageJob returns not-found for a missing npc and never throws", async () => {
  seedRunWithNpc("run_vn_c");
  const result = await runVnBodyImageJob({ runId: "run_vn_c", npcId: "ghost" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not found/);
});

test("resolveVnBodyUri returns the sprite only for the active VN speaker", async () => {
  seedRunWithNpc("run_vn_d");
  await runVnBodyImageJob({ runId: "run_vn_d", npcId: "tavern_keeper" });
  const run = getSoloRun("run_vn_d");
  const uri = run.imageAssets.img_tavern_keeper_vnBody.uri;
  // Active VN mode for this speaker -> the sprite uri.
  assert.equal(resolveVnBodyUri(run, { active: true, speakerId: "tavern_keeper" }), uri);
  // Ambient -> null.
  assert.equal(resolveVnBodyUri(run, { active: false, speakerId: null }), null);
  // Active but a different (un-generated) speaker -> null.
  assert.equal(resolveVnBodyUri(run, { active: true, speakerId: "someone_else" }), null);
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

// ─────────────────────────────────────────────────────────────────────────────
// C.6 — a scene/location image must carry the run's selected ART STYLE, not a
// hardcoded cinematic/dark-fantasy direction. artStyleDirection now has a
// "location" surface per style; anime runs must produce anime scene direction.
// ─────────────────────────────────────────────────────────────────────────────
test("location art direction differs per art style (anime scene != cinematic scene)", () => {
  const anime = artStyleDirection("anime", "location");
  const cinematic = artStyleDirection("cinematic", "location");
  const illustrated = artStyleDirection("illustrated", "location");

  // Each carries its own aesthetic keyword.
  assert.match(anime, /anime/i, "anime location direction asserts anime");
  assert.doesNotMatch(anime, /film noir/i, "anime location is NOT cinematic dark-fantasy");
  assert.match(cinematic, /cinematic|film noir/i, "cinematic location asserts cinematic");
  assert.match(illustrated, /painterly/i, "illustrated location asserts painterly");

  // The three are genuinely distinct directions.
  assert.notEqual(anime, cinematic);
  assert.notEqual(anime, illustrated);
  assert.notEqual(cinematic, illustrated);
});

test("every location direction keeps the shared establishing-shot composition", () => {
  for (const style of ["illustrated", "anime", "cinematic"]) {
    const dir = artStyleDirection(style, "location");
    assert.match(dir, /establishing shot/i, `${style} location composes as a banner`);
    assert.match(dir, /no people, no characters/i, `${style} location has no subject`);
  }
});

test("unknown/missing art style falls back to the illustrated location direction", () => {
  const fallback = artStyleDirection("illustrated", "location");
  assert.equal(artStyleDirection("nonexistent-style", "location"), fallback);
  assert.equal(artStyleDirection("", "location"), fallback);
  assert.equal(artStyleDirection(undefined, "location"), fallback);
});
