// F5 — SCENE HOSTILE INJECTION (+ INSP-09 consumer).
//
// The live Waking Mile scene rendered an EMPTY path while the committed hostile Limping
// Grey (a corrupted grey wolf) was PRESENT: the live cook receives a canon-only basePrompt
// ("…wide establishing shot, no people") with NO subject. The fix injects the committed
// present HOSTILE as a species-true midground subject carrying its VIOLET per-tier
// corruption markers (INSP-09's corruption.artFragment — the open seam, now consumed).
//
// This proves: (1) the injected phrase is a wolf + violet markers; (2) no present hostile
// => no injection; (3) the injection reaches the actual COOKED prompt through
// runLocationImageJob even with a canon-only basePrompt; (4) the enemy-fullbody sprite is a
// corrupted wolf and its job enqueues on combat entry. GPU-free (ComfyUI fetch is stubbed).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "scene-hostile-"));
process.env.NOTDND_DB_PATH = path.join(TMP, "db.json");
process.env.NOTDND_ASSETS_ROOT = path.join(TMP, "assets");
process.env.NOTDND_ASSET_LIBRARY_ROOT = path.join(TMP, "library");
process.env.NOTDND_IMAGE_PROVIDER = "comfyui";
delete process.env.NOTDND_MOCK_IMAGE;
delete process.env.INKBORNE_MOCK_IMAGE;
delete process.env.NOTDND_BOOTSTRAP_DEMO;
delete process.env.FAL_API_KEY;

import assert from "node:assert/strict";
import test from "node:test";

const {
  sceneHostileSubject, buildScenePrompt, runLocationImageJob,
  buildEnemyBodyPrompt, enqueueEnemyBodyImageJob, queuedJobCount
} = await import("../server/solo/imageWorker.js");
const { resolveStatBlock } = await import("../server/campaign/bestiary.js");
const { createSoloRun, getSoloRun, saveSoloRun, initializeDatabase, resetDatabase } =
  await import("../server/db/repository.js");

// A committed present hostile: the authored Limping Grey (statBlockId resolves the violet
// tier-2 corruption.artFragment + baseAnimalId grey_wolf + injured behavior).
function greyNpc(overrides = {}) {
  return {
    npcId: "npc_grey", displayName: "The Limping Grey", role: "chaosling",
    currentLocationId: "loc_waking_mile", status: "present",
    statBlockId: "limping_grey", tags: ["wildlife", "wolf", "chaosling", "corrupted"],
    flags: { hostile: true, statBlockId: "limping_grey" }, ...overrides
  };
}
const wakingMile = {
  locationId: "loc_waking_mile", name: "The Waking Mile",
  description: "A mossy forest path at the starter zone's first exit.", state: { dangerLevel: 2 }
};

test("F5: a present HOSTILE renders a species-true wolf midground subject + VIOLET corruption markers", () => {
  const run = { npcs: { npc_grey: greyNpc() }, currentLocationId: "loc_waking_mile", world: { tone: "dark fantasy" } };
  const subj = sceneHostileSubject(run, "loc_waking_mile");
  assert.match(subj, /wolf/, "the wolf renders as a wolf");
  assert.match(subj, /the clear midground subject/, "it is the scene's midground subject");
  assert.match(subj, /wounded/, "the Grey's committed injury rides");
  assert.match(subj, /violet/, "INSP-09: violet corruption markers ride");
  assert.match(subj, /corruption markings/, "the tier-2 artFragment (not a generic 'corrupted') is consumed");
  // The subject must NOT carry human/person words (that would drop the scene framing guard).
  assert.doesNotMatch(subj, /\b(human|person|\bman\b|\bwoman\b)\b/i, "a beast is never framed as a person");
});

test("F5: NO present hostile => NO injection (empty, dead, gone, or non-hostile)", () => {
  const world = { tone: "dark fantasy" };
  assert.equal(sceneHostileSubject({ npcs: {}, world }, "loc_waking_mile"), "", "empty location => no injection");
  assert.equal(
    sceneHostileSubject({ npcs: { npc_grey: greyNpc({ flags: { hostile: false } }) }, world }, "loc_waking_mile"),
    "", "a present but non-hostile creature is not force-injected as the subject"
  );
  assert.equal(
    sceneHostileSubject({ npcs: { npc_grey: greyNpc({ status: "dead" }) }, world }, "loc_waking_mile"),
    "", "a dead hostile is not injected"
  );
  assert.equal(
    sceneHostileSubject({ npcs: { npc_grey: greyNpc({ currentLocationId: "elsewhere" }) }, world }, "loc_waking_mile"),
    "", "a hostile at another location is not injected here"
  );
});

test("F5: the fallback scene builder is hostile-first (the wolf leads, canon still rides)", () => {
  const run = { npcs: { npc_grey: greyNpc() }, currentLocationId: "loc_waking_mile", world: { tone: "dark fantasy" } };
  const p = buildScenePrompt(run, wakingMile, "loc_waking_mile");
  assert.match(p, /wolf/, "the present hostile leads the fallback prompt");
  assert.match(p, /violet/, "violet corruption markers ride the fallback prompt too");
  assert.match(p, /Waking Mile/, "the location canon still rides");
});

