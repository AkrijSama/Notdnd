// PUBLIC ROADMAP (item 6): data-driven home zone. Renders from the data file;
// absent/empty → hides cleanly. Owner-safe content (no dates/percentages/codenames).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderRoadmapZone } from "../src/components/homeZones.js";

test("renders rows from data (title, description, status pill)", () => {
  const html = renderRoadmapZone([
    { title: "Combat", description: "Turn-based battles with a readable queue", status: "building" },
    { title: "Bestiary", description: "The wilds get teeth", status: "next" }
  ]);
  assert.match(html, /Roadmap/);
  assert.match(html, /Combat/);
  assert.match(html, /Turn-based battles/);
  assert.match(html, /solo-roadmap-status--building/);
  assert.match(html, /solo-roadmap-status--next/);
});

test("absent / empty data → panel hides cleanly (empty string)", () => {
  assert.equal(renderRoadmapZone([]), "");
  assert.equal(renderRoadmapZone(null), "");
  assert.equal(renderRoadmapZone(undefined), "");
  assert.equal(renderRoadmapZone([{ description: "no title" }]), "", "rows without a title are dropped");
});

test("the seeded data file is valid and owner-safe (no dates/percentages/codenames)", () => {
  const raw = fs.readFileSync(path.resolve("docs/roadmap-public.json"), "utf8");
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed.items) && parsed.items.length > 0);
  for (const item of parsed.items) {
    assert.equal(typeof item.title, "string");
    assert.ok(["building", "next", "planned"].includes(item.status), `valid status: ${item.status}`);
    const blob = `${item.title} ${item.description || ""}`;
    assert.doesNotMatch(blob, /\b\d{4}-\d{2}-\d{2}\b/, "no ISO dates");
    assert.doesNotMatch(blob, /%/, "no percentages");
    assert.doesNotMatch(blob, /Q[1-4]\b/, "no quarter codenames");
  }
});
