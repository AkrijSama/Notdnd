// THE CUSTOM WORLD CREATOR (client). String-render + reducers + dispatch. Asserts the
// data-* hooks, the 5-step flow surfaces, the collapsed defaults drawer, the world-select
// integration, and the Worlds-law taxonomy ("world"/"draft", never "template").
import assert from "node:assert/strict";
import test from "node:test";
import {
  renderWorldCreator, dispatchWorldCreatorClick, defaultWorldCreatorState,
  creatorStartInterview, creatorAnswer, creatorSkip, creatorJustBuild,
  creatorCreateReview, creatorKeep, creatorKill, creatorReplace
} from "../src/components/worldCreator.js";
import { renderOnboardingFlow } from "../src/components/onboardingFlow.js";

const draft = {
  identity: { name: "Neon Reach", tagline: "rain" }, cosmology: "gods of weather",
  pois: [{ id: "poi_1", name: "District 1", poiClass: "settlement", description: "a place", dangerLevel: 1 }],
  factions: [{ id: "f1", name: "Zaibatsu", disposition: "hostile", wants: "control" }],
  threatLadder: [{ id: "t0", rung: "drones", rarity: "common" }]
};

// ── render: the five steps ───────────────────────────────────────────────────

test("SPARK step: one input, begin + just-build affordances", () => {
  const html = renderWorldCreator({ substep: "spark", spark: "neon city" });
  assert.match(html, /data-wc-input="spark"/);
  assert.match(html, /data-wc-action="begin"/);
  assert.match(html, /data-wc-action="just-build-from-spark"/);
  assert.match(html, /Describe your world/i);
});

test("INTERVIEW step: one question at a time, skippable, just-build, with progress", () => {
  const iv = creatorStartInterview("neon city");
  const html = renderWorldCreator({ substep: "interview", interview: iv, answerDraft: "" });
  assert.match(html, /Question 1 of 7/);
  assert.match(html, /data-wc-input="answerDraft"/);
  assert.match(html, /data-wc-action="answer"/);
  assert.match(html, /data-wc-action="skip"/);
  assert.match(html, /data-wc-action="just-build"/);
});

test("REVIEW step: keep/twist/kill cards + step-in + collapsed defaults drawer", () => {
  const review = creatorCreateReview(draft);
  const html = renderWorldCreator({ substep: "review", review });
  assert.match(html, /Neon Reach/);
  assert.match(html, /District 1/);
  assert.match(html, /data-wc-action="twist-open"[^>]*data-wc-section="pois"/);
  assert.match(html, /data-wc-action="kill"/);
  assert.match(html, /data-wc-action="step-in"/);
  assert.match(html, /data-wc-action="toggle-defaults"/);
  // The advanced stub is BEHIND the drawer (collapsed by default).
  assert.doesNotMatch(html, /coming soon/i, "advanced stub hidden while the drawer is collapsed");
  const open = renderWorldCreator({ substep: "review", review, defaultsOpen: true });
  assert.match(open, /coming soon/i, "advanced stub appears when the drawer is opened");
  assert.match(open, /data-wc-input="override:era"/);
});

test("a twist card open state renders its one-line instruction input", () => {
  const review = creatorCreateReview(draft);
  const html = renderWorldCreator({ substep: "review", review, twistOpen: { section: "pois", id: "poi_1" } });
  assert.match(html, /data-wc-input="twistText"/);
  assert.match(html, /data-wc-action="twist-submit"[^>]*data-wc-id="poi_1"/);
});

// ── Worlds-law taxonomy: never "template" on the creator surfaces ─────────────

test("no banned 'template' taxonomy anywhere in the creator (Worlds law)", () => {
  const surfaces = [
    renderWorldCreator({ substep: "spark", spark: "" }),
    renderWorldCreator({ substep: "interview", interview: creatorStartInterview("x") }),
    renderWorldCreator({ substep: "review", review: creatorCreateReview(draft), defaultsOpen: true })
  ].join("\n");
  assert.doesNotMatch(surfaces, /\btemplate/i);
});

// ── world-select integration ─────────────────────────────────────────────────

test("world-select renders the CREATE tile (T6) AND the user's own worlds", () => {
  const html = renderOnboardingFlow({ step: "world", worldDef: {}, userWorlds: [{ userWorldId: "uw_x", title: "Neon Reach", hook: "rain", art: null }] });
  // T6: the fake "Custom World" card is GONE — a distinct "+ Create a world" tile stands in
  assert.doesNotMatch(html, /data-world-scenario=""/, "no empty-scenario Custom World card");
  assert.match(html, /data-world-create="1"/, "the distinct create-world tile");
  assert.match(html, /data-world-userworld="uw_x"/, "the user's saved world card");
  assert.match(html, /Neon Reach/);
  assert.match(html, /Yours/, "user worlds are badged Yours");
});

test("onboarding routes the world_create step to the creator", () => {
  const html = renderOnboardingFlow({ step: "world_create", worldCreator: { substep: "spark", spark: "" } });
  assert.match(html, /data-wc-root/);
});

// ── dispatch + reducers ──────────────────────────────────────────────────────

test("dispatchWorldCreatorClick routes an action with its section/id", () => {
  let got = null;
  const target = { closest: (s) => (s === "[data-wc-action]" ? { getAttribute: (a) => ({ "data-wc-action": "kill", "data-wc-section": "pois", "data-wc-id": "poi_1" }[a]) } : null) };
  assert.equal(dispatchWorldCreatorClick(target, { onWcAction: (a, args) => (got = { a, args }) }), true);
  assert.deepEqual(got, { a: "kill", args: { section: "pois", id: "poi_1" } });
  assert.equal(dispatchWorldCreatorClick({ closest: () => null }, {}), false);
});

test("client interview reducers mirror the server (answer/skip/just-build)", () => {
  let iv = creatorStartInterview("x");
  iv = creatorAnswer(iv, "a tower");
  assert.equal(iv.answers.landmark.value, "a tower");
  iv = creatorSkip(iv);
  assert.equal(iv.answers.remnant.skipped, true);
  iv = creatorJustBuild(iv);
  assert.equal(iv.status, "ready");
});

test("client review reducers (keep/kill/replace) match the server surface", () => {
  let review = creatorCreateReview(draft);
  review = creatorKill(review, "pois", "poi_1");
  assert.equal(review.pois[0].status, "killed");
  review = creatorKeep(review, "pois", "poi_1");
  assert.equal(review.pois[0].status, "keep");
  review = creatorReplace(review, "pois", "poi_1", { name: "New", poiClass: "x" });
  assert.equal(review.pois[0].name, "New");
});

test("defaultWorldCreatorState starts on the spark step", () => {
  assert.equal(defaultWorldCreatorState().substep, "spark");
});
