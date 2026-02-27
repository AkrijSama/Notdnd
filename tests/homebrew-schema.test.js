import assert from "node:assert/strict";
import test from "node:test";
import { HOMEBREW_SCHEMA_VERSION, validateHomebrewJsonDocument } from "../server/homebrew/schema.js";

test("valid canonical document passes schema validator", () => {
  const input = {
    schemaVersion: HOMEBREW_SCHEMA_VERSION,
    book: {
      title: "Storm Wastes Codex",
      tags: ["storm"],
      chapters: ["Overview"]
    },
    entities: {
      classes: ["Tempest Knight"],
      monsters: ["Gale Wyrm"],
      spells: ["Thunder Lash"],
      npcs: ["Captain Nera"],
      locations: ["Shatterport"]
    }
  };

  const result = validateHomebrewJsonDocument(input);
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.normalized.book.title, "Storm Wastes Codex");
});

test("missing required canonical fields fail schema validator", () => {
  const result = validateHomebrewJsonDocument({
    schemaVersion: HOMEBREW_SCHEMA_VERSION,
    book: {},
    entities: {
      classes: [],
      monsters: [],
      spells: [],
      npcs: [],
      locations: []
    }
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(" | "), /book\.title is required/);
});

test("unsupported schemaVersion fails", () => {
  const result = validateHomebrewJsonDocument({
    schemaVersion: "2.0",
    book: { title: "X" },
    entities: {
      classes: [],
      monsters: [],
      spells: [],
      npcs: [],
      locations: []
    }
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(" | "), /schemaVersion must be/);
});
