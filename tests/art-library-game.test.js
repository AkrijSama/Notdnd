import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated temp library so keeps here never touch the real one.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "art-lib-game-"));
process.env.NOTDND_ASSET_LIBRARY_ROOT = TMP;

const { addAsset, rateAsset } = await import("../scripts/art/library.mjs");
const { resolveLibraryArt, resolveSceneArtForRun, worldKeyForRun, libraryAssetUri } =
  await import("../server/solo/artLibrary.js");
const { resolveLocationImageUri } = await import("../server/solo/scene.js");

// Helper: a rated "keep" asset with an explicit createdAt (stable ordering).
function keep({ id, world, kind, style, createdAt }) {
  addAsset({ id, world, kind, style, createdAt });
  rateAsset(id, "keep");
}

test("resolveLibraryArt: null when the slot has zero keeps (fallback untouched)", () => {
  assert.equal(resolveLibraryArt({ world: "empty", kind: "world-card" }), null);
  assert.equal(resolveLibraryArt({ world: "", kind: "world-card" }), null, "no world -> null");
});

test("resolveLibraryArt: a keep surfaces as its served library URI", () => {
  keep({ id: "wc1", world: "w_card", kind: "world-card", style: "anime" });
  assert.equal(resolveLibraryArt({ world: "w_card", kind: "world-card" }), libraryAssetUri("wc1"));
  assert.equal(libraryAssetUri("wc1"), "/data/assets/library/wc1.png");
});

test("resolveLibraryArt: null-rated and toss assets never surface — only keep", () => {
  addAsset({ id: "unrated", world: "w_rate", kind: "world-card", style: "anime" }); // rating null
  addAsset({ id: "tossed", world: "w_rate", kind: "world-card", style: "anime" });
  rateAsset("tossed", "toss");
  assert.equal(resolveLibraryArt({ world: "w_rate", kind: "world-card" }), null);
  keep({ id: "kept", world: "w_rate", kind: "world-card", style: "anime" });
  assert.equal(resolveLibraryArt({ world: "w_rate", kind: "world-card" }), libraryAssetUri("kept"));
});

test("resolveLibraryArt: style narrows to the mapped canonical library style", () => {
  keep({ id: "s_anime", world: "w_style", kind: "scene", style: "anime" });
  keep({ id: "s_dark", world: "w_style", kind: "scene", style: "dark-fantasy" });
  keep({ id: "s_real", world: "w_style", kind: "scene", style: "realistic" });
  // canonical vocab matches directly
  assert.equal(resolveLibraryArt({ world: "w_style", kind: "scene", style: "anime" }), libraryAssetUri("s_anime"));
  assert.equal(resolveLibraryArt({ world: "w_style", kind: "scene", style: "dark-fantasy" }), libraryAssetUri("s_dark"));
  assert.equal(resolveLibraryArt({ world: "w_style", kind: "scene", style: "realistic" }), libraryAssetUri("s_real"));
  // legacy engine vocab is normalized: illustrated -> dark-fantasy, cinematic -> realistic
  assert.equal(resolveLibraryArt({ world: "w_style", kind: "scene", style: "illustrated" }), libraryAssetUri("s_dark"));
  assert.equal(resolveLibraryArt({ world: "w_style", kind: "scene", style: "cinematic" }), libraryAssetUri("s_real"));
});

test("resolveLibraryArt: stable pick = newest first, stable across calls", () => {
  keep({ id: "old", world: "w_pick", kind: "scene", style: "anime", createdAt: "2026-01-01T00:00:00.000Z" });
  keep({ id: "new", world: "w_pick", kind: "scene", style: "anime", createdAt: "2026-06-01T00:00:00.000Z" });
  const a = resolveLibraryArt({ world: "w_pick", kind: "scene", style: "anime" });
  const b = resolveLibraryArt({ world: "w_pick", kind: "scene", style: "anime" });
  assert.equal(a, libraryAssetUri("new"), "newest keep wins");
  assert.equal(a, b, "pick is stable across renders (no reshuffle)");
});

test("worldKeyForRun: variant wins, else lowercased name, else null", () => {
  assert.equal(worldKeyForRun({ world: { variant: "babel", name: "Babel" } }), "babel");
  assert.equal(worldKeyForRun({ world: { name: "Wrong Woods" } }), "wrong woods");
  assert.equal(worldKeyForRun({ world: {} }), null);
  assert.equal(worldKeyForRun({}), null);
});

test("resolveSceneArtForRun: library scene keep for the run's world + style", () => {
  keep({ id: "run_scene", world: "w_run", kind: "scene", style: "anime" });
  const run = { world: { variant: "w_run", artStyleOptions: { default: "anime" } } };
  assert.equal(resolveSceneArtForRun(run), libraryAssetUri("run_scene"));
  // a run whose world has no keeps -> null (fallback path)
  assert.equal(resolveSceneArtForRun({ world: { variant: "w_none", artStyle: "anime" } }), null);
});

test("resolveLocationImageUri: library scene keep wins over the generated image (library-first)", () => {
  keep({ id: "loc_lib", world: "w_loc", kind: "scene", style: "anime" });
  const location = { locationId: "start" };
  const run = {
    world: { variant: "w_loc", artStyleOptions: { default: "anime" } },
    imageAssets: { img_location_start: { status: "generated", uri: "/data/assets/run/location_start/base.png" } }
  };
  assert.equal(resolveLocationImageUri(run, location), libraryAssetUri("loc_lib"));
});

test("resolveLocationImageUri: a LOCKED generated image wins over a library keep", () => {
  keep({ id: "loc_lib2", world: "w_lock", kind: "scene", style: "anime" });
  const location = { locationId: "start" };
  const run = {
    world: { variant: "w_lock", artStyleOptions: { default: "anime" } },
    imageAssets: { img_location_start: { status: "generated", uri: "/data/assets/run/base.png", locked: true } }
  };
  assert.equal(resolveLocationImageUri(run, location), "/data/assets/run/base.png");
});

test("resolveLocationImageUri: zero keeps -> unchanged (generated uri, else null)", () => {
  const location = { locationId: "start" };
  const genRun = {
    world: { variant: "w_fallthrough", artStyle: "anime" },
    imageAssets: { img_location_start: { status: "generated", uri: "/gen.png" } }
  };
  assert.equal(resolveLocationImageUri(genRun, location), "/gen.png", "generated image served when no keep");
  const bareRun = { world: { variant: "w_fallthrough2", artStyle: "anime" }, imageAssets: {} };
  assert.equal(resolveLocationImageUri(bareRun, location), null, "null when neither keep nor generated");
});
