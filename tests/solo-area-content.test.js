import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-areacontent-"));
process.env.NOTDND_DB_PATH = path.join(tmpDir, "area.db.json");
process.env.NOTDND_MEMORY_ROOT = path.join(tmpDir, "campaigns");
process.env.NOTDND_WORLD_PROVIDER = "placeholder";
process.env.NOTDND_NPC_IDENTITY_PROVIDER = "placeholder";
process.env.NOTDND_MOCK_IMAGE = "true";
process.env.NOTDND_MOCK_OPENROUTER = "true";

const { initializeDatabase, resetDatabase, registerUser, getSoloRun } = await import("../server/db/repository.js");
const { createWorldOnboardingRun } = await import("../server/campaign/onboarding.js");

const CHAR = {
  name: "Bram",
  race: "Human",
  characterClass: "Rogue",
  background: "Criminal",
  baseAbilityScores: { strength: 10, dexterity: 12, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10 }
};

// A fresh adoptable forest-ruins start (the default sandbox area) must contain
// REAL, server-owned, discoverable features in run-state — not bare terrain. This
// proves the procedural area generator places content (Task 3 verdict (a) fix).
test("a fresh forest-ruins start area has placed features in run-state (ruins landmark + POIs)", async () => {
  initializeDatabase();
  resetDatabase();
  const { user } = registerUser({ email: "area1@notdnd.local", password: "password123", displayName: "Area One" });

  // Blank world -> forest-ruins default (startIsBaseable).
  const result = await createWorldOnboardingRun(user.id, { world: {}, character: CHAR });
  const run = getSoloRun(result.runId);
  const start = run.locations.start_location;

  const details = Array.isArray(start.searchDetails) ? start.searchDetails : [];
  // At least four placed features (was a single generic "Scuffed Mark").
  assert.ok(details.length >= 4, `expected >=4 placed features, got ${details.length}`);

  // The ruins structure itself is a discoverable landmark (the base's core).
  const labels = details.map((d) => String(d.label || ""));
  assert.ok(labels.some((l) => /hall|keep|ruin/i.test(l)), `expected a ruins-structure landmark, got ${JSON.stringify(labels)}`);

  // Features are genuine, schema-shaped, server-owned content (not faked markers).
  for (const d of details) {
    assert.ok(typeof d.detailId === "string" && d.detailId.startsWith("start_location_"), "feature has a stable id");
    assert.ok(typeof d.description === "string" && d.description.length > 20, "feature has real descriptive content");
    assert.equal(d.revealed, false, "features start undiscovered (revealed by searching)");
    assert.deepEqual(d.linkedEntityIds, ["start_location"], "feature is anchored to the starting area");
  }
});

test("an explicit non-baseable venue (tavern) is NOT given the ruins features", async () => {
  resetDatabase();
  const { user } = registerUser({ email: "area2@notdnd.local", password: "password123", displayName: "Area Two" });
  const result = await createWorldOnboardingRun(user.id, {
    world: { tone: "dark fantasy", startingLocationName: "The Ember Tavern", startingLocationType: "tavern" },
    character: CHAR
  });
  const start = getSoloRun(result.runId).locations.start_location;
  const labels = (start.searchDetails || []).map((d) => String(d.label || ""));
  // No forest-ruins hall/well/watchpoint/cache injected into a tavern.
  assert.ok(!labels.some((l) => /collapsed hall|old well|watchpoint|ash-buried cache/i.test(l)), `tavern should keep bare default, got ${JSON.stringify(labels)}`);
});

test("two different worlds get deterministically-flavored (non-identical) features", async () => {
  resetDatabase();
  const { user: u1 } = registerUser({ email: "area3a@notdnd.local", password: "password123", displayName: "A" });
  const { user: u2 } = registerUser({ email: "area3b@notdnd.local", password: "password123", displayName: "B" });
  const r1 = getSoloRun((await createWorldOnboardingRun(u1.id, { world: { name: "Aaa", tone: "grimdark" }, character: CHAR })).runId);
  const r2 = getSoloRun((await createWorldOnboardingRun(u2.id, { world: { name: "Zzz", tone: "high fantasy" }, character: CHAR })).runId);
  const desc1 = (r1.locations.start_location.searchDetails || []).map((d) => d.description).join("|");
  const desc2 = (r2.locations.start_location.searchDetails || []).map((d) => d.description).join("|");
  assert.notEqual(desc1, desc2, "feature prose should vary by world (tone/name)");
});
