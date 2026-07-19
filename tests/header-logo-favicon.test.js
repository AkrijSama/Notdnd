// HEADER LOGO + FAVICON (item 7). The mark renders left of the title in BOTH header
// states, theme-inverts (currentColor mask), and a favicon (SVG + PNG) is present.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderBrand } from "../src/components/brand.js";

const styles = fs.readFileSync(path.resolve("src/styles.css"), "utf8");
const html = fs.readFileSync(path.resolve("index.html"), "utf8");
const mainSrc = fs.readFileSync(path.resolve("src/main.js"), "utf8");

test("brand lockup renders the mark left of the wordmark", () => {
  const out = renderBrand();
  assert.match(out, /class="brand-logo"/, "the mark element is present");
  assert.match(out, /Inkborne/);
  assert.match(out, /AI RPG/);
  // mark comes BEFORE the text in source order (left of it in a flex row)
  assert.ok(out.indexOf("brand-logo") < out.indexOf("Inkborne"), "mark precedes the title");
});

test("the mark is in BOTH header states (one shared brand in renderSoloHeader)", () => {
  // renderSoloHeader is used for guest AND logged-in; it renders the brand once via
  // renderBrand(), so the mark is in both states by construction.
  assert.match(mainSrc, /function renderSoloHeader\(/);
  assert.match(mainSrc, /\$\{renderBrand\(\)\}/, "header uses the shared brand");
  assert.doesNotMatch(mainSrc, /<div class="brand">\s*<h1>Inkborne/, "no stale hardcoded brand remains");
});

test("the mark theme-inverts (currentColor mask, both themes) + no layout shift", () => {
  const rule = styles.match(/\.brand-logo\s*\{([^}]*)\}/);
  assert.ok(rule, ".brand-logo rule exists");
  const body = rule[1];
  assert.match(body, /background-color:\s*(currentColor|var\()/, "color is currentColor/var — not a baked hex");
  assert.match(body, /mask:[^;]*logo\.svg/, "painted via a mask of the logo asset");
  assert.match(body, /height:\s*1\.2em/, "sized to the type (vertically centered)");
  assert.match(body, /width:\s*1\.2em/, "fixed box → no layout shift");
});

test("favicon is present (SVG + PNG fallback) and wired in index.html", () => {
  assert.match(html, /rel="icon"\s+type="image\/svg\+xml"\s+href="[^"]*favicon\.svg"/);
  assert.match(html, /rel="icon"\s+type="image\/png"[^>]*href="[^"]*favicon\.png"/);
  assert.ok(fs.existsSync(path.resolve("src/assets/logo.svg")), "logo.svg committed");
  assert.ok(fs.existsSync(path.resolve("src/assets/favicon.svg")), "favicon.svg committed");
  assert.ok(fs.statSync(path.resolve("src/assets/favicon.png")).size > 0, "favicon.png committed + non-empty");
});

test("logo.svg is transparent + theme-ready; favicon.svg adapts to both browser themes", () => {
  const logo = fs.readFileSync(path.resolve("src/assets/logo.svg"), "utf8");
  assert.doesNotMatch(logo, /<rect[^>]*width="(64|100%|200)"[^>]*height="(64|100%|300)"/, "no full-bleed background rect (stays transparent)");
  assert.match(logo, /matrix\(-1|scale\(-1/, "vertical mirror symmetry (Rorschach)");
  const fav = fs.readFileSync(path.resolve("src/assets/favicon.svg"), "utf8");
  assert.match(fav, /prefers-color-scheme:\s*dark/, "favicon swaps fill for dark tab bars");
  assert.match(fav, /#16233a/, "brand ink for light tab bars");
});
