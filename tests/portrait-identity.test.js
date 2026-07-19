// PORTRAIT REFINE: identity-as-state, single path (2026-07-18 refine-inverts-
// gender fix). A refine edit like "male" must UPDATE the committed identity field
// and rebuild the prompt with a WEIGHTED gender token + opposite-gender negative —
// never fight an unweighted tail append. Server logic only; no image generation.

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseIdentityEdit,
  applyIdentityEdit,
  pronounsToGender,
  buildPlayerPortraitPrompt
} from "../server/solo/imageWorker.js";
import { sealPortraitPrompt } from "../server/ai/comfyui.js";
import { createDefaultSoloRun, validateSoloRun } from "../server/solo/schema.js";

// ── identity-class edits parse into FIELD changes; other text stays freeform ──
test("parseIdentityEdit: gender/age-class tokens become fields; the rest is freeform", () => {
  assert.deepEqual(
    (({ pronouns, gender, freeform }) => ({ pronouns, gender, freeform }))(parseIdentityEdit("Male character")),
    { pronouns: "he/him", gender: "male", freeform: "" }
  );
  assert.equal(parseIdentityEdit("female").pronouns, "she/her");
  assert.equal(parseIdentityEdit("make her a woman").gender, "female");
  assert.equal(parseIdentityEdit("nonbinary").pronouns, "they/them");
  const older = parseIdentityEdit("make him older");
  assert.equal(older.pronouns, "he/him");
  assert.equal(older.ageClass, "elderly");
  // A pure visual tweak carries NO identity field and stays entirely freeform.
  const hair = parseIdentityEdit("longer hair");
  assert.equal(hair.pronouns, null);
  assert.equal(hair.gender, null);
  assert.equal(hair.freeform, "longer hair");
  // Mixed: identity absorbed into fields, visual remainder kept.
  const mixed = parseIdentityEdit("add a scar and make him male");
  assert.equal(mixed.pronouns, "he/him");
  assert.match(mixed.freeform, /scar/);
});

test("pronounsToGender maps declared pronouns to the committed gender", () => {
  assert.equal(pronounsToGender("he/him"), "male");
  assert.equal(pronounsToGender("she/her"), "female");
  assert.equal(pronounsToGender("they/them"), "nonbinary");
  assert.equal(pronounsToGender(""), null);
});

test("applyIdentityEdit updates the character state (not the prompt text)", () => {
  const out = applyIdentityEdit({ name: "Aki", origin: "The Beckoned" }, "Male character");
  assert.equal(out.character.pronouns, "he/him");
  assert.equal(out.character.gender, "male");
  assert.equal(out.changed, true);
  assert.equal(out.freeform, "");
});

// ── the prompt is REBUILT from state with a WEIGHTED gender token ─────────────
test("buildPlayerPortraitPrompt emits a weighted gender token from the declared field", () => {
  const w = { tone: "dark fantasy", artStyle: "anime" };
  const none = buildPlayerPortraitPrompt({ name: "Aki", origin: "The Beckoned" }, w);
  assert.match(none, /\(adult:1\.3\)/); // ungendered when unset
  assert.doesNotMatch(none, /adult man|adult woman/);
  const male = buildPlayerPortraitPrompt({ name: "Aki", origin: "The Beckoned", pronouns: "he/him", gender: "male" }, w);
  assert.match(male, /\(adult man:1\.3\)/);
  const female = buildPlayerPortraitPrompt({ name: "Aki", origin: "The Beckoned", pronouns: "she/her", gender: "female" }, w);
  assert.match(female, /\(adult woman:1\.3\)/);
  const older = buildPlayerPortraitPrompt({ name: "Aki", origin: "The Beckoned", pronouns: "he/him", gender: "male", ageClass: "elderly" }, w);
  assert.match(older, /\(elderly man:1\.3\)/);
});

// ── the seal ENFORCES gender by purging the opposite in the NEGATIVE ─────────
test("sealPortraitPrompt gender-lock: the opposite gender is purged in the negative", () => {
  const w = { tone: "dark fantasy", artStyle: "anime" };
  const malePos = buildPlayerPortraitPrompt({ name: "Aki", origin: "The Beckoned", pronouns: "he/him", gender: "male" }, w);
  const femPos = buildPlayerPortraitPrompt({ name: "Aki", origin: "The Beckoned", pronouns: "she/her", gender: "female" }, w);
  const maleNeg = sealPortraitPrompt("anime", malePos, "").negative;
  const femNeg = sealPortraitPrompt("anime", femPos, "").negative;
  assert.match(maleNeg, /\bfemale\b/);
  assert.match(maleNeg, /1girl/);
  assert.doesNotMatch(maleNeg, /1boy/);
  assert.match(femNeg, /\bmale\b/);
  assert.match(femNeg, /1boy/);
  assert.doesNotMatch(femNeg, /1girl/);
  // Non-anime lanes get the gender lock too (single-sourced from the positive).
  const dfNeg = sealPortraitPrompt("dark-fantasy", malePos, "base neg").negative;
  assert.match(dfNeg, /female/);
});

// ── declared gender is committed + resume-safe ───────────────────────────────
test("run.player.gender derives from declared pronouns and is resume-safe", () => {
  const she = createDefaultSoloRun({ runId: "r1", pronouns: "she/her" });
  assert.equal(she.player.gender, "female");
  assert.equal(validateSoloRun(she).ok, true);
  const def = createDefaultSoloRun({ runId: "r2" }); // owner default he/him
  assert.equal(def.player.gender, "male");
  delete def.player.gender; // legacy run predates the field
  assert.equal(validateSoloRun(def).ok, true);
});
