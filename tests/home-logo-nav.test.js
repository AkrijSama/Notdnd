// T1 — HOME LOGO CLICKABLE. The header mark+wordmark is a LINK to the landing/home in
// both header states (guest + logged-in) and in-run; it confirms before navigating away
// when there is in-progress work (an open run's unsent turn, or a half-built character),
// so drafts/turns are never silently abandoned.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderBrand } from "../src/components/brand.js";
import { renderSceneHeader } from "../src/components/soloSceneShell.js";
import { shouldConfirmHomeNav, HOME_NAV_CONFIRM } from "../src/components/homeNav.js";

const mainSrc = fs.readFileSync(path.resolve("src/main.js"), "utf8");
const styles = fs.readFileSync(path.resolve("src/styles.css"), "utf8");

test("the interactive brand is a keyboard-reachable home link (data-action, role, aria) — mark preserved", () => {
  const out = renderBrand();
  assert.match(out, /data-action="go-home"/, "carries the go-home hook");
  assert.match(out, /role="link"/, "exposed as a link");
  assert.match(out, /tabindex="0"/, "keyboard-reachable");
  assert.match(out, /aria-label="Go to the home screen"/, "accessible name present");
  assert.doesNotMatch(out, /—/, "no em-dash in the brand markup (honesty/string net)");
  // the mark + wordmark still render, mark before the title
  assert.match(out, /class="brand-logo"/);
  assert.ok(out.indexOf("brand-logo") < out.indexOf("Inkborne"), "mark precedes the title");
});

test("interactive:false renders the plain lockup (no home hook) for static contexts", () => {
  const out = renderBrand({ interactive: false });
  assert.doesNotMatch(out, /data-action="go-home"/);
  assert.match(out, /class="brand"/);
  assert.match(out, /Inkborne/);
});

test("BOTH home header states carry the go-home brand (one shared renderBrand in renderSoloHeader)", () => {
  // renderSoloHeader is the single header for guest AND logged-in; it renders the brand
  // once via renderBrand() (now the go-home link), so both states get it by construction.
  assert.match(mainSrc, /function renderSoloHeader\(/);
  assert.match(mainSrc, /\$\{renderBrand\(\)\}/, "header uses the shared (interactive) brand");
});

test("the IN-RUN scene header also carries the clickable home brand", () => {
  const out = renderSceneHeader({ runId: "run_x", location: { name: "The Waking Mile" } }, {});
  assert.match(out, /data-action="go-home"/, "in-run brand is a home link too");
  assert.match(out, /class="brand-logo"/, "the mark renders in-run");
});

test("confirm GATE: confirm when in a run OR mid character-creation; not on the landing", () => {
  // in a run — an unsent turn may be lost
  assert.equal(shouldConfirmHomeNav({ inRun: true, onboardingStep: "inactive" }), true);
  // mid character-creation — a portrait draft / entered fields
  assert.equal(shouldConfirmHomeNav({ inRun: false, onboardingStep: "character" }), true);
  assert.equal(shouldConfirmHomeNav({ inRun: false, onboardingStep: "world_create" }), true);
  assert.equal(shouldConfirmHomeNav({ inRun: false, onboardingStep: "arrival" }), true);
  // on the landing / world-select / inactive — no confirm, just navigate
  assert.equal(shouldConfirmHomeNav({ inRun: false, onboardingStep: "world" }), false);
  assert.equal(shouldConfirmHomeNav({ inRun: false, onboardingStep: "inactive" }), false);
  assert.equal(shouldConfirmHomeNav({}), false, "defaults to no confirm");
  // the confirm copy carries no em-dash (honesty-string em-dash net, T7)
  assert.doesNotMatch(HOME_NAV_CONFIRM, /—/, "no em-dash in the confirm string");
});

test("the go-home handler navigates to the landing (strips ?soloRunId) and is confirm-gated", () => {
  // main.js goHome() checks shouldConfirmHomeNav and, when it returns true, gates on
  // window.confirm before navigating to pathname-only (drops the run param).
  assert.match(mainSrc, /function goHome\(/);
  assert.match(mainSrc, /shouldConfirmHomeNav\(/, "handler consults the gate");
  assert.match(mainSrc, /window\.confirm\(HOME_NAV_CONFIRM\)/, "confirm gate wired");
  assert.match(mainSrc, /window\.location\.href = window\.location\.pathname/, "home = pathname only");
});

test("the brand home link has cursor + hover affordance (both states)", () => {
  const rule = styles.match(/\.brand--home\s*\{([^}]*)\}/);
  assert.ok(rule, ".brand--home rule exists");
  assert.match(rule[1], /cursor:\s*pointer/, "cursor pointer");
  assert.match(styles, /\.brand--home:hover\s*\{/, "hover affordance present");
});
