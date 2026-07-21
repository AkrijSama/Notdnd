// FRIDGE TASTER — the automated taste check gating library auto-keep.
// Proves the full lifecycle with the deterministic MOCK assessor (zero cost):
//   • pass    -> FRIDGE   (library keep, served)
//   • suspect -> QUARANTINE (holding pen, served to NOTHING)
//   • a quarantined asset is UNSERVABLE (the serve/resolve path skips it)
//   • owner review resolves quarantine -> fridge (keep) or trash (destroy)
//   • a 30-day auto-trash sweep drains aged quarantine entries
//   • the config seat (NOTDND_TASTER_MODEL) defaults to the mock and fails closed
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated temp roots (never the real library).
const LIB = fs.mkdtempSync(path.join(os.tmpdir(), "fridge-lib-"));
const ASSETS = fs.mkdtempSync(path.join(os.tmpdir(), "fridge-assets-"));
process.env.NOTDND_ASSET_LIBRARY_ROOT = LIB;
process.env.NOTDND_ASSETS_ROOT = ASSETS;
process.env.NOTDND_MOCK_IMAGE = "true";

const lib = await import("../scripts/art/library.mjs");
const taster = await import("../server/solo/fridgeTaster.js");
const artLib = await import("../server/solo/artLibrary.js");
const { intakeToLibrary } = await import("../server/solo/imageWorker.js");

// A minimal valid PNG header — bytes are irrelevant to the mock assessor.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngExists = (id) => fs.existsSync(path.join(LIB, `${id}.png`));
const runFor = (world, extra = {}) => ({ runId: `run_${world}`, world: { name: world }, flags: { artStyle: "anime" }, ...extra });

beforeEach(() => {
  taster.clearTasteFixtures();
  delete process.env.NOTDND_TASTER_MODEL;
});

test("PASS -> FRIDGE: auto-kept and servable", async () => {
  taster.setTasteFixtures({ sc_pass: "pass" });
  const run = runFor("passtown");
  await intakeToLibrary({ id: "sc_pass", bytes: PNG, kind: "scene", run, provider: "comfyui" });

  const s = lib.getAsset("sc_pass");
  assert.equal(s.rating, "keep", "pass lands as a library keep");
  assert.equal(taster.isQuarantined("sc_pass"), false, "not quarantined");
  assert.ok(s.tags.includes("taste:pass"), "carries the taste:pass tag");
  // The scene serve path serves it.
  assert.equal(artLib.resolveSceneArtForRun(run), artLib.libraryAssetUri("sc_pass"));
});

test("SUSPECT -> QUARANTINE: unservable (serve/resolve path skips it)", async () => {
  taster.setTasteFixtures({ sc_susp: "suspect" });
  const run = runFor("susptown");
  await intakeToLibrary({ id: "sc_susp", bytes: PNG, kind: "scene", run, provider: "comfyui" });

  const s = lib.getAsset("sc_susp");
  assert.equal(taster.isQuarantined("sc_susp"), true, "in the holding pen");
  assert.notEqual(s.rating, "keep", "a quarantined asset is never a keep");
  assert.equal(s.quarantine.verdict, "suspect", "carries a quarantine marker");
  // Unservable: every serve gate skips it.
  assert.equal(artLib.resolveSceneArtForRun(run), null, "scene serve path skips it");
  assert.equal(lib.queryAssets({ world: "susptown", kind: "scene" }).some((a) => a.id === "sc_susp"), false, "dropped from queryAssets");
  assert.ok(taster.listQuarantined().some((a) => a.id === "sc_susp"), "listed for owner review");
});

test("QUARANTINED FACE never checks out and is unservable via the face path", async () => {
  taster.setTasteFixtures({ pf_susp: "suspect" });
  const run = runFor("facetown", { npcs: { npc1: { gender: "female" } } });
  await intakeToLibrary({ id: "pf_susp", bytes: PNG, kind: "portrait", run, subjectId: "npc1", provider: "comfyui" });

  const s = lib.getAsset("pf_susp");
  assert.equal(taster.isQuarantined("pf_susp"), true);
  assert.equal(s.checkout, null, "a quarantined face is served to nothing, so never checks out");
  assert.equal(artLib.resolveNpcFaceFromLibrary(run, "npc1", "portrait"), null, "face serve path skips it");
});

