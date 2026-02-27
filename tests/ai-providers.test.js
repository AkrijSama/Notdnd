import assert from "node:assert/strict";
import test from "node:test";
import { generateWithProvider, listAiProviders } from "../server/ai/providers.js";

test("provider catalog exposes requested agent providers", () => {
  const providers = listAiProviders();
  const keys = providers.map((entry) => entry.key);
  assert.ok(keys.includes("chatgpt"));
  assert.ok(keys.includes("grok"));
  assert.ok(keys.includes("gemini"));
  assert.ok(keys.includes("local"));
  const chatgpt = providers.find((entry) => entry.key === "chatgpt");
  assert.ok(chatgpt.endpoint);
  assert.notEqual(chatgpt.status, "missing-endpoint");
});

test("remote provider surfaces bad api key errors explicitly", async () => {
  await assert.rejects(
    () =>
      generateWithProvider({
        provider: "chatgpt",
        type: "gm",
        prompt: "hello",
        model: "gpt-5-mini",
        configOverride: {
          apiKey: "bad-key",
          endpoint: "https://example.com/responses"
        },
        fetchImpl: async () => ({
          ok: false,
          status: 401,
          async text() {
            return JSON.stringify({ error: { message: "Incorrect API key provided" } });
          }
        })
      }),
    (error) => {
      assert.equal(error.code, "BAD_API_KEY");
      assert.match(String(error.message || ""), /API key rejected/i);
      return true;
    }
  );
});
