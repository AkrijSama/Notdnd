// DEBUG PANEL — the IMAGE line must show the LIVE worker state so a working cook
// (~40-70s on the local GPU) never reads as "none rendered yet" (the 2026-07-19 redo
// confusion: the job WAS enqueued + rendered; only the panel looked dead).
import assert from "node:assert/strict";
import test from "node:test";
import { renderBody } from "../src/components/debugPanel.js";

const base = {
  build: { sha: "abc1234", branch: "main", nodeEnv: "development" },
  gm: { configuredModel: "deepseek/deepseek-v4-flash", served: null },
  cloudChain: "openrouter → gemini"
};
const img = (image) => renderBody({ ...base, image });

test("nothing served + worker cooking → 'cooking…', NOT 'none rendered yet'", () => {
  const html = img({ configuredProvider: "comfyui", served: null, worker: { processing: true, queueDepth: 0, wedged: false } });
  assert.match(html, /cooking…/);
  assert.doesNotMatch(html, /none rendered yet/);
});

test("nothing served + idle worker → 'none rendered yet' (honest)", () => {
  const html = img({ configuredProvider: "comfyui", served: null, worker: { processing: false, queueDepth: 0, wedged: false } });
  assert.match(html, /none rendered yet/);
});

test("a served image + a NEW cook in flight shows both the last render AND 'cooking…'", () => {
  const html = img({
    configuredProvider: "comfyui",
    served: { provider: "comfyui", checkpoint: "JANKU.safetensors", at: new Date(Date.now() - 5000).toISOString(), mock: false },
    worker: { processing: true, queueDepth: 1, wedged: false }
  });
  assert.match(html, /JANKU\.safetensors/, "last render still shown");
  assert.match(html, /cooking…/, "the in-flight redo is visible over the prior image");
  assert.match(html, /\+1 queued/);
});

test("a wedged worker shows LOUD, distinct from cooking", () => {
  const html = img({ configuredProvider: "comfyui", served: null, worker: { processing: true, queueDepth: 0, wedged: true, stuckMs: 210000 } });
  assert.match(html, /WEDGED/);
  assert.match(html, /dbg-warn/, "wedged uses the warning class");
  assert.doesNotMatch(html, /none rendered yet/);
});

test("idle worker with a queued backlog shows the queue depth", () => {
  const html = img({ configuredProvider: "comfyui", served: null, worker: { processing: false, queueDepth: 3, wedged: false } });
  assert.match(html, /queued: 3/);
});
