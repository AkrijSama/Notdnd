// ---------------------------------------------------------------------------
// PROOF BATCH (art-week phase 1, PART 4) — exactly 14 curated candidates for the
// owner's keep/toss review. Run ONLY inside an authorized GPU window:
//
//   node scripts/art/proof-batch.mjs
//
// It refuses to start unless the play server has been idle >=10 min AND free VRAM
// >= 1GB (assertSafeWindow), cooks in chunks of <=10 with a VRAM check between,
// and stops ComfyUI at the end. Idempotent per id — a re-run resumes cleanly.
//
// Composition (per dispatch):
//  - 4 world-card, anime, wide  — Babel starter: sunlit ORDINARY frontier forest,
//    distant town, a FAINT impossible tower on the far horizon (chaos-gradient:
//    the starter area is NORMAL; the wrongness is distant).
//  - 6 scene — 3 anime + 3 dark-fantasy of the SAME subjects (the style A/B).
//  - 4 fullbody, anime, tall — varied adults, distinct faces, neutral standing
//    poses (VN sprites); faces tagged thoroughly to seed the checkout pool.
//
// DRY-RUN: `node scripts/art/proof-batch.mjs --plan` prints what WOULD generate
// per (kind, style) — the resolved recipe file + dimensions — and a four-waiter
// routing matrix, without touching ComfyUI. Use it to confirm every lane resolves.
// ---------------------------------------------------------------------------

import { runBatch, comfyReachable, resolveRecipeFile, recipeCandidates, loadRecipe, dimsFor } from "./generate.mjs";
import path from "node:path";

const WORLD = "babel";

// The chaos-gradient starter card. NORMAL foreground, distant faint wrongness.
const CARD_BASE =
  "sunlit ordinary frontier forest clearing, tall pines and wildflowers, a dirt path, a small timber frontier town in the middle distance with smoke from chimneys, warm afternoon light, calm and inviting, a single very faint impossibly tall slender tower barely visible on the far horizon through haze, wide establishing shot, landscape";

const SCENE_SUBJECTS = [
  { key: "forest-path", prompt: "a quiet forest path at the edge of a frontier settlement, dappled sunlight through pines, a wooden signpost, no people, wide" },
  { key: "town-gate", prompt: "the open timber gate of a small frontier town, market stalls just inside, cobbled street, midday, wide establishing shot, no people" },
  { key: "town-square", prompt: "a modest frontier town square with a well and a notice board, low timber and stone buildings, overcast soft light, wide, no people" }
];

const NPC_BODIES = [
  { key: "npc-warden", prompt: "full body standing portrait of an adult frontier warden, weathered face, short cropped hair, leather coat, calm neutral expression, neutral standing pose, plain neutral grey background, full figure head to boots", tags: ["face", "adult", "male", "warden", "leather-coat", "short-hair", "neutral-pose", "standing"] },
  { key: "npc-herbalist", prompt: "full body standing portrait of an adult herbalist woman, kind observant face, long braided hair, simple apron over a linen dress, neutral standing pose, plain neutral grey background, full figure head to feet", tags: ["face", "adult", "female", "herbalist", "apron", "braided-hair", "neutral-pose", "standing"] },
  { key: "npc-smith", prompt: "full body standing portrait of a broad adult blacksmith, soot-marked face, shaved head, heavy leather apron, rolled sleeves, neutral standing pose, plain neutral grey background, full figure head to boots", tags: ["face", "adult", "male", "smith", "apron", "shaved-head", "neutral-pose", "standing"] },
  { key: "npc-scholar", prompt: "full body standing portrait of a slender adult scholar, thoughtful angular face, glasses, hair tied back, long travelling coat over layered clothes, neutral standing pose, plain neutral grey background, full figure", tags: ["face", "adult", "androgynous", "scholar", "glasses", "coat", "neutral-pose", "standing"] }
];

