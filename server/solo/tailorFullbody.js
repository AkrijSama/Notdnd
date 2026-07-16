// TAILOR v2 — server-driven fullbody generation keyed off equipped slots.
//
// Two exports:
//   buildTailorPrompt(...)  — PURE, deterministic prompt-fragment builder. Part of
//                             the truth surface: it renders ONLY what it is handed
//                             and never invents gear. Unit-tested in isolation.
//   tailorFullbody(...)     — the service. Loads committed state, resolves the
//                             keeper portrait as the IP-Adapter face reference,
//                             injects the built prompt into the owner's validated
//                             fullbody-realistic-tailor workflow (preserving every
//                             sampler / IP-Adapter parameter), POSTs to ComfyUI,
//                             and stores the result via the asset-library pattern.
//
// Reuse (not reinvention): the ComfyUI job contract is the exported client from
// scripts/art/generate.mjs; storage is scripts/art/library.mjs. The server already
// imports scripts/art/* (see server/solo/artLibrary.js).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  queuePrompt,
  waitForOutput,
  fetchImageBytes,
  comfyReachable
} from "../../scripts/art/generate.mjs";
import { addAsset, libraryRoot } from "../../scripts/art/library.mjs";
import { getSoloRun } from "../db/repository.js";
import { getEquippedItems } from "./equipment.js";

const COMFY = process.env.COMFY_URL || "http://127.0.0.1:8188";
const WORKFLOW_FILE = "fullbody-realistic-tailor.json";

// The fixed framing wrapped around the subject. Split lead/tail so equipped-item
// fragments sit between the identity and the background, matching the owner's
// export. Joined together these are exactly the brief's framing block.
const FRAMING_LEAD = "solo, full body shot, standing, head to toe, feet visible";
const FRAMING_TAIL = "wide shot, plain dark background";

// The negative prompt is fixed by the brief and never varies.
export const TAILOR_NEGATIVE =
  "close-up, portrait, upper body, cropped, out of frame, multiple views, extra heads, text, watermark";

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// The visual contribution of one committed item: its explicit `visual` field when
// present, else its name. NEVER a fabricated description — only committed data.
function itemFragment(item) {
  if (isNonEmptyString(item?.visual)) return item.visual.trim();
  if (isNonEmptyString(item?.name)) return item.name.trim();
  return null;
}

// PURE, deterministic prompt builder.
//   identity      — { fragments: string[] } base identity/appearance descriptors
//                   (the caller resolves these from committed player fields). Empty
//                   slots contribute nothing, so an empty equipped list still yields
//                   a valid prompt from identity + framing alone.
//   equippedItems — committed item objects, in slot order. Each contributes exactly
//                   one fragment (visual ?? name); unequipped/carried items are
//                   simply not in this list and therefore never appear.
// Returns { positive, negative } with a fixed negative.
export function buildTailorPrompt({ identity = {}, equippedItems = [] } = {}) {
  const identityFragments = Array.isArray(identity.fragments)
    ? identity.fragments.filter(isNonEmptyString).map((f) => f.trim())
    : [];
  const itemFragments = (Array.isArray(equippedItems) ? equippedItems : [])
    .map(itemFragment)
    .filter(isNonEmptyString);

  const positive = [FRAMING_LEAD, ...identityFragments, ...itemFragments, FRAMING_TAIL].join(", ");
  return { positive, negative: TAILOR_NEGATIVE };
}

// Resolve the base identity descriptor fragments from the committed player. Uses
// the same coarse identity fields the portrait pipeline consumes (pronouns, race)
// plus a neutral base-clothing default so empty equipment slots still read as
// clothed. Deterministic and free of invented physical traits.
function personWordFromPronouns(pronouns) {
  const p = String(pronouns || "").toLowerCase();
  if (p.includes("she")) return "woman";
  if (p.includes("he")) return "man";
  return "person";
}

export function resolveIdentityFragments(run) {
  const player = isPlainObject(run?.player) ? run.player : {};
  const fragments = [];
  fragments.push(personWordFromPronouns(player.pronouns));
  if (isNonEmptyString(player.race)) fragments.push(player.race.toLowerCase());
  // Base clothing — remains when no armor/attire item is equipped (brief: empty
  // slots contribute nothing, base clothing words remain).
  fragments.push("simple traveling clothes");
  return { fragments };
}

