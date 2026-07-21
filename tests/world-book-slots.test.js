// THE SLOT-REGISTRY LAW (steel/furniture split, owner 2026-07-21).
//
// The registry (WORLD_BOOK_SLOTS) is the ONE place a furniture slot declares its
// mint-default, so the creator flow, compileWorldBook, and the bill-of-materials
// manifest can never drift. These tests are the enforcement:
//
//   1. NO SLOT MAY BE DEFAULT-LESS  — the {name,vibe}-plays law in executable form.
//   2. The registry covers the declared vocabulary (WORLD_BOOK_FIELDS).
//   3. The manifest can READ every declared slot (no slot invisible to the BOM).
//   4. A bare {name,vibe} book compiles and reports zero empty slots.
//   5. Babel's manifest matches the known ledger (its gaps are the planned slots).
import test from "node:test";
import assert from "node:assert/strict";
import {
  WORLD_BOOK_SLOTS,
  WORLD_BOOK_FIELDS,
  defaultlessSlots,
  compileWorldBook
} from "../server/campaign/worldBook.js";
import { worldBookManifest, formatManifest } from "../server/campaign/worldBookManifest.js";

test("LAW: no furniture slot is default-less ({name,vibe} always plays)", () => {
  const offenders = defaultlessSlots();
  assert.deepEqual(
    offenders.map((s) => s.path),
    [],
    `every slot must declare a default, a mint, or be 'planned' — offenders: ${offenders.map((s) => s.path).join(", ")}`
  );
});

test("the registry covers the declared world-book vocabulary", () => {
  const roots = new Set(WORLD_BOOK_SLOTS.map((s) => s.path.split(".")[0]));
  const missing = WORLD_BOOK_FIELDS.filter((f) => !roots.has(f));
  assert.deepEqual(missing, [], `WORLD_BOOK_FIELDS entries absent from the slot registry: ${missing.join(", ")}`);
});

test("every declared slot is readable by the manifest (none invisible to the BOM)", () => {
  const manifest = worldBookManifest({ name: "Probe", vibe: "a test world" });
  const reported = new Set(manifest.slots.map((s) => s.path));
  for (const slot of WORLD_BOOK_SLOTS) {
    assert.ok(reported.has(slot.path), `slot ${slot.path} is declared but the manifest cannot read it`);
  }
  assert.equal(manifest.slots.length, WORLD_BOOK_SLOTS.length);
});

test("a bare {name,vibe} world: zero empty slots, and it compiles to a valid scenario", () => {
  const manifest = worldBookManifest({ name: "Thinworld", vibe: "quiet and strange" });
  const empties = manifest.slots.filter((s) => s.status === "empty");
  assert.deepEqual(empties.map((s) => s.path), [], "a named world must have no empty slot");
  assert.equal(manifest.summary.lawHolds, true);
  // name + vibe are the two the author gave; everything live else is engine-covered.
  assert.equal(manifest.summary.filled, 2);

  const { validation } = compileWorldBook({ name: "Thinworld", vibe: "quiet and strange" });
  assert.equal(validation.ok, true, `thin world must compile: ${JSON.stringify(validation.errors)}`);
});

test("an unnamed world is the ONE legal empty slot (name is required)", () => {
  const manifest = worldBookManifest({ vibe: "nameless" });
  const empties = manifest.slots.filter((s) => s.status === "empty").map((s) => s.path);
  assert.deepEqual(empties, ["name"]);
  assert.equal(manifest.summary.lawHolds, true, "an empty `name` is the declared exception");
});

test("babel's manifest: gaps are the PLANNED slots (the known ledger)", () => {
  const manifest = worldBookManifest("babel");
  assert.equal(manifest.summary.lawHolds, true);
  assert.equal(manifest.summary.empty, 0, "babel has no empty slot");
  // The owner's ledger: babel's real gaps are key figures + handbook chapters
  // (ROADMAP-CANON's locked 'Law of Creating Worlds' shape), not engine coverage.
  assert.ok(manifest.summary.plannedSlots.includes("figures"), "key figures is a known gap");
  assert.ok(manifest.summary.plannedSlots.includes("handbook"), "handbook chapters is a known gap");
  // Babel is the reference filled world — it should author the large majority of LIVE slots.
  assert.ok(manifest.summary.authoredPct >= 80, `babel should be richly authored, got ${manifest.summary.authoredPct}%`);
});

test("the dead-slot ledger is surfaced, not hidden (secrets is validated then discarded)", () => {
  const manifest = worldBookManifest("babel");
  assert.ok(
    manifest.summary.deadSlots.includes("secrets"),
    "secrets is required + exhaustively validated but never loaded into the run — the BOM must say so"
  );
});

test("formatManifest renders every slot and the law verdict", () => {
  const text = formatManifest(worldBookManifest("babel"));
  for (const slot of WORLD_BOOK_SLOTS) assert.ok(text.includes(slot.path), `manifest omits ${slot.path}`);
  assert.match(text, /\{name,vibe\}-plays law: HOLDS/);
});
