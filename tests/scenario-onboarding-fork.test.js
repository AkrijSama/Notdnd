import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attemptNeedsCheck, isObservationQuery } from "../server/solo/attempt.js";
import { validateScenario } from "../server/campaign/scenarioSchema.js";

// Tests-of-record for the scenario-onboarding fork fixes.
//   ITEM 2 — passive observation of the immediate scene is NEVER a failable roll.
//   ITEM 1 — a pre-built scenario authors its OWN world + locations (the single
//            source of setting truth), so onboarding can skip the worldgen flavor
//            that otherwise contaminated narration (the ruins-vs-market bug).

// ── ITEM 2: observation queries resolve informationally, never a losable check ─
test("passive scene-observation queries never roll (even if the provider proposed a DC)", () => {
  const observations = [
    "Is anyone around me?",
    "what do I see?",
    "who is here?",
    "who's watching me",
    "is anybody nearby",
    "look around",
    "what do I notice",
    "around me — anyone?",
    "can I see anyone",
    "what's going on here"
  ];
  for (const q of observations) {
    assert.equal(isObservationQuery(q), true, `"${q}" should be an observation query`);
    // Overrides a provider that mis-classified it as a perception check.
    assert.equal(attemptNeedsCheck(q, { needsCheck: true }), false, `"${q}" must NOT roll`);
  }
});

test("active manipulation/search stays a real, failable check", () => {
  const checks = [
    "search the stall for a hidden compartment",
    "investigate the body",
    "examine the strange device",
    "inspect the lock",
    "pick the lock",
    "climb the wall",
    "sneak past the guard",
    "I attack the collector",
    "rummage through the crate"
  ];
  for (const q of checks) {
    assert.equal(isObservationQuery(q), false, `"${q}" is not passive observation`);
    // With no provider hint, contested verbs roll by the heuristic.
    assert.equal(attemptNeedsCheck(q, null), true, `"${q}" should roll`);
  }
});

test("observation override does not disturb the provider path for non-observational intents", () => {
  // A provider-supplied needsCheck still wins when it is not an observation query.
  assert.equal(attemptNeedsCheck("bribe the guard", { needsCheck: false }), false);
  assert.equal(attemptNeedsCheck("bribe the guard", { needsCheck: true }), true);
  assert.equal(isObservationQuery(""), false);
  assert.equal(isObservationQuery(null), false);
});

// ── ITEM 1: the scenario is the authoritative setting (world + locations) ──────
const here = path.dirname(fileURLToPath(import.meta.url));
const theShipment = JSON.parse(
  fs.readFileSync(path.join(here, "../server/campaign/scenarios/the_shipment.json"), "utf8")
);

test("the_shipment authors its own world (the fix's source of truth — not worldgen)", () => {
  assert.ok(theShipment.world && typeof theShipment.world === "object", "scenario must carry a world block");
  assert.equal(theShipment.world.name, "Terra");
  assert.equal(theShipment.world.tone, "cyberpunk");
  assert.ok(typeof theShipment.world.flavor === "string" && theShipment.world.flavor.length > 0);
});

test("the_shipment authors its start location (Terra Night Market) with a cyberpunk tag, no ruins", () => {
  const locs = theShipment.locations || {};
  const start = locs[theShipment.opening.startLocationRef];
  assert.ok(start, "the opening's start location must be authored");
  assert.equal(start.name, "Terra Night Market");
  assert.match(start.description, /night market|neon|chrome|data-case/i);
  assert.ok(Array.isArray(start.tags) && start.tags.includes("cyberpunk"), "authored tags replace worldgen tone tags");
  // No dark-fantasy contamination in the authored setting.
  const blob = JSON.stringify(theShipment).toLowerCase();
  assert.equal(/ruin|rubble|barrow|ashenmoor|dark.?fantasy/.test(blob), false, "authored scenario carries no ruins/dark-fantasy");
});

test("the enriched the_shipment still validates against the scenario schema", () => {
  const r = validateScenario(theShipment);
  assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
  assert.equal(r.ok, true);
});
