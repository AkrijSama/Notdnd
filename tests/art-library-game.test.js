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

// ── location precision + face read path (library batch-cook wiring) ──────────

const { locationLibraryTag, resolveNpcFaceFromLibrary } = await import("../server/solo/artLibrary.js");
const { resolveVnBodyUri } = await import("../server/solo/scene.js");
const { checkoutFace } = await import("../scripts/art/library.mjs");

test("locationLibraryTag: committed name -> loc:<slug> (punctuation collapses)", () => {
  assert.equal(locationLibraryTag("Hollow Pine"), "loc:hollow-pine");
  assert.equal(locationLibraryTag("The Green Static — Fringe"), "loc:the-green-static-fringe");
  assert.equal(locationLibraryTag("The Shattered Flagon"), "loc:the-shattered-flagon");
  assert.equal(locationLibraryTag(""), null);
  assert.equal(locationLibraryTag(undefined), null);
});

test("resolveSceneArtForRun: a loc-tagged keep serves ONLY its own location", () => {
  addAsset({ id: "fringe_scene", world: "w_geo", kind: "scene", style: "anime", tags: ["loc:the-green-static-fringe"] });
  rateAsset("fringe_scene", "keep");
  const run = { world: { variant: "w_geo", artStyleOptions: { default: "anime" } } };
  assert.equal(
    resolveSceneArtForRun(run, { name: "The Green Static — Fringe" }),
    libraryAssetUri("fringe_scene"),
    "tag-matched location serves its scene"
  );
  assert.equal(
    resolveSceneArtForRun(run, { name: "Rust Delta" }),
    null,
    "a DIFFERENT location never inherits a loc-tagged scene (no stranger's location)"
  );
  assert.equal(resolveSceneArtForRun(run), null, "no location given -> loc-tagged keeps stay out of the generic rung");
});

test("resolveSceneArtForRun: untagged (generic) keeps still serve any location of the world", () => {
  addAsset({ id: "generic_scene", world: "w_geo2", kind: "scene", style: "anime" });
  rateAsset("generic_scene", "keep");
  const run = { world: { variant: "w_geo2", artStyleOptions: { default: "anime" } } };
  assert.equal(resolveSceneArtForRun(run, { name: "Anywhere" }), libraryAssetUri("generic_scene"));
  assert.equal(resolveSceneArtForRun(run), libraryAssetUri("generic_scene"));
});

test("resolveNpcFaceFromLibrary: keep + checkout to exactly (run, npc) + style match", () => {
  addAsset({ id: "face_a", world: "w_face", kind: "portrait", style: "anime" });
  rateAsset("face_a", "keep");
  checkoutFace("face_a", { runId: "run_1", npcId: "npc_x" });
  const run = { runId: "run_1", world: { variant: "w_face", artStyleOptions: { default: "anime" } } };
  assert.equal(resolveNpcFaceFromLibrary(run, "npc_x", "portrait"), libraryAssetUri("face_a"));
  assert.equal(resolveNpcFaceFromLibrary(run, "npc_other", "portrait"), null, "no checkout -> never a stranger's face");
  assert.equal(resolveNpcFaceFromLibrary({ ...run, runId: "run_2" }, "npc_x", "portrait"), null, "another run never sees the face");
  assert.equal(resolveNpcFaceFromLibrary(run, "npc_x", "fullbody"), null, "kind is exact (portrait checkout is not a fullbody)");
});

test("resolveNpcFaceFromLibrary: off-style and unrated checkouts never serve", () => {
  addAsset({ id: "face_real", world: "w_face2", kind: "portrait", style: "realistic" });
  rateAsset("face_real", "keep");
  checkoutFace("face_real", { runId: "run_s", npcId: "npc_s" });
  const animeRun = { runId: "run_s", flags: { artStyle: "anime" }, world: { variant: "w_face2" } };
  assert.equal(resolveNpcFaceFromLibrary(animeRun, "npc_s", "portrait"), null, "style lock holds — realistic art never serves an anime run");
  const realRun = { runId: "run_s", flags: { artStyle: "realistic" }, world: { variant: "w_face2" } };
  assert.equal(resolveNpcFaceFromLibrary(realRun, "npc_s", "portrait"), libraryAssetUri("face_real"));

  addAsset({ id: "face_unrated", world: "w_face2", kind: "portrait", style: "realistic" });
  checkoutFace("face_unrated", { runId: "run_u", npcId: "npc_u" });
  assert.equal(
    resolveNpcFaceFromLibrary({ runId: "run_u", flags: { artStyle: "realistic" }, world: { variant: "w_face2" } }, "npc_u", "portrait"),
    null,
    "unrated checkout stays invisible until rated keep"
  );
});

test("resolveVnBodyUri: run-generated sprite wins; library checkout fullbody is the fallback", () => {
  addAsset({ id: "vn_body", world: "w_vn", kind: "fullbody", style: "realistic" });
  rateAsset("vn_body", "keep");
  checkoutFace("vn_body", { runId: "run_vn", npcId: "npc_talker" });
  const base = { runId: "run_vn", flags: { artStyle: "realistic" }, world: { variant: "w_vn" } };

  const withRunAsset = {
    ...base,
    imageAssets: { img_npc_talker_vnBody: { status: "generated", uri: "/data/assets/run_vn/npc_talker/vnBody.png" } }
  };
  assert.equal(
    resolveVnBodyUri(withRunAsset, { active: true, speakerId: "npc_talker" }),
    "/data/assets/run_vn/npc_talker/vnBody.png",
    "the face the player has seen never swaps"
  );

  const withoutRunAsset = { ...base, imageAssets: {} };
  assert.equal(
    resolveVnBodyUri(withoutRunAsset, { active: true, speakerId: "npc_talker" }),
    libraryAssetUri("vn_body"),
    "library checkout serves while the run asset is absent"
  );
  assert.equal(resolveVnBodyUri(withoutRunAsset, { active: true, speakerId: "npc:npc_talker" }), libraryAssetUri("vn_body"), "npc: prefix stripped");
  assert.equal(resolveVnBodyUri(withoutRunAsset, { active: false, speakerId: "npc_talker" }), null, "ambient -> null");
  assert.equal(resolveVnBodyUri({ ...base, imageAssets: {} }, { active: true, speakerId: "npc_nobody" }), null, "no checkout -> clean empty state");
});

test("collectNpcsNeedingArt: an NPC wearing a checked-out library face is art-complete", async () => {
  const { collectNpcsNeedingArt } = await import("../server/solo/scene.js");
  addAsset({ id: "face_worn", world: "w_need", kind: "portrait", style: "realistic" });
  rateAsset("face_worn", "keep");
  checkoutFace("face_worn", { runId: "run_need", npcId: "npc_dressed" });
  const run = {
    runId: "run_need",
    flags: { artStyle: "realistic" },
    world: { variant: "w_need" },
    imageAssets: {},
    npcs: {
      npc_dressed: { npcId: "npc_dressed", imageAssetId: "img_npc_dressed_base" },
      npc_bare: { npcId: "npc_bare", imageAssetId: "img_npc_bare_base" }
    }
  };
  const visible = [
    { entityType: "npc", entityId: "npc:npc_dressed" },
    { entityType: "npc", entityId: "npc:npc_bare" }
  ];
  assert.deepEqual(
    collectNpcsNeedingArt(run, visible),
    ["npc_bare"],
    "only the faceless NPC needs generated art — the library face never gets swapped"
  );
});
