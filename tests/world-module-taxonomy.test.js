// WORLD / MODULE TAXONOMY (owner law, docs/design/world-module-law.md). Player
// copy says "modules" (world-scoped adventures), never "story templates".
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderModulesZone, renderRoadmapZone } from "../src/components/homeZones.js";
import { renderGuestAuthPanel } from "../src/components/authPanel.js";

test("Modules zone: correct copy, banned taxonomy absent", () => {
  const html = renderModulesZone();
  assert.match(html, /Modules/);
  assert.match(html, /Ready-made adventures within this world/);
  assert.doesNotMatch(html, /story template/i, "banned phrase absent");
  assert.doesNotMatch(html, /\btemplate/i, "no 'template' in player copy");
});

test("banned string absent from the home player-facing surfaces", () => {
  const surfaces = [
    renderModulesZone(),
    renderRoadmapZone([{ title: "X", description: "y", status: "next" }]),
    renderGuestAuthPanel("register"),
    renderGuestAuthPanel("login")
  ].join("\n");
  assert.doesNotMatch(surfaces, /story template/i);
});

test("the law doc is sealed with the invariants it protects", () => {
  const law = fs.readFileSync(path.resolve("docs/design/world-module-law.md"), "utf8");
  assert.match(law, /sealed universe/i);
  assert.match(law, /never cross between worlds/i);
  assert.match(law, /provenance/i);
  assert.match(law, /soul law/i);
  assert.match(law, /seed/i);
});
