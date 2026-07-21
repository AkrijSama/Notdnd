// C4 — GAME-OVER (per-world death law). The dying loop resolves to a real END: death is
// TERMINAL (run marked dead, unresumable), the game-over screen shows a per-world epilogue
// (Babel: the soul-law), and "Return to your adventures" closes to the lobby. Death is
// gated on the terminal verdict (status === "dead"), NEVER on merely hitting 0 HP (dying is
// recoverable — pre-mortem a).
import test from "node:test";
import assert from "node:assert/strict";
import { renderSoloSceneShell, deathEpilogue, DEATH_LAW_EPILOGUE } from "../src/components/soloSceneShell.js";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { isDead, isDying, applyDamage } from "../server/solo/death.js";

test("death is the TERMINAL verdict (status dead), not merely 0 HP (dying is recoverable)", () => {
  const run = createDefaultSoloRun({ runId: "go" });
  run.player.resources = { hitPoints: { current: 2, max: 9 } };
  applyDamage(run, 5); // -> 0 HP
  assert.equal(isDying(run), true, "0 HP is DYING (recoverable), not dead");
  assert.equal(isDead(run), false, "0 HP alone is NOT the game-over gate (pre-mortem a)");
});

test("the game-over screen renders a per-world epilogue (Babel soul-law) + returns to lobby", () => {
  const html = renderSoloSceneShell({
    deathScreen: true,
    runSummary: { playerName: "Kael", location: "the Waking Mile", outcome: "died" },
    scene: { world: { variant: "babel" } }
  });
  assert.match(html, /solo-death-screen/, "the game-over screen renders");
  assert.match(html, /You Died/);
  assert.match(html, /solo-death-epilogue/, "a per-world epilogue line is present");
  assert.match(html, /Green Static releases its hold/, "Babel's soul-law epilogue");
  assert.match(html, /data-solo-home/, "returns cleanly to the lobby");
});

test("deathEpilogue keys on the world; a non-Babel run gets the generic close", () => {
  assert.equal(deathEpilogue({ scene: { world: { variant: "babel" } } }, {}), DEATH_LAW_EPILOGUE.babel);
  assert.match(deathEpilogue({}, {}), /goes on without you/, "generic close for a worldgen/custom run");
  // no em-dash leak in the epilogue copy family
  for (const line of [DEATH_LAW_EPILOGUE.babel, deathEpilogue({}, {})]) assert.doesNotMatch(line, /—/);
});
