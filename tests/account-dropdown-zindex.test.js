// ACCOUNT DROPDOWN STACKING (2026-07-18). The dropdown rendered BEHIND lower
// panels because .topbar's `backdrop-filter` creates a stacking context that
// trapped the dropdown. The header must sit above all content AND the drawer tier
// (roll-history / character drawers = z-index 40), below true modals (VN 80 / 90).
// CSS-text assertions in the existing string/geometry test idiom (no jsdom).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const css = fs.readFileSync(path.resolve("src/styles.css"), "utf8");

// z-index of the FIRST occurrence of a selector's rule block.
function zIndexOf(selector) {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const m = css.match(re);
  if (!m) return null;
  const z = m[1].match(/z-index:\s*(\d+)/);
  return z ? Number(z[1]) : null;
}

test(".topbar establishes a stacking context (backdrop-filter) — the trap being fixed", () => {
  const m = css.match(/\.topbar\s*\{([^}]*)\}/);
  assert.ok(m, ".topbar rule exists");
  assert.match(m[1], /backdrop-filter/, "backdrop-filter is what creates the trapping context");
});

test("the header (.solo-topbar) is lifted above content and the drawer tier", () => {
  const header = zIndexOf(".solo-topbar");
  assert.ok(Number.isFinite(header), ".solo-topbar has an explicit z-index");
  // roll-history / character drawers are the tier the dropdown must beat.
  const drawerBackdrop = zIndexOf(".solo-roll-history-backdrop");
  assert.ok(Number.isFinite(drawerBackdrop), "a drawer tier z-index exists to compare against");
  assert.ok(header > drawerBackdrop, `header z (${header}) must beat the drawer tier (${drawerBackdrop})`);
  assert.ok(header >= 50, "header sits at/above the dropdown tier (50)");
});

test("the header stays BELOW the true full-screen modals (VN / NPC)", () => {
  const header = zIndexOf(".solo-topbar");
  const vn = zIndexOf(".solo-vn-overlay");
  const npc = zIndexOf(".solo-npc-modal-overlay");
  assert.ok(header < vn, `header (${header}) below VN overlay (${vn})`);
  assert.ok(header < npc, `header (${header}) below NPC modal (${npc})`);
});

test(".account-dropdown still carries its own z-index (defensive)", () => {
  assert.ok(Number.isFinite(zIndexOf(".account-dropdown")), ".account-dropdown has a z-index");
});
