// BUILD line must give the stale check a FACE (owner ruling 2026-07-19): loud warn
// when the loaded SHA has fallen behind the disk tip; a subtle "current" tick when
// clean+current — so "what build am I on" is answered at a glance.
import assert from "node:assert/strict";
import test from "node:test";
import { renderBody } from "../src/components/debugPanel.js";

const base = {
  gm: { configuredModel: "x", served: null },
  image: { configuredProvider: "comfyui", served: null, worker: {} },
  cloudChain: "openrouter"
};
const build = (b) => renderBody({ ...base, build: b });

test("STALE loaded code renders LOUD with the disk SHA + restart cue", () => {
  const html = build({ sha: "aaaaaaa", branch: "main", dirty: false, diskSha: "bbbbbbb", stale: true, nodeEnv: "development" });
  assert.match(html, /STALE — restart needed/);
  assert.match(html, /bbbbbbb/, "names the disk tip so forensics starts with ground truth");
  assert.match(html, /dbg-warn/, "uses the warning state, not a quiet tag");
});

test("clean + current renders a subtle 'current' tick, not a warning", () => {
  const html = build({ sha: "aaaaaaa", branch: "main", dirty: false, diskSha: "aaaaaaa", stale: false, nodeEnv: "development" });
  assert.match(html, /✓ current/);
  assert.doesNotMatch(html, /STALE/);
  assert.doesNotMatch(html, /dbg-warn/, "current build never shows the warn state");
});
