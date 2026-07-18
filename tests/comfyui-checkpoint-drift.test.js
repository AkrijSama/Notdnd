// CHECKPOINT DRIFT GUARD — the 2026-07-18 root cause.
//
// The live image path served the RETIRED Illustrious for anime long after the
// Chunk-6 JANKU switch, because its checkpoint came from a PARALLEL hardcoded
// table (STYLE_PRESETS) that drifted from the validated per-lane exports. The
// exports (scripts/art/workflows/*.json) are the single source of truth — the same
// files the batch cook reads. This test asserts: for EVERY engine style that has a
// validated export, the live-path checkpoint MUST equal that export's checkpoint,
// on BOTH the generic fallback and the per-kind validated path. If a lane is
// re-cooked onto a new checkpoint, the live path follows automatically; if someone
// re-introduces a hardcoded table, this fails.
import assert from "node:assert/strict";
import test from "node:test";
import {
  comfyuiWorkflowForStyle,
  checkpointForStyle,
  resolveValidatedComfyWorkflow
} from "../server/ai/comfyui.js";
import { ENGINE_STYLES, toCanonicalStyle } from "../server/solo/artStyle.js";
import { resolveRecipeFile, loadRecipe, isApiWorkflow } from "../scripts/art/generate.mjs";

const KINDS = ["portrait", "fullbody", "scene", "item", "world-card", "landscape"];

function checkpointOf(recipe) {
  for (const n of Object.values(recipe || {})) {
    if (n && n.class_type === "CheckpointLoaderSimple") return n.inputs?.ckpt_name || null;
  }
  return null;
}

// Every validated API export for an engine style: [{ kind, ckpt }].
function validatedExports(engineStyle) {
  const canon = toCanonicalStyle(engineStyle);
  const out = [];
  const seen = new Set();
  for (const kind of KINDS) {
    let file = null;
    try { file = resolveRecipeFile(canon, kind); } catch { file = null; }
    if (!file || seen.has(file)) continue;
    seen.add(file);
    let recipe = null;
    try { recipe = loadRecipe(canon, kind); } catch { continue; }
    if (!isApiWorkflow(recipe)) continue;
    const ckpt = checkpointOf(recipe);
    if (ckpt) out.push({ kind, ckpt });
  }
  return out;
}

// Isolate a test body from any ambient checkpoint env override (which would mask
// real drift), restoring afterwards.
function withoutCheckpointEnv(style, fn) {
  const keys = [
    "NOTDND_COMFYUI_CHECKPOINT", "INKBORNE_COMFYUI_CHECKPOINT",
    `NOTDND_COMFYUI_CHECKPOINT_${style.toUpperCase()}`, `INKBORNE_COMFYUI_CHECKPOINT_${style.toUpperCase()}`
  ];
  const saved = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  try { return fn(); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

for (const style of ENGINE_STYLES) {
  test(`checkpoint drift: "${style}" live path == its validated export checkpoint`, () => {
    withoutCheckpointEnv(style, () => {
      const exps = validatedExports(style);
      if (exps.length === 0) return; // zero exports → STYLE_PRESETS fallback is legitimate

      // A lane uses ONE checkpoint across all its exports.
      const distinct = new Set(exps.map((e) => e.ckpt));
      assert.equal(distinct.size, 1, `${style} exports disagree on checkpoint: ${[...distinct].join(", ")}`);
      const laneCkpt = exps[0].ckpt;

      // (1) the single-source derivation matches the export
      assert.equal(checkpointForStyle(style), laneCkpt, `checkpointForStyle("${style}") drifted from its export`);

      // (2) the GENERIC live fallback matches the export — the assertion that would
      //     have caught anime→Illustrious
      assert.equal(
        comfyuiWorkflowForStyle(style, { prompt: "x" }).checkpoint, laneCkpt,
        `generic live checkpoint for "${style}" drifted from its export`
      );

      // (3) each per-kind validated live path serves that kind's export checkpoint
      for (const e of exps) {
        const sel = resolveValidatedComfyWorkflow(style, e.kind, { positive: "human, rounded ears", negative: "", seed: 1 });
        assert.ok(sel, `validated ${style}/${e.kind} should resolve`);
        assert.equal(sel.checkpoint, e.ckpt, `validated ${style}/${e.kind} checkpoint drifted`);
      }
    });
  });
}

test("anime is JANKU end-to-end (Chunk-6 switch honored; Illustrious retired)", () => {
  withoutCheckpointEnv("anime", () => {
    assert.equal(checkpointForStyle("anime"), "JANKUTrainedChenkinNoobai_v777.safetensors");
    assert.match(comfyuiWorkflowForStyle("anime", { prompt: "x" }).checkpoint, /JANKU/);
  });
});
