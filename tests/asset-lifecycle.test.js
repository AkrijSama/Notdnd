// ASSET LIFECYCLE LAW (owner 2026-07-20): every generated image has exactly two fates —
// LIBRARY-KEPT or DESTROYED. No retained-with-a-flag third state. This proves:
//   • toss = the file is GONE (not flagged)
//   • a redo DESTROYS its predecessor once the replacement lands
//   • a superseded/destroyed draft is UNREACHABLE (serve-only-live) AND absent from disk
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LIB = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-lib-"));
const ASSETS = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-assets-"));
process.env.NOTDND_ASSET_LIBRARY_ROOT = LIB;
process.env.NOTDND_ASSETS_ROOT = ASSETS;
process.env.NOTDND_MOCK_IMAGE = "true"; // deterministic placeholder bytes, no network

const { addAsset, rateAsset, assetExists, libraryRoot } = await import("../scripts/art/library.mjs");
const { runDraftPortraitJob, getDraftPortrait } = await import("../server/solo/imageWorker.js");

test("TOSS = DESTROYED: the file + record are gone, not flagged", () => {
  addAsset({ id: "asset_toss", world: "w", kind: "portrait", style: "anime" });
  fs.writeFileSync(path.join(libraryRoot(), "asset_toss.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.equal(assetExists("asset_toss"), true, "asset exists before toss");
  const r = rateAsset("asset_toss", "toss");
  assert.equal(r.destroyed, true, "toss reports a destroy");
  assert.equal(assetExists("asset_toss"), false, "sidecar record is gone");
  assert.equal(fs.existsSync(path.join(libraryRoot(), "asset_toss.png")), false, "the image file is gone");
});

test("REDO DESTROYS PREDECESSOR: a superseded draft is unreachable AND absent from disk", async () => {
  const world = { artStyle: "anime", artStyleOptions: { default: "anime" }, tone: "dark fantasy", name: "W" };
  const character = { name: "Rowan", race: "Human", characterClass: "Fighter", pronouns: "he/him" };

  // The predecessor lands.
  const a = await runDraftPortraitJob({ draftId: "draft_pred", character, world });
  assert.equal(a.ok, true, "predecessor generated");
  assert.ok(fs.existsSync(path.join(ASSETS, "draft_pred")), "predecessor on disk");

  // The replacement lands, superseding the predecessor.
  const b = await runDraftPortraitJob({ draftId: "draft_repl", character, world, supersedes: "draft_pred" });
  assert.equal(b.ok, true, "replacement generated");
  assert.ok(fs.existsSync(path.join(ASSETS, "draft_repl")), "replacement (the live one) survives");

  // Predecessor: DESTROYED on disk + UNREACHABLE via the serve path.
  assert.equal(fs.existsSync(path.join(ASSETS, "draft_pred")), false, "predecessor file destroyed");
  const served = getDraftPortrait("draft_pred");
  assert.notEqual(served.status, "generated", "a destroyed draft never serves a live uri");
});

test("SERVE-ONLY-LIVE: a stale 'generated' entry whose file was destroyed is not served", async () => {
  const world = { artStyle: "anime", artStyleOptions: { default: "anime" }, tone: "dark fantasy", name: "W" };
  const character = { name: "Mara", race: "Human", characterClass: "Rogue", pronouns: "she/her" };
  await runDraftPortraitJob({ draftId: "draft_live", character, world });
  assert.equal(getDraftPortrait("draft_live").status, "generated", "live draft serves");
  // Destroy its file out from under the (in-memory generated) entry.
  fs.rmSync(path.join(ASSETS, "draft_live"), { recursive: true, force: true });
  assert.notEqual(getDraftPortrait("draft_live").status, "generated", "a dead file is never served as generated");
});
