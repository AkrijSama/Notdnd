// SPECIES/NATURE COHERENCE (live defect run_61fb9c16: the Limping Grey — a corrupted
// wolf — was narrated as a human man). Three layers: the briefing nature line, the
// nature-contradiction scrub, and the nature-gated affordance.
import test from "node:test";
import assert from "node:assert/strict";
import { entityNature, naturePhrase } from "../server/solo/entityNature.js";
import { detectNatureContradiction, scrubNatureContradiction } from "../server/solo/natureAudit.js";
import { deriveAffordances } from "../server/solo/affordances.js";
import { buildNpcIntroDirective } from "../server/solo/scene.js";
import { buildScenePrompt } from "../server/solo/imageWorker.js";
import { sealPortraitPrompt } from "../server/ai/comfyui.js";

// The committed Grey (a corrupted-wolf chaosling) + a human bandit, at a location.
function sceneWith(npcs) {
  const run = { currentLocationId: "loc_x", worldSeed: "s", locations: { loc_x: { locationId: "loc_x", connectedLocationIds: [], tags: [], state: {}, flags: {} } }, npcs: {} };
  for (const n of npcs) run.npcs[n.npcId] = n;
  return run;
}
const grey = () => ({ npcId: "npc_limping_grey", displayName: "The Limping Grey", role: "hostile", statBlockId: "limping_grey", currentLocationId: "loc_x", status: "present", known: false, flags: { hostile: true, introduced: false }, tags: ["hostile", "wildlife", "wolf", "chaosling", "corrupted"] });
const bandit = () => ({ npcId: "npc_thug", displayName: "The reeve's collector", role: "enforcer", statBlockId: "waylayer", currentLocationId: "loc_x", status: "present", flags: { hostile: true }, tags: ["human", "enforcer"] });

test("entityNature: the Grey is an ANIMAL, non-social; the bandit is human-tier, social", () => {
  const g = entityNature(grey());
  assert.equal(g.isAnimal, true, "a corrupted wolf is an animal");
  assert.equal(g.socialCapable, false, "a beast can't be talked to");
  assert.equal(g.species, "grey wolf");
  const b = entityNature(bandit());
  assert.equal(b.isAnimal, false);
  assert.equal(b.socialCapable, true, "a bandit is the social-capable rung");
});

test("(a) briefing: a creature rides a mandatory NATURE line with species; the narrator can't invent a man", () => {
  const dir = buildNpcIntroDirective(sceneWith([grey()]));
  assert.match(dir, /NATURE \(committed truth/);
  assert.match(dir, /grey wolf/);
  assert.match(dir, /not a person/i);
  assert.match(dir, /may NOT reassign its species or make it human/);
  assert.match(dir, /a bite that chills/, "the sight-read rides too");
  // a plain human NPC gets NO nature line
  assert.doesNotMatch(buildNpcIntroDirective(sceneWith([bandit()])), /NATURE \(committed/);
});

test("(b) auditor: the exact live crime scrubs to a species-true beast", () => {
  const run = sceneWith([grey()]);
  const crime = "A man sits against a tree ten paces ahead, one leg bent wrong beneath him. He watches you with flat eyes, one hand pressed flat against the bark beside his hip. He does not speak.";
  const hits = detectNatureContradiction(crime, run).map((h) => h.kind);
  assert.ok(hits.includes("noun") && hits.includes("hands"), "the human noun + hands flag");
  const out = scrubNatureContradiction(crime, run).text;
  assert.doesNotMatch(out, /\bA man\b|\bhis hip\b|\bone hand\b/, "no human noun/hands/pronoun survives");
  assert.match(out, /grey wolf|It watches|its /, "corrected to the committed beast");
});

test("(b) auditor GUARDS: uncanny is canon; a present human makes it ambiguous (no scrub)", () => {
  const run = sceneWith([grey()]);
  assert.equal(detectNatureContradiction("A grey wolf watches you with patient, unsettling intelligence.", run).length, 0, "uncanny ≠ human claim");
  // With a human NPC present too, a 'man' could be that NPC → don't audit (ambiguous).
  const mixed = sceneWith([grey(), bandit()]);
  assert.deepEqual(scrubNatureContradiction("A man steps forward.", mixed).scrubbed, [], "ambiguous scene is not scrubbed");
});

test("(c) affordance: a beast gets Face/Approach (never Talk-to); a human keeps Talk-to", () => {
  const beastAff = deriveAffordances(sceneWith([grey()])).map((a) => a.label);
  assert.ok(beastAff.some((l) => /^Face /.test(l)), "hostile beast → Face");
  assert.ok(!beastAff.some((l) => /^Talk to/.test(l)), "no Talk-to for a beast");
  const humanAff = deriveAffordances(sceneWith([{ ...bandit(), flags: {} }])).map((a) => a.label);
  assert.ok(humanAff.some((l) => /^Talk to/.test(l)), "a human-tier NPC keeps Talk-to");
});

// ── Defect 2: SCENE COMPOSITION — a committed present entity is a MANDATORY midground
// subject (species-true); the negative net bans stray humans UNLESS a human is committed,
// and no longer bans "character" (which had suppressed the beast to a bare floor).
function sceneRun(npcs) {
  const run = sceneWith(npcs);
  run.world = { tone: "dark fantasy", era: "" };
  run.locations.loc_x.name = "The Still Clearing";
  run.locations.loc_x.description = "a mossy clearing ringed by pale birches, a shallow over-still pool";
  return run;
}

test("(2) scene: a committed beast is the species-true midground subject, not a bare floor", () => {
  const pos = buildScenePrompt(sceneRun([grey()]), { locationId: "loc_x", name: "The Still Clearing", description: "a mossy clearing" }, "loc_x");
  assert.match(pos, /grey wolf/, "the wolf rides the scene positive by species");
  assert.match(pos, /midground/, "as a midground subject");
  assert.match(pos, /wounded|corrupted/, "with its committed condition");
});

test("(2) scene negative: bans stray humans + bare floor for a beast; drops 'character'", () => {
  const pos = buildScenePrompt(sceneRun([grey()]), { locationId: "loc_x", name: "The Still Clearing", description: "a mossy clearing" }, "loc_x");
  const { negative } = sealPortraitPrompt("realistic", pos, "lowres");
  assert.doesNotMatch(negative, /\bcharacter\b/, "'character' no longer suppresses the beast");
  assert.match(negative, /human figure/, "stray humans banned in a beast scene");
  assert.match(negative, /no subject|empty floor/, "a bare floor is banned");
});

test("(2) scene negative: the human ban is DROPPED when a human is the committed subject", () => {
  const pos = buildScenePrompt(sceneRun([{ ...bandit(), flags: { hostile: true } }]), { locationId: "loc_x", name: "The Still Clearing", description: "a mossy clearing" }, "loc_x");
  assert.match(pos, /lone figure/, "a committed human is a midground figure");
  const { negative } = sealPortraitPrompt("realistic", pos, "lowres");
  assert.doesNotMatch(negative, /human figure/, "the committed human is allowed to render");
});
