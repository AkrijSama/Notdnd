import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validatePortraitUpload, PORTRAIT_UPLOAD_MAX_BYTES, renderOnboardingFlow } from "../src/components/onboardingFlow.js";

// Item 1 (client-clearout): "I'll upload my own" is a real path — the file IS
// the portrait, generation NEVER fires on it, and rejects are visibly explained.

// ---- client-side validation (owner spec: png/jpg/webp, <=5MB, visible error) ----

test("validatePortraitUpload accepts png/jpeg/webp within 5MB", () => {
  for (const type of ["image/png", "image/jpeg", "image/webp"]) {
    assert.deepEqual(validatePortraitUpload({ name: "x", type, size: 1024 }), { ok: true });
  }
  assert.equal(validatePortraitUpload({ type: "image/png", size: PORTRAIT_UPLOAD_MAX_BYTES }).ok, true);
});

test("validatePortraitUpload rejects wrong type and oversize with player-readable errors", () => {
  const gif = validatePortraitUpload({ type: "image/gif", size: 10 });
  assert.equal(gif.ok, false);
  assert.match(gif.error, /PNG, JPG, or WEBP/);
  const big = validatePortraitUpload({ type: "image/png", size: PORTRAIT_UPLOAD_MAX_BYTES + 1 });
  assert.equal(big.ok, false);
  assert.match(big.error, /5MB/);
  const none = validatePortraitUpload(null);
  assert.equal(none.ok, false);
});

// ---- upload mode renders a real file picker + the error slot ----

function wizardState(extra = {}, character = {}) {
  return {
    step: "character",
    mode: "world",
    worldPreview: { name: "W", tone: "grim" },
    character: { step: 1, name: "Ash", pronouns: "they/them", portraitMode: "upload", ...character },
    ...extra
  };
}

test("upload mode renders the file input (png/jpg/webp accept) and honest hint", () => {
  const html = renderOnboardingFlow(wizardState());
  assert.match(html, /data-cw-portrait-file/);
  assert.match(html, /accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(html, /up to 5MB/);
  assert.match(html, /nothing is generated on this path/i);
});

test("a rejected upload shows the visible error message", () => {
  const html = renderOnboardingFlow(wizardState({ portraitUploadError: "That image is over the 5MB limit — pick a smaller file." }));
  assert.match(html, /onb-upload-error/);
  assert.match(html, /over the 5MB limit/);
});

test("generate mode shows NO file input (and no upload error)", () => {
  const html = renderOnboardingFlow(wizardState({}, { portraitMode: "generate" }));
  assert.doesNotMatch(html, /data-cw-portrait-file/);
});

// ---- the server route stores the file in the draft layout (disk-first) ----

test("upload route logic: uploaded bytes land as the draft portrait and poll reports generated", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-upload-"));
  process.env.NOTDND_ASSETS_ROOT = path.join(tmp, "assets");
  process.env.NOTDND_DB_PATH = path.join(tmp, "u.db.json");
  const { writeUploadedBasePortrait, getDraftPortrait } = await import("../server/solo/imageWorker.js");
  // A minimal real PNG header so detectImageExt-style consumers agree it's a png.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
  const draftId = "draft_upload_testabc";
  const { uri } = writeUploadedBasePortrait(draftId, "player", "png", png);
  assert.match(uri, /draft_upload_testabc\/player\/base\.png$/);
  // The existing disk-first poll sees the uploaded file as a GENERATED portrait —
  // which is also what makes runDraftPortraitJob skip generation for this draftId.
  const status = getDraftPortrait(draftId);
  assert.equal(status.status, "generated");
  assert.equal(status.uri, uri);
  delete process.env.NOTDND_ASSETS_ROOT;
});
