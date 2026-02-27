import assert from "node:assert/strict";
import test from "node:test";
import { parseHomebrewDocuments } from "../server/homebrew/parser.js";
import { loadFixturesFromManifest } from "./helpers/fixtures.js";

const fixtures = loadFixturesFromManifest();

for (const fixture of fixtures) {
  test(`parser fixture: ${fixture.file}`, () => {
    const result = parseHomebrewDocuments([fixture.fileData]);
    const summary = result.summary;

    assert.equal(summary.documents, 1);

    if (fixture.shouldParse) {
      assert.ok(summary.books >= fixture.min.books, `expected books >= ${fixture.min.books}, got ${summary.books}`);
      assert.ok(summary.classes >= fixture.min.classes, `expected classes >= ${fixture.min.classes}, got ${summary.classes}`);
      assert.ok(summary.monsters >= fixture.min.monsters, `expected monsters >= ${fixture.min.monsters}, got ${summary.monsters}`);
      assert.ok(summary.spells >= fixture.min.spells, `expected spells >= ${fixture.min.spells}, got ${summary.spells}`);
      assert.ok(Array.isArray(result.indexes?.chapters), "expected chapter index array");
      assert.ok(Array.isArray(result.indexes?.scenes), "expected scene index array");
      assert.ok(Array.isArray(result.indexes?.encounters), "expected encounter index array");
    } else {
      assert.equal(summary.books, 0);
      const failed = result.diagnostics.filter((entry) => entry.status === "failed");
      assert.ok(failed.length >= 1);
    }

    assert.ok(result.confidence.score >= fixture.minConfidence, `expected confidence >= ${fixture.minConfidence}`);
  });
}
