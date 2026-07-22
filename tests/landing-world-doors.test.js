// LANDING MAKEOVER — WORLDS ARE THE DOOR (2026-07-21).
// The old lone "Start a New Adventure" button is gone; the world cards themselves are
// the entry, single-sourced (renderWorldDoors) so the onboarding catalogue and the
// home landing render the SAME doors. This net locks that door surface.
import test from "node:test";
import assert from "node:assert/strict";
import { renderWorldDoors } from "../src/components/onboardingFlow.js";

test("world doors: the built-in world card is a clickable entry (data-world-scenario)", () => {
  const html = renderWorldDoors();
  assert.match(html, /data-world-scenario="babel"/, "babel is a world door, not a button target");
  assert.match(html, /Tower of Babel/, "the world's title renders on its card");
  assert.match(html, /onb-world-card-art/, "the card carries an art slot the library serve can swap");
});

test("world doors: the '+ Create a world' tile is present and distinct (no fake world card)", () => {
  const html = renderWorldDoors();
  assert.match(html, /data-world-create="1"/, "creating a world is a distinct tile");
  assert.match(html, /Create a world/);
});

test("world doors: a player's own worlds ride along as doors (data-world-userworld)", () => {
  const html = renderWorldDoors({ userWorlds: [{ userWorldId: "uw_1", title: "Saltmarsh", hook: "mine" }] });
  assert.match(html, /data-world-userworld="uw_1"/, "a user world is selectable straight from the doors");
  assert.match(html, /Saltmarsh/);
});

test("world doors: NO 'Start a New Adventure' button — worlds ARE the door", () => {
  const html = renderWorldDoors({ userWorlds: [] });
  assert.doesNotMatch(html, /Start a New Adventure/i, "the generic start button is dead");
  assert.doesNotMatch(html, /start-new-adventure/i);
});
