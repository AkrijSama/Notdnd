import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NOTDND_MOCK_IMAGE = "false";

const { comfyuiImage, comfyuiWorkflowForStyle, comfyuiBaseUrl, checkpointForStyle } = await import("../server/ai/comfyui.js");
const { generateImage } = await import("../server/ai/providers.js");

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

// A minimal in-process ComfyUI: POST /prompt queues, /history flips to done on
// the second poll, /view serves bytes. Same endpoints and shapes as the real
// thing, so the adapter is exercised over its actual wire protocol.
function startStubComfyui({ failWorkflow = false } = {}) {
  let polls = 0;
  let lastQueuedWorkflow = null;
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/prompt") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        lastQueuedWorkflow = JSON.parse(body);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ prompt_id: "stub-prompt-1", number: 1, node_errors: {} }));
      });
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/history/")) {
      polls += 1;
      res.setHeader("content-type", "application/json");
      if (failWorkflow) {
        res.end(JSON.stringify({
          "stub-prompt-1": { status: { status_str: "error", messages: [["execution_error", { node_type: "CheckpointLoaderSimple" }]] }, outputs: {} }
        }));
        return;
      }
      if (polls < 2) {
        res.end(JSON.stringify({}));
        return;
      }
      res.end(JSON.stringify({
        "stub-prompt-1": {
          status: { status_str: "success" },
          outputs: { "9": { images: [{ filename: "inkborne_00001_.png", subfolder: "", type: "output" }] } }
        }
      }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/view")) {
      res.setHeader("content-type", "image/png");
      res.end(PNG_BYTES);
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}`,
        getLastWorkflow: () => lastQueuedWorkflow
      });
    });
  });
}

// ── 3-STYLE TOGGLE: the locked art style selects the workflow ────────────────
test("each locked art style derives its checkpoint from its validated export, not a hardcoded table", () => {
  const saved = process.env.NOTDND_COMFYUI_CHECKPOINT;
  delete process.env.NOTDND_COMFYUI_CHECKPOINT;
  try {
    for (const s of ["illustrated", "anime", "cinematic"]) {
      const r = comfyuiWorkflowForStyle(s, { prompt: "a ruined chapel" });
      assert.equal(r.styleKey, s, `styleKey stays ${s}`);
      // SINGLE SOURCE OF TRUTH: the live checkpoint equals the style's export
      // checkpoint (checkpointForStyle), never a parallel preset table.
      assert.equal(r.checkpoint, checkpointForStyle(s), `${s} checkpoint comes from the export`);
    }
    // The Chunk-6 switch specifically: anime serves JANKU, never retired Illustrious
    // (the 2026-07-18 drift). Exhaustive per-lane coverage: comfyui-checkpoint-drift.
    assert.match(comfyuiWorkflowForStyle("anime", { prompt: "x" }).checkpoint, /JANKU/);
    assert.doesNotMatch(comfyuiWorkflowForStyle("anime", { prompt: "x" }).checkpoint, /Illustrious/);
    const fallback = comfyuiWorkflowForStyle("watercolor-nonsense", { prompt: "x" });
    assert.equal(fallback.styleKey, "illustrated", "unknown style falls back to illustrated");
  } finally {
    if (saved === undefined) delete process.env.NOTDND_COMFYUI_CHECKPOINT;
    else process.env.NOTDND_COMFYUI_CHECKPOINT = saved;
  }
});

test("the workflow graph carries prompt/seed/dimensions and per-style checkpoint env override wins", () => {
  process.env.NOTDND_COMFYUI_CHECKPOINT_ANIME = "my-local-anime.safetensors";
  try {
    const { workflow, checkpoint } = comfyuiWorkflowForStyle("anime", {
      prompt: "hollow pine at dusk",
      seed: 42,
      width: 896,
      height: 512
    });
    assert.equal(checkpoint, "my-local-anime.safetensors", "env checkpoint override wins");
    assert.equal(workflow["4"].inputs.ckpt_name, "my-local-anime.safetensors");
    assert.match(workflow["6"].inputs.text, /hollow pine at dusk/, "positive prompt lands in CLIP encode");
    // Sealed anime-lane law: JANKU booru quality register leads the anime positive (v4, 2026-07-19).
    assert.match(workflow["6"].inputs.text, /masterpiece, best quality/, "anime booru quality vocab present");
    assert.ok(workflow["7"].inputs.text.length > 0, "style negative present");
    assert.equal(workflow["3"].inputs.seed, 42);
    assert.equal(workflow["5"].inputs.width, 896);
    assert.equal(workflow["5"].inputs.height, 512);
  } finally {
    delete process.env.NOTDND_COMFYUI_CHECKPOINT_ANIME;
  }
});

test("an external workflow JSON (env-pointed) is instantiated with typed token substitution", () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "comfy-wf-")), "cine.json");
  fs.writeFileSync(tmp, JSON.stringify({
    "1": { class_type: "KSampler", inputs: { seed: "__SEED__", text: "epic shot of __PROMPT__" } },
    "2": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "__CHECKPOINT__" } },
    "3": { class_type: "EmptyLatentImage", inputs: { width: "__WIDTH__", height: "__HEIGHT__" } }
  }));
  process.env.NOTDND_COMFYUI_WORKFLOW_CINEMATIC = tmp;
  try {
    const { workflow } = comfyuiWorkflowForStyle("cinematic", { prompt: "the fringe", seed: 7, width: 640, height: 360 });
    assert.equal(workflow["1"].inputs.seed, 7, "exact-token string becomes a NUMBER");
    assert.equal(workflow["1"].inputs.text, "epic shot of the fringe", "embedded token spliced into text");
    assert.equal(workflow["3"].inputs.width, 640);
    assert.ok(String(workflow["2"].inputs.ckpt_name).endsWith(".safetensors"));
  } finally {
    delete process.env.NOTDND_COMFYUI_WORKFLOW_CINEMATIC;
  }
});

test("a configured-but-unreadable workflow file fails LOUDLY (misconfiguration, not silent wrong art)", () => {
  process.env.NOTDND_COMFYUI_WORKFLOW_ANIME = "/nonexistent/anime.json";
  try {
    assert.throws(() => comfyuiWorkflowForStyle("anime", { prompt: "x" }), /unreadable/);
  } finally {
    delete process.env.NOTDND_COMFYUI_WORKFLOW_ANIME;
  }
});

// ── PROTOCOL: queue → poll → download against a real HTTP stub ───────────────
test("comfyuiImage speaks the ComfyUI API end to end and returns provider bytes", async () => {
  const stub = await startStubComfyui();
  process.env.NOTDND_COMFYUI_URL = stub.url;
  try {
    const result = await comfyuiImage({ prompt: "hollow pine palisade", style: "illustrated", seed: 5 });
    assert.equal(result.provider, "comfyui");
    assert.equal(result.mock, false);
    assert.ok(Buffer.isBuffer(result.bytes) && result.bytes.length > 0, "real bytes returned");
    assert.ok(result.url.includes("/view?"), "url points at the ComfyUI view endpoint");
    const queued = stub.getLastWorkflow();
    assert.equal(queued.client_id, "inkborne");
    assert.equal(queued.prompt["6"].inputs.text, "hollow pine palisade", "the queued graph carries the prompt");
  } finally {
    delete process.env.NOTDND_COMFYUI_URL;
    stub.server.close();
  }
});

test("a workflow that errors server-side surfaces as a coded provider error", async () => {
  const stub = await startStubComfyui({ failWorkflow: true });
  process.env.NOTDND_COMFYUI_URL = stub.url;
  try {
    await assert.rejects(
      () => comfyuiImage({ prompt: "x", style: "anime" }),
      /workflow errored/
    );
  } finally {
    delete process.env.NOTDND_COMFYUI_URL;
    stub.server.close();
  }
});

// ── GRACEFUL DEGRADATION: ComfyUI down → the existing chain serves ────────────
test("with ComfyUI unreachable, generateImage falls back to the provider chain (no hang)", async () => {
  process.env.NOTDND_COMFYUI_URL = "http://127.0.0.1:1"; // nothing listens here
  process.env.NOTDND_COMFYUI_CONNECT_TIMEOUT_MS = "800";
  try {
    const started = Date.now();
    const result = await generateImage({
      provider: "comfyui",
      prompt: "fallback proof",
      style: "cinematic",
      retryDelayMs: 0,
      providerPriority: ["pollinations"],
      // Route the pollinations lane to a stub success; comfyui's own fetch will
      // fail on the refused socket before this is ever consulted for it.
      fetchImpl: async (url) => {
        if (String(url).includes("pollinations")) {
          return { ok: true, arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength) };
        }
        throw new Error("connect ECONNREFUSED");
      }
    });
    assert.equal(result.provider, "pollinations", "the chain served the image");
    assert.ok(result.bytes.length > 0);
    assert.ok(Date.now() - started < 10000, "fallback happened fast — no hung turn");
  } finally {
    delete process.env.NOTDND_COMFYUI_URL;
    delete process.env.NOTDND_COMFYUI_CONNECT_TIMEOUT_MS;
  }
});
