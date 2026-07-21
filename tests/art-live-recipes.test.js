import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveLiveWorkflowFile, resolveLiveTailorFile } from "../server/ai/comfyui.js";
import { intakeToLibrary } from "../server/solo/imageWorker.js";
import { getAsset } from "../scripts/art/library.mjs";

// GAP 1 — the live image path routes (style, kind) through the same validated
// per-lane exports the batch cook uses; lanes without a validated export fall
// back to the generic workflow (never fail generation).

test("kind-routing: realistic (+cinematic alias) has the full validated four-lane set", () => {
  for (const style of ["realistic", "cinematic"]) {
    assert.equal(resolveLiveWorkflowFile(style, "portrait"), "portrait-realistic.json", style);
    assert.equal(resolveLiveWorkflowFile(style, "scene"), "landscape-realistic.json", style);
    assert.equal(resolveLiveWorkflowFile(style, "fullbody"), "fullbody-realistic.json", style);
    assert.equal(resolveLiveWorkflowFile(style, "item"), "item-realistic.json", style);
  }
});

test("kind-routing: anime has validated portrait+scene+fullbody, dark-fantasy portrait only; other kinds fall back", () => {
  assert.equal(resolveLiveWorkflowFile("anime", "portrait"), "portrait-anime.json");
  // The owner's cfg-3.5 register is LANE-WIDE: anime scene (and world-card, which
  // shares the scene recipe) resolve to a validated export, not the generic
  // defaultWorkflow (sampler "euler", cfg 7).
  assert.equal(resolveLiveWorkflowFile("anime", "scene"), "scene-anime.json");
  assert.equal(resolveLiveWorkflowFile("anime", "world-card"), "scene-anime.json", "world-card shares the scene recipe");
  // FULLBODY LANE SEALED (owner re-export, 832x1216 cfg 3.5): battle + VN fullbody
  // resolve to the validated export — the generic fallback DIES for anime/fullbody.
  assert.equal(resolveLiveWorkflowFile("anime", "fullbody"), "fullbody-anime.json");
  assert.equal(resolveLiveWorkflowFile("dark-fantasy", "portrait"), "portrait-darkfantasy.json");
  assert.equal(resolveLiveWorkflowFile("illustrated", "portrait"), "portrait-darkfantasy.json", "engine alias resolves");
  // anime item still falls back; every non-portrait dark-fantasy kind still falls back.
  assert.equal(resolveLiveWorkflowFile("anime", "item"), null, "anime/item falls back to generic");
  for (const kind of ["scene", "fullbody", "item"]) {
    assert.equal(resolveLiveWorkflowFile("dark-fantasy", kind), null, `dark-fantasy/${kind} falls back to generic`);
  }
});

test("kind-routing: an unknown/absent style or kind falls back to generic (null)", () => {
  assert.equal(resolveLiveWorkflowFile("nonsense", "portrait"), null);
  assert.equal(resolveLiveWorkflowFile("realistic", null), null);
  assert.equal(resolveLiveWorkflowFile("realistic", "bogus"), null);
});

test("tailor route: only realistic ships a face-ref tailor; other styles → fallback", () => {
  assert.equal(resolveLiveTailorFile("realistic"), "fullbody-realistic-tailor.json");
  assert.equal(resolveLiveTailorFile("cinematic"), "fullbody-realistic-tailor.json", "engine alias");
  assert.equal(resolveLiveTailorFile("anime"), null);
  assert.equal(resolveLiveTailorFile("dark-fantasy"), null);
  assert.equal(resolveLiveTailorFile("nonsense"), null);
});

// GAP 2 — live-generated images join the library with Law-5 tags.

function withTempLibrary(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-lib-"));
  const prev = process.env.NOTDND_ASSET_LIBRARY_ROOT;
  process.env.NOTDND_ASSET_LIBRARY_ROOT = dir;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (prev === undefined) delete process.env.NOTDND_ASSET_LIBRARY_ROOT;
    else process.env.NOTDND_ASSET_LIBRARY_ROOT = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    const r = fn(dir);
    // intakeToLibrary is async (the taster's real assessor is a vision call), so
    // an async callback must keep the temp library alive until it settles.
    if (r && typeof r.then === "function") return r.finally(cleanup);
    cleanup();
    return r;
  } catch (e) {
    cleanup();
    throw e;
  }
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const sceneRun = { runId: "run_x", userId: "usr_1", world: { name: "Ashenmoor", artStyleOptions: { default: "realistic" } } };

test("intake: a scene lands with origin/creator/kind + Law-5 tags (kind/style/world/loc), auto-keep", async () => {
  await withTempLibrary(async (dir) => {
    const sidecar = await intakeToLibrary({ id: "live_run_x_loc_ravine", bytes: PNG, kind: "scene", run: sceneRun, subjectId: "ravine", promptUsed: "a ravine", workflow: "landscape-realistic.json" });
    assert.ok(sidecar);
    assert.equal(sidecar.origin, "generated");
    assert.equal(sidecar.creator, "usr_1");
    assert.equal(sidecar.kind, "scene");
    assert.equal(sidecar.style, "realistic");
    assert.equal(sidecar.world, "Ashenmoor");
    assert.equal(sidecar.rating, "keep", "auto-keep (batch parity)");
    assert.equal(sidecar.checkout, null, "scenery is never checked out");
    assert.equal(sidecar.workflow, "landscape-realistic.json");
    for (const t of ["kind:scene", "style:realistic", "world:ashenmoor", "loc:ravine", "live", "auto-keep"]) {
      assert.ok(sidecar.tags.includes(t), `tag ${t}`);
    }
    // The image bytes were written into the library root.
    assert.ok(fs.existsSync(path.join(dir, "live_run_x_loc_ravine.png")));
    // And the sidecar is readable back.
    assert.equal(getAsset("live_run_x_loc_ravine").kind, "scene");
  });
});