// --- workflow loading + injection ------------------------------------------
function workflowDir() {
  if (process.env.NOTDND_ART_WORKFLOW_DIR) {
    return path.resolve(process.env.NOTDND_ART_WORKFLOW_DIR);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../scripts/art/workflows");
}

function loadTailorWorkflow(deps) {
  if (typeof deps.loadWorkflow === "function") return deps.loadWorkflow();
  const file = path.join(workflowDir(), WORKFLOW_FILE);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Resolve the four injection roles by GRAPH SHAPE (not by hard-coded node ids), so
// a re-export that renumbers nodes still injects correctly. Returns node ids or
// throws a typed marker if a required role is absent.
function resolveInjectionNodes(graph) {
  const entries = Object.entries(graph);
  const sampler = entries.find(([, n]) => /KSampler/.test(n?.class_type || ""));
  if (!sampler) throw new TailorError("workflow_invalid", "no KSampler node in tailor workflow");
  const positive = sampler[1].inputs?.positive?.[0];
  const negative = sampler[1].inputs?.negative?.[0];
  const loadImage = entries.find(([, n]) => n?.class_type === "LoadImage");
  const latent = entries.find(([, n]) => n?.class_type === "EmptyLatentImage");
  if (!positive || !graph[positive]) throw new TailorError("workflow_invalid", "no positive CLIP node");
  if (!negative || !graph[negative]) throw new TailorError("workflow_invalid", "no negative CLIP node");
  if (!loadImage) throw new TailorError("workflow_invalid", "no LoadImage (face reference) node");
  if (!latent) throw new TailorError("workflow_invalid", "no EmptyLatentImage node");
  return { positive, negative, loadImage: loadImage[0], latent: latent[0] };
}

// Inject prompt + face reference + batch-of-1 into a DEEP COPY of the graph. Every
// other node — the KSamplerAdvanced (steps/cfg/sampler/scheduler/seed), the
// LoraLoader, and the IPAdapterUnifiedLoader / IPAdapterAdvanced (weight,
// weight_type, start_at, end_at, embeds_scaling) — is preserved verbatim.
export function injectTailorWorkflow(graph, { positive, negative, imageName }) {
  const clone = JSON.parse(JSON.stringify(graph));
  const nodes = resolveInjectionNodes(clone);
  clone[nodes.positive].inputs.text = positive;
  clone[nodes.negative].inputs.text = negative;
  clone[nodes.loadImage].inputs.image = imageName;
  clone[nodes.latent].inputs.batch_size = 1; // batch forced to 1
  return clone;
}

// --- portrait → ComfyUI image name -----------------------------------------
// The IP-Adapter LoadImage node needs a filename resolvable in ComfyUI's input
// dir. A bare filename is used as-is; a data: URI or file path is read and uploaded
// via the client. Returns the ComfyUI-side image name.
async function resolvePortraitImageName(run, comfy) {
  const uri = run?.player?.portraitUri;
  if (!isNonEmptyString(uri)) {
    throw new TailorError("no_portrait", "character has no committed portraitUri to use as a face reference");
  }
  const looksLikeBareName = !uri.includes("://") && !uri.startsWith("data:") && !uri.includes("/");
  if (looksLikeBareName) return uri;

  let bytes = null;
  if (uri.startsWith("data:")) {
    const comma = uri.indexOf(",");
    bytes = Buffer.from(uri.slice(comma + 1), "base64");
  } else if (uri.startsWith("file://") || uri.startsWith("/")) {
    bytes = fs.readFileSync(uri.replace(/^file:\/\//, ""));
  } else {
    // A remote/relative URL we cannot upload deterministically — refuse rather
    // than guess (server owns truth).
    throw new TailorError("no_portrait", `unsupported portraitUri form for face reference: ${uri.slice(0, 40)}`);
  }
  if (typeof comfy.uploadImage !== "function") {
    throw new TailorError("comfy_unreachable", "comfy client cannot upload the portrait face reference");
  }
  return comfy.uploadImage(bytes, `tailor_face_${run.runId}.png`);
}

async function defaultUploadImage(bytes, filename) {
  const form = new FormData();
  form.append("image", new Blob([bytes]), filename);
  form.append("overwrite", "true");
  const res = await fetch(`${COMFY}/upload/image`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`comfy /upload/image ${res.status}`);
  const out = await res.json();
  return out.name || filename;
}

const defaultComfy = {
  queuePrompt,
  waitForOutput,
  fetchImageBytes,
  reachable: comfyReachable,
  uploadImage: defaultUploadImage
};

// Default asset writer — mirrors scripts/art/generate.mjs: <id>.png in the library
// root + a sidecar via addAsset (Law-5 origin/creator fields).
function defaultStore({ id, bytes, positive, identityRef, world, style }) {
  const pngPath = path.join(libraryRoot(), `${id}.png`);
  fs.writeFileSync(pngPath, bytes);
  const sidecar = addAsset({
    id,
    origin: "generated",
    creator: null,
    world: world ?? null,
    style: style || "realistic",
    kind: "fullbody",
    tags: ["tailor", "fullbody"],
    identityRef: identityRef ?? null,
    workflow: WORKFLOW_FILE,
    promptUsed: positive
  });
  return { pngPath, sidecar };
}

class TailorError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

// tailorFullbody(characterId) — characterId is the runId whose committed player is
// the character (the 5e sheet lives on run.player; equipped slots on run.equipment).
//
// deps (all injectable for tests): getRun, comfy, store, loadWorkflow,
// onBeforeGenerate (the PRICING HOOK — a single pre-generation seam, no-op stub
// today), timeoutMs, world, style, identityRef.
//
// Returns { ok:true, assetId, pngPath, positive, negative, promptId, ms } or a
// typed { ok:false, error:{ code, message } }. Never throws for operational
// failures (ComfyUI down / timeout / missing portrait) — those are typed results.
// Typed error codes: run_not_found, no_portrait, comfy_unreachable,
// workflow_invalid, generation_failed.
export async function tailorFullbody(characterId, deps = {}) {
  const started = Date.now();
  const getRun = deps.getRun || getSoloRun;
  const comfy = deps.comfy || defaultComfy;
  const store = deps.store || defaultStore;

  const run = getRun(characterId);
  if (!isPlainObject(run)) {
    return fail("run_not_found", `no committed run/character "${characterId}"`);
  }

  const equippedItems = getEquippedItems(run);
  const identity = resolveIdentityFragments(run);
  const { positive, negative } = buildTailorPrompt({ identity, equippedItems });

  // PRICING HOOK (stub seam): Ink pricing attaches here, pre-generation. Charging
  // is intentionally NOT implemented (economy confirms pending owner decision). A
  // hook that returns { ok:false } aborts before any GPU work.
  if (typeof deps.onBeforeGenerate === "function") {
    const gate = await deps.onBeforeGenerate({
      characterId,
      runId: run.runId,
      positive,
      negative,
      equippedCount: equippedItems.length
    });
    if (gate && gate.ok === false) {
      return fail(gate.code || "pricing_declined", gate.message || "pre-generation hook declined");
    }
  }

  try {
    if (typeof comfy.reachable === "function" && !(await comfy.reachable())) {
      return fail("comfy_unreachable", `ComfyUI not reachable at ${COMFY}`);
    }
    const graph = loadTailorWorkflow(deps);
    const imageName = await resolvePortraitImageName(run, comfy);
    const injected = injectTailorWorkflow(graph, { positive, negative, imageName });

    const promptId = await comfy.queuePrompt(injected, `tailor-${run.runId}`);
    const image = await comfy.waitForOutput(promptId, { timeoutMs: deps.timeoutMs ?? 180000 });
    const bytes = await comfy.fetchImageBytes(image);

    const assetId = `fullbody_${run.runId}`;
    const { pngPath } = store({
      id: assetId,
      bytes,
      positive,
      identityRef: deps.identityRef ?? run.player?.portraitAssetId ?? null,
      world: deps.world ?? run.world?.slug ?? run.world?.name ?? null,
      style: deps.style
    });

    return { ok: true, assetId, pngPath, positive, negative, promptId, ms: Date.now() - started };
  } catch (err) {
    if (err instanceof TailorError) {
      return fail(err.code, err.message);
    }
    return fail("generation_failed", String(err?.message || err));
  }
}
