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
  const g = buildGraph(recipe, { kind: "npc-body", prompt: "a warden", seed: 42 });
  assert.equal(g["4"].class_type, "CheckpointLoaderSimple");
  assert.equal(g["4"].inputs.ckpt_name, recipe.checkpoint);
  // npc-body is TALL
  assert.equal(g["5"].inputs.width, 832);
  assert.equal(g["5"].inputs.height, 1216);
  assert.equal(g["3"].inputs.seed, 42);
  assert.match(g["6"].inputs.text, /a warden/, "prompt + style suffix in the positive");
  assert.match(g["6"].inputs.text, /anime/);
  assert.equal(g["9"].class_type, "SaveImage");
  // world-card is WIDE
  const wide = buildGraph(recipe, { kind: "world-card", prompt: "x", seed: 1 });
  assert.ok(wide["5"].inputs.width > wide["5"].inputs.height, "world-card is wide");
});

// ---- proof batch composition ----------------------------------------------
test("the proof batch is exactly 14: 4 world-card + 6 scene (3 anime/3 dark) + 4 npc-body", () => {
  assert.equal(PROOF_SPECS.length, 14);
  const by = (k) => PROOF_SPECS.filter((s) => s.kind === k);
  assert.equal(by("world-card").length, 4);
  assert.equal(by("scene").length, 6);
  assert.equal(by("npc-body").length, 4);
  assert.ok(by("world-card").every((s) => s.style === "anime"), "world-cards are anime");
  assert.equal(by("scene").filter((s) => s.style === "anime").length, 3);
  assert.equal(by("scene").filter((s) => s.style === "dark-fantasy").length, 3);
  assert.ok(by("npc-body").every((s) => s.style === "anime"), "npc-bodies are anime");
  // faces tagged for the checkout pool
  assert.ok(by("npc-body").every((s) => s.tags.includes("face")), "npc-body faces tagged");
  // ids unique (idempotent-resume keys)
  assert.equal(new Set(PROOF_SPECS.map((s) => s.id)).size, 14);
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
