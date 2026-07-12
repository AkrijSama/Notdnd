import assert from "node:assert/strict";
import test from "node:test";

import { identifyWorkflowRoles, validateWorkflow, samplerSeedField } from "../scripts/art/validateWorkflow.mjs";
import { injectWorkflow, verifyDimsAgainstSpec, isApiWorkflow, workflowLatentDims, KIND_DIMENSIONS } from "../scripts/art/generate.mjs";
import { buildPrompt, mapNpcToSlots, eraDescriptor, worldHasEra } from "../scripts/art/promptAssembly.js";
import { queryAssets, addAsset, rateAsset } from "../scripts/art/library.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The owner's ComfyUI API export shape (node-id keyed). _meta titles are set to
// LIE (node 6 titled "Negative", node 7 "Positive") to prove role detection is by
// GRAPH SHAPE — the wiring to the sampler — not by titles.
function apiGraph(over = {}) {
  return {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "Juggernaut-XI.safetensors" }, _meta: { title: "Load Checkpoint" } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 896, height: 1152, batch_size: 4 }, _meta: { title: "Latent" } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "OLD POSITIVE", clip: ["4", 1] }, _meta: { title: "Negative" } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "OLD NEGATIVE", clip: ["4", 1] }, _meta: { title: "Positive" } },
    "10": { class_type: "KSamplerAdvanced", inputs: { noise_seed: 111, steps: 26, cfg: 5.2, sampler_name: "euler_ancestral", scheduler: "normal", model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] }, _meta: { title: "Sampler" } },
    "17": { class_type: "VAEDecode", inputs: { samples: ["10", 0], vae: ["4", 2] } },
    "19": { class_type: "SaveImage", inputs: { filename_prefix: "X", images: ["17", 0] } },
    ...over
  };
}

// ── item 1a: role identification BY SHAPE ─────────────────────────────────────
test("identifyWorkflowRoles finds sockets by graph shape, not node titles", () => {
  const { roles, errors } = identifyWorkflowRoles(apiGraph());
  assert.deepEqual(errors, []);
  assert.equal(roles.checkpoint, "4");
  assert.equal(roles.positive, "6"); // wired to sampler.positive — despite title "Negative"
  assert.equal(roles.negative, "7"); // wired to sampler.negative — despite title "Positive"
  assert.equal(roles.latent, "5");
  assert.equal(roles.sampler, "10");
  assert.equal(roles.seedField, "noise_seed"); // KSamplerAdvanced
  assert.equal(roles.vaeDecode, "17");
  assert.equal(roles.save, "19");
});

test("samplerSeedField distinguishes KSampler (seed) from KSamplerAdvanced (noise_seed)", () => {
  assert.equal(samplerSeedField({ inputs: { noise_seed: 1 } }), "noise_seed");
  assert.equal(samplerSeedField({ inputs: { seed: 1 } }), "seed");
  assert.equal(samplerSeedField({ inputs: {} }), null);
});

// ── item 1a: reject malformed exports, naming the fix ─────────────────────────
test("validateWorkflow rejects a UI-format export (not API format) and names the fix", () => {
  const ui = { nodes: [{ id: 1 }], links: [] };
  const { ok, errors } = validateWorkflow(ui);
  assert.equal(ok, false);
  assert.match(errors.join(" "), /Save \(API Format\)/);
  assert.throws(() => validateWorkflow(ui, { throwOnError: true }), /malformed export/);
});

test("validateWorkflow rejects a graph with no sampler and names the fix", () => {
  const g = apiGraph();
  delete g["10"]; // remove the sampler
  const { ok, errors } = validateWorkflow(g);
  assert.equal(ok, false);
  assert.match(errors.join(" "), /no sampler/i);
});

// ── item 1b: injection into the identified node ids ───────────────────────────
test("injectWorkflow writes prompt/dims/seed into the right nodes and never mutates the source", () => {
  const src = apiGraph();
  const g = injectWorkflow(src, { positive: "NEW POS", negative: "NEW NEG", width: 832, height: 1216, seed: 999 });
  assert.equal(g["6"].inputs.text, "NEW POS");
  assert.equal(g["7"].inputs.text, "NEW NEG");
  assert.equal(g["5"].inputs.width, 832);
  assert.equal(g["5"].inputs.height, 1216);
  assert.equal(g["5"].inputs.batch_size, 1); // forced to 1 for a single idempotent cook
  assert.equal(g["10"].inputs.noise_seed, 999);
  // source untouched
  assert.equal(src["6"].inputs.text, "OLD POSITIVE");
  assert.equal(src["5"].inputs.batch_size, 4);
});

test("injectWorkflow throws (naming the fix) on a malformed graph", () => {
  const g = apiGraph();
  delete g["10"];
  assert.throws(() => injectWorkflow(g, { positive: "x" }), /malformed workflow/);
});

