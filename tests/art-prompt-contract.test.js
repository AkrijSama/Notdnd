import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated temp library (for the sidecar-meta test); templates/blocks resolve from
// the real scripts/art/prompts (default dir, cwd = repo root).
process.env.NOTDND_ASSET_LIBRARY_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "art-pc-"));

const {
  buildPrompt,
  mapNpcToSlots,
  mapLocationToSlots,
  laneForKind,
  TOWER_HORIZON_PHRASE
} = await import("../scripts/art/promptAssembly.js");
const { buildSidecar, getAsset, addAsset } = await import("../scripts/art/library.mjs");

test("REQUIRED slot missing -> throws (never generate underspecified)", () => {
  assert.throws(() => buildPrompt("portrait", "anime", {}), /requires slot "gender"/);
  assert.throws(() => buildPrompt("fullbody", "anime", { age: "adult" }), /requires slot "gender"/);
  assert.throws(() => buildPrompt("scene", "anime", {}), /requires slot "subject"/);
  assert.throws(() => buildPrompt("item", "anime", {}), /requires slot "itemType"/);
  // a filled required slot succeeds
  assert.ok(buildPrompt("portrait", "anime", { gender: "woman" }).positive.includes("woman"));
});

test("INJECTION punctuation in a slot value -> rejected", () => {
  for (const bad of ["woman (masterpiece:1.5)", "man:1.3", "elf <lora:x>", "hero [bad]", "a (weighted) thing"]) {
    assert.throws(() => buildPrompt("portrait", "anime", { gender: bad }), /plain words/, `should reject "${bad}"`);
  }
  // plain words with commas are fine (commas are segment separators, not weights)
  assert.ok(buildPrompt("portrait", "anime", { gender: "woman", attire: "linen dress, leather boots" }).positive.includes("leather boots"));
});

test("mapNpcToSlots derives plain slots from a real committed NPC shape", () => {
  const npc = {
    npcId: "npc_herbalist",
    displayName: "Mara",
    role: "herbalist",
    gender: "female",
    pronouns: "she/her",
    appearance: "a kind observant face, long braided hair, a simple apron over a linen dress",
    mannerism: "wipes her hands on her apron"
  };
  const slots = mapNpcToSlots(npc);
  assert.equal(slots.gender, "woman", "committed gender -> plain noun");
  assert.match(slots.hair, /braided/, "hair parsed from appearance");
  assert.match(slots.attire, /apron|dress/, "attire parsed from appearance");
  assert.match(slots.poseHint, /apron/, "poseHint from mannerism");
  // the parsed slots must ASSEMBLE cleanly (no injection, no missing required)
  const { positive } = buildPrompt("fullbody", "anime", slots);
  assert.match(positive, /woman/);
  assert.match(positive, /solo, full body, standing/, "fullbody invariants present");

  // a male NPC whose appearance has no parseable clause -> passthrough into attire
  const guard = mapNpcToSlots({ gender: "male", appearance: "grizzled and watchful" });
  assert.equal(guard.gender, "man");
  assert.equal(guard.attire, "grizzled and watchful", "passthrough when nothing parses");
});

test("mapLocationToSlots derives scene slots from a committed location + clock", () => {
  const slots = mapLocationToSlots({ name: "Forest Path", type: "frontier forest", clock: { phase: "afternoon" }, weather: "clear" });
  assert.deepEqual(slots, { subject: "Forest Path", setting: "frontier forest", timeOfDay: "afternoon", weatherHint: "clear" });
});

test("DIEGETIC LAW: starter-zone scene injects 'tower' into the NEGATIVE", () => {
  const plain = buildPrompt("scene", "anime", { subject: "a forest path" });
  assert.ok(!plain.negative.split(", ").includes("tower"), "no ban without a starter tag");
  for (const tag of ["starter", "distant-from-tower"]) {
    const banned = buildPrompt("scene", "anime", { subject: "a forest path" }, { tags: [tag] });
    assert.ok(banned.negative.split(", ").includes("tower"), `tower banned for tag "${tag}"`);
    assert.ok(!banned.positive.includes("tower"), "tower never in a scene positive");
  }
});

test("PROMOTIONAL EXEMPTION: worldcard offers the tower literal (positive), never bans it", () => {
  const wc = buildPrompt("worldcard", "anime", { subject: "a frontier town", horizon: TOWER_HORIZON_PHRASE }, { tags: ["starter"] });
  assert.ok(wc.positive.includes(TOWER_HORIZON_PHRASE), "tower literal available on the cover");
  assert.ok(!wc.negative.split(", ").includes("tower"), "worldcard is exempt from the diegetic ban even when tagged starter");
  // world-card KIND maps to the worldcard LANE
  assert.equal(laneForKind("world-card"), "worldcard");
});

test("DETERMINISM: identical inputs -> identical prompt + meta", () => {
  const slots = { gender: "man", age: "adult", build: "broad", hair: "short hair", attire: "leather coat", poseHint: "neutral standing pose" };
  const a = buildPrompt("fullbody", "dark-fantasy", slots, { tags: ["face"] });
  const b = buildPrompt("fullbody", "dark-fantasy", slots, { tags: ["face"] });
  assert.deepEqual(a, b, "same inputs assemble byte-for-byte identically");
});

test("META records templateVersion + blockVersions + slotValues, and persists on the sidecar", () => {
  const slots = { gender: "woman", hair: "long hair" };
  const { meta } = buildPrompt("portrait", "anime", slots);
  assert.equal(typeof meta.templateVersion, "number");
  assert.equal(meta.blockVersions.style, "anime");
  assert.equal(typeof meta.blockVersions.blockVersion, "number");
  assert.deepEqual(meta.slotValues, slots);
  // buildSidecar carries meta through (generate.mjs writes it alongside promptUsed)
  const s = buildSidecar({ id: "meta_asset", kind: "portrait", style: "anime", meta });
  assert.deepEqual(s.meta, meta);
  addAsset({ id: "meta_asset", kind: "portrait", style: "anime", meta, promptUsed: "..." });
  assert.deepEqual(getAsset("meta_asset").meta, meta, "meta round-trips through the sidecar");
  // an asset with no meta defaults to null (back-compat)
  assert.equal(buildSidecar({ id: "x" }).meta, null);
});