// ── End-to-end: the injection reaches the actual COOKED prompt (canon-only basePrompt) ──
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
function installFetchCapture() {
  const captured = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith("/prompt") && opts.method === "POST") {
      captured.push(JSON.parse(opts.body).prompt);
      return { ok: true, json: async () => ({ prompt_id: "pid" }) };
    }
    if (u.includes("/history/")) {
      return { ok: true, json: async () => ({ pid: { outputs: { "19": { images: [{ filename: "s.png", subfolder: "", type: "output" }] } } } }) };
    }
    if (u.includes("/view")) {
      return { ok: true, arrayBuffer: async () => TINY_PNG.buffer.slice(TINY_PNG.byteOffset, TINY_PNG.byteOffset + TINY_PNG.byteLength) };
    }
    return { ok: false, status: 404, text: async () => "x", json: async () => ({}) };
  };
  return captured;
}
function cookedPositive(wf) {
  const sampler = Object.values(wf).find((n) => /KSampler/.test(n?.class_type || ""));
  const posId = sampler?.inputs?.positive?.[0];
  return String(wf[posId]?.inputs?.text ?? wf["6"]?.inputs?.text ?? "");
}
function seedRun(runId, { hostile }) {
  initializeDatabase();
  resetDatabase();
  createSoloRun({ userId: "u_scene", runId, now: "2026-01-01T00:00:00.000Z" });
  const run = getSoloRun(runId);
  // Keep the valid default world (worldId/time/flags/tags) — only set what the scene needs.
  run.world = { ...run.world, tone: "dark fantasy", artStyle: "anime" };
  run.currentLocationId = "loc_waking_mile";
  run.locations = {
    loc_waking_mile: {
      ...wakingMile, connectedLocationIds: [],
      state: { dangerLevel: 2, visited: true, discovered: true }, memoryFactIds: [], tags: [], flags: {}
    }
  };
  if (hostile) run.npcs = { npc_grey: { ...greyNpc(), known: true, memoryFactIds: [] } };
  saveSoloRun(run);
}
// The LIVE caller's canon-only basePrompt — no subject in it (this is what produced the empty path).
const CANON_BASEPROMPT = "The Waking Mile, a mossy forest path, dark fantasy, atmospheric, wide establishing shot, no people";

test("F5: runLocationImageJob INJECTS the hostile into the cooked prompt (canon-only basePrompt had none)", async () => {
  seedRun("run_scene_grey", { hostile: true });
  const captured = installFetchCapture();
  const r = await runLocationImageJob({ runId: "run_scene_grey", locationId: "loc_waking_mile", style: "anime", basePrompt: CANON_BASEPROMPT });
  assert.equal(r.ok, true, `cook ok (${r.reason || ""})`);
  const pos = cookedPositive(captured[0]);
  assert.match(pos, /wolf/, "the wolf reached the cooked ComfyUI prompt");
  assert.match(pos, /the clear midground subject/, "injected as the midground subject");
  assert.match(pos, /violet/, "INSP-09 violet markers reached the cooked prompt");
  assert.match(pos, /Waking Mile/, "the location canon is preserved");
});

test("F5: runLocationImageJob does NOT inject when no hostile is present", async () => {
  seedRun("run_scene_empty", { hostile: false });
  const captured = installFetchCapture();
  const r = await runLocationImageJob({ runId: "run_scene_empty", locationId: "loc_waking_mile", style: "anime", basePrompt: CANON_BASEPROMPT });
  assert.equal(r.ok, true, `cook ok (${r.reason || ""})`);
  const pos = cookedPositive(captured[0]);
  assert.doesNotMatch(pos, /the clear midground subject/, "no hostile => no midground-subject injection");
  assert.doesNotMatch(pos, /a single .*wolf/, "no wolf conjured into an empty scene");
});

// ── Combat entry: the enemy fullbody sprite is a corrupted wolf, and its job enqueues ──
test("F5: the enemy fullbody sprite is a species-true CORRUPTED wolf, and the job enqueues on combat entry", () => {
  const prompt = buildEnemyBodyPrompt(resolveStatBlock("limping_grey"), "dark fantasy");
  assert.match(prompt, /wolf/, "enemy sprite is the committed base animal");
  assert.match(prompt, /corrupt/i, "tier-scaled corruption rides the sprite");
  assert.match(prompt, /wounded|limping/i, "the Grey's committed injury rides");
  assert.match(prompt, /frost|cold/i, "the inverted-element chill rider cue rides");
  // enqueueEnemyBodyImageJob (the enqueuer index.js fires for each active-combat enemy
  // without a bodyUri — server/index.js combat-entry block) actually queues a job.
  const before = queuedJobCount();
  enqueueEnemyBodyImageJob({ runId: "run_combat", npcId: "npc_grey", style: "anime" });
  assert.ok(queuedJobCount() > before, "an enemyBody job is enqueued");
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ } });
