import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildTailorPrompt,
  injectTailorWorkflow,
  tailorFullbody,
  TAILOR_NEGATIVE
} from "../server/solo/tailorFullbody.js";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { equipItem } from "../server/solo/equipment.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_WORKFLOW = JSON.parse(
  fs.readFileSync(path.resolve(HERE, "../scripts/art/workflows/fullbody-realistic-tailor.json"), "utf8")
);

// ---- PURE FRAGMENT BUILDER -------------------------------------------------

test("builder emits the fixed framing and negative", () => {
  const { positive, negative } = buildTailorPrompt({ identity: { fragments: ["woman"] }, equippedItems: [] });
  assert.equal(negative, TAILOR_NEGATIVE);
  assert.ok(positive.startsWith("solo, full body shot, standing, head to toe, feet visible"));
  assert.ok(positive.endsWith("wide shot, plain dark background"));
});

test("empty equipment → base identity/clothing survives, no gear fragments", () => {
  const { positive } = buildTailorPrompt({
    identity: { fragments: ["woman", "human", "simple traveling clothes"] },
    equippedItems: []
  });
  assert.ok(positive.includes("simple traveling clothes"));
  assert.equal(positive.includes("sword"), false);
});

test("equipped items contribute one fragment each, preferring visual over name", () => {
  const { positive } = buildTailorPrompt({
    identity: { fragments: ["woman"] },
    equippedItems: [
      { name: "Iron Sword", visual: "a plain iron longsword at the hip" },
      { name: "Leather Armor" } // no visual → falls back to name
    ]
  });
  assert.ok(positive.includes("a plain iron longsword at the hip"));
  assert.ok(positive.includes("Leather Armor"));
});

test("builder NEVER invents gear — only committed fragments appear", () => {
  const { positive } = buildTailorPrompt({
    identity: { fragments: ["woman"] },
    equippedItems: [{ name: "Iron Sword", visual: "a plain iron longsword at the hip" }]
  });
  // Exactly: framing lead, identity, one item, framing tail.
  assert.deepEqual(positive.split(", "), [
    "solo",
    "full body shot",
    "standing",
    "head to toe",
    "feet visible",
    "woman",
    "a plain iron longsword at the hip",
    "wide shot",
    "plain dark background"
  ]);
});

test("builder is deterministic — same input, byte-identical output", () => {
  const input = {
    identity: { fragments: ["man", "elf"] },
    equippedItems: [{ name: "Bow", visual: "a yew longbow slung across the back" }]
  };
  assert.equal(buildTailorPrompt(input).positive, buildTailorPrompt(input).positive);
});

test("items with neither visual nor name contribute nothing", () => {
  const { positive } = buildTailorPrompt({
    identity: { fragments: ["woman"] },
    equippedItems: [{ slot: "accessory" }, { visual: "  " }]
  });
  assert.deepEqual(positive.split(", "), [
    "solo", "full body shot", "standing", "head to toe", "feet visible",
    "woman", "wide shot", "plain dark background"
  ]);
});

// ---- WORKFLOW INJECTION (real owner export) --------------------------------

test("injection hits the real workflow's prompt/face/latent nodes and preserves IP-Adapter params", () => {
  const injected = injectTailorWorkflow(REAL_WORKFLOW, {
    positive: "POS_TEXT",
    negative: "NEG_TEXT",
    imageName: "face_ref.png"
  });
  // Positive (node 6), negative (node 7), LoadImage (node 21), batch=1 (node 5).
  assert.equal(injected["6"].inputs.text, "POS_TEXT");
  assert.equal(injected["7"].inputs.text, "NEG_TEXT");
  assert.equal(injected["21"].inputs.image, "face_ref.png");
  assert.equal(injected["5"].inputs.batch_size, 1);

  // Sampler + IP-Adapter parameters preserved verbatim.
  assert.equal(injected["10"].inputs.steps, 26);
  assert.equal(injected["10"].inputs.cfg, 5.2);
  assert.equal(injected["10"].inputs.sampler_name, "euler_ancestral");
  assert.equal(injected["23"].inputs.weight, 0.8);
  assert.equal(injected["23"].inputs.weight_type, "linear");
  assert.equal(injected["23"].inputs.start_at, 0);
  assert.equal(injected["23"].inputs.end_at, 0.15);
  assert.equal(injected["22"].inputs.preset, "PLUS FACE (portraits)");

  // The source graph is untouched (deep-copied).
  assert.notEqual(REAL_WORKFLOW["6"].inputs.text, "POS_TEXT");
  assert.equal(REAL_WORKFLOW["5"].inputs.batch_size, 4);
});

