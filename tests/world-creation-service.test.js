// THE WORLD-CREATION SERVICE (the route↔engine glue). With an injected MOCK provider
// (setWorldDraftProviderForTests → zero real LLM calls): draft → save → list → delete,
// plus owner-scoping (the Worlds law). Uses a temp DB.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notdnd-wcsvc-"));
process.env.NOTDND_DB_PATH = path.join(tmpDir, "svc.db.json");
process.env.NOTDND_MEMORY_ROOT = path.join(tmpDir, "campaigns");
process.env.NOTDND_MOCK_OPENROUTER = "true";
process.env.NOTDND_MOCK_IMAGE = "true";

const { initializeDatabase, resetDatabase, createGuestUser, getUserWorld } = await import("../server/db/repository.js");
const { setWorldDraftProviderForTests, serviceDraft, serviceSaveWorld, listWorldsForSelect, serviceDeleteWorld } = await import("../server/campaign/worldCreationService.js");
const { resolveUserWorldScenario } = await import("../server/campaign/scenarioLoader.js");
const { validateScenario } = await import("../server/campaign/scenarioSchema.js");
const { createInterview, answerQuestion, justBuild } = await import("../server/campaign/worldInterview.js");

initializeDatabase();
resetDatabase();
setWorldDraftProviderForTests(async () => ({
  model: "mock-flash", tokensUsed: { prompt: 1200, completion: 800 }, cost: 0,
  content: JSON.stringify({
    identity: { name: "Neon Reach", tagline: "rain that never stops", era: "late-corporate", tone: "neon-noir" },
    cosmology: "Corporations became gods when they learned to print weather.",
    pois: Array.from({ length: 13 }, (_, i) => ({ name: `District ${i + 1}`, poiClass: i < 6 ? "settlement" : "wilds", description: "a place", dangerLevel: i % 4 })),
    factions: [{ name: "Zaibatsu", disposition: "hostile-reserved", wants: "control" }, { name: "Drowned Court", disposition: "neutral", wants: "tribute" }],
    threatLadder: [{ rung: "drones", rarity: "common" }, { rung: "gangers", rarity: "common" }, { rung: "corp sec", rarity: "rare" }]
  })
}));

function interview() {
  let iv = createInterview("neon cyberpunk city, corporate gods, rain that never stops");
  iv = answerQuestion(iv, "a hundred-floor arcology that prints weather");
  return justBuild(iv);
}

test("serviceDraft drafts tables through the (mock) provider + a cost ledger", async () => {
  const res = await serviceDraft({ creationId: "c1", interview: interview() });
  assert.equal(res.ok, true);
  assert.equal(res.source, "provider");
  assert.equal(res.draft.pois.length, 13);
  assert.ok(res.ledger.calls >= 1 && res.ledger.costUsd >= 0);
});

test("serviceSaveWorld compiles + persists an owner-scoped world; scenario is loadable", async () => {
  const guest = createGuestUser();
  const drafted = await serviceDraft({ creationId: "c2", interview: interview() });
  const saved = serviceSaveWorld({ userId: guest.user.id, creationId: "c2", draft: drafted.draft, interview: interview(), overrides: { artStyle: "cinematic" } });
  assert.equal(saved.ok, true);
  assert.match(saved.worldId, /^uw_/);

  const rec = getUserWorld(guest.user.id, saved.worldId);
  assert.ok(rec, "owner can fetch the saved world");
  assert.equal(rec.scenario.scenarioId, saved.worldId, "the record id IS the compiled scenarioId");
  const scenario = resolveUserWorldScenario(rec);
  assert.equal(validateScenario(scenario).ok, true, "the saved scenario passes the strict loader gate");
  const start = scenario.locations[scenario.opening.startLocationRef];
  assert.ok(start.tags.includes("poi:start-area"), "kept-ground start survives the round trip");
});

test("a minimal/empty curation still SAVES (never blocked from playing)", () => {
  const guest = createGuestUser();
  const saved = serviceSaveWorld({ userId: guest.user.id, creationId: "c3", draft: {}, interview: interview() });
  assert.equal(saved.ok, true, "a thin world compiles and saves rather than erroring");
});

test("world isolation: worlds are owner-scoped (the Worlds law)", async () => {
  const owner = createGuestUser();
  const stranger = createGuestUser();
  const drafted = await serviceDraft({ creationId: "c4", interview: interview() });
  const saved = serviceSaveWorld({ userId: owner.user.id, creationId: "c4", draft: drafted.draft, interview: interview() });

  assert.ok(listWorldsForSelect(owner.user.id).some((w) => w.userWorldId === saved.worldId), "owner sees it on world-select");
  assert.equal(getUserWorld(stranger.user.id, saved.worldId), null, "a stranger cannot fetch it");
  assert.equal(listWorldsForSelect(stranger.user.id).some((w) => w.userWorldId === saved.worldId), false, "a stranger never sees it");

  assert.equal(listWorldsForSelect(owner.user.id).find((w) => w.userWorldId === saved.worldId).kind, "user");
  assert.equal(serviceDeleteWorld(owner.user.id, saved.worldId).ok, true);
  assert.equal(getUserWorld(owner.user.id, saved.worldId), null, "deleted");
});
