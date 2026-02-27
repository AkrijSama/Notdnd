import assert from "node:assert/strict";
import test from "node:test";
import { fetchHomebrewUrl, validateImportUrl } from "../server/homebrew/urlImport.js";

test("validateImportUrl accepts http/https", () => {
  const parsed = validateImportUrl("https://example.com/homebrew.md");
  assert.equal(parsed.hostname, "example.com");
});

test("validateImportUrl rejects non-http protocols", () => {
  assert.throws(() => validateImportUrl("file:///tmp/a.md"), /Only http and https/);
});

test("fetchHomebrewUrl returns normalized import payload", async () => {
  const response = await fetchHomebrewUrl("https://example.com/book.md", {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: {
        get(name) {
          if (String(name).toLowerCase() === "content-type") {
            return "text/markdown";
          }
          return null;
        }
      },
      async text() {
        return "# Book\nMonster: Arc Drake";
      }
    })
  });

  assert.equal(response.file.name, "book.md");
  assert.match(response.file.content, /Arc Drake/);
});