test("RESOLVE -> FRIDGE: promotes to keep and becomes servable", async () => {
  taster.setTasteFixtures({ sc_fridge: "suspect" });
  const run = runFor("fridgetown");
  await intakeToLibrary({ id: "sc_fridge", bytes: PNG, kind: "scene", run, provider: "comfyui" });
  assert.equal(artLib.resolveSceneArtForRun(run), null, "unservable while quarantined");

  taster.resolveQuarantine("sc_fridge", "fridge");
  const s = lib.getAsset("sc_fridge");
  assert.equal(s.rating, "keep", "promoted to a library keep");
  assert.equal(taster.isQuarantined("sc_fridge"), false, "quarantine marker cleared");
  assert.equal(s.tags.includes("quarantine"), false, "quarantine tag stripped");
  assert.equal(artLib.resolveSceneArtForRun(run), artLib.libraryAssetUri("sc_fridge"), "now servable");
});

test("RESOLVE -> TRASH: destroys the image + sidecar", async () => {
  taster.setTasteFixtures({ sc_trash: "suspect" });
  const run = runFor("trashtown");
  await intakeToLibrary({ id: "sc_trash", bytes: PNG, kind: "scene", run, provider: "comfyui" });
  assert.equal(taster.isQuarantined("sc_trash"), true);

  const r = taster.resolveQuarantine("sc_trash", "trash");
  assert.equal(r.destroyed, true, "reports a destroy");
  assert.equal(lib.getAsset("sc_trash"), null, "sidecar record is gone");
  assert.equal(pngExists("sc_trash"), false, "image file is gone");
});

test("30-DAY AUTO-TRASH SWEEP removes an aged quarantine entry, spares a fresh one", async () => {
  taster.setTasteFixtures({ sc_aged: "suspect", sc_fresh: "suspect" });
  const run = runFor("sweeptown");
  await intakeToLibrary({ id: "sc_aged", bytes: PNG, kind: "scene", run, provider: "comfyui" });
  await intakeToLibrary({ id: "sc_fresh", bytes: PNG, kind: "scene", run, provider: "comfyui" });

  // Backdate the aged entry past the Law-6 max age.
  const aged = lib.getAsset("sc_aged");
  aged.quarantine.at = new Date(Date.now() - (taster.QUARANTINE_MAX_AGE_DAYS + 1) * 86_400_000).toISOString();
  lib.addAsset(aged);

  const result = taster.sweepQuarantine();
  assert.ok(result.swept.includes("sc_aged"), "aged entry swept");
  assert.equal(lib.getAsset("sc_aged"), null, "aged entry trashed (record gone)");
  assert.equal(pngExists("sc_aged"), false, "aged entry image gone");
  assert.equal(taster.isQuarantined("sc_fresh"), true, "fresh entry survives the sweep");
});

test("MOCK HEURISTIC (no fixture): flags a declared-human rendered as a skull-demon", async () => {
  const v = taster.taste({ id: "heur_monster", kind: "portrait", promptUsed: "portrait of a man, skull demon face, monstrous", run: { npcs: {} }, subjectId: null });
  assert.equal(v.verdict, "suspect", "human subject + monster tokens -> suspect");
  assert.ok(v.quarantine, "produces a quarantine marker");
});

test("MOCK HEURISTIC: a clean scene passes; a declared demon rendered monstrous is spared", async () => {
  const clean = taster.taste({ id: "heur_clean", kind: "scene", promptUsed: "a quiet forest clearing at dawn, painterly", run: {} });
  assert.equal(clean.verdict, "pass");

  const run = { npcs: { d1: { tags: ["demon"] } } };
  const spared = taster.taste({ id: "heur_demon", kind: "portrait", promptUsed: "a horned demon with a skull face", run, subjectId: "d1" });
  assert.equal(spared.verdict, "pass", "a declared non-human is allowed to look monstrous");
});

test("CONFIG SEAT: defaults to mock, fails closed when unwired, selects a registered adapter (no paid call)", async () => {
  assert.equal(taster.getAssessor().model, "mock", "default assessor is the mock");

  // Seat set but no adapter registered -> FAIL CLOSED to the mock (never a paid call).
  process.env.NOTDND_TASTER_MODEL = "claude-haiku-4-5";
  assert.equal(taster.getAssessor().model, "mock", "unwired seat falls back to mock");

  // Register a zero-cost local stub to prove the adapter point wires through.
  taster.registerAssessor("claude-haiku-4-5", () => ({ verdict: "pass", checks: [], reason: "stub adapter" }));
  assert.equal(taster.getAssessor().model, "claude-haiku-4-5", "registered adapter is selected");
  const v = taster.taste({ id: "seat_x", kind: "scene", promptUsed: "x", run: {}, defaultRating: "keep" });
  assert.equal(v.model, "claude-haiku-4-5");
  assert.equal(v.verdict, "pass");
});
