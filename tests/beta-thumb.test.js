// BETA THUMB — owner-feedback calibration control. Proves the lifecycle law that goes
// wrong: a thumbs-down is a SIGNAL, never a destruction order; an in-use fridge asset
// KEEPS SERVING while flagged; the 30-day fuse escalates, never auto-trashes; the
// dataset survives the asset and the button. Isolated temp library + verdict log.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "beta-thumb-"));
process.env.NOTDND_ASSET_LIBRARY_ROOT = path.join(TMP, "library");
process.env.NOTDND_OWNER_VERDICTS_PATH = path.join(TMP, "owner-verdicts.jsonl");
fs.mkdirSync(process.env.NOTDND_ASSET_LIBRARY_ROOT, { recursive: true });

const lib = await import("../scripts/art/library.mjs");
const fb = await import("../server/art/ownerFeedback.js");
const art = await import("../server/solo/artLibrary.js");

function keep(id, { world, kind, style } = {}) {
  lib.addAsset({ id, world, kind, style, origin: "generated" });
  lib.rateAsset(id, "keep");
}
const uriOf = (id) => "/data/assets/library/" + id + ".png";
const now = 1_700_000_000_000;

test("JOB 4.1: the kill switch defaults ON and flips off in one env move", () => {
  delete process.env.NOTDND_BETA_THUMB;
  assert.equal(fb.betaThumbEnabled(), true);
  process.env.NOTDND_BETA_THUMB = "false";
  assert.equal(fb.betaThumbEnabled(), false);
  process.env.NOTDND_BETA_THUMB = "true";
});

test("JOB 3.1/3.2: thumbs-down flags for eviction but the in-use fridge asset KEEPS SERVING", () => {
  keep("wc-babel", { world: "babel", kind: "world-card", style: "anime" });
  assert.equal(art.resolveLibraryArt({ world: "babel", kind: "world-card", style: "anime" }), uriOf("wc-babel"), "served before down");
  // thumbs-down (the whole lifecycle: record + flag, NO destruction, NO taster quarantine)
  fb.appendVerdict({ ...fb.buildVerdictRecord({ uri: uriOf("wc-babel"), kind: "world-card", world: "babel", verdict: "down", reasons: ["just ugly"] }), at: now });
  fb.setOwnerDown("wc-babel", ["just ugly"], now);
  const s = lib.getAsset("wc-babel");
  assert.equal(s.rating, "keep", "rating stays keep");
  assert.equal(s.quarantine, null, "NO taster quarantine marker (that would drop it from serve + feed auto-trash)");
  assert.equal(s.ownerFeedback.verdict, "down");
  assert.equal(art.resolveLibraryArt({ world: "babel", kind: "world-card", style: "anime" }), uriOf("wc-babel"), "STILL SERVES after thumbs-down — the card does not go blank (JOB 3.2)");
});

test("JOB 2: the verdict record carries recipe version + taster verdict (the non-negotiables)", () => {
  // seed a taster verdict for the id, so pairing is testable
  fs.writeFileSync(path.join(process.env.NOTDND_ASSET_LIBRARY_ROOT, "..", "quarantine-verdicts.json"),
    JSON.stringify({ model: "gemini", rows: [{ id: "port-x", kind: "portrait", world: "babel", verdict: "pass", recommend: "fridge", reason: "looks fine" }] }));
  keep("port-x", { world: "babel", kind: "portrait", style: "anime" });
  // give it a recipe in the sidecar
  const p = path.join(process.env.NOTDND_ASSET_LIBRARY_ROOT, "port-x.json");
  const sc = JSON.parse(fs.readFileSync(p, "utf8")); sc.meta = { templateVersion: 2, blockVersions: { blockVersion: 2 } }; sc.workflow = "portrait-anime.json"; sc.promptUsed = "a courier";
  fs.writeFileSync(p, JSON.stringify(sc));
  const rec = fb.buildVerdictRecord({ uri: uriOf("port-x"), kind: "portrait", world: "babel", verdict: "up", reasons: [] });
  assert.equal(rec.recipeVersion, "tmpl2/blk2/portrait-anime.json", "recipe version is recorded (else a down goes stale on a recipe change)");
  assert.equal(rec.tasterVerdict, "fridge", "the taster's own verdict is stored alongside (else agreement is uncomputable)");
  assert.equal(rec.tasterReason, "looks fine");
  assert.equal(rec.prompt, "a courier");
});

test("JOB 3.3: an old down-flag ESCALATES (loud), it never auto-trashes", () => {
  keep("scn-old", { world: "babel", kind: "scene", style: "anime" });
  fb.setOwnerDown("scn-old", ["bad crop"], now - 40 * 86400000); // 40 days old
  const items = fb.listOwnerDown({ now });
  const row = items.find((i) => i.assetId === "scn-old");
  assert.ok(row, "appears in the sweep");
  assert.equal(row.overdue, true, "flagged OVERDUE past the escalate window");
  assert.ok(lib.assetExists("scn-old"), "still exists — expiry never destroys (JOB 3.3)");
  assert.equal(row.serving, true, "and still serving");
});

test("JOB 3.4: owner stamp is the ONLY destruction path; fridge keeps serving, trash destroys", () => {
  keep("scn-a", { world: "babel", kind: "scene", style: "anime" });
  keep("scn-b", { world: "babel", kind: "scene", style: "anime" });
  fb.setOwnerDown("scn-a", [], now); fb.setOwnerDown("scn-b", [], now);
  // fridge = clear flag, keep serving
  assert.deepEqual(fb.stampOwnerDown("scn-a", "fridge"), { ok: true, outcome: "fridge", serving: true });
  assert.equal(lib.getAsset("scn-a").ownerFeedback, undefined, "flag cleared");
  assert.ok(lib.assetExists("scn-a"), "still on disk");
  // trash = owner-stamped destroy
  const r = fb.stampOwnerDown("scn-b", "trash");
  assert.equal(r.destroyed, true);
  assert.equal(lib.assetExists("scn-b"), false, "destroyed only by the explicit owner stamp");
});

test("JOB 3.5: a verdict for a destroyed asset is orphaned DATA in the log, never a crash", () => {
  keep("scn-dead", { world: "babel", kind: "scene" });
  fb.appendVerdict({ ...fb.buildVerdictRecord({ uri: uriOf("scn-dead"), verdict: "down", reasons: [] }), at: now });
  lib.destroyAsset("scn-dead");
  // building a record for a now-gone asset does not throw; the log line already written stays.
  assert.doesNotThrow(() => fb.buildVerdictRecord({ uri: uriOf("scn-dead"), verdict: "down", reasons: [] }));
  const logged = fs.readFileSync(process.env.NOTDND_OWNER_VERDICTS_PATH, "utf8");
  assert.match(logged, /scn-dead/, "the historical verdict survives the asset");
  // stamping a gone asset is handled, not a crash
  assert.equal(fb.stampOwnerDown("scn-dead", "trash").ok, false);
});

test("JOB 4.2: the dataset lives on disk, independent of the control being enabled", () => {
  process.env.NOTDND_BETA_THUMB = "false"; // kill the UI
  const before = fs.readFileSync(process.env.NOTDND_OWNER_VERDICTS_PATH, "utf8");
  assert.ok(before.length > 0, "verdicts persist in the JSONL regardless of the flag");
  process.env.NOTDND_BETA_THUMB = "true";
});
