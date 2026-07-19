// PART C (shared-component gap): the condition-chip idiom is a SHARED component
// (conditionChips.js) — markup + the .solo-cond-chip cond-<kind> class contract —
// so CLI 2's battle surface reuses the exact same chip, not portrait-only styling.
import assert from "node:assert/strict";
import test from "node:test";
import { renderConditionChip, renderConditionChipRow } from "../src/components/conditionChips.js";

const kindMeta = (k) => ({ buff: { glyph: "✚", word: "Boon", order: 0 }, debuff: { glyph: "▼", word: "Affliction", order: 4 } }[String(k || "").toLowerCase()] || { glyph: "•", word: "Status", order: 2 });
const knownKind = (k) => ["buff", "debuff"].includes(String(k || "").toLowerCase());
const fmt = (m) => (m > 0 ? `${m}m` : "");

test("shared chip renders the contract class + glyph + tooltip (any surface can call it)", () => {
  const chip = renderConditionChip({ id: "c1", name: "Chilled", kind: "debuff", effect: "Slowed.", remainingMinutes: 10 }, { compact: true, kindMeta, knownKind, formatDuration: fmt });
  assert.match(chip, /class="solo-cond-chip cond-debuff is-compact"/);
  assert.match(chip, /solo-cond-glyph/);
  assert.match(chip, /solo-cond-tip/);
  assert.match(chip, /Chilled/);
});

test("unknown kind falls to neutral (contract-safe for a battle surface's own kinds)", () => {
  const chip = renderConditionChip({ id: "x", name: "Marked", kind: "weird" }, { kindMeta, knownKind, formatDuration: fmt });
  assert.match(chip, /cond-neutral/);
});

test("row: compact caps at 4 with a '+N' overflow pill; empty → nothing", () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, kind: "buff" }));
  const row = renderConditionChipRow(many, { compact: true, cap: 4, kindMeta, knownKind, formatDuration: fmt });
  assert.equal((row.match(/solo-cond-chip cond-/g) || []).length, 4, "4 visible chips");
  assert.match(row, /solo-cond-overflow[^>]*>\+3</, "the remaining 3 collapse into +3");
  assert.equal(renderConditionChipRow([], { compact: true }), "", "empty-state → nothing");
});

test("row is stackable-safe: a stacked condition shows its count", () => {
  const row = renderConditionChipRow([{ id: "c", name: "Bleed", kind: "debuff", stacks: 3 }], { compact: true, kindMeta, knownKind, formatDuration: fmt });
  assert.match(row, /solo-cond-count[^>]*>3</);
});
