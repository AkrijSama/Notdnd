// SURFACE UNITY (owner stamp updated 2026-07-22). POLISHED is the chosen surface (deeper
// base, stronger specular sheen) after Obsidian was seen live and rejected; Obsidian is now
// the unwired :root[data-leather="obsidian"] variant. The lobby resolves its surface tokens
// from styles.css :root, while a live RUN applies SOLO_SKINS.ashen as an INLINE style on the
// shell — TWO copies of the same Polished values. They once diverged (lobby updated, run
// stale) and nothing caught it because a stylesheet read is not a door read. This locks the
// two copies together so the run surface can never silently drift off the lobby's Polished.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOLO_SKINS } from "../src/components/soloSceneShell.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(here, "../src/styles.css"), "utf8");
// The FIRST :root { ... } block is the Polished default (before the * reset).
const rootBlock = css.slice(css.indexOf(":root {"), css.indexOf("}\n\n*"));
const rootVar = (name) => {
  const m = rootBlock.match(new RegExp("--" + name.replace(/-/g, "\\-") + ":\\s*([^;]+);"));
  return m ? m[1].trim().toLowerCase() : undefined;
};

const ashen = SOLO_SKINS.ashen;

test("the RUN's Polished color tokens equal the lobby :root Polished (no drift)", () => {
  // --accent-2 is a DOCUMENTED overload: the skins reuse --accent-2 for the BRIGHT silver
  // (:root keeps --accent-2 as legacy-GM cool steel and exposes the bright value as
  // --accent-bright). So the run's --accent-2 must match :root --accent-bright, not --accent-2.
  const OVERLOADS = { "--accent-2": "accent-bright" };
  // Tokens the run adds that :root does not carry (additive run-shell tokens, not surface color).
  const RUN_ONLY = new Set(["--card-dim", "--tabbar", "--border-faint", "--text-label", "--text-faint", "--accent-grad-a", "--accent-grad-b", "--texture", "--texture-size"]);

  const mismatches = [];
  for (const [key, val] of Object.entries(ashen)) {
    if (RUN_ONLY.has(key)) continue;
    const rootName = OVERLOADS[key] || key.slice(2);
    const rv = rootVar(rootName);
    assert.ok(rv !== undefined, `:root is missing ${key} (mapped to --${rootName}) — the compare lost its anchor`);
    if (rv !== String(val).toLowerCase()) mismatches.push(`${key}: run=${val} vs :root --${rootName}=${rv}`);
  }
  assert.deepEqual(mismatches, [], "run Polished tokens drifted from the lobby :root:\n" + mismatches.join("\n"));
});

test("the chosen surface is Polished (deeper base), not Obsidian — the signature values", () => {
  // Polished default: --bg #05060b, stronger glass sheen. Obsidian (:root[data-leather=obsidian])
  // is the lighter #06070a matte variant. Assert BOTH the run AND the lobby carry Polished.
  assert.equal(String(ashen["--bg"]).toLowerCase(), "#05060b", "the run surface must be Polished --bg, not Obsidian #06070a");
  assert.equal(rootVar("bg"), "#05060b", "the lobby :root default must be Polished --bg");
  // The stronger specular: :root --glass-sheen must open at the Polished 0.11 alpha, not 0.07.
  assert.ok(/rgba\(226, 232, 240, 0\.11\)/.test(rootVar("glass-sheen") || ""), "the :root sheen must be the Polished 0.11 specular");
});

test("Polished is the default; Obsidian is the variant — the UNGATED :root holds Polished", () => {
  // The default :root block must NOT be gated on any [data-leather=...]. The app never sets
  // data-leather, so whatever the ungated :root holds is what ships. Confirm Polished lives in
  // the ungated :root, ahead of the (obsidian) variant block, and that Obsidian is behind the attr.
  assert.ok(css.indexOf(":root {") < css.indexOf(':root[data-leather'), "Polished must be the ungated :root default, ahead of the variant block");
  assert.ok(css.includes(':root[data-leather="obsidian"]'), "Obsidian must be kept as the data-leather=obsidian variant (unwired, not removed)");
  assert.ok(!css.includes(':root[data-leather="polished"]'), "there must be no polished variant block — Polished is the default now");
});
