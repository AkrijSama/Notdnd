import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Run the whole file against an isolated temp library (never the real one).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "art-lib-"));
process.env.NOTDND_ASSET_LIBRARY_ROOT = TMP;

const {
  addAsset,
  getAsset,
  queryAssets,
  tagAsset,
  checkoutFace,
  releaseFace,
  rateAsset,
  buildSidecar,
  ASSET_KINDS,
  FACE_KINDS
} = await import("../scripts/art/library.mjs");

test("buildSidecar carries every Law 5 field, with defaults", () => {
  const s = buildSidecar({ id: "a1" });
  for (const k of ["id", "createdAt", "origin", "creator", "world", "style", "kind", "tags", "checkout", "rating", "workflow", "promptUsed"]) {
    assert.ok(k in s, `sidecar has ${k}`);
  }
  assert.equal(s.origin, "generated", "origin defaults to generated");
  assert.equal(s.creator, null, "creator null now (load-bearing later)");
  assert.equal(s.checkout, null);
  assert.equal(s.rating, null);
  assert.deepEqual(s.tags, []);
});

test("addAsset writes a sidecar readable by getAsset (idempotent by id)", () => {
  addAsset({ id: "scene1", kind: "scene", world: "babel", style: "anime", tags: ["forest", "day"], workflow: "anime", promptUsed: "a forest" });
  const got = getAsset("scene1");
  assert.equal(got.kind, "scene");
  assert.equal(got.world, "babel");
  assert.deepEqual(got.tags, ["forest", "day"]);
  // re-add overwrites cleanly (resumed batch)
  addAsset({ id: "scene1", kind: "scene", world: "babel", style: "dark-fantasy", tags: ["forest"] });
  assert.equal(getAsset("scene1").style, "dark-fantasy");
});

test("CHECKOUT UNIQUENESS: a face holds at most ONE checkout", () => {
  addAsset({ id: "face1", kind: "npc-body", style: "anime", tags: ["face", "adult"] });
  checkoutFace("face1", { runId: "run_A", npcId: "npc_1" });
  assert.deepEqual(getAsset("face1").checkout, { runId: "run_A", npcId: "npc_1" });
  // a second checkout while held is refused
  assert.throws(() => checkoutFace("face1", { runId: "run_B", npcId: "npc_2" }), /already checked out/);
  // release returns it to the pool, then it can be re-claimed
  releaseFace("face1");
  assert.equal(getAsset("face1").checkout, null);
  checkoutFace("face1", { runId: "run_B", npcId: "npc_2" });
  assert.deepEqual(getAsset("face1").checkout, { runId: "run_B", npcId: "npc_2" });
});

test("SCENERY NEVER checks out (only face kinds)", () => {
  addAsset({ id: "card1", kind: "world-card", style: "anime" });
  assert.throws(() => checkoutFace("card1", { runId: "r", npcId: "n" }), /never check out/);
  // and face kinds are exactly npc-body / npc-portrait
  assert.deepEqual([...FACE_KINDS].sort(), ["npc-body", "npc-portrait"]);
  assert.ok(ASSET_KINDS.includes("world-card"));
});

test("QUERY excludes TOSS-rated images", () => {
  addAsset({ id: "keepme", kind: "scene", world: "babel", style: "anime" });
  addAsset({ id: "tossme", kind: "scene", world: "babel", style: "anime" });
  rateAsset("keepme", "keep");
  rateAsset("tossme", "toss");
  const ids = queryAssets({ world: "babel", style: "anime", kind: "scene" }).map((a) => a.id);
  assert.ok(ids.includes("keepme"), "kept image surfaces");
  assert.ok(!ids.includes("tossme"), "tossed image is excluded");
});

test("QUERY available:true returns only un-checked-out faces", () => {
  addAsset({ id: "poolA", kind: "npc-body", style: "anime" });
  addAsset({ id: "poolB", kind: "npc-body", style: "anime" });
  checkoutFace("poolB", { runId: "r", npcId: "n" });
  const avail = queryAssets({ kind: "npc-body", available: true }).map((a) => a.id);
  assert.ok(avail.includes("poolA"), "free face is available");
  assert.ok(!avail.includes("poolB"), "checked-out face is not available");
});

test("tagAsset merges + dedupes; rateAsset validates", () => {
  addAsset({ id: "t1", kind: "scene", tags: ["a"] });
  tagAsset("t1", ["b", "a", "c"]);
  assert.deepEqual(getAsset("t1").tags.sort(), ["a", "b", "c"]);
  assert.throws(() => rateAsset("t1", "maybe"), /rating must be/);
});