// ---- SERVICE with ComfyUI MOCKED -------------------------------------------

function characterRun() {
  const run = createDefaultSoloRun({ runId: "run_tailor" });
  run.player.pronouns = "she/her";
  run.player.race = "Human";
  run.player.portraitUri = "keeper_face.png"; // bare filename → used as-is, no upload
  run.inventory.iron_sword = {
    itemId: "iron_sword", name: "Iron Sword", visual: "a plain iron longsword at the hip",
    slot: "weapon", quantity: 1, tags: [], flags: {}
  };
  equipItem(run, "iron_sword");
  return run;
}

function stubComfy(overrides = {}) {
  const calls = { queued: null };
  return {
    calls,
    reachable: async () => true,
    queuePrompt: async (graph) => { calls.queued = graph; return "prompt_stub_1"; },
    waitForOutput: async () => ({ filename: "out_00001_.png", subfolder: "", type: "output" }),
    fetchImageBytes: async () => Buffer.from("PNG", "utf8"),
    uploadImage: async () => "uploaded_face.png",
    ...overrides
  };
}

test("tailorFullbody generates from equipped state and stores a fullbody asset (ComfyUI mocked)", async () => {
  const run = characterRun();
  const comfy = stubComfy();
  const stored = [];
  const result = await tailorFullbody(run.runId, {
    getRun: () => run,
    comfy,
    store: (rec) => { stored.push(rec); return { pngPath: `/tmp/${rec.id}.png` }; }
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.assetId, "fullbody_run_tailor");
  // The equipped sword made it into the queued graph's positive node (node 6).
  assert.ok(comfy.calls.queued["6"].inputs.text.includes("a plain iron longsword at the hip"));
  assert.equal(comfy.calls.queued["5"].inputs.batch_size, 1);
  assert.equal(comfy.calls.queued["21"].inputs.image, "keeper_face.png");
  // Stored via the library pattern with economy fields.
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, "fullbody_run_tailor");
  assert.equal(stored[0].positive, result.positive);
});

test("carried-but-unequipped gear never reaches the render", async () => {
  const run = characterRun();
  run.inventory.hidden_dagger = {
    itemId: "hidden_dagger", name: "Hidden Dagger", visual: "a concealed dagger",
    slot: "weapon", quantity: 1, tags: [], flags: {}
  }; // carried, NOT equipped
  const comfy = stubComfy();
  await tailorFullbody(run.runId, { getRun: () => run, comfy, store: () => ({ pngPath: "x" }) });
  assert.equal(comfy.calls.queued["6"].inputs.text.includes("concealed dagger"), false);
});

test("ComfyUI unreachable → typed error, no throw, no store", async () => {
  const run = characterRun();
  let stored = false;
  const result = await tailorFullbody(run.runId, {
    getRun: () => run,
    comfy: stubComfy({ reachable: async () => false }),
    store: () => { stored = true; return { pngPath: "x" }; }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "comfy_unreachable");
  assert.equal(stored, false);
});

test("missing committed portrait → typed no_portrait error", async () => {
  const run = characterRun();
  delete run.player.portraitUri;
  const result = await tailorFullbody(run.runId, {
    getRun: () => run,
    comfy: stubComfy(),
    store: () => ({ pngPath: "x" })
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "no_portrait");
});

test("unknown character id → typed run_not_found", async () => {
  const result = await tailorFullbody("nope", { getRun: () => null, comfy: stubComfy() });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "run_not_found");
});

test("pricing hook runs pre-generation and can abort before any GPU work", async () => {
  const run = characterRun();
  const comfy = stubComfy();
  const result = await tailorFullbody(run.runId, {
    getRun: () => run,
    comfy,
    store: () => ({ pngPath: "x" }),
    onBeforeGenerate: async (ctx) => {
      assert.equal(ctx.runId, "run_tailor");
      assert.equal(ctx.equippedCount, 1);
      return { ok: false, code: "insufficient_ink", message: "not enough ink" };
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "insufficient_ink");
  assert.equal(comfy.calls.queued, null, "no workflow queued when the hook declines");
});
