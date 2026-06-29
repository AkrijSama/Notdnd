import assert from "node:assert/strict";
import test from "node:test";
import { resolveGmProvider } from "../server/ai/openrouter.js";

// resolveGmProvider is CALL-TIME (reads process.env on each call), so these
// tests set env then call — proving edition routing without any network.
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const CLOUD_ENV = {
  INKBORNE_LLM_BASE_URL: "https://cloud.example/v1/chat/completions",
  NOTDND_LLM_BASE_URL: undefined,
  INKBORNE_GM_MODEL: "cloud/narrative-model",
  NOTDND_GM_MODEL: undefined,
  INKBORNE_LLM_API_KEY: "sk-test-cloud-key",
  NOTDND_LLM_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
  INKBORNE_FORBIDDEN_LLM_BASE_URL: "http://127.0.0.1:11434/v1/chat/completions",
  NOTDND_FORBIDDEN_LLM_BASE_URL: undefined,
  INKBORNE_FORBIDDEN_LLM_MODEL: "dolphin-llama3:8b",
  NOTDND_FORBIDDEN_LLM_MODEL: undefined
};

test("gm-provider routing", async (t) => {
  await t.test("mainline -> cloud (unchanged config), with a key, not local", () => {
    withEnv(CLOUD_ENV, () => {
      const p = resolveGmProvider("mainline");
      assert.equal(p.local, false);
      assert.equal(p.baseUrl, "https://cloud.example/v1/chat/completions");
      assert.equal(p.model, "cloud/narrative-model");
      assert.equal(p.key, "sk-test-cloud-key");
      assert.equal(p.edition, "mainline");
    });
  });

  await t.test("default edition is mainline cloud", () => {
    withEnv(CLOUD_ENV, () => {
      const p = resolveGmProvider();
      assert.equal(p.local, false);
      assert.equal(p.baseUrl, "https://cloud.example/v1/chat/completions");
    });
  });

  await t.test("forbidden -> local Ollama, no key", () => {
    withEnv(CLOUD_ENV, () => {
      const p = resolveGmProvider("forbidden");
      assert.equal(p.local, true);
      assert.equal(p.baseUrl, "http://127.0.0.1:11434/v1/chat/completions");
      assert.equal(p.model, "dolphin-llama3:8b");
      assert.equal(p.key, null);
      assert.equal(p.edition, "forbidden");
    });
  });

  await t.test("fallback flag forces local even for mainline (cloud->local recovery)", () => {
    withEnv(CLOUD_ENV, () => {
      const p = resolveGmProvider("mainline", { fallback: true });
      assert.equal(p.local, true);
      assert.equal(p.baseUrl, "http://127.0.0.1:11434/v1/chat/completions");
      assert.equal(p.model, "dolphin-llama3:8b");
      assert.equal(p.key, null);
    });
  });

  await t.test("forbidden base/model are env-overridable at call time", () => {
    withEnv(
      { ...CLOUD_ENV, INKBORNE_FORBIDDEN_LLM_BASE_URL: "http://gpu-box:11434/v1/chat/completions", INKBORNE_FORBIDDEN_LLM_MODEL: "hermes3:8b" },
      () => {
        const p = resolveGmProvider("forbidden");
        assert.equal(p.baseUrl, "http://gpu-box:11434/v1/chat/completions");
        assert.equal(p.model, "hermes3:8b");
      }
    );
  });

  await t.test("forbidden falls back to built-in local defaults when env unset", () => {
    withEnv(
      { ...CLOUD_ENV, INKBORNE_FORBIDDEN_LLM_BASE_URL: undefined, INKBORNE_FORBIDDEN_LLM_MODEL: undefined },
      () => {
        const p = resolveGmProvider("forbidden");
        assert.equal(p.baseUrl, "http://127.0.0.1:11434/v1/chat/completions");
        assert.equal(p.model, "dolphin-llama3:8b");
        assert.equal(p.local, true);
      }
    );
  });

  await t.test("edition is case-insensitive / trimmed", () => {
    withEnv(CLOUD_ENV, () => {
      assert.equal(resolveGmProvider("  FORBIDDEN ").local, true);
      assert.equal(resolveGmProvider("Mainline").local, false);
    });
  });
});
