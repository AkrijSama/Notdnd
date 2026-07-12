import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "art-gen-"));
process.env.NOTDND_ASSET_LIBRARY_ROOT = TMP;

const { loadRecipe, buildGraph } = await import("../scripts/art/generate.mjs");
const { PROOF_SPECS } = await import("../scripts/art/proof-batch.mjs");
const { createReviewServer } = await import("../scripts/art/review.mjs");
const { addAsset, getAsset } = await import("../scripts/art/library.mjs");

// ---- recipes + graph (pure, no GPU) ---------------------------------------
test("both style recipes load and name their checkpoints", () => {
  const anime = loadRecipe("anime");
  const dark = loadRecipe("dark-fantasy");
  assert.match(anime.checkpoint, /Illustrious-XL/);
  assert.match(dark.checkpoint, /Juggernaut-XI/);
  assert.deepEqual(anime.lora, [], "LoRA slot present and empty");
  assert.deepEqual(dark.lora, [], "LoRA slot present and empty");
});

test("buildGraph makes a valid SDXL txt2img graph with per-kind dimensions", () => {
  const recipe = loadRecipe("anime");
  const g = buildGraph(recipe, { kind: "fullbody", prompt: "a warden", seed: 42 });
  assert.equal(g["4"].class_type, "CheckpointLoaderSimple");
  assert.equal(g["4"].inputs.ckpt_name, recipe.checkpoint);
  // fullbody is TALL
  assert.equal(g["5"].inputs.width, 832);
  assert.equal(g["5"].inputs.height, 1216);
  assert.equal(g["3"].inputs.seed, 42);
  assert.match(g["6"].inputs.text, /a warden/, "prompt + style suffix in the positive");
  assert.match(g["6"].inputs.text, /anime/);
  assert.equal(g["9"].class_type, "SaveImage");
  // world-card is WIDE
  const wide = buildGraph(recipe, { kind: "world-card", prompt: "x", seed: 1 });
  assert.ok(wide["5"].inputs.width > wide["5"].inputs.height, "world-card is wide");
  // item is square (clean-bg icon)
  const item = buildGraph(recipe, { kind: "item", prompt: "a sword", seed: 2 });
  assert.equal(item["5"].inputs.width, item["5"].inputs.height, "item is square");
});

// ---- proof batch composition ----------------------------------------------
test("the proof batch is exactly 14: 4 world-card + 6 scene (3 anime/3 dark) + 4 fullbody", () => {
  assert.equal(PROOF_SPECS.length, 14);
  const by = (k) => PROOF_SPECS.filter((s) => s.kind === k);
  assert.equal(by("world-card").length, 4);
  assert.equal(by("scene").length, 6);
  assert.equal(by("fullbody").length, 4);
  assert.ok(by("world-card").every((s) => s.style === "anime"), "world-cards are anime");
  assert.equal(by("scene").filter((s) => s.style === "anime").length, 3);
  assert.equal(by("scene").filter((s) => s.style === "dark-fantasy").length, 3);
  assert.ok(by("fullbody").every((s) => s.style === "anime"), "fullbodies are anime");
  // faces tagged for the checkout pool
  assert.ok(by("fullbody").every((s) => s.tags.includes("face")), "fullbody faces tagged");
  // ids unique (idempotent-resume keys)
  assert.equal(new Set(PROOF_SPECS.map((s) => s.id)).size, 14);
  // the old npc-body kind is fully retired from the batch
  assert.equal(by("npc-body").length, 0);
});

test("planFor resolves all four waiter lanes to a recipe + dims (dry-run routing)", async () => {
  const { planFor } = await import("../scripts/art/proof-batch.mjs");
  for (const kind of ["portrait", "fullbody", "scene", "item"]) {
    for (const style of ["anime", "dark-fantasy"]) {
      const p = planFor(style, kind);
      assert.equal(p.unresolved, false, `${kind}/${style} must resolve a recipe`);
      assert.ok(p.file.endsWith(".json"), `${kind}/${style} names a recipe file`);
      assert.ok(Array.isArray(p.dims) && p.dims.length === 2, `${kind}/${style} has [w,h] dims`);
    }
  }
  // lane-specific aspects: fullbody tall, scene wide, item square, portrait square-ish
  assert.deepEqual(planFor("anime", "fullbody").dims, [832, 1216]);
  assert.deepEqual(planFor("anime", "scene").dims, [1344, 768]);
  assert.deepEqual(planFor("anime", "item").dims, [1024, 1024]);
  assert.deepEqual(planFor("anime", "portrait").dims, [1024, 1024]);
});

test("loadRecipe passes a recipe.identity block through untouched (tailor socket)", () => {
  // A recipe carrying the optional IP-Adapter identity block must survive the load
  // verbatim — routing does not strip or interpret it this round.
  const recipe = loadRecipe("anime");
  assert.ok(!("identity" in recipe) || recipe.identity, "no identity in the stock recipe");
  // simulate a tuned recipe with the block: buildGraph must ignore it, not throw.
  const withIdentity = { ...recipe, identity: { refImage: "PORTRAIT_REF", weight: 0.7 } };
  const g = buildGraph(withIdentity, { kind: "fullbody", prompt: "a warden", seed: 3 });
  assert.equal(g["4"].class_type, "CheckpointLoaderSimple", "graph builds normally; identity ignored");
  assert.deepEqual(withIdentity.identity, { refImage: "PORTRAIT_REF", weight: 0.7 }, "identity block untouched");
});

// ---- review tool records a rating (acceptance #4) --------------------------
test("the review server records a keep/toss rating into the sidecar", async () => {
  addAsset({ id: "reviewme", kind: "scene", world: "babel", style: "anime" });
  fs.writeFileSync(path.join(TMP, "reviewme.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47])); // stub PNG bytes
  const server = createReviewServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/rate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "reviewme", rating: "keep" })
    });
    assert.equal(res.status, 200);
    assert.equal(getAsset("reviewme").rating, "keep", "keep written to the sidecar");
    // toss then clear
    await fetch(`http://127.0.0.1:${port}/rate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "reviewme", rating: "toss" }) });
    assert.equal(getAsset("reviewme").rating, "toss");
    await fetch(`http://127.0.0.1:${port}/rate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "reviewme", rating: "" }) });
    assert.equal(getAsset("reviewme").rating, null, "empty clears the rating");
    // the index page renders and serves the image
    const idx = await fetch(`http://127.0.0.1:${port}/`);
    assert.match(await idx.text(), /Inkborne art review/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
