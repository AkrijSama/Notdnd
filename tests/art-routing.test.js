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

const { resolveRecipeFile, loadRecipe, buildGraph } = await import("../scripts/art/generate.mjs");

function writeRecipe(name, body) {
  fs.writeFileSync(path.join(WF, `${name}.json`), JSON.stringify(body));
}

// Mock workflow files: per-kind (scene-anime, entity-darkfantasy) + per-style
// fallbacks (anime, dark-fantasy). Note the per-kind style slug collapses the
// hyphen ("dark-fantasy" -> "darkfantasy"); the fallback keeps it.
writeRecipe("scene-anime", { name: "scene-anime", checkpoint: "Illustrious.safetensors", lora: [] });
writeRecipe("anime", { name: "anime", checkpoint: "Illustrious.safetensors", lora: [] });
writeRecipe("entity-darkfantasy", { name: "entity-darkfantasy", checkpoint: "Juggernaut.safetensors", lora: [] });
writeRecipe("dark-fantasy", { name: "dark-fantasy", checkpoint: "Juggernaut.safetensors", lora: [] });

test("ROUTING: per-(kind,style) file wins over the per-style fallback", () => {
  // scene-kind + anime -> scene-anime.json (per-kind), not anime.json
  assert.equal(path.basename(resolveRecipeFile("anime", "scene")), "scene-anime.json");
  assert.equal(loadRecipe("anime", "scene").name, "scene-anime");
  // world-card also maps to the "scene" recipe family
  assert.equal(path.basename(resolveRecipeFile("anime", "world-card")), "scene-anime.json");
  // npc-body maps to the "entity" family; dark-fantasy collapses to darkfantasy
  assert.equal(path.basename(resolveRecipeFile("dark-fantasy", "npc-body")), "entity-darkfantasy.json");
  assert.equal(path.basename(resolveRecipeFile("dark-fantasy", "npc-portrait")), "entity-darkfantasy.json");
});

test("ROUTING: falls back to the per-style file when no per-kind file exists", () => {
  // no entity-anime.json present -> npc-body(anime) falls back to anime.json
  assert.equal(path.basename(resolveRecipeFile("anime", "npc-body")), "anime.json");
  // no scene-darkfantasy.json present -> scene(dark-fantasy) falls back to dark-fantasy.json
  assert.equal(path.basename(resolveRecipeFile("dark-fantasy", "scene")), "dark-fantasy.json");
  // no kind given -> straight to per-style
  assert.equal(path.basename(resolveRecipeFile("anime")), "anime.json");
});

test("ROUTING: returns null (and loadRecipe throws) when nothing matches", () => {
  assert.equal(resolveRecipeFile("nope", "scene"), null);
  assert.throws(() => loadRecipe("nope", "scene"), /no workflow recipe/);
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
