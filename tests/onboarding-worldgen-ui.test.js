import assert from "node:assert/strict";
import test from "node:test";
import { renderOnboardingFlow } from "../src/components/onboardingFlow.js";

test("world-definition step renders fields, chips, art styles, and disclaimer", () => {
  const html = renderOnboardingFlow({ step: "world", worldDef: { tone: "grimdark", artStyle: "anime" } });
  assert.match(html, /Define Your World/);
  assert.match(html, /imagined by the AI/);
  assert.match(html, /data-world-field="name"/);
  assert.match(html, /data-world-field="flavor"/);
  assert.match(html, /data-action="generate-world"/);
  // selected tone chip is active
  assert.match(html, /class="onb-chip active" data-world-tone="grimdark"/);
  // selected art style is active
  assert.match(html, /class="onb-art-card active" data-world-artstyle="anime"/);
  // The starting-location-type picker was removed from the sandbox flow (sandbox
  // defaults to forest-ruins engine-side); assert it is genuinely gone.
  assert.doesNotMatch(html, /data-world-loctype/);
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

test("world-definition step escapes user input", () => {
  const html = renderOnboardingFlow({ step: "world", worldDef: { name: '"><script>x</script>' } });
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});
