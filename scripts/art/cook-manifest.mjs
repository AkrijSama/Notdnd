// ---------------------------------------------------------------------------
// MANIFEST COOK (library batch cook) — cooks a JSON manifest of asset specs into
// the library via local ComfyUI. Zero API credits, sequential jobs only.
//
//   node scripts/art/cook-manifest.mjs <manifest.json> [--plan]
//
// The manifest is DATA (a dispatch artifact derived from committed run state —
// NPCs, locations, worlds); this runner is the reusable tool. Manifest shape:
//
//   {
//     "specs": [
//       { "id", "style", "kind", "world", "slotValues", "tags" },        // standard lanes
//       { ..., "kind": "fullbody", "faceRef": "<portrait asset id>" }    // TAILORED: cooks
//     ],                                                                  //   through the
//     "keeps": "cooked" | ["id", ...],                                    //   IP-Adapter tailor
//     "checkouts": [{ "id", "runId", "npcId" }]                           //   workflow with the
//   }                                                                     //   portrait as face ref
//
// Standard specs ride generateImage() (prompt contract + recipe ladder). A spec
// with `faceRef` cooks through the owner's fullbody-realistic-tailor workflow:
// the referenced portrait PNG is uploaded to ComfyUI and injected into the
// LoadImage (IP-Adapter face reference) socket so face consistency holds —
// same shape-driven injection as server/solo/tailorFullbody.js, reimplemented
// here without the server/db import chain (this is an offline batch tool).
//
// GPU discipline (freeze history on this 8GB card):
//  - assertSafeWindow() before the batch (play server idle >=10 min, >=1GB VRAM);
//  - strictly sequential jobs, VRAM re-check between jobs;
//  - every output verified on disk (>50KB) before the next job; one retry per
//    spec, then the spec is SKIPPED and listed (a failure never blocks the batch);
//  - ComfyUI is stopped at the end no matter what (it never idles).
//
// Post-cook (only for specs that verified): rate "keep" + tag "auto-keep"
// (surfaces serve keeps only — auto-keeps are flagged for owner re-review via
// scripts/art/review.mjs, which can re-rate any of them to toss), linkIdentity
// for tailored fullbodies, and the manifest's face checkouts (Law 5: one face
// per NPC per run — the portrait IS the checkout).
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  generateImage,
  dryRunPlan,
  assertSafeWindow,
  stopComfy,
  comfyReachable,
  queuePrompt,
  waitForOutput,
  fetchImageBytes
} from "./generate.mjs";
import { cookResourceStatus } from "../../server/ai/resourceGate.js";
import { buildPrompt, laneForKind } from "./promptAssembly.js";
import { addAsset, assetExists, getAsset, libraryRoot, rateAsset, tagAsset, linkIdentity, checkoutFace } from "./library.mjs";

const COMFY = process.env.COMFY_URL || "http://127.0.0.1:8188";
const TAILOR_WORKFLOW = "fullbody-realistic-tailor.json";
const MIN_BYTES = 50 * 1024; // a real SDXL PNG is never smaller

function workflowDir() {
  return process.env.NOTDND_ART_WORKFLOW_DIR
    ? path.resolve(process.env.NOTDND_ART_WORKFLOW_DIR)
    : path.resolve(process.cwd(), "scripts/art/workflows");
}

function seedFromId(id) {
  return crypto.createHash("sha256").update(String(id)).digest().readUInt32BE(0);
}

// --- tailored fullbody (IP-Adapter face reference) ---------------------------
// Shape-driven injection mirroring server/solo/tailorFullbody.js: roles are found
// by class_type, never by node id, so an owner re-export keeps working.
function resolveTailorNodes(graph) {
  const entries = Object.entries(graph);
  const sampler = entries.find(([, n]) => /KSampler/.test(n?.class_type || ""));
  if (!sampler) throw new Error("tailor workflow: no KSampler node");
  const positive = sampler[1].inputs?.positive?.[0];
  const negative = sampler[1].inputs?.negative?.[0];
  const loadImage = entries.find(([, n]) => n?.class_type === "LoadImage");
  const latent = entries.find(([, n]) => n?.class_type === "EmptyLatentImage");
  if (!positive || !graph[positive]) throw new Error("tailor workflow: no positive CLIP node");
  if (!negative || !graph[negative]) throw new Error("tailor workflow: no negative CLIP node");
  if (!loadImage) throw new Error("tailor workflow: no LoadImage (face reference) node");
  if (!latent) throw new Error("tailor workflow: no EmptyLatentImage node");
  return { sampler: sampler[0], positive, negative, loadImage: loadImage[0], latent: latent[0] };
}

async function uploadFaceRef(faceRefId) {
  const pngPath = path.join(libraryRoot(), `${faceRefId}.png`);
  if (!fs.existsSync(pngPath)) {
    throw new Error(`faceRef portrait not on disk: ${pngPath}`);
  }
  const bytes = fs.readFileSync(pngPath);
  const form = new FormData();
  form.append("image", new Blob([bytes]), `cookface_${faceRefId}.png`);
  form.append("overwrite", "true");
  const res = await fetch(`${COMFY}/upload/image`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`comfy /upload/image ${res.status}`);
  const out = await res.json();
  return out.name || `cookface_${faceRefId}.png`;
}

async function cookTailored(spec) {
  const { id, style, world = null, slotValues, tags = [], faceRef } = spec;
  const pngPath = path.join(libraryRoot(), `${id}.png`);
  if (fs.existsSync(pngPath) && assetExists(id)) {
    return { id, skipped: true, ms: 0, pngPath };
  }
  if (!assetExists(faceRef)) {
    throw new Error(`faceRef ${faceRef} has no sidecar — cook the portrait first`);
  }
  const graph = JSON.parse(fs.readFileSync(path.join(workflowDir(), TAILOR_WORKFLOW), "utf8"));
  const { positive, negative, meta } = buildPrompt(laneForKind("fullbody"), style, slotValues, { tags });
  const clone = JSON.parse(JSON.stringify(graph));
  const nodes = resolveTailorNodes(clone);
  clone[nodes.positive].inputs.text = positive;
  clone[nodes.negative].inputs.text = negative;
  clone[nodes.loadImage].inputs.image = await uploadFaceRef(faceRef);
  clone[nodes.latent].inputs.batch_size = 1;
  // Deterministic per-id seed (same rule as generateImage) so a resumed re-cook
  // reproduces the image; the sampler's own field name varies by sampler class.
  const seedField = "noise_seed" in clone[nodes.sampler].inputs ? "noise_seed" : "seed";
  clone[nodes.sampler].inputs[seedField] = seedFromId(id);

  const t0 = Date.now();
  const promptId = await queuePrompt(clone, `inkborne-cook-${id}`);
  const image = await waitForOutput(promptId);
  const bytes = await fetchImageBytes(image);
  fs.mkdirSync(libraryRoot(), { recursive: true });
  fs.writeFileSync(pngPath, bytes);
  addAsset({
    id,
    origin: "generated",
    world,
    style,
    kind: "fullbody",
    tags: [...new Set(["tailor", ...tags])],
    identityRef: faceRef,
    workflow: TAILOR_WORKFLOW,
    promptUsed: positive,
    meta
  });
  return { id, skipped: false, ms: Date.now() - t0, pngPath };
}

// --- verification -------------------------------------------------------------
function verifyOnDisk(id) {
  const pngPath = path.join(libraryRoot(), `${id}.png`);
  if (!fs.existsSync(pngPath)) return { ok: false, why: "png missing" };
  const size = fs.statSync(pngPath).size;
  if (size < MIN_BYTES) return { ok: false, why: `png only ${size} bytes (<${MIN_BYTES})` };
  if (!assetExists(id)) return { ok: false, why: "sidecar missing" };
  return { ok: true, size };
}

// --- main ----------------------------------------------------------------------
async function cookOne(spec) {
  return spec.faceRef ? cookTailored(spec) : generateImage(spec);
}

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath || manifestPath.startsWith("--")) {
    console.error("usage: node scripts/art/cook-manifest.mjs <manifest.json> [--plan]");
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const specs = Array.isArray(manifest.specs) ? manifest.specs : [];
  if (!specs.length) throw new Error("manifest has no specs");

  if (process.argv.includes("--plan")) {
    for (const s of specs) {
      if (s.faceRef) {
        const { positive, negative } = buildPrompt(laneForKind("fullbody"), s.style, s.slotValues, { tags: s.tags || [] });
        console.log(`\n--- ${s.id}  [${s.style}/fullbody TAILORED faceRef=${s.faceRef}]  recipe: ${TAILOR_WORKFLOW}`);
        console.log(`  POSITIVE: ${positive}`);
        console.log(`  NEGATIVE: ${negative}`);
      } else {
        const p = dryRunPlan({ style: s.style, kind: s.kind, slotValues: s.slotValues, tags: s.tags || [] });
        console.log(`\n--- ${s.id}  [${s.style}/${s.kind}]  recipe: ${p.workflowFile} ${p.dims.width}x${p.dims.height}`);
        console.log(`  POSITIVE: ${p.positive}`);
        console.log(`  NEGATIVE: ${p.negative}`);
      }
    }
    console.log(`\n${specs.length} specs planned. Nothing generated.`);
    return;
  }

  if (!(await comfyReachable())) {
    throw new Error(`ComfyUI not reachable at ${COMFY} — launch it with --novram first.`);
  }
  await assertSafeWindow();

  const cooked = [];
  const skippedExisting = [];
  const failed = [];
  const pending = [];
  try {
    for (const spec of specs) {
      // STABILIZER LAW (owner 2026-07-21): gate BEFORE EACH cook against the shared
      // Law-6 floor (VRAM + system RAM), not the old 1024 MiB VRAM-only per-chunk
      // check. A starving machine SKIPS-AND-MARKS-PENDING this spec and moves on — it
      // never queues a render into starvation and never aborts the whole manifest.
      const gate = cookResourceStatus();
      if (!gate.ok) {
        pending.push({ id: spec.id, why: gate.reason });
        console.warn(`  PENDING ${spec.id} — ${gate.reason}. Machine starving; not queued.`);
        continue;
      }
      let lastErr = null;
      let deferred = false;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const r = await cookOne(spec);
          const v = verifyOnDisk(spec.id);
          if (!v.ok) throw new Error(`output verify failed: ${v.why}`);
          if (r.skipped) {
            skippedExisting.push(spec.id);
            console.log(`  SKIP   ${spec.id} (already in library)`);
          } else {
            cooked.push(spec.id);
            console.log(`  cooked ${spec.id} (${(r.ms / 1000).toFixed(1)}s, ${Math.round(v.size / 1024)}KB)`);
          }
          lastErr = null;
          break;
        } catch (err) {
          // A resource-gate block (headroom dropped after the pre-check) is NOT a
          // failure and must not burn a retry — mark pending and move on.
          if (err?.code === "RESOURCE_GATE_BLOCKED") {
            deferred = true;
            pending.push({ id: spec.id, why: err.status?.reason || "insufficient resources" });
            console.warn(`  PENDING ${spec.id} — gate blocked mid-batch; not queued.`);
            break;
          }
          lastErr = err;
          console.warn(`  RETRY? ${spec.id} attempt ${attempt} failed: ${err.message}`);
        }
      }
      if (!deferred && lastErr) {
        failed.push({ id: spec.id, why: lastErr.message });
        console.error(`  FAILED ${spec.id} — skipped after 2 attempts: ${lastErr.message}`);
      }
    }
  } finally {
    stopComfy();
  }

  // Post-cook curation — verified assets only. keeps: "cooked" rates everything
  // that landed this batch; an explicit id list rates just those.
  const keepIds = manifest.keeps === "cooked"
    ? [...cooked, ...skippedExisting]
    : Array.isArray(manifest.keeps) ? manifest.keeps : [];
  for (const id of keepIds) {
    if (!verifyOnDisk(id).ok) continue;
    rateAsset(id, "keep");
    tagAsset(id, ["auto-keep"]);
  }
  for (const spec of specs) {
    if (spec.faceRef && verifyOnDisk(spec.id).ok && assetExists(spec.faceRef)) {
      linkIdentity(spec.id, spec.faceRef);
    }
  }
  for (const co of Array.isArray(manifest.checkouts) ? manifest.checkouts : []) {
    try {
      const existing = getAsset(co.id);
      if (existing && existing.checkout) {
        console.log(`  checkout SKIP ${co.id} (already held by ${JSON.stringify(existing.checkout)})`);
        continue;
      }
      checkoutFace(co.id, { runId: co.runId, npcId: co.npcId });
      console.log(`  checked out ${co.id} -> ${co.npcId} @ ${co.runId}`);
    } catch (err) {
      console.error(`  checkout FAILED ${co.id}: ${err.message}`);
    }
  }

  console.log(`\ncook-manifest done: ${cooked.length} cooked, ${skippedExisting.length} already present, ${failed.length} failed, ${pending.length} pending (deferred — machine starving).`);
  if (failed.length) {
    console.log("FAILED SPECS:");
    for (const f of failed) console.log(`  - ${f.id}: ${f.why}`);
  }
  if (pending.length) {
    console.log("PENDING SPECS (re-run when the machine has headroom):");
    for (const p of pending) console.log(`  - ${p.id}: ${p.why}`);
  }
  console.log("ComfyUI stopped. Owner re-review: node scripts/art/review.mjs (auto-keeps are tagged).");
}

main().catch((err) => {
  console.error(`\nCOOK ABORTED: ${err.message}`);
  process.exit(1);
});
