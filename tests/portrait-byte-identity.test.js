// F3 — PORTRAIT BYTE-IDENTITY. The portrait the player SELECTS must be the portrait
// committed in-game, byte-identical. The commit path is enterWorld → draftPortraitId →
// server copyDraftPortraitToRun (copies THAT draft's on-disk file). The bug was the poll
// setting only draftPortraitUri (the shown image) while draftPortraitId (the committed
// one) could diverge — a different portrait in-game. The invariant: draftPortraitId and
// draftPortraitUri always move as a PAIR. Client-state logic → asserted at the source
// (no DOM), the way the em-dash net asserts builder sources.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.resolve("src/main.js"), "utf8");

test("the poll success pairs the committed id with the shown uri (kills the divergence)", () => {
  // in the generated-poll branch, both draftPortraitUri and draftPortraitId are set
  const pollBranch = src.slice(src.indexOf('res?.status === "generated"'));
  const block = pollBranch.slice(0, pollBranch.indexOf("return; // done"));
  assert.match(block, /draftPortraitUri = res\.uri/, "the shown uri is set");
  assert.match(block, /draftPortraitId = draftId/, "the committed id is paired to it");
});

test("selecting a version pairs id + uri from the SAME version (revert path)", () => {
  const revert = src.slice(src.indexOf("function revertPortraitVersion"));
  const body = revert.slice(0, revert.indexOf("scheduleRender"));
  assert.match(body, /draftPortraitUri = version\.uri/, "uri from the selected version");
  assert.match(body, /draftPortraitId = version\.id/, "id from the SAME selected version");
});

test("enterWorld commits the selected draftPortraitId (which the server copies byte-for-byte)", () => {
  const enter = src.slice(src.indexOf("async function enterWorld"));
  const body = enter.slice(0, 2000); // the createWorldRun payload
  assert.match(body, /draftPortraitId: uiState\.onboarding\.draftPortraitId/, "the paired id is what commits");
});
