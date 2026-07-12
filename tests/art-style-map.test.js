import assert from "node:assert/strict";
import test from "node:test";

const {
  ENGINE_STYLES,
  LIBRARY_STYLES,
  engineToLibraryStyle,
  libraryToEngineStyle,
  normalizeEngineStyle,
  normalizeLibraryStyle,
  resolveWorldArtStyle,
  runArtStyle,
  stampArtStyle
} = await import("../server/solo/artStyle.js");

test("the vocab sets are exactly the two locked vocabularies", () => {
  assert.deepEqual([...ENGINE_STYLES], ["illustrated", "anime", "cinematic"]);
  assert.deepEqual([...LIBRARY_STYLES], ["anime", "dark-fantasy"]);
});

test("engine <-> library mapping is total and correct", () => {
  assert.equal(engineToLibraryStyle("illustrated"), "dark-fantasy");
  assert.equal(engineToLibraryStyle("cinematic"), "dark-fantasy");
  assert.equal(engineToLibraryStyle("anime"), "anime");
  // reverse
  assert.equal(libraryToEngineStyle("anime"), "anime");
  assert.equal(libraryToEngineStyle("dark-fantasy"), "illustrated");
  // junk clamps to the defaults
  assert.equal(engineToLibraryStyle("bogus"), "dark-fantasy");
  assert.equal(normalizeEngineStyle("ANIME"), "anime");
  assert.equal(normalizeEngineStyle(""), "illustrated");
  assert.equal(normalizeLibraryStyle("nope"), "dark-fantasy");
});

test("RECONCILIATION FLAG: artStyleOptions.default is primary, legacy artStyle is fallback", () => {
  // new field wins even when the legacy string disagrees
  assert.equal(
    resolveWorldArtStyle({ artStyleOptions: { default: "anime" }, artStyle: "cinematic" }),
    "anime"
  );
  // legacy string used only when the new field is absent (old saves)
  assert.equal(resolveWorldArtStyle({ artStyle: "cinematic" }), "cinematic");
  // neither -> default engine style
  assert.equal(resolveWorldArtStyle({}), "illustrated");
  assert.equal(resolveWorldArtStyle(null), "illustrated");
  // an empty/blank new field falls through to legacy, not to the default
  assert.equal(resolveWorldArtStyle({ artStyleOptions: { default: "  " }, artStyle: "anime" }), "anime");
});

test("runArtStyle prefers world, uses flags.artStyle only for a world with no style", () => {
  assert.equal(runArtStyle({ world: { artStyleOptions: { default: "anime" } }, flags: { artStyle: "cinematic" } }), "anime");
  assert.equal(runArtStyle({ world: { artStyle: "cinematic" }, flags: { artStyle: "anime" } }), "cinematic");
  // world carries no style -> the flags mirror is the last resort
  assert.equal(runArtStyle({ world: {}, flags: { artStyle: "anime" } }), "anime");
  assert.equal(runArtStyle({ flags: { artStyle: "anime" } }), "anime");
  assert.equal(runArtStyle({}), "illustrated");
});

test("stampArtStyle writes BOTH the new primary and the legacy string", () => {
  const w = stampArtStyle({}, "anime");
  assert.equal(w.artStyle, "anime");
  assert.deepEqual(w.artStyleOptions, { default: "anime" });
  // clamps junk
  const j = stampArtStyle({}, "bogus");
  assert.equal(j.artStyle, "illustrated");
  assert.equal(j.artStyleOptions.default, "illustrated");
});
