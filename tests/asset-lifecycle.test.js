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
const { runDraftPortraitJob, getDraftPortrait, computeDraftPortraitId, draftIsCurrentRecipe } = await import("../server/solo/imageWorker.js");

// Valid current-recipe ids (the serve path treats any other id as stale-by-law).
const world0 = { artStyle: "anime", artStyleOptions: { default: "anime" }, tone: "dark fantasy", name: "W" };
const ID_PRED = computeDraftPortraitId({ name: "Pred", race: "Human", characterClass: "Fighter", pronouns: "he/him" }, 0, world0);
const ID_REPL = computeDraftPortraitId({ name: "Repl", race: "Human", characterClass: "Fighter", pronouns: "he/him" }, 0, world0);
const ID_LIVE = computeDraftPortraitId({ name: "Live", race: "Human", characterClass: "Rogue", pronouns: "she/her" }, 0, world0);

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
  const character = { name: "Rowan", race: "Human", characterClass: "Fighter", pronouns: "he/him" };

  // The predecessor lands.
  const a = await runDraftPortraitJob({ draftId: ID_PRED, character, world: world0 });
  assert.equal(a.ok, true, "predecessor generated");
  assert.ok(fs.existsSync(path.join(ASSETS, ID_PRED)), "predecessor on disk");

  // The replacement lands, superseding the predecessor.
  const b = await runDraftPortraitJob({ draftId: ID_REPL, character, world: world0, supersedes: ID_PRED });
  assert.equal(b.ok, true, "replacement generated");
  assert.ok(fs.existsSync(path.join(ASSETS, ID_REPL)), "replacement (the live one) survives");

  // Predecessor: DESTROYED on disk + UNREACHABLE via the serve path.
  assert.equal(fs.existsSync(path.join(ASSETS, ID_PRED)), false, "predecessor file destroyed");
  const served = getDraftPortrait(ID_PRED);
  assert.notEqual(served.status, "generated", "a destroyed draft never serves a live uri");
});

test("SERVE-ONLY-LIVE: a stale 'generated' entry whose file was destroyed is not served", async () => {
  const character = { name: "Mara", race: "Human", characterClass: "Rogue", pronouns: "she/her" };
  await runDraftPortraitJob({ draftId: ID_LIVE, character, world: world0 });
  assert.equal(getDraftPortrait(ID_LIVE).status, "generated", "live draft serves");
  // Destroy its file out from under the (in-memory generated) entry.
  fs.rmSync(path.join(ASSETS, ID_LIVE), { recursive: true, force: true });
  assert.notEqual(getDraftPortrait(ID_LIVE).status, "generated", "a dead file is never served as generated");
});

test("STALE-BY-LAW: a live draft older than the current recipe epoch is destroyed + not served", async () => {
  // The OLD prefix-less id format (pre-clause) and a wrong-epoch prefix are both stale.
  assert.equal(draftIsCurrentRecipe("draft_deadbeef"), false, "old prefix-less format is stale");
  assert.equal(draftIsCurrentRecipe("draft_20200101a_deadbeef"), false, "a wrong epoch is stale");
  assert.equal(draftIsCurrentRecipe(ID_PRED), true, "a current-epoch id is live");
  // Plant a pre-recipe live draft on disk under an old-format id, then serve it.
  const staleId = "draft_oldrecipe";
  fs.mkdirSync(path.join(ASSETS, staleId, "player"), { recursive: true });
  fs.writeFileSync(path.join(ASSETS, staleId, "player", "base.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const served = getDraftPortrait(staleId);
  assert.equal(served.status, "failed", "a pre-recipe draft is never served as live");
  assert.match(served.reason, /older art recipe/i, "the player is told a fresh one is cooking");
  assert.equal(fs.existsSync(path.join(ASSETS, staleId)), false, "the stale draft is destroyed on access");
});
