// WORLD-BOOK SCHEMA (docs/design/world-book-schema.md). The two-layer contract:
// validateWorldBook is permissive (name-only floor); compileWorldBook lowers a world-book
// into a scenario that passes the strict validateScenario. Regression: babel validates as
// a world-book unchanged AND still passes the authored scenario gate.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  validateWorldBook, compileWorldBook, normalizeWorldBook, keptGroundStart,
  DEFAULT_ORIENTATION_MIX, DEFAULT_DEATH_LAW, WORLD_BOOK_SCHEMA_VERSION
} from "../server/campaign/worldBook.js";
import { validateScenario } from "../server/campaign/scenarioSchema.js";

const babel = JSON.parse(fs.readFileSync(path.resolve("server/campaign/scenarios/babel.json"), "utf8"));

// ── validateWorldBook (permissive) ───────────────────────────────────────────

test("babel validates as a world-book UNCHANGED (regression)", () => {
  assert.equal(validateWorldBook(babel).ok, true);
  // …and babel still passes the strict authored gate untouched.
  assert.equal(validateScenario(babel).ok, true);
});

test("a minimal {name, vibe} world-book validates (the one law)", () => {
  assert.equal(validateWorldBook({ name: "Neon Sprawl", vibe: "cyberpunk rain" }).ok, true);
  // name via any of the accepted shapes.
  assert.equal(validateWorldBook({ identity: { name: "X" } }).ok, true);
  assert.equal(validateWorldBook({ title: "Y" }).ok, true);
  assert.equal(validateWorldBook({ world: { name: "Z" } }).ok, true);
});

test("a nameless world-book is the ONLY hard rejection", () => {
  const v = validateWorldBook({ vibe: "no name here" });
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].path, "name");
});

test("optional fields are type-checked only when present; fronts cap surfaced early", () => {
  assert.equal(validateWorldBook({ name: "X", factions: "nope" }).ok, false);
  assert.equal(validateWorldBook({ name: "X", fronts: [1, 2, 3, 4] }).ok, false, "4 fronts exceeds the cap");
  assert.equal(validateWorldBook({ name: "X", orientationMix: { hetero: -1 } }).ok, false);
  assert.equal(validateWorldBook({ name: "X", pois: [], factions: [], fronts: [] }).ok, true);
});

// ── compileWorldBook (→ strict scenario) ─────────────────────────────────────

test("a minimal world compiles to a scenario that passes the strict gate (plays via mints)", () => {
  const { scenario, validation } = compileWorldBook({ name: "Neon Sprawl", vibe: "rain that never stops" });
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.equal(scenario.substrate, 1);
  assert.ok(scenario.fronts.length >= 1, "minted a valid default front");
  assert.ok(scenario.secrets.length >= 1, "minted a secret tied to the front");
  assert.ok(scenario.opening && scenario.opening.startLocationRef, "minted an opening");
});

test("EVERY compiled world gets a kept-ground start (the universal anti-lost law)", () => {
  const { scenario } = compileWorldBook({ name: "Grimhold", vibe: "a cursed moor" });
  const start = scenario.locations[scenario.opening.startLocationRef] || scenario.locations.start_location;
  assert.ok(start, "a start location exists");
  assert.ok(start.tags.includes("poi:start-area"), "tagged poi:start-area (the anti-lost contract)");
  assert.equal(start.dangerLevel, 0);
  assert.match(start.description, /kept ground/i);
  assert.match(start.description, /honest|plain|easy to read/i, "carries the auditor-safe kept-ground language");
});

test("mint-capable defaults fill orientation + death law", () => {
  const { scenario } = compileWorldBook({ name: "Anywhere", vibe: "x" });
  assert.deepEqual(scenario.world.orientationMix, DEFAULT_ORIENTATION_MIX);
  assert.equal(scenario.world.deathLaw.kind, DEFAULT_DEATH_LAW.kind);
  assert.equal(scenario.world.deathLaw.premiumContinuation, true);
});

test("user POIs + factions carry through; danger clamps; scenarioId is forced when given", () => {
  const { scenario, validation } = compileWorldBook({
    name: "Verdance Reach", vibe: "a drowned frontier",
    pois: [{ name: "Ford Market", poiClass: "settlement", dangerLevel: 0, services: [{ kind: "market", label: "Trade" }] }, { name: "The Sink", poiClass: "wilds", dangerLevel: 9 }],
    factions: [{ factionId: "f1", name: "The Wardens", disposition: "friendly", standing: 10, wants: "order" }]
  }, { scenarioId: "uw_fixed" });
  assert.equal(validation.ok, true);
  assert.equal(scenario.scenarioId, "uw_fixed");
  assert.equal(scenario.factions.length, 1);
  const sink = Object.values(scenario.locations).find((l) => l.name === "The Sink");
  assert.equal(sink.dangerLevel, 4, "dangerLevel clamps to 0-4");
});

test("compileWorldBook is deterministic under a fixed idFactory", () => {
  const wb = { name: "Twin", vibe: "same seed", pois: [{ name: "A place" }] };
  const idf = () => { let i = 0; return () => `id${++i}`; };
  const a = compileWorldBook(wb, { idFactory: idf(), scenarioId: "uw_twin" });
  const b = compileWorldBook(wb, { idFactory: idf(), scenarioId: "uw_twin" });
  assert.deepEqual(a.scenario, b.scenario);
});

test("normalizeWorldBook never mutates input + is idempotent on a full book (babel)", () => {
  const before = JSON.stringify(babel);
  const norm = normalizeWorldBook(babel);
  assert.equal(JSON.stringify(babel), before, "input untouched");
  assert.equal(norm.schemaVersion, WORLD_BOOK_SCHEMA_VERSION);
  assert.ok(norm.name && norm.orientationMix && norm.deathLaw);
  // keptGroundStart derives a start with the tag regardless of input completeness.
  assert.ok(keptGroundStart(normalizeWorldBook({ name: "X" })).tags.includes("poi:start-area"));
});
