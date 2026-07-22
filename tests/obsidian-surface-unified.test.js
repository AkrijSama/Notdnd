// OBSIDIAN SURFACE UNITY (owner stamp 2026-07-22). Obsidian is the chosen surface
// variant (the softer matte sheen); Polished is NOT selected. The lobby resolves its
// surface tokens from styles.css :root, while a live RUN applies SOLO_SKINS.ashen as an
// INLINE style on the shell — TWO copies of the same Obsidian values. They once diverged
// (lobby obsidian, run gray) and nothing caught it because a stylesheet read is not a
// door read. This locks the two copies together so the run surface can never silently
// drift off the lobby's Obsidian again.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOLO_SKINS } from "../src/components/soloSceneShell.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(here, "../src/styles.css"), "utf8");
// The FIRST :root { ... } block is the Obsidian default (before the * reset).
const rootBlock = css.slice(css.indexOf(":root {"), css.indexOf("}\n\n*"));
const rootVar = (name) => {
  const m = rootBlock.match(new RegExp("--" + name.replace(/-/g, "\\-") + ":\\s*([^;]+);"));
  return m ? m[1].trim().toLowerCase() : undefined;
};

const ashen = SOLO_SKINS.ashen;

test("the RUN's Obsidian color tokens equal the lobby :root Obsidian (no drift)", () => {
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
  assert.deepEqual(mismatches, [], "run Obsidian tokens drifted from the lobby :root:\n" + mismatches.join("\n"));
});

test("the chosen surface is Obsidian (softer matte), not Polished — the signature values", () => {
  // Obsidian default: --bg #06070a, softer glass sheen. Polished (:root[data-leather=polished])
  // deepens --bg to #05060b and raises the sheen alpha. Assert the RUN carries the Obsidian bg.
  assert.equal(String(ashen["--bg"]).toLowerCase(), "#06070a", "the run surface must be Obsidian --bg, not Polished #05060b");
  assert.equal(rootVar("bg"), "#06070a", "the lobby :root default must be Obsidian --bg");
});

test("Polished is a variant, not the default: :root default has no data-leather requirement", () => {
  // The default :root block must NOT be gated on [data-leather="polished"]. If Obsidian were
  // ever moved behind that attribute, the app (which never sets data-leather) would fall back
  // to whatever raw :root held. Confirm the Obsidian tokens live in the UNGATED :root.
  assert.ok(/^:root \{/.test(css.trim()) || css.indexOf(":root {") < css.indexOf(':root[data-leather'), "Obsidian must be the ungated :root default, ahead of the polished variant block");
});
