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

test("cards are image-led: key art + title + one hook line, per-world DATA", () => {
  const html = renderOnboardingFlow(worldState());
  assert.match(html, /onb-world-card-art/, "cards carry key art");
  assert.match(html, /src="\/public\/assets\/art-illustrated\.jpg"/, "Babel placeholder art from committed assets");
  assert.match(html, /onb-world-card-title">Babel</, "Babel titled plainly (no Wrong Woods suffix)");
  assert.doesNotMatch(html, /Wrong Woods/);
  assert.match(html, /Wake in a strange land\. Answer the call\. Climb\./, "Babel hook line");
  assert.match(html, /onb-world-card-title">Custom World</);
  assert.match(html, /A world imagined for you\./);
  // data-driven: the card list is exported data, not markup
  assert.equal(WORLD_SELECT_CARDS.length, 2);
  assert.ok(WORLD_SELECT_CARDS.every((c) => c.title && c.hook && c.art));
});

test("selection state is visible and continue wiring (data-world-scenario) is unchanged", () => {
  const babel = renderOnboardingFlow(worldState({ scenarioId: "babel" }));
  assert.match(babel, /onb-world-card active" data-world-scenario="babel" aria-pressed="true"/);
  assert.match(babel, /onb-world-card " data-world-scenario="" aria-pressed="false"/);
  const custom = renderOnboardingFlow(worldState({ scenarioId: "" }));
  assert.match(custom, /onb-world-card active" data-world-scenario="" aria-pressed="true"/);
  // the same data-world-scenario hook the existing binding + continue flow use
  assert.match(babel, /data-world-scenario="babel"/);
});
