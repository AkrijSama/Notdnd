import assert from "node:assert/strict";
import test from "node:test";

const {
  styleForRun,
  engineStyleForRun,
  styleToEngine,
  toCanonicalStyle,
  lockRunArtStyle,
  allowedStylesFor,
  STYLES,
  STYLE_COOKBOOK
} = await import("../server/solo/artStyle.js");

// ---- THE BUTLER — one rung per test ---------------------------------------

test("rung 1: run.flags.artStyle (locked choice) wins over everything below", () => {
  const run = { flags: { artStyle: "anime" }, edition: "forbidden", world: { artStyleOptions: { default: "realistic" } } };
  assert.equal(styleForRun(run), "anime");
  // accepts legacy engine vocab in the lock too, normalized to canonical
  assert.equal(styleForRun({ flags: { artStyle: "cinematic" }, world: {} }), "realistic");
});

test("rung 2: a forbidden-mode run with no lock prefers realistic", () => {
  const run = { edition: "forbidden", world: { artStyleOptions: { default: "anime" } } };
  assert.equal(styleForRun(run), "realistic");
  // mainline edition does NOT trigger the realistic preference
  assert.equal(styleForRun({ edition: "mainline", world: { artStyleOptions: { default: "anime" } } }), "anime");
});

test("rung 3: world.artStyleOptions.default (then legacy artStyle) when no lock/forbidden", () => {
  assert.equal(styleForRun({ world: { artStyleOptions: { default: "anime" } } }), "anime");
  // legacy engine-vocab world default is normalized
  assert.equal(styleForRun({ world: { artStyleOptions: { default: "cinematic" } } }), "realistic");
  // resume-safety: legacy world.artStyle string when no options object
  assert.equal(styleForRun({ world: { artStyle: "anime" } }), "anime");
});

test("rung 4: house fallback is dark-fantasy when nothing else resolves", () => {
  assert.equal(styleForRun({ world: {} }), "dark-fantasy");
  assert.equal(styleForRun({}), "dark-fantasy");
  assert.equal(styleForRun(null), "dark-fantasy");
});

test("engineStyleForRun maps the butler result into engine vocab for the live path", () => {
  assert.equal(engineStyleForRun({ flags: { artStyle: "realistic" } }), "cinematic");
  assert.equal(engineStyleForRun({ world: { artStyleOptions: { default: "anime" } } }), "anime");
  assert.equal(engineStyleForRun({ world: {} }), "illustrated"); // dark-fantasy -> illustrated
});

// ---- STYLE LOCK LAW --------------------------------------------------------

test("lock: the guarded setter writes once, validated against the world's allow-list", () => {
  const run = { world: { artStyleOptions: { default: "anime", allowed: ["anime", "dark-fantasy", "realistic"] } } };
  assert.equal(lockRunArtStyle(run, "anime"), "anime");
  assert.equal(run.flags.artStyle, "anime");
  // re-writing the SAME style is a harmless no-op (idempotent)
  assert.equal(lockRunArtStyle(run, "anime"), "anime");
});

test("lock: a second CHANGING write is rejected unless a styleSwitch grant is passed", () => {
  const run = { world: { artStyleOptions: { allowed: [...STYLES] } } };
  lockRunArtStyle(run, "anime");
  assert.throws(() => lockRunArtStyle(run, "realistic"), /LOCKED/, "changing the locked style throws");
  assert.equal(run.flags.artStyle, "anime", "the lock held");
  // the Ink-purchase grant permits the switch (and invalidates cached art downstream)
  assert.equal(lockRunArtStyle(run, "realistic", { grant: true }), "realistic");
  assert.equal(run.flags.artStyle, "realistic");
});

test("lock: a style outside the world's allow-list is rejected at write time", () => {
  const run = { world: { artStyleOptions: { allowed: ["anime"] } } };
  assert.throws(() => lockRunArtStyle(run, "realistic"), /not an allowed style/);
  assert.equal(lockRunArtStyle(run, "anime"), "anime");
  // engine-vocab choice from the (legacy) chip is normalized before the allow-check
  const run2 = { world: { artStyleOptions: { allowed: ["dark-fantasy"] } } };
  assert.equal(lockRunArtStyle(run2, "illustrated"), "dark-fantasy", "illustrated -> dark-fantasy passes an allow-list of dark-fantasy");
});

test("allowedStylesFor defaults to all styles; the cookbook table has a realistic row", () => {
  assert.deepEqual(allowedStylesFor({}), [...STYLES]);
  assert.deepEqual(allowedStylesFor({ artStyleOptions: { allowed: ["anime", "realistic"] } }), ["anime", "realistic"]);
  // realistic shares the Juggernaut cookbook with dark-fantasy
  assert.equal(STYLE_COOKBOOK.realistic, "Juggernaut");
  assert.equal(STYLE_COOKBOOK["dark-fantasy"], "Juggernaut");
  assert.equal(STYLE_COOKBOOK.anime, "Illustrious");
  assert.equal(toCanonicalStyle("cinematic"), "realistic");
});