// ── item 1c: dims verify (warn, don't fail) ───────────────────────────────────
test("verifyDimsAgainstSpec warns when an export's latent differs from the lane spec", () => {
  const warnings = [];
  const g = apiGraph(); // 896x1152
  // fullbody spec is 832x1216 → mismatch → warn
  const res = verifyDimsAgainstSpec(g, "fullbody", { warn: (m) => warnings.push(m) });
  assert.equal(res.match, false);
  assert.deepEqual(res.actual, { width: 896, height: 1152 });
  assert.deepEqual(res.spec, { width: 832, height: 1216 });
  assert.equal(warnings.length, 1);
  // portrait spec IS 896x1152 → no warn
  const res2 = verifyDimsAgainstSpec(g, "portrait", { warn: () => assert.fail("should not warn") });
  assert.equal(res2.match, true);
});

test("the lane dims spec matches the workflow-intake table", () => {
  assert.deepEqual(KIND_DIMENSIONS.portrait, [896, 1152]);
  assert.deepEqual(KIND_DIMENSIONS.fullbody, [832, 1216]);
  assert.deepEqual(KIND_DIMENSIONS.scene, [1344, 768]);
  assert.deepEqual(KIND_DIMENSIONS.item, [1024, 1024]);
  assert.equal(isApiWorkflow(apiGraph()), true);
  assert.equal(isApiWorkflow({ checkpoint: "x", sampler: {} }), false);
  assert.deepEqual(workflowLatentDims(apiGraph()), { width: 896, height: 1152 });
});

// ── item 2: the owner-discovered laws are baked into the templates ────────────
test("scene template bakes the no-fisheye + no-pale-wash laws", () => {
  const { positive, negative } = buildPrompt("scene", "realistic", { subject: "a market square" });
  assert.match(negative, /fisheye, wide angle distortion, curved horizon, barrel distortion/);
  assert.match(negative, /washed out, pale, faded, low contrast, hazy, overexposed, flat lighting/);
  assert.match(positive, /dramatic lighting, rich saturated color, deep shadows, high contrast, moody atmosphere/);
  assert.match(positive, /atmospheric depth/);
});

test("item template bakes the wearables person-safety + flat-lay laws", () => {
  const { positive, negative } = buildPrompt("item", "realistic", { itemType: "a wool cloak" });
  assert.match(negative, /person, human, face, mannequin, model, body, worn by person/);
  assert.match(positive, /flat lay, empty garment/);
});

test("fullbody template bakes the whole-figure-in-frame law", () => {
  const { positive, negative } = buildPrompt("fullbody", "realistic", { gender: "woman" });
  assert.match(positive, /full figure visible from head to feet/);
  assert.match(negative, /cropped, out of frame, feet cut off, close-up, portrait/);
});

// ── item 2: the ERA LAW (inject if the world carries an era; never invent) ─────
test("mapNpcToSlots injects the world's era onto the attire slot when present", () => {
  const npc = { gender: "man", appearance: "wool robe" };
  const withEra = mapNpcToSlots(npc, { era: "medieval fantasy" });
  assert.equal(withEra.attire, "medieval fantasy wool robe");
  const noEra = mapNpcToSlots(npc, {}); // world with no era field → attire rides bare (the gap)
  assert.equal(noEra.attire, "wool robe");
  assert.equal(eraDescriptor({ era: "medieval fantasy" }), "medieval fantasy");
  assert.equal(eraDescriptor({}), "");
  assert.equal(worldHasEra({ era: "steampunk" }), true);
  assert.equal(worldHasEra({ tone: "dark fantasy" }), false); // tone is NOT an era
});

// ── item 5a: toss-rated assets never surface in queryAssets ───────────────────
test("queryAssets excludes toss-rated images from all serving", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "art-lib-"));
  const prev = process.env.NOTDND_ASSET_LIBRARY_ROOT;
  process.env.NOTDND_ASSET_LIBRARY_ROOT = dir;
  try {
    addAsset({ id: "keep_1", kind: "scene", world: "w", style: "realistic", rating: "keep" });
    addAsset({ id: "toss_1", kind: "scene", world: "w", style: "realistic" });
    rateAsset("toss_1", "toss");
    const scenes = queryAssets({ kind: "scene", world: "w" });
    assert.ok(scenes.some((a) => a.id === "keep_1"));
    assert.ok(!scenes.some((a) => a.id === "toss_1"), "toss-rated never surfaces");
  } finally {
    if (prev === undefined) delete process.env.NOTDND_ASSET_LIBRARY_ROOT;
    else process.env.NOTDND_ASSET_LIBRARY_ROOT = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
