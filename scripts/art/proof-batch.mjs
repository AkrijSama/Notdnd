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
//  - 4 npc-body, anime, tall — varied adults, distinct faces, neutral standing
//    poses (VN sprites); faces tagged thoroughly to seed the checkout pool.
// ---------------------------------------------------------------------------

import { runBatch, comfyReachable } from "./generate.mjs";

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
  // 4 npc-bodies (anime, tall) — VN-sprite candidates, faces tagged for checkout.
  for (const n of NPC_BODIES) {
    out.push({
      id: `babel-npcbody-${n.key}`,
      style: "anime",
      kind: "npc-body",
      world: WORLD,
      prompt: n.prompt,
      tags: n.tags
    });
  }
  return out;
}

export const PROOF_SPECS = specs();

async function main() {
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
