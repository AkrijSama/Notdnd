// ---------------------------------------------------------------------------
// WORKFLOW VALIDATOR (art-pipeline-v2 — the intake for the owner's ComfyUI exports)
//
// The owner exports API-format ComfyUI graphs (node-id keyed: each value is
// { class_type, inputs, _meta? }) into scripts/art/workflows/. This module confirms
// the format and identifies the DRIVEABLE SOCKETS by GRAPH SHAPE — never by node
// titles (the owner may rename any node). The generator injects the assembled
// prompt / dims / seed into the identified node ids; a malformed export is rejected
// with an error that names the fix, before any GPU time is spent.
//
// Detection anchors on the SAMPLER (the only node that wires positive + negative +
// latent_image together): whatever its `positive` input points at IS the positive
// CLIP encode; `negative` → the negative; `latent_image` → the empty-latent; and
// its own seed field (seed | noise_seed) is the seed socket. Checkpoint / VAE decode
// / save are found by class_type family. No titles are read for any of this.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function isObj(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

// A ComfyUI input reference is [nodeId, outputIndex].
function refNodeId(value) {
  return Array.isArray(value) && value.length === 2 ? String(value[0]) : null;
}

// The sampler is the node that wires positive + negative + latent_image (the three
// txt2img sockets) — a signature no other node carries. If several match (rare),
// the first in id order wins. Returns { id, node } or null.
function findSampler(graph) {
  const ids = Object.keys(graph).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  for (const id of ids) {
    const node = graph[id];
    const inp = isObj(node) ? node.inputs : null;
    if (!isObj(inp)) continue;
    if (refNodeId(inp.positive) && refNodeId(inp.negative) && refNodeId(inp.latent_image)) {
      return { id, node };
    }
  }
  return null;
}

// The seed socket on a sampler: KSampler uses `seed`, KSamplerAdvanced uses
// `noise_seed`. Returns the field name present (preferring an existing numeric one).
export function samplerSeedField(samplerNode) {
  const inp = isObj(samplerNode) ? samplerNode.inputs : {};
  if (Object.prototype.hasOwnProperty.call(inp, "noise_seed")) return "noise_seed";
  if (Object.prototype.hasOwnProperty.call(inp, "seed")) return "seed";
  return null;
}

function firstOfClass(graph, re) {
  const ids = Object.keys(graph).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  for (const id of ids) {
    if (isObj(graph[id]) && re.test(String(graph[id].class_type || ""))) return id;
  }
  return null;
}

/**
 * Identify the driveable node ids of an API-format graph by SHAPE.
 * @returns {{ roles: object, errors: string[] }}
 *   roles: { checkpoint, positive, negative, latent, sampler, seedField, vaeDecode, save }
 *          (a role is null when absent). errors names each missing/ambiguous socket
 *          AND the fix.
 */
