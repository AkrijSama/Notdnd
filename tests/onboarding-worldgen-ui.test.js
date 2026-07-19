import assert from "node:assert/strict";
import test from "node:test";
import { renderOnboardingFlow } from "../src/components/onboardingFlow.js";

test("CARD-LED landing: the world step is world cards only — no inline form, no start button", () => {
  const html = renderOnboardingFlow({ step: "world", worldDef: {}, userWorlds: [] });
  assert.match(html, /Choose Your World/);
  assert.match(html, /onb-world-cards/, "the cards are the landing");
  assert.match(html, /data-world-scenario="babel"/, "the Babel card");
  assert.match(html, /data-world-scenario=""/, "the Custom World card");
  // the legacy inline worldgen form + its start button are GONE (the card is the entry)
  assert.doesNotMatch(html, /data-action="generate-world"/, "no Generate/Continue start button");
  assert.doesNotMatch(html, /data-world-field="name"/, "no inline world-name input");
  assert.doesNotMatch(html, /data-world-field="flavor"/, "no inline flavor input");
  assert.doesNotMatch(html, /data-world-artstyle/, "no inline art picker (custom picks in the wizard)");
});

test("world-preview step renders the generated world + confirm/regenerate controls", () => {
  const html = renderOnboardingFlow({
    step: "world_preview",
    worldPreview: {
      name: "The Test Realm",
      description: "A grim place of rust and oaths.",
      tone: "grimdark",
      startingLocationType: "port",
      artStyle: "anime",
      startingLocation: { name: "Iron Harbor", description: "Salt and smoke cling to the docks." }
    }
  });
  assert.match(html, /The Test Realm/);
  assert.match(html, /A grim place of rust and oaths/);
  assert.match(html, /Iron Harbor/);
  assert.match(html, /Salt and smoke cling to the docks/);
  assert.match(html, /data-action="confirm-world"/);
  assert.match(html, /data-action="regenerate-world"/);
  assert.match(html, /data-world-regen-field="description"/);
  assert.match(html, /data-world-regen-field="startingLocationDescription"/);
});

test("the landing escapes user-world card content", () => {
  const html = renderOnboardingFlow({ step: "world", worldDef: {}, userWorlds: [{ userWorldId: "uw_x", title: '"><script>x</script>', tagline: "t" }] });
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});
