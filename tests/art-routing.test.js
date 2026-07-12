import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated temp dirs: a mock WORKFLOW dir (routing) and a temp library (so a
// stray addAsset never touches the real one). Both set before importing.
const WF = fs.mkdtempSync(path.join(os.tmpdir(), "art-wf-"));
process.env.NOTDND_ART_WORKFLOW_DIR = WF;
process.env.NOTDND_ASSET_LIBRARY_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "art-wf-lib-"));

const { resolveRecipeFile, recipeCandidates, loadRecipe, buildGraph } = await import("../scripts/art/generate.mjs");

function writeRecipe(name, body) {
  fs.writeFileSync(path.join(WF, `${name}.json`), JSON.stringify(body));
}
const R = (name) => writeRecipe(name, { name, checkpoint: "X.safetensors", lora: [] });

// Mock workflow files exercising every rung of the ladder. Per-kind LANE files
// (portrait-/fullbody-/item-/scene-), legacy FAMILY files (entity-/scene-), and
// per-STYLE fallbacks (anime/dark-fantasy/cinematic). Per-kind slug collapses the
// hyphen ("dark-fantasy" -> "darkfantasy"); per-style files keep it.
R("portrait-anime");       // lane
R("fullbody-darkfantasy"); // lane
R("item-anime");           // lane
R("scene-anime");          // lane (scene's lane == legacy family)
R("entity-anime");         // legacy family (portrait/fullbody/item)
R("entity-darkfantasy");   // legacy family
R("scene-darkfantasy");    // legacy/lane for scene
R("anime");                // per-style
R("dark-fantasy");         // per-style
R("cinematic");            // per-style ONLY — no lane, no legacy

test("ROUTING rung 1: the per-kind LANE file wins over legacy + per-style", () => {
  assert.equal(path.basename(resolveRecipeFile("anime", "portrait")), "portrait-anime.json");
  assert.equal(path.basename(resolveRecipeFile("dark-fantasy", "fullbody")), "fullbody-darkfantasy.json");
  assert.equal(path.basename(resolveRecipeFile("anime", "item")), "item-anime.json");
  assert.equal(path.basename(resolveRecipeFile("anime", "scene")), "scene-anime.json");
  // world-card rides the scene lane
  assert.equal(path.basename(resolveRecipeFile("anime", "world-card")), "scene-anime.json");
});

test("ROUTING rung 2: portrait/fullbody/item fall back to entity-*, scene to scene-*", () => {
  // no fullbody-anime.json -> entity-anime.json (legacy family)
  assert.equal(path.basename(resolveRecipeFile("anime", "fullbody")), "entity-anime.json");
  // no portrait-darkfantasy.json -> entity-darkfantasy.json
  assert.equal(path.basename(resolveRecipeFile("dark-fantasy", "portrait")), "entity-darkfantasy.json");
  // no item-darkfantasy.json -> entity-darkfantasy.json
  assert.equal(path.basename(resolveRecipeFile("dark-fantasy", "item")), "entity-darkfantasy.json");
  // scene(dark-fantasy) -> scene-darkfantasy.json (scene's legacy family is scene-*)
  assert.equal(path.basename(resolveRecipeFile("dark-fantasy", "scene")), "scene-darkfantasy.json");
});

test("ROUTING rung 3: per-STYLE file when neither lane nor legacy exists", () => {
  // cinematic has no lane/legacy files -> the per-style cinematic.json for every kind
  assert.equal(path.basename(resolveRecipeFile("cinematic", "portrait")), "cinematic.json");
  assert.equal(path.basename(resolveRecipeFile("cinematic", "fullbody")), "cinematic.json");
  assert.equal(path.basename(resolveRecipeFile("cinematic", "scene")), "cinematic.json");
  // no kind given -> straight to per-style
  assert.equal(path.basename(resolveRecipeFile("anime")), "anime.json");
});

