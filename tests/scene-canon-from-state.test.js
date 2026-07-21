// SCENE CANON-FROM-STATE + FRAMING LAW (owner ruling 2026-07-19). Scene art is
// built from COMMITTED STATE as mandatory slots (canon description past sentence 1,
// weather, time, danger, era, tone) and framed as the player's eye-level view
// (never an aerial/postcard vista). Server logic only; no image generation.
import test from "node:test";
import assert from "node:assert/strict";
import { buildScenePrompt, artStyleDirection } from "../server/solo/imageWorker.js";
import { sealPortraitPrompt } from "../server/ai/comfyui.js";

// STEEL/FURNITURE (2026-07-21): the "beautiful AND wrong" tone clause is no longer
// hardcoded in the engine — it is Babel's authored `world.sceneRegister` (babel.json).
// This synthetic run mirrors a really-loaded babel run, register included, so the TONE
// LAW assertion below still tests Babel's behaviour rather than engine steel.
const VERDANCE_SCENE_REGISTER =
  "beautiful yet subtly wrong, uneasy stillness, faint shimmer in the air, over-still water, off light";
const verdanceRun = (overrides = {}) => ({
  world: { tone: "modern arcane", era: "Modern parallel Earth, Pacific Northwest", variant: "babel", sceneRegister: VERDANCE_SCENE_REGISTER, time: { minutes: 18 * 60, phase: "dusk" }, weather: "fog", ...overrides.world },
  locations: {},
  ...overrides
});
const fringe = {
  name: "The Green Static — Fringe",
  description: "The corrupted edge of an old Pacific-Northwest rainforest. From here the air above the canopy shimmers like bad signal. Moss grows in spirals it should not know, the light comes a half-beat wrong.",
  state: { dangerLevel: 2 }
};

test("the scene subject quote-mines the FULL canon, not just the first sentence", () => {
  const p = buildScenePrompt(verdanceRun(), fringe, "start_location");
  assert.match(p, /Green Static/);
  // The corruption/unease lives PAST sentence 1 — it must survive (the old
  // first-sentence-only fragment dropped it → generic postcards).
  assert.match(p, /shimmers like bad signal/);
  assert.match(p, /spirals/);
  assert.match(p, /half-beat wrong/);
});

test("committed state rides as mandatory slots: weather, time-of-day, danger, era, tone", () => {
  const p = buildScenePrompt(verdanceRun(), fringe, "start_location");
  assert.match(p, /fog|mist/, "committed weather");
  assert.match(p, /dusk/, "world-clock time-of-day");
  assert.match(p, /unsettled|on edge/, "danger register (MID)");
  assert.match(p, /modern Earth/i, "era fragment");
  assert.match(p, /beautiful yet subtly wrong|uneasy/, "TONE LAW: beautiful AND wrong");
  assert.match(p, /modern arcane/, "world tone");
});

test("scene FRAMING LAW: the location direction is eye-level, at DISTANCE, sky capped", () => {
  const dir = artStyleDirection("anime", "location");
  assert.match(dir, /eye-level/);
  assert.match(dir, /sky only in the upper third/);
  // WALK-3 V3: the law must command DISTANCE. The owner's wolf-feet render happened
  // with the whole law riding, because nothing in it asked for distance.
  assert.match(dir, /natural distance|seen in full/i, "the framing law must command distance");
  // …and must NOT contain the low-camera words that CAUSED the close-up. "ground level
  // view" literally specifies a camera at ground level — that IS the paws shot.
  assert.doesNotMatch(dir, /ground level view/i, "a ground-level camera is the wolf-feet defect");
  assert.doesNotMatch(dir, /standing low on the ground/i);
});

test("the seal's scene guard bans aerial/vista/vehicles/city for non-character subjects", () => {
  const scenePos = buildScenePrompt(verdanceRun(), fringe, "start_location") + ", anime background art";
  const neg = sealPortraitPrompt("anime", scenePos, "").negative;
  assert.match(neg, /aerial view/);
  assert.match(neg, /bird's-eye/);
  assert.match(neg, /sky focus/);
  assert.match(neg, /modern city skyline|skyscrapers/);
  assert.match(neg, /crowd/);
  // A character subject must NOT get the scene guard (it has no framing).
  const charNeg = sealPortraitPrompt("anime", "character portrait of Aki, a man", "").negative;
  assert.doesNotMatch(charNeg, /aerial view/);
});
