import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NOTDND_MOCK_IMAGE = "false";

const { comfyuiImage, comfyuiWorkflowForStyle, comfyuiBaseUrl } = await import("../server/ai/comfyui.js");
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
test("each locked art style maps to an installed checkpoint per the 2-model rig; unknown falls back to illustrated", () => {
  delete process.env.NOTDND_COMFYUI_CHECKPOINT;
  const byStyle = Object.fromEntries(
    ["illustrated", "anime", "cinematic"].map((s) => [s, comfyuiWorkflowForStyle(s, { prompt: "a ruined chapel" })])
  );
  // Style keys stay distinct (routing is per-style)...
  assert.equal(byStyle.illustrated.styleKey, "illustrated");
  assert.equal(byStyle.anime.styleKey, "anime");
  assert.equal(byStyle.cinematic.styleKey, "cinematic");
  // ...but on the local 8GB rig only two SDXL checkpoints are installed, so the
  // three styles fold onto them: Juggernaut XI = illustrated + cinematic,
  // Illustrious XL = anime (director-set map).
  assert.equal(byStyle.illustrated.checkpoint, "Juggernaut-XI-byRunDiffusion.safetensors");
  assert.equal(byStyle.cinematic.checkpoint, "Juggernaut-XI-byRunDiffusion.safetensors");
  assert.equal(byStyle.anime.checkpoint, "Illustrious-XL-v2.0.safetensors");
  assert.equal(
    new Set(Object.values(byStyle).map((r) => r.checkpoint)).size,
    2,
    "three styles fold onto the two installed checkpoints"
  );
  const fallback = comfyuiWorkflowForStyle("watercolor-nonsense", { prompt: "x" });
  assert.equal(fallback.styleKey, "illustrated", "unknown style falls back to illustrated");
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
    // Sealed anime-lane law: JANKU quality vocab leads the anime positive (2026-07-18).
    assert.match(workflow["6"].inputs.text, /amazing quality/, "anime quality vocab present");
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
