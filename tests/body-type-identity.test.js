// DECLARED BUILD / BODY TYPE (identity-as-state, owner ruling 2026-07-19). bodyType
// is a declared identity field alongside gender/pronouns: required-with-default
// (Average → neutral), committed on the character record, the SOLE source of the
// build token across every player-render lane, refine edits UPDATE the field, and
// minted NPCs carry a varied build. Mirrors the gender spine (0462bb6).
import assert from "node:assert/strict";
import test from "node:test";
import {
  bodyTypePhrase,
  buildPlayerPortraitPrompt,
  parseIdentityEdit,
  applyIdentityEdit
} from "../server/solo/imageWorker.js";
import { resolveIdentityFragments } from "../server/solo/tailorFullbody.js";
import { createDefaultSoloRun, validatePlayerState } from "../server/solo/schema.js";
import { buildCharacter, toRunPlayer } from "../server/solo/characterBuild.js";
import { generateNpcIdentity } from "../server/solo/npcIdentity.js";
import { renderOnboardingFlow } from "../src/components/onboardingFlow.js";
import fs from "node:fs";

// ── (1) field: required-with-default (Average), additive/resume-safe ─────────
test("(1) required-with-default: a new run commits bodyType Average; empty falls back to Average", () => {
  const fresh = createDefaultSoloRun({ pronouns: "she/her" });
  assert.equal(fresh.player.bodyType, "average", "new run defaults to Average");
  // explicit choice wins through the character build → commit path
  const built = buildCharacter({ pronouns: "he/him", bodyType: "muscular" });
  const player = toRunPlayer(built, createDefaultSoloRun({}).player);
  assert.equal(player.bodyType, "muscular", "declared choice is committed");
  // an empty custom value falls back to the base Average (required-with-default)
  const empty = createDefaultSoloRun({ bodyType: "" });
  assert.equal(empty.player.bodyType, "average", "empty → Average, never unset for a new run");
});

test("(1) additive/resume-safe: a legacy player without bodyType still validates", () => {
  const legacy = createDefaultSoloRun({});
  delete legacy.player.bodyType; // simulate a run persisted before the field existed
  const result = validatePlayerState(legacy.player);
  assert.equal(result.ok, true, `legacy player validates without bodyType: ${JSON.stringify(result.errors)}`);
  assert.ok(!result.errors.some((e) => /bodyType/.test(JSON.stringify(e))), "no bodyType-specific error");
});

// ── (2) per-option prompt tokens, per lane ───────────────────────────────────
test("(2) per-option build vocab: each class emits its weighted token; Average is neutral", () => {
  assert.match(bodyTypePhrase({ bodyType: "slim" }, { weighted: true }), /\(slender slim build:1\.2\)/);
  assert.match(bodyTypePhrase({ bodyType: "athletic" }, { weighted: true }), /\(athletic toned build:1\.2\)/);
  assert.match(bodyTypePhrase({ bodyType: "muscular" }, { weighted: true }), /\(muscular build, broad shoulders:1\.2\)/);
  assert.match(bodyTypePhrase({ bodyType: "heavyset" }, { weighted: true }), /\(heavyset build, stocky and broad:1\.2\)/);
  assert.equal(bodyTypePhrase({ bodyType: "average" }, { weighted: true }), "", "Average → no token (neutral default)");
  assert.equal(bodyTypePhrase({ bodyType: "" }, { weighted: true }), "", "unset → neutral");
  // custom free text (no canonical-class name) passes through verbatim: weighting
  // punctuation stripped, " build" appended when it reads as a bare adjective.
  assert.equal(bodyTypePhrase({ bodyType: "gangly and angular" }, { weighted: false }), "gangly and angular build");
  assert.equal(bodyTypePhrase({ bodyType: "tall (masterpiece:1.5) frame" }, { weighted: false }), "tall masterpiece1.5 frame");
});

test("(2) the build token rides the player portrait (both lanes), weighted, only when non-neutral", () => {
  const world = { tone: "dark fantasy", artStyle: "anime" };
  const musc = buildPlayerPortraitPrompt({ name: "Kai", pronouns: "he/him", gender: "male", bodyType: "muscular" }, world);
  assert.match(musc, /\(muscular build, broad shoulders:1\.2\)/, "normal-race lane carries the weighted build");
  const avg = buildPlayerPortraitPrompt({ name: "Kai", pronouns: "he/him", gender: "male", bodyType: "average" }, world);
  assert.doesNotMatch(avg, /build/, "Average renders neutral — no build token");
  // Beckoned lane carries it too
  const beck = buildPlayerPortraitPrompt({ name: "Ren", pronouns: "she/her", gender: "female", bodyType: "athletic", origin: "The Beckoned" }, { tone: "dark fantasy" });
  assert.match(beck, /\(athletic toned build:1\.2\)/, "Beckoned lane carries the weighted build");
});

