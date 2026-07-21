// F4 — REDO-IDENTITY BREAK (regression lock).
//
// The reported break: a REDO produced an unclothed woman against MALE pronouns —
// the same class of defect as the old kontext EDIT path that rendered a fresh model
// AROUND the seal (unweighted gender, no wardrobe floor). This test proves the
// assumption REFUTED for the plain redo: a redo (bumped nonce, no edit instruction)
// carries the BYTE-IDENTICAL sealed prompt as a fresh generation of the same
// character — the weighted gender-lock token, the wardrobe floor, the gender-lock
// negative, and the T8 avoid negatives all ride identically; only the seed differs.
//
// It exercises the REAL worker path (runDraftPortraitJob -> generateImage ->
// comfyui.sealPortraitPrompt) with the validated per-lane recipe on disk, capturing
// the exact workflow POSTed to ComfyUI via a stubbed fetch (no GPU, no network).
//
// Env is set BEFORE importing the worker so provider resolution + the assets root
// are correct at module load.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "redo-seal-"));
process.env.NOTDND_IMAGE_PROVIDER = "comfyui";
process.env.NOTDND_ASSETS_ROOT = TMP_ROOT;
delete process.env.NOTDND_MOCK_IMAGE;
delete process.env.INKBORNE_MOCK_IMAGE;
delete process.env.NOTDND_BOOTSTRAP_DEMO;

import assert from "node:assert/strict";
import test from "node:test";
import { runDraftPortraitJob } from "../server/solo/imageWorker.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

// Capture the workflow graph POSTed to ComfyUI's /prompt, and satisfy the poll +
// download protocol so runDraftPortraitJob completes offline.
function installFetchCapture() {
  const captured = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith("/prompt") && opts.method === "POST") {
      captured.push(JSON.parse(opts.body).prompt);
      return { ok: true, json: async () => ({ prompt_id: "pid" }) };
    }
    if (u.includes("/history/")) {
      return {
        ok: true,
        json: async () => ({ pid: { outputs: { "19": { images: [{ filename: "x.png", subfolder: "", type: "output" }] } } } })
      };
    }
    if (u.includes("/view")) {
      return { ok: true, arrayBuffer: async () => TINY_PNG.buffer.slice(TINY_PNG.byteOffset, TINY_PNG.byteOffset + TINY_PNG.byteLength) };
    }
    return { ok: false, status: 404, text: async () => "unexpected", json: async () => ({}) };
  };
  return captured;
}

// Follow the sampler's positive/negative links to the CLIPTextEncode text — robust
// across the validated (KSamplerAdvanced) and generic (KSampler) graphs.
function extractSeal(wf) {
  const sampler = Object.values(wf).find((n) => /KSampler/.test(n?.class_type || ""));
  if (sampler) {
    const posId = sampler.inputs?.positive?.[0];
    const negId = sampler.inputs?.negative?.[0];
    return {
      positive: wf[posId]?.inputs?.text ?? "",
      negative: wf[negId]?.inputs?.text ?? "",
      seed: sampler.inputs?.noise_seed ?? sampler.inputs?.seed ?? null
    };
  }
  return { positive: wf["6"]?.inputs?.text ?? "", negative: wf["7"]?.inputs?.text ?? "", seed: wf["3"]?.inputs?.seed ?? null };
}

const MALE = { name: "Corin", race: "Human", class: "Fighter", background: "Soldier", pronouns: "he/him", gender: "male" };
const WORLD = { tone: "dark fantasy", artStyle: "anime", name: "Verdance" };

async function cookAndExtract(job) {
  const captured = installFetchCapture();
  const r = await runDraftPortraitJob(job);
  assert.equal(r.ok, true, `job cooked (${r.reason || ""})`);
  assert.ok(captured.length >= 1, "a workflow was POSTed to ComfyUI");
  return extractSeal(captured[0]);
}

test("F4: a REDO (nonce>0) carries the BYTE-IDENTICAL seal as a fresh gen — no gender/clothing drift", async () => {
  const fresh = await cookAndExtract({ draftId: "df_fresh", character: MALE, world: WORLD, nonce: 0, avoid: "freckles" });
  const redo = await cookAndExtract({ draftId: "df_redo", character: MALE, world: WORLD, nonce: 3, avoid: "freckles" });

  // Fresh gen carries the full seal (baseline).
  assert.match(fresh.positive, /\(adult man:1\.3\)/, "fresh: weighted male token");
  assert.match(fresh.positive, /wearing a plain dark shirt/, "fresh: wardrobe floor");
  assert.match(fresh.negative, /\(1girl:1\.4\)/, "fresh: gender-lock purges the opposite gender");
  assert.match(fresh.negative, /freckles/, "fresh: T8 avoid negative rides");

  // The REDO must carry every one of them too — this is the identity break guard.
  assert.match(redo.positive, /\(adult man:1\.3\)/, "REDO must keep the weighted male token (no gender drift)");
  assert.match(redo.positive, /wearing a plain dark shirt/, "REDO must keep the wardrobe floor (no clothing drift)");
  assert.match(redo.negative, /\(1girl:1\.4\)/, "REDO must keep the gender-lock negative");
  assert.match(redo.negative, /freckles/, "REDO must keep the T8 avoid negative");

  // Strongest parity claim: the sealed positive + negative are byte-identical; ONLY
  // the seed differs (so the redo is a genuinely different image, not a re-serve).
  assert.equal(redo.positive, fresh.positive, "redo positive === fresh positive (seal parity)");
  assert.equal(redo.negative, fresh.negative, "redo negative === fresh negative (seal parity)");
  assert.notEqual(redo.seed, fresh.seed, "redo seed differs from fresh (a real reroll)");
});

test("F4: cross-lane — the wardrobe floor + gender lock ride the redo on the illustrated lane too", async () => {
  const world = { ...WORLD, artStyle: "illustrated" };
  const fresh = await cookAndExtract({ draftId: "df_illu_fresh", character: MALE, world, nonce: 0 });
  const redo = await cookAndExtract({ draftId: "df_illu_redo", character: MALE, world, nonce: 2 });
  for (const [label, s] of [["fresh", fresh], ["redo", redo]]) {
    assert.match(s.positive, /\(adult man:1\.3\)/, `${label} illustrated: weighted male token`);
    assert.match(s.positive, /wearing a plain dark shirt/, `${label} illustrated: wardrobe floor`);
    assert.match(s.negative, /\(1girl:1\.4\)/, `${label} illustrated: gender-lock negative`);
  }
  assert.equal(redo.positive, fresh.positive, "illustrated redo positive === fresh (seal parity)");
  assert.equal(redo.negative, fresh.negative, "illustrated redo negative === fresh (seal parity)");
});

test.after(() => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
});
