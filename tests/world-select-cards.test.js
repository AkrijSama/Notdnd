import assert from "node:assert/strict";
import test from "node:test";
import { renderOnboardingFlow, WORLD_SELECT_CARDS } from "../src/components/onboardingFlow.js";

// Item 2 (client-clearout): the world-select screen is image-led cards with
// PLAYER-FACING copy only — system jargon is banned on this screen.

const worldState = (def = {}) => ({
  step: "world",
  mode: "world",
  worldDef: { scenarioId: "babel", ...def },
  worldLoading: false
});

const BANNED_JARGON = ["VOICE", "STATUS WINDOW", "cast", "configure", "authored"];

test("world-select screen contains ZERO system jargon (banned strings absent)", () => {
  for (const def of [{ scenarioId: "babel" }, { scenarioId: "" }]) {
    const html = renderOnboardingFlow(worldState(def));
    for (const word of BANNED_JARGON) {
      assert.ok(
        !html.toLowerCase().includes(word.toLowerCase()),
        `banned string "${word}" leaked into the world-select screen (scenarioId="${def.scenarioId}")`
      );
    }
  }
});

test("cards are image-led: key art + title + one hook line, per-world DATA (T5/T6)", () => {
  const html = renderOnboardingFlow(worldState());
  assert.match(html, /onb-world-card-art/, "cards carry key art");
  assert.match(html, /src="\/public\/assets\/art-illustrated\.jpg"/, "Babel placeholder art from committed assets");
  // T5: the Babel card reads "The Tower of Babel" + an isekai genre tag
  assert.match(html, /onb-world-card-title">The Tower of Babel</, "Babel titled 'The Tower of Babel'");
  assert.doesNotMatch(html, /Wrong Woods/);
  assert.match(html, /class="onb-genre-tag">isekai</, "isekai genre tag renders");
  assert.match(html, /Wake in a strange land\. Answer the call\. Climb\./, "Babel hook line");
  // T6: the fake "Custom World" card is GONE; a distinct create tile stands in its place
  assert.doesNotMatch(html, /onb-world-card-title">Custom World</);
  assert.match(html, /data-world-create="1"/, "a distinct create-world tile");
  // data-driven: the card list is exported data (now just the authored world; create is a tile)
  assert.equal(WORLD_SELECT_CARDS.length, 1);
  assert.ok(WORLD_SELECT_CARDS.every((c) => c.title && c.hook && c.art));
});

test("selection state is visible and the ready-made continue wiring (data-world-scenario) is unchanged", () => {
  const babel = renderOnboardingFlow(worldState({ scenarioId: "babel" }));
  assert.match(babel, /onb-world-card active" data-world-scenario="babel" aria-pressed="true"/);
  // the same data-world-scenario hook the existing binding + continue flow use
  assert.match(babel, /data-world-scenario="babel"/);
  // T6: no empty-scenario fake card remains; creating a world is the distinct tile
  assert.doesNotMatch(babel, /data-world-scenario="" aria-pressed/);
});
