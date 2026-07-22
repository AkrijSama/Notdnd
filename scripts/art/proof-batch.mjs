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
// PROMPT CONTRACT (art-pipeline-v2): specs carry SLOT VALUES, never freehand
// prompts — every image is assembled from its lane template + model blocks via
// buildPrompt. DRY-RUN: `node scripts/art/proof-batch.mjs --plan` prints the
// assembled positive+negative per curated spec AND one exemplar per lane per
// style (10 plans), without touching ComfyUI — the owner reviews the prompts as
// text before any GPU time.
// ---------------------------------------------------------------------------

import { runBatch, comfyReachable, resolveRecipeFile, recipeCandidates, loadRecipe, dimsFor } from "./generate.mjs";
import { buildPrompt, laneForKind, TOWER_HORIZON_PHRASE } from "./promptAssembly.js";
import path from "node:path";

const WORLD = "babel";

// Scene subjects — SLOT VALUES (plain words), not sentences. Every scene is a
// starter-zone Babel location, so it carries "distant-from-tower": the assembler
// injects "tower" into the negative (diegetic law — no Tower in starter scenes).
const SCENE_SUBJECTS = [
  { key: "forest-path", slots: { subject: "a quiet forest path at the edge of a frontier settlement, a wooden signpost", setting: "frontier forest", timeOfDay: "dappled afternoon" } },
  { key: "town-gate", slots: { subject: "the open timber gate of a small frontier town, market stalls just inside, a cobbled street", setting: "frontier town", timeOfDay: "midday" } },
  { key: "town-square", slots: { subject: "a modest frontier town square with a well and a notice board, low timber and stone buildings", setting: "frontier town", timeOfDay: "overcast" } }
];

// Fullbody NPCs — committed-shape SLOT VALUES (gender/build/hair/attire/poseHint).
const NPC_BODIES = [
  { key: "npc-warden", slots: { gender: "man", age: "adult", hair: "short cropped hair", attire: "leather coat", poseHint: "neutral standing pose" }, tags: ["face", "adult", "male", "warden", "neutral-pose", "standing"] },
  { key: "npc-herbalist", slots: { gender: "woman", age: "adult", hair: "long braided hair", attire: "simple apron over a linen dress", poseHint: "neutral standing pose" }, tags: ["face", "adult", "female", "herbalist", "neutral-pose", "standing"] },
  { key: "npc-smith", slots: { gender: "man", age: "adult", build: "broad", hair: "shaved head", attire: "heavy leather apron", poseHint: "neutral standing pose" }, tags: ["face", "adult", "male", "smith", "neutral-pose", "standing"] },
  { key: "npc-scholar", slots: { gender: "androgynous person", age: "adult", build: "slender", hair: "hair tied back", attire: "long travelling coat", poseHint: "neutral standing pose" }, tags: ["face", "adult", "androgynous", "scholar", "neutral-pose", "standing"] }
];

