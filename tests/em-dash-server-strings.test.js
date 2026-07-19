// EM-DASH BAN — SERVER-SIDE NET (append 1). The ban was only enforced at the narration
// trim layer, so server-ASSEMBLED player-facing copy (affordance labels, quest/notice
// text, compiled world content, cue templates) leaked em-dashes. This drives the string
// builders with fixture data and greps the output corpus for the character, plus scans
// the builder SOURCES (non-comment lines) — the net, not just the trim.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { deriveAffordances } from "../server/solo/affordances.js";
import { compileWorldBook } from "../server/campaign/worldBook.js";
import { sightPhrase, SIGHT_PHRASES as SERVER_SIGHT_PHRASES } from "../server/solo/essence.js";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { loadScenarioIntoRun, loadScenarioFile } from "../server/campaign/scenarioLoader.js";
import { renderSoloTraceChips, SIGHT_PHRASES as CLIENT_SIGHT_PHRASES } from "../src/components/soloSceneShell.js";

const EM = "—"; // —

function babelRun() {
  const run = createDefaultSoloRun({ runId: "emdash" });
  run.world = run.world || {}; run.world.variant = "babel";
  loadScenarioIntoRun(run, loadScenarioFile("babel"), {});
  return run;
}

test("driven builder OUTPUT corpus carries no em-dash (fixtures are dash-free)", () => {
  const parts = [];
  // Authored flagship content (notices, quests, descriptions) — surfaced verbatim.
  parts.push(fs.readFileSync(path.resolve("server/campaign/scenarios/babel.json"), "utf8"));
  // Affordance labels incl. the diegetic sight labels, on a real loaded babel run.
  const run = babelRun();
  run.currentLocationId = "loc_waking_mile";
  parts.push(JSON.stringify(deriveAffordances(run)));
  // Compiled user world (offer summary / poi desc / front brief / secret text builders).
  parts.push(JSON.stringify(compileWorldBook({ name: "Plainworld", vibe: "a plain frontier", pois: [{ name: "Ford Market", poiClass: "settlement" }] }).scenario));
  // Sight phrases across every kind x band.
  for (const k of ["trail", "mark", "residue"]) for (const b of ["bright", "clear", "faint", "cold"]) parts.push(sightPhrase(k, b));
  // Client trace chip render.
  parts.push(renderSoloTraceChips({ sight: { traces: [{ id: "t", kind: "trail", band: "bright", followable: true, direction: "north" }] } }));

  const corpus = parts.join("\n");
  const idx = corpus.indexOf(EM);
  assert.equal(idx, -1, idx === -1 ? "" : `em-dash in builder output near: ...${corpus.slice(Math.max(0, idx - 50), idx + 50)}...`);
});

test("builder SOURCES carry no em-dash in player-facing (non-comment) lines", () => {
  const files = [
    "server/campaign/scenarios/babel.json",
    "server/solo/affordances.js",
    "server/campaign/worldBook.js",
    "server/campaign/momentumEvents.js",
    "server/campaign/onboarding.js",
    "server/campaign/bestiary.js"
  ];
  for (const f of files) {
    const lines = fs.readFileSync(path.resolve(f), "utf8").split("\n");
    lines.forEach((ln, i) => {
      const st = ln.trimStart();
      if (st.startsWith("//") || st.startsWith("*") || st.startsWith("/*")) return; // comments exempt
      assert.equal(ln.includes(EM), false, `em-dash in ${f}:${i + 1}: ${ln.trim().slice(0, 80)}`);
    });
  }
});

test("diegetic sight phrases: client mirror equals the server table (parity)", () => {
  assert.deepEqual(CLIENT_SIGHT_PHRASES, SERVER_SIGHT_PHRASES);
});

test("sightPhrase reads as perception, never a bare band/field label", () => {
  assert.equal(sightPhrase("trail", "bright"), "The trail burns fresh");
  assert.equal(sightPhrase("mark", "cold"), "An old mark, all but gone");
  // unknown kind/band fall back safely, still diegetic
  assert.equal(sightPhrase("weird", "weird"), sightPhrase("trail", "clear"));
  const BARE = new Set(["bright", "clear", "faint", "cold", "trail", "mark", "residue", "band"]);
  for (const k of ["trail", "mark", "residue"]) for (const b of ["bright", "clear", "faint", "cold"]) {
    const p = sightPhrase(k, b);
    assert.ok(p.length > 8 && p.includes(" "), `"${p}" is a full perception phrase, not a token`);
    assert.equal(BARE.has(p.trim().toLowerCase()), false, `"${p}" is not a bare field/band label`);
    assert.equal(p.includes(EM), false);
  }
});