test("intake: a face-kind (portrait/fullbody) is checked out to its run (not pooled unreviewed)", async () => {
  await withTempLibrary(async () => {
    const bust = await intakeToLibrary({ id: "live_run_x_npc1_base", bytes: PNG, kind: "portrait", run: sceneRun, subjectId: "npc1", extraTags: ["expr:neutral"] });
    assert.equal(bust.kind, "portrait");
    assert.deepEqual(bust.checkout, { runId: "run_x", npcId: "npc1" });
    assert.ok(bust.tags.includes("subject:npc1"));
    assert.ok(bust.tags.includes("expr:neutral"));
    const body = await intakeToLibrary({ id: "live_run_x_npc1_vnBody", bytes: PNG, kind: "fullbody", run: sceneRun, subjectId: "npc1", extraTags: ["pose:standing", "face-ref"] });
    assert.deepEqual(body.checkout, { runId: "run_x", npcId: "npc1" });
    assert.ok(body.tags.includes("face-ref"));
  });
});

test("intake never throws or writes on empty bytes (dialogue-never-blocks discipline)", async () => {
  await withTempLibrary(async () => {
    assert.equal(await intakeToLibrary({ id: "x", bytes: Buffer.alloc(0), kind: "scene", run: sceneRun }), null);
    assert.equal(await intakeToLibrary({ id: "", bytes: PNG, kind: "scene", run: sceneRun }), null);
    // A malformed run must not reject (intake swallows and returns a sidecar/null).
    await assert.doesNotReject(() => intakeToLibrary({ id: "y", bytes: PNG, kind: "scene", run: null }));
  });
});

// ── PROVENANCE GUARD — the 4 face/body intake sites (2026-07-19) ─────────────
// The intake guard was scene-only in practice: only the scene site passed
// `provider`, so the 4 face/body sites (enemyBody, NPC base bust, vnBody, player
// portrait) never gave the guard anything to act on and would pool a failover.
// generateSlot now threads `provider` and every site passes it. Each site must
// REFUSE a non-comfyui serve-attribution (pollinations/cloudflare/fal failover,
// or a mock placeholder) and still POOL a validated comfyui attribution.
const FACE_BODY_SITES = [
  { site: "enemyBody", id: "live_run_x_npc1_enemyBody", kind: "fullbody", subjectId: "npc1" },
  { site: "npc base bust", id: "live_run_x_npc1_base", kind: "portrait", subjectId: "npc1" },
  { site: "vnBody", id: "live_run_x_npc1_vnBody", kind: "fullbody", subjectId: "npc1" },
  { site: "player portrait", id: "live_run_x_player", kind: "portrait", subjectId: "player" }
];

for (const s of FACE_BODY_SITES) {
  test(`provenance guard: ${s.site} REFUSES a non-comfyui (failover/mock) attribution`, async () => {
    await withTempLibrary(async (dir) => {
      for (const bad of ["pollinations", "cloudflare", "fal", "placeholder", "local"]) {
        const refused = await intakeToLibrary({ id: s.id, bytes: PNG, kind: s.kind, run: sceneRun, subjectId: s.subjectId, provider: bad });
        assert.equal(refused, null, `${s.site} pooled a "${bad}" attribution`);
        assert.equal(fs.existsSync(path.join(dir, `${s.id}.png`)), false, `${s.site} wrote "${bad}" bytes into the library`);
        assert.ok(!getAsset(s.id), `${s.site} left a "${bad}" sidecar behind`);
      }
    });
  });

  test(`provenance guard: ${s.site} still pools a validated comfyui attribution (checked out)`, async () => {
    await withTempLibrary(async (dir) => {
      const kept = await intakeToLibrary({ id: s.id, bytes: PNG, kind: s.kind, run: sceneRun, subjectId: s.subjectId, provider: "comfyui" });
      assert.ok(kept, `${s.site} refused a validated comfyui attribution`);
      assert.equal(kept.kind, s.kind);
      assert.deepEqual(kept.checkout, { runId: "run_x", npcId: s.subjectId }, "face/body is checked out to its run, never pooled unreviewed");
      assert.ok(fs.existsSync(path.join(dir, `${s.id}.png`)));
    });
  });
}

// Dialogue-never-blocks: enqueue is fire-and-forget (returns synchronously, no await).
test("enqueue is fire-and-forget — returns synchronously, never blocks the turn", async () => {
  const { enqueueVnBodyImageJob, enqueueLocationImageJob, enqueuePlayerImageJob } = await import("../server/solo/imageWorker.js");
  // Each returns undefined immediately (a queued Promise drains later), and never throws.
  assert.equal(enqueueVnBodyImageJob({ runId: "r", npcId: "n" }), undefined);
  assert.equal(enqueueLocationImageJob({ runId: "r", locationId: "l" }), undefined);
  assert.equal(enqueuePlayerImageJob({ runId: "r" }), undefined);
  // Missing ids are silently ignored (no throw).
  assert.doesNotThrow(() => enqueueVnBodyImageJob({}));
});