export function identifyWorkflowRoles(graph) {
  const errors = [];
  const roles = {
    checkpoint: null, positive: null, negative: null, latent: null,
    sampler: null, seedField: null, vaeDecode: null, save: null
  };
  if (!isObj(graph) || !Object.keys(graph).length) {
    errors.push("not an API-format graph: expected a non-empty object of node-id → { class_type, inputs }. FIX: export from ComfyUI via 'Save (API Format)', not the UI 'Save'.");
    return { roles, errors };
  }
  // Every value must be a node with class_type + inputs (the API-format contract).
  for (const [id, node] of Object.entries(graph)) {
    if (!isObj(node) || typeof node.class_type !== "string" || !isObj(node.inputs)) {
      errors.push(`node "${id}" is not API-format ({ class_type, inputs }). FIX: re-export via ComfyUI 'Save (API Format)' — the UI-format graph (with "nodes"/"links" arrays) is not driveable.`);
      return { roles, errors };
    }
  }

  const sampler = findSampler(graph);
  if (!sampler) {
    errors.push("no sampler found: expected one node wiring positive + negative + latent_image (KSampler / KSamplerAdvanced). FIX: the graph must contain a sampler with those three inputs.");
    return { roles, errors }; // everything else hangs off the sampler
  }
  roles.sampler = sampler.id;
  roles.positive = refNodeId(sampler.node.inputs.positive);
  roles.negative = refNodeId(sampler.node.inputs.negative);
  roles.latent = refNodeId(sampler.node.inputs.latent_image);
  roles.seedField = samplerSeedField(sampler.node);
  if (!roles.seedField) {
    errors.push(`sampler "${sampler.id}" has no seed socket (seed | noise_seed). FIX: use a standard KSampler/KSamplerAdvanced node.`);
  }

  // Confirm the wired positive/negative are CLIP encodes (shape sanity — still not
  // reading titles: we check the referenced node's class_type family).
  for (const role of ["positive", "negative"]) {
    const id = roles[role];
    if (!id || !graph[id]) {
      errors.push(`sampler.${role} does not point at a node. FIX: wire the ${role} conditioning to a CLIPTextEncode.`);
    } else if (!/CLIPTextEncode|Conditioning/i.test(graph[id].class_type)) {
      errors.push(`sampler.${role} points at "${graph[id].class_type}" (node ${id}), not a CLIP text encode — cannot inject ${role} prompt text. FIX: wire ${role} to a CLIPTextEncode.`);
    }
  }
  if (!roles.latent || !graph[roles.latent]) {
    errors.push("sampler.latent_image does not point at a node. FIX: wire an EmptyLatentImage into latent_image.");
  } else if (!/EmptyLatent/i.test(graph[roles.latent].class_type)) {
    errors.push(`sampler.latent_image points at "${graph[roles.latent].class_type}" — cannot inject width/height. FIX: wire an EmptyLatentImage (width/height inputs).`);
  }

  roles.checkpoint = firstOfClass(graph, /Checkpoint.*Loader|UNETLoader/i);
  if (!roles.checkpoint) {
    errors.push("no checkpoint loader (CheckpointLoaderSimple). FIX: the graph must load a checkpoint.");
  }
  roles.vaeDecode = firstOfClass(graph, /VAE.*Decode/i);
  if (!roles.vaeDecode) {
    errors.push("no VAE decode (VAEDecode). FIX: the sampler's latent must be decoded to pixels.");
  }
  roles.save = firstOfClass(graph, /SaveImage|SaveImageWebsocket/i);
  if (!roles.save) {
    errors.push("no save node (SaveImage). FIX: the decoded image must be saved so the batch can collect it.");
  }
  return { roles, errors };
}

/**
 * Validate a graph. Returns { ok, roles, errors }. ok === errors.length === 0.
 * With { throwOnError: true } throws an Error naming the first fix (the loud
 * rejection the intake spec requires).
 */
export function validateWorkflow(graph, { throwOnError = false } = {}) {
  const { roles, errors } = identifyWorkflowRoles(graph);
  const ok = errors.length === 0;
  if (!ok && throwOnError) {
    const err = new Error(`validateWorkflow: malformed export — ${errors[0]}`);
    err.code = "WORKFLOW_INVALID";
    err.errors = errors;
    throw err;
  }
  return { ok, roles, errors };
}

// ── CLI: a node-id → role table per file ──────────────────────────────────────
const ROLE_ORDER = ["checkpoint", "positive", "negative", "latent", "sampler", "vaeDecode", "save"];

export function roleTable(graph) {
  const { roles, errors, ok } = validateWorkflow(graph);
  const rows = ROLE_ORDER.map((role) => {
    const id = roles[role];
    const cls = id && graph[id] ? graph[id].class_type : "—";
    return `  ${role.padEnd(11)} → node ${String(id ?? "MISSING").padEnd(6)} ${cls}`;
  });
  if (roles.sampler && roles.seedField) rows.push(`  seed field   → ${roles.sampler}.inputs.${roles.seedField}`);
  return { ok, errors, text: rows.join("\n") };
}

function main(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = process.env.NOTDND_ART_WORKFLOW_DIR || path.join(here, "workflows");
  let files = argv.filter((a) => !a.startsWith("-"));
  if (!files.length) {
    files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith("-realistic.json")).map((f) => path.join(dir, f))
      : [];
  }
  if (!files.length) {
    console.error("validateWorkflow: no workflow files given and none found in", dir);
    process.exitCode = 2;
    return;
  }
  let anyBad = false;
  for (const file of files) {
    console.log(`\n=== ${path.basename(file)} ===`);
    let graph;
    try {
      graph = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      console.log(`  PARSE ERROR: ${e.message}`);
      anyBad = true;
      continue;
    }
    const { ok, errors, text } = roleTable(graph);
    console.log(text);
    if (!ok) {
      anyBad = true;
      console.log("  STATUS: INVALID");
      for (const e of errors) console.log(`    - ${e}`);
    } else {
      console.log("  STATUS: OK");
    }
  }
  process.exitCode = anyBad ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
