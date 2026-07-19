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

// The sampler REGISTER (cfg/sampler/scheduler/steps) from a graph's KSampler node.
// Like the checkpoint, this is owned by the validated export — the live path must
// derive it from the file, never from a hardcoded default (defaultWorkflow /
// STYLE_PRESETS). injectWorkflow only sets prompt/dims/seed/batch, so these must
// pass through untouched.
function samplerOf(recipe) {
  for (const n of Object.values(recipe || {})) {
    if (n && /KSampler/.test(n.class_type || "")) {
      const i = n.inputs || {};
      return { cfg: i.cfg, sampler: i.sampler_name, scheduler: i.scheduler, steps: i.steps };
    }
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
    if (ckpt) out.push({ kind, ckpt, sampler: samplerOf(recipe) });
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
      //     AND its sampler register (cfg/sampler/scheduler/steps). injectWorkflow
      //     must not shadow the file — the export is the single source for BOTH.
      for (const e of exps) {
        const sel = resolveValidatedComfyWorkflow(style, e.kind, { positive: "human, rounded ears", negative: "", seed: 1 });
        assert.ok(sel, `validated ${style}/${e.kind} should resolve`);
        assert.equal(sel.checkpoint, e.ckpt, `validated ${style}/${e.kind} checkpoint drifted`);
        assert.deepEqual(
          samplerOf(sel.workflow), e.sampler,
          `validated ${style}/${e.kind} sampler register (cfg/sampler/scheduler/steps) drifted from its export`
        );
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

// The owner's kitchen-validated JANKU register (2026-07-19, corrected): cfg 3.5 is
// what his 4/4 acceptance batch (ComfyUI 00226-00229) actually ran at — the fix that
// pulls the portrait "style-card" register clothed/human-eared/warm. It is LANE-WIDE:
// both portrait and scene derive it from their validated exports (portrait-anime.json
// / scene-anime.json), never a hardcoded default. If the scene lane ever falls back to
// the generic path again (sampler "euler", cfg 7), the scene assertion here fails.
test("anime register: portrait + scene carry the owner-validated cfg 3.5 / euler_ancestral", () => {
  for (const kind of ["portrait", "scene"]) {
    const sel = resolveValidatedComfyWorkflow("anime", kind, { positive: "human, rounded ears", negative: "x", seed: 1 });
    assert.ok(sel, `anime/${kind} must resolve to a VALIDATED export (not the generic fallback)`);
    const s = samplerOf(sel.workflow);
    assert.equal(s.cfg, 3.5, `anime/${kind} cfg must be the validated 3.5`);
    assert.equal(s.sampler, "euler_ancestral", `anime/${kind} sampler must be euler_ancestral`);
    assert.equal(s.scheduler, "normal", `anime/${kind} scheduler must be normal`);
    assert.equal(s.steps, 26, `anime/${kind} steps must be 26`);
  }
});