test("ROUTING rung 4: null (and loadRecipe throws) when nothing matches", () => {
  assert.equal(resolveRecipeFile("ghost", "portrait"), null);
  assert.throws(() => loadRecipe("ghost", "portrait"), /no workflow recipe/);
});

test("ROUTING: recipeCandidates emits the ladder in order, deduped", () => {
  assert.deepEqual(recipeCandidates("dark-fantasy", "portrait"), [
    "portrait-darkfantasy.json",
    "entity-darkfantasy.json",
    "dark-fantasy.json"
  ]);
  // scene's lane == legacy == "scene" (collapse to one), PLUS the "landscape" alias
  // the owner names the scene-lane export with, then the per-style fallback.
  assert.deepEqual(recipeCandidates("anime", "scene"), ["scene-anime.json", "landscape-anime.json", "anime.json"]);
  // no kind -> per-style only
  assert.deepEqual(recipeCandidates("anime"), ["anime.json"]);
});

test("LORA: recipe.lora entries chain LoraLoader nodes wired into the graph", () => {
  const recipe = {
    name: "lora-test",
    checkpoint: "Base.safetensors",
    lora: [
      { name: "style.safetensors", strength: 0.8 },
      { name: "detail.safetensors", strength: 0.5, strengthClip: 0.3 }
    ]
  };
  const g = buildGraph(recipe, { kind: "scene", prompt: "a keep", seed: 7 });
  // two LoraLoader nodes appear at 10 and 11
  assert.equal(g["10"].class_type, "LoraLoader");
  assert.equal(g["10"].inputs.lora_name, "style.safetensors");
  assert.equal(g["10"].inputs.strength_model, 0.8);
  assert.equal(g["10"].inputs.strength_clip, 0.8, "single strength applies to both by default");
  assert.deepEqual(g["10"].inputs.model, ["4", 0], "first lora reads the checkpoint model");
  assert.deepEqual(g["10"].inputs.clip, ["4", 1], "first lora reads the checkpoint clip");
  assert.equal(g["11"].inputs.lora_name, "detail.safetensors");
  assert.equal(g["11"].inputs.strength_clip, 0.3, "explicit strengthClip honored");
  assert.deepEqual(g["11"].inputs.model, ["10", 0], "second lora chains off the first");
  assert.deepEqual(g["11"].inputs.clip, ["10", 1]);
  // downstream nodes read the END of the chain (node 11), not the checkpoint
  assert.deepEqual(g["3"].inputs.model, ["11", 0], "KSampler model = last lora");
  assert.deepEqual(g["6"].inputs.clip, ["11", 1], "positive CLIP = last lora");
  assert.deepEqual(g["7"].inputs.clip, ["11", 1], "negative CLIP = last lora");
  // VAE always off the checkpoint (loras don't replace it)
  assert.deepEqual(g["8"].inputs.vae, ["4", 2]);
});

test("LORA: an empty lora list yields the pre-lora graph shape (checkpoint refs)", () => {
  const g = buildGraph({ name: "x", checkpoint: "Base.safetensors", lora: [] }, { kind: "scene", prompt: "p", seed: 1 });
  assert.equal(g["10"], undefined, "no LoraLoader nodes");
  assert.deepEqual(g["3"].inputs.model, ["4", 0]);
  assert.deepEqual(g["6"].inputs.clip, ["4", 1]);
});

test("LORA: a malformed entry (no name) is skipped, not wired", () => {
  const g = buildGraph({ name: "x", checkpoint: "Base.safetensors", lora: [{ strength: 1 }, { name: "ok.safetensors" }] }, { kind: "scene", prompt: "p", seed: 1 });
  // only the named entry becomes a node; it reads straight off the checkpoint
  assert.equal(g["10"].inputs.lora_name, "ok.safetensors");
  assert.deepEqual(g["10"].inputs.model, ["4", 0]);
  assert.equal(g["11"], undefined);
});
