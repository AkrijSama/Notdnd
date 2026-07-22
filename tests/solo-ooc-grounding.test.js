import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { loadScenarioFile } from "../server/campaign/scenarioLoader.js";
import { buildOocGroundingContext, buildOocSystemPrompt, OOC_FRAMING } from "../server/gm/oocGrounding.js";

// ooc-grounding (owner 2026-07-10): the OOC channel worked but the GM answering
// it was BLIND — it sent only a generic prompt + the raw question, so it asked
// the player to re-supply context that was ON SCREEN. These assert the OOC
// prompt now carries the SAME committed grounding a narration turn sees.

function groundedRun() {
  const run = createDefaultSoloRun({ runId: "run_ooc_grounding" });
  // Recent narration the player just read (the referent for a "what does that
  // mean?" question), plus a committed clock and a committed objective/quest.
  run.narration = "You burst onto the track. Black smoke rises from Hollow Pine. You have maybe five minutes to decide.";
  run.world = run.world || {};
  run.world.time = { day: 1, tick: 0, minutes: 447, clock: "07:27", phase: "day" };
  // SYSTEM LORE is now furniture (world.systemLore) — a grounded Babel-style OOC run
  // carries it so the WINDOW/VOICE world-law rides the OOC context (see below).
  run.world.systemLore = loadScenarioFile("babel").world.systemLore;
  // run.quests is an internal KEYED map (getQuestPayload reads Object.values).
  run.quests = {
    quest_momentum_smoke: {
      questId: "quest_momentum_smoke",
      status: "active",
      stage: 0,
      isMain: false,
      authoredBy: "momentum",
      title: "The smoke column",
      description: "Black smoke rose toward Hollow Pine.",
      stages: [{ objective: "Find the source of the smoke near Hollow Pine.", completion: { kind: "reach_location", targetId: "second_location" } }],
      relatedEntityIds: [],
      memoryFactIds: [],
      flags: {},
      edition: run.edition,
      policyProfileId: run.policyProfileId,
      contentTags: []
    }
  };
  return run;
}

test("OOC grounding contains the recent narration VERBATIM (the referent on screen)", () => {
  const ctx = buildOocGroundingContext(groundedRun());
  assert.match(ctx, /RECENT NARRATION/);
  assert.match(ctx, /You have maybe five minutes to decide\./, "the exact narration the player read must be present");
});

test("OOC grounding contains committed OBJECTIVES and the world CLOCK", () => {
  const ctx = buildOocGroundingContext(groundedRun());
  assert.match(ctx, /COMMITTED OBJECTIVES/);
  assert.match(ctx, /Find the source of the smoke near Hollow Pine\./, "the committed quest objective is grounded");
  assert.match(ctx, /WORLD CLOCK: 07:27/, "the committed clock is grounded");
  assert.match(ctx, /No real-time countdown runs unless a committed clock event says so/, "clock note disarms invented timers");
});

test("OOC grounding contains LOCATION and SYSTEM LORE", () => {
  const ctx = buildOocGroundingContext(groundedRun());
  assert.match(ctx, /LOCATION: /);
  assert.match(ctx, /SYSTEM LORE/, "the WINDOW/VOICE world-law rides the OOC context too");
});

test("OOC framing bans the assistant register that produced the blind reply", () => {
  assert.match(OOC_FRAMING, /OUT OF CHARACTER/);
  assert.match(OOC_FRAMING, /never ask the player to provide context that appears there/);
  assert.match(OOC_FRAMING, /please clarify/, "explicitly bans 'please clarify'");
  assert.match(OOC_FRAMING, /let me know/, "explicitly bans 'let me know'");
  assert.match(OOC_FRAMING, /never feign ignorance of your own narration/);
  assert.match(OOC_FRAMING, /NAME the committed decision it bears on/, "must name the decision behind a stake/deadline");
});

test("buildOocSystemPrompt = grounding block THEN the framing", () => {
  const prompt = buildOocSystemPrompt(groundedRun());
  const groundingIdx = prompt.indexOf("RECENT NARRATION");
  const framingIdx = prompt.indexOf("The player is asking OUT OF CHARACTER");
  assert.ok(groundingIdx >= 0 && framingIdx > groundingIdx, "grounding precedes the OOC framing");
});

test("grounding never throws on a sparse run (non-fatal OOC path)", () => {
  // A run with no narration / no quests / no committed system must still produce a
  // string rather than throwing — OOC must stay non-fatal. Post steel/furniture
  // migration, a worldless run carries NO SYSTEM LORE (that's furniture now), so the
  // invariant here is non-fatality, not the presence of any one block.
  const bare = createDefaultSoloRun({ runId: "run_ooc_bare" });
  const ctx = buildOocGroundingContext(bare);
  assert.equal(typeof ctx, "string");
  assert.doesNotMatch(ctx, /SYSTEM LORE/, "a worldless run inherits no VOICE/WINDOW system lore");
});