function specs() {
  const out = [];
  // 4 world-cards (anime, wide) — cover art: the Tower IS permitted here (horizon
  // slot). seed variety by numbering the id (distinct seeds).
  for (let i = 1; i <= 4; i += 1) {
    out.push({
      id: `babel-worldcard-anime-${i}`,
      style: "anime",
      kind: "world-card",
      world: WORLD,
      slotValues: { subject: "a small timber frontier town in a sunlit forest clearing", setting: "frontier forest clearing", timeOfDay: "warm afternoon", horizon: TOWER_HORIZON_PHRASE },
      tags: ["setting:frontier-forest", "town", "daylight", "wide", "chaos-gradient", "starter"]
    });
  }
  // 6 scenes: 3 anime + 3 dark-fantasy of the SAME subjects (style A/B). Tagged
  // distant-from-tower -> the assembler bans the Tower from the negative.
  for (const style of ["anime", "dark-fantasy"]) {
    for (const s of SCENE_SUBJECTS) {
      out.push({
        id: `babel-scene-${s.key}-${style}`,
        style,
        kind: "scene",
        world: WORLD,
        slotValues: s.slots,
        tags: [`subject:${s.key}`, "setting:frontier", "wide", "no-people", "distant-from-tower", `style:${style}`]
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
      slotValues: n.slots,
      tags: n.tags
    });
  }
  return out;
}

export const PROOF_SPECS = specs();

// One exemplar per LANE (portrait/fullbody/scene/item/worldcard) for the dry-run:
// buildPrompt runs against these × both styles = 10 assembled prompts the owner
// reviews before any batch. scene carries the tower-ban tag; worldcard the tower
// horizon literal — so the diegetic-vs-promotional law is visible both ways.
const LANE_EXEMPLARS = {
  portrait: { slotValues: { gender: "woman", age: "adult", hair: "long braided hair", expression: "calm", attire: "linen dress" }, tags: [] },
  fullbody: { slotValues: { gender: "man", age: "adult", build: "broad", hair: "short cropped hair", attire: "leather coat", poseHint: "neutral standing pose" }, tags: ["face"] },
  scene: { slotValues: { subject: "a quiet forest path at the edge of a frontier settlement", setting: "frontier forest", timeOfDay: "dappled afternoon" }, tags: ["distant-from-tower"] },
  item: { slotValues: { itemType: "a warden's short sword", materials: "steel and leather", styleHint: "worn and practical" }, tags: [] },
  worldcard: { slotValues: { subject: "a small timber frontier town in a sunlit forest clearing", setting: "frontier forest clearing", timeOfDay: "warm afternoon", horizon: TOWER_HORIZON_PHRASE }, tags: ["starter"] }
};
const EXEMPLAR_LANES = ["portrait", "fullbody", "scene", "item", "worldcard"];
const PLAN_STYLES = ["anime", "dark-fantasy"];

// The asset KIND a lane routes through for recipe resolution (worldcard -> world-card).
const LANE_TO_KIND = Object.freeze({ worldcard: "world-card" });
function kindForLane(lane) {
  return LANE_TO_KIND[lane] || lane;
}

// Resolve routing for one (style, kind): { file, dims, candidates, unresolved }.
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

// Assemble routing + prompt for one spec-like {style, kind, slotValues, tags}.
export function assemblePlan({ style, kind, slotValues, tags = [] }) {
  const route = planFor(style, kind);
  const { positive, negative, meta } = buildPrompt(laneForKind(kind), style, slotValues, { tags });
  return { ...route, positive, negative, meta };
}

function printAssembled(label, style, kind, slotValues, tags) {
  const a = assemblePlan({ style, kind, slotValues, tags });
  const recipe = a.unresolved ? "UNRESOLVED" : `${a.file} ${a.dims[0]}x${a.dims[1]}`;
  console.log(`\n--- ${label}  [${style}]  recipe: ${recipe}`);
  console.log(`  POSITIVE: ${a.positive}`);
  console.log(`  NEGATIVE: ${a.negative}`);
}

// DRY-RUN: assembled prompts per lane×style exemplar (10) + per curated spec.
export function printPlan() {
  console.log("=== proof-batch --plan (DRY RUN — nothing generated, ComfyUI untouched) ===");
  console.log("\n### LANE x STYLE EXEMPLARS (one per lane per style — review before GPU):");
  for (const lane of EXEMPLAR_LANES) {
    const ex = LANE_EXEMPLARS[lane];
    for (const style of PLAN_STYLES) {
      printAssembled(lane, style, kindForLane(lane), ex.slotValues, ex.tags);
    }
  }
  console.log("\n\n### CURATED BATCH (14 specs — the actual proof dispatch):");
  for (const s of PROOF_SPECS) {
    printAssembled(s.id, s.style, s.kind, s.slotValues, s.tags);
  }
  // Routing coverage: every lane must resolve a recipe for both styles.
  const allResolved = EXEMPLAR_LANES.every((lane) =>
    PLAN_STYLES.every((style) => !planFor(style, kindForLane(lane)).unresolved)
  );
  console.log(`\n\nAll lanes resolve a recipe for both styles: ${allResolved ? "YES" : "NO (owner must export a recipe)"}`);
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
    throw new Error(`proof-batch: ComfyUI not reachable at 127.0.0.1:8188. Launch it leashed first:\n  scripts/comfyui-server.sh 8188`);
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
