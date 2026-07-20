// PORTRAIT LANE-INVARIANCE — the owner law (2026-07-20).
//
// Declared identity (species/kind, gender, age, build) must ride EVERY portrait prompt
// in EVERY style lane through the ONE sealed builder — no lane may assemble identity
// independently. Two live failures motivated this:
//   • the SKULL DEMON: a fresh "illustrated" run (→ nihilmania / dark-fantasy lane)
//     rendered a red-eyed horned skull monster from a declared human adult male, because
//     the non-anime seal branch carried NO monster/skull negative — only the anime lane
//     did — so nihilmania's grimdark prior won.
//   • the "mustard" bust: a redo rendered a western-comic bust on a flat yellow field
//     (pre-kitchen signature the validated recipe forbids), because the non-anime lanes
//     had no style-collapse negative and the kontext edit path could bypass the seal.
//
// This asserts, for each engine style with a portrait path: the sealed prompt KEEPS the
// weighted identity block in the positive AND gains the human-gated monster/species
// negatives + the style-collapse ban. Any future lane inherits this by construction
// (the seal is the single chokepoint every portrait route funnels through).
import assert from "node:assert/strict";
import test from "node:test";
import { buildPlayerPortraitPrompt } from "../server/solo/imageWorker.js";
import {
  sealPortraitPrompt,
  comfyuiWorkflowForStyle,
  humanSubjectMonsterNegativeFor
} from "../server/ai/comfyui.js";
import { editImage } from "../server/ai/providers.js";
import { ENGINE_STYLES } from "../server/solo/artStyle.js";

const HUMAN_MALE = Object.freeze({
  name: "Kael",
  pronouns: "he/him",
  race: "Human",
  characterClass: "Fighter",
  gender: "male",
  ageClass: "Adult",
  bodyType: "Athletic"
});

// Read the (positive, negative) CLIPTextEncode text out of a built ComfyUI graph, in
// graph order (positive node first, negative second — the defaultWorkflow shape).
function promptsFromGraph(graph) {
  const texts = [];
  for (const node of Object.values(graph || {})) {
    if (node && node.class_type === "CLIPTextEncode") texts.push(String(node.inputs?.text || ""));
  }
  return { positive: texts[0] || "", negative: texts[1] || "" };
}

test("every engine style's portrait keeps the weighted identity block + gains the monster/species negatives", () => {
  for (const style of ENGINE_STYLES) {
    const world = { tone: "dark fantasy", artStyleOptions: { default: style } };
    const prompt = buildPlayerPortraitPrompt(HUMAN_MALE, world);
    const { positive, negative } = promptsFromGraph(comfyuiWorkflowForStyle(style, { prompt }).workflow);

    // POSITIVE: the declared identity survives sealing, weighted, in every lane.
    assert.match(positive, /\(adult man:1\.3\)/, `${style}: weighted gender token missing`);
    assert.match(positive, /human/i, `${style}: human identity missing`);
    assert.match(positive, /rounded human ears/i, `${style}: human-ear identity missing`);

    // NEGATIVE: the human-gated monster ban rides every lane (closes the skull demon).
    assert.match(negative, /skull/i, `${style}: skull negative missing`);
    assert.match(negative, /skeleton|undead/i, `${style}: undead negative missing`);
    // The sheet + age laws are lane-invariant too.
    assert.match(negative, /model sheet|reference sheet/i, `${style}: portrait-sheet law missing`);
    assert.match(negative, /child|teenager/i, `${style}: age law missing`);
  }
});

test("non-anime lanes ban the pre-kitchen 'mustard' style-collapse (western comic / yellow field)", () => {
  for (const style of ENGINE_STYLES.filter((s) => s !== "anime")) {
    const world = { tone: "dark fantasy", artStyleOptions: { default: style } };
    const prompt = buildPlayerPortraitPrompt(HUMAN_MALE, world);
    const { negative } = promptsFromGraph(comfyuiWorkflowForStyle(style, { prompt }).workflow);
    assert.match(negative, /western comic/i, `${style}: western-comic ban missing`);
    assert.match(negative, /yellow background/i, `${style}: yellow-field ban missing`);
    assert.match(negative, /floating head|disembodied bust/i, `${style}: floating-bust ban missing`);
  }
  // The anime lane owns the western-comic ban in its own negativeBase (belt + suspenders).
  const { negative: aniNeg } = sealPortraitPrompt("anime", "character portrait of a human man, (adult man:1.3), rounded human ears", "photo");
  assert.match(aniNeg, /western comic/i);
});

test("the monster ban is human-GATED: a committed non-human keeps its nature", () => {
  // A plain human subject is protected.
  assert.notEqual(
    humanSubjectMonsterNegativeFor("character portrait of a human man, (adult man:1.3), rounded human ears"),
    ""
  );
  // A DECLARED demonic/nonhuman subject is NOT fought (would strip its identity).
  for (const declared of [
    "character portrait of a Tiefling (curved horns, long pointed tail), rounded human-like ears",
    "a single demonic figure, human-like",
    "an undead lich, skeletal",
    "a Dragonborn warrior, draconic scales"
  ]) {
    assert.equal(humanSubjectMonsterNegativeFor(declared), "", `should not fight declared: ${declared}`);
  }
  // A non-human scene/creature subject has no human face to protect.
  assert.equal(humanSubjectMonsterNegativeFor("eye-level shot, a forest clearing, a lone wolf in the midground"), "");
});

test("cross-ROUTE: the freeform edit path is a SEALED regenerate by default (kontext parallel path is off)", async () => {
  // Without NOTDND_ALLOW_UNSEALED_EDIT, editImage never routes to the kontext provider;
  // it regenerates through generateImage → the ONE sealed comfyui portrait path. In mock
  // mode the fetchImpl must never be called (no network bypass).
  const prevMock = process.env.NOTDND_MOCK_IMAGE;
  const prevAllow = process.env.NOTDND_ALLOW_UNSEALED_EDIT;
  process.env.NOTDND_MOCK_IMAGE = "true";
  delete process.env.NOTDND_ALLOW_UNSEALED_EDIT;
  try {
    const prompt = buildPlayerPortraitPrompt(HUMAN_MALE, { tone: "dark fantasy", artStyleOptions: { default: "illustrated" } });
    const result = await editImage({
      sourceImageUrl: "/data/assets/draft_x/player/base.png",
      instruction: "add a scar over the left eye",
      prompt,
      style: "illustrated",
      kind: "portrait",
      mock: true,
      fetchImpl: () => { throw new Error("network must not be reached on the sealed default edit path"); }
    });
    assert.equal(result.edited, false, "default edit must be a regenerate, not a kontext image-to-image");
    assert.ok(result.bytes && result.bytes.length > 0, "regenerate must produce image bytes");
  } finally {
    if (prevMock === undefined) delete process.env.NOTDND_MOCK_IMAGE; else process.env.NOTDND_MOCK_IMAGE = prevMock;
    if (prevAllow === undefined) delete process.env.NOTDND_ALLOW_UNSEALED_EDIT; else process.env.NOTDND_ALLOW_UNSEALED_EDIT = prevAllow;
  }
});