test("(2) the fullbody tailor lane carries the build (unweighted prose fragment)", () => {
  const frags = resolveIdentityFragments({ player: { pronouns: "she/her", bodyType: "heavyset" } }).fragments;
  assert.ok(frags.includes("heavyset build, stocky and broad"), `tailor fragments carry build: ${JSON.stringify(frags)}`);
  const neutral = resolveIdentityFragments({ player: { pronouns: "he/him", bodyType: "average" } }).fragments;
  assert.ok(!neutral.some((f) => /build/.test(f)), "Average → no build fragment in the tailor");
});

// ── (3) refine = identity-as-state (edit updates the FIELD) ──────────────────
test("(3) a build-class word in a refine UPDATES the bodyType field, and strips from freeform", () => {
  const parsed = parseIdentityEdit("make them much more muscular and add a scar");
  assert.equal(parsed.bodyType, "muscular", "the build class is parsed out");
  assert.doesNotMatch(parsed.freeform, /muscular/i, "the build word is stripped from the freeform remainder");
  assert.match(parsed.freeform, /scar/i, "the non-identity remainder survives");
  // applyIdentityEdit writes the field (not an unweighted prompt tail)
  const applied = applyIdentityEdit({ bodyType: "average", gender: "male" }, "slimmer, please");
  assert.equal(applied.character.bodyType, "slim", "the field is rewritten");
  assert.equal(applied.changed, true);
  assert.equal(applied.identity.bodyType, "slim", "the endpoint identity carries the new field");
});

test("(3) a non-build edit leaves bodyType untouched", () => {
  const parsed = parseIdentityEdit("give them a red cloak and a lantern");
  assert.equal(parsed.bodyType, null, "no build word → no field change");
});

// ── (4) legacy neutral: an unset field renders no build token anywhere ────────
test("(4) legacy neutral: a player with no bodyType emits no build token", () => {
  const world = { tone: "dark fantasy", artStyle: "anime" };
  const prompt = buildPlayerPortraitPrompt({ name: "Old", pronouns: "he/him", gender: "male" }, world);
  assert.doesNotMatch(prompt, /build/, "no declared build → neutral portrait");
  assert.equal(bodyTypePhrase({}, { weighted: true }), "", "no field → empty phrase");
});

// ── (5) NPC mint carries a varied bodyType committed on the entity ───────────
test("(5) minted NPCs carry a bodyType (varied by seed), woven into the portrait prompt", async () => {
  const builds = new Set();
  for (let i = 0; i < 8; i += 1) {
    const id = await generateNpcIdentity({ role: "reeve", worldSeed: "w1", npcIndex: i, provider: "placeholder" });
    assert.ok(typeof id.bodyType === "string" && id.bodyType.length > 0, "every mint carries a bodyType");
    builds.add(id.bodyType);
    if (id.bodyType !== "average") {
      assert.match(id.portraitPrompt, new RegExp(`${id.bodyType} build`), "a non-neutral build is woven into the portrait prompt");
    }
  }
  assert.ok(builds.size > 1, `mint default is VARIED across the roster: saw ${[...builds].join(", ")}`);
});

// ── (6) client: the Build field renders in the Identity step (chips + default) ─
test("(6) the Identity step renders the Build field: 5 classes + Custom, Average default active", () => {
  const html = renderOnboardingFlow({ step: "character", character: { step: 1, name: "", race: "", characterClass: "", bodyType: "average" } });
  assert.match(html, />Build</, "a Build label renders");
  for (const v of ["slim", "average", "athletic", "muscular", "heavyset", "custom"]) {
    assert.match(html, new RegExp(`data-cw-bodytype="${v}"`), `the ${v} chip renders`);
  }
});

// ── blocks: the fullbody anti-drift is folded into the human-gated negative ───
test("(blocks) anime.json humanNegative carries the folded fullbody anti-drift (human-gated)", () => {
  const block = JSON.parse(fs.readFileSync(new URL("../scripts/art/prompts/blocks/anime.json", import.meta.url)));
  assert.equal(block.blockVersion, 5, "v5 discipline");
  for (const token of ["bare legs", "glowing clothing", "magic circle", "energy aura", "portal", "miniskirt"]) {
    assert.ok(block.humanNegative.includes(token), `humanNegative folds "${token}"`);
  }
  assert.ok(!/\bskirt\b(?!,| )/.test(block.humanNegative) || !block.humanNegative.split(",").map((s) => s.trim()).includes("skirt"), "bare 'skirt' is NOT banned (a dress/long skirt must render)");
});