function specs() {
  const out = [];
  // 4 world-cards (anime, wide) — seed variety by numbering the id (distinct seeds).
  for (let i = 1; i <= 4; i += 1) {
    out.push({
      id: `babel-worldcard-anime-${i}`,
      style: "anime",
      kind: "world-card",
      world: WORLD,
      prompt: CARD_BASE,
      tags: ["setting:frontier-forest", "town", "distant-tower", "daylight", "wide", "chaos-gradient", "starter"]
    });
  }
  // 6 scenes: 3 anime + 3 dark-fantasy of the SAME subjects (style A/B).
  for (const style of ["anime", "dark-fantasy"]) {
    for (const s of SCENE_SUBJECTS) {
      out.push({
        id: `babel-scene-${s.key}-${style}`,
        style,
        kind: "scene",
        world: WORLD,
        prompt: s.prompt,
        tags: [`subject:${s.key}`, "setting:frontier", "wide", "no-people", `style:${style}`]
      });
    }
  }
  // 4 fullbodies (anime, tall) — VN-sprite candidates, faces tagged for checkout.
  for (const n of NPC_BODIES) {
    out.push({
      id: `babel-fullbody-${n.key}`,
      style: "anime",
      kind: "fullbody",
      world: WORLD,
      prompt: n.prompt,
      tags: n.tags
    });
  }
  return out;
}

export const PROOF_SPECS = specs();

// The four generation lanes ("waiters") the dry-run proves resolve, per style.
const WAITER_LANES = ["portrait", "fullbody", "scene", "item"];
const PLAN_STYLES = ["anime", "dark-fantasy"];

// Resolve one (style, kind) to { file, dims, candidates, unresolved } WITHOUT
// touching ComfyUI — pure filesystem routing.
export function planFor(style, kind) {
  const abs = resolveRecipeFile(style, kind);
  const candidates = recipeCandidates(style, kind);
  if (!abs) {
    return { file: null, dims: null, candidates, unresolved: true };
  }
  const recipe = loadRecipe(style, kind);
  const { width, height } = dimsFor(recipe, kind);
  return { file: path.basename(abs), dims: [width, height], candidates, unresolved: false };
}

// DRY-RUN: print what WOULD generate (per curated spec) + a four-waiter routing
// matrix, so every lane's resolution is visible without cooking anything.
export function printPlan() {
  console.log("=== proof-batch --plan (DRY RUN — nothing generated, ComfyUI untouched) ===\n");
  console.log(`Curated specs (${PROOF_SPECS.length}):`);
  for (const s of PROOF_SPECS) {
    const p = planFor(s.style, s.kind);
    const where = p.unresolved
      ? `UNRESOLVED (tried: ${p.candidates.join(" -> ")})`
      : `${p.file}  ${p.dims[0]}x${p.dims[1]}`;
    console.log(`  ${s.id.padEnd(34)} ${String(s.kind).padEnd(11)} ${String(s.style).padEnd(13)} -> ${where}`);
  }
  console.log("\nFour-waiter routing matrix (lane x style -> resolved recipe file, dims):");
  let allResolved = true;
  for (const kind of WAITER_LANES) {
    for (const style of PLAN_STYLES) {
      const p = planFor(style, kind);
      if (p.unresolved) {
        allResolved = false;
      }
      const where = p.unresolved
        ? `UNRESOLVED (ladder: ${p.candidates.join(" -> ")})`
        : `${p.file.padEnd(20)} ${p.dims[0]}x${p.dims[1]}   (ladder: ${p.candidates.join(" -> ")})`;
      console.log(`  ${kind.padEnd(9)} ${style.padEnd(13)} -> ${where}`);
    }
  }
  console.log(
    `\nAll four lanes resolve for both styles: ${allResolved ? "YES" : "NO (some fell through to null — owner must export a recipe)"}`
  );
  return allResolved;
}

async function main() {
  if (process.argv.includes("--plan")) {
    printPlan();
    return;
  }
  const list = PROOF_SPECS;
  if (list.length !== 14) {
    throw new Error(`proof-batch: expected 14 specs, built ${list.length}`);
  }
  if (!(await comfyReachable())) {
    throw new Error(`proof-batch: ComfyUI not reachable at 127.0.0.1:8188. Launch it with --novram first:\n  cd ~/ComfyUI && ./venv/bin/python main.py --listen --novram`);
  }
  const t0 = Date.now();
  const results = await runBatch(list, {
    chunkSize: 10,
    onProgress: (r) => console.log(`  ${r.skipped ? "SKIP" : "cooked"} ${r.id}${r.skipped ? "" : ` (${(r.ms / 1000).toFixed(1)}s)`}`)
  });
  const cooked = results.filter((r) => !r.skipped);
  console.log(`\nproof-batch done: ${results.length} images (${cooked.length} cooked, ${results.length - cooked.length} skipped) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("ComfyUI stopped. Review with: node scripts/art/review.mjs");
}

// Only run when invoked directly (import for tests stays side-effect-free).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`\nBATCH ABORTED: ${err.message}`);
    process.exit(1);
  });
}
