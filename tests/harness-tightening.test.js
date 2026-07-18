import assert from "node:assert/strict";
import test from "node:test";
import { detectInventedAgents } from "../server/solo/npcCommit.js";
import { detectEmDashViolations, stripAiTells } from "../server/gm/voice.js";
import { enforceRomanceRegister, stripRomanceRegister, ROMANCE_CORRECTIVE_CLAUSE } from "../server/gm/romanceEnforcement.js";

// ── ITEM 1: phantom-agent v2 (unnamed invented agents) ──────────────────────

test("agent-v2: the documented maintenance-drone case is now caught live", () => {
  // Pre-upgrade this returned [] — combat/outcome verbs (shatters/clatters)
  // were only in the offline harness, so the drone was flagged offline but
  // never committed live (tests/harness-audit.test.js:126 pins the harness).
  const names = detectInventedAgents(
    "Your blade shatters a rusted maintenance drone's chassis. The dying drone clatters to the floor, sparks raining down.",
    { hasCast: false }
  );
  assert.ok(names.includes("Drone"), `expected Drone, got ${JSON.stringify(names)}`);
});

test("agent-v2: an answering voice with no committed speaker is an invented agent", () => {
  const names = detectInventedAgents(
    "A thin, static-laden voice sputters from the broken wall, its tone metallic and weary.",
    { hasCast: false }
  );
  assert.ok(names.includes("Voice"), `expected Voice, got ${JSON.stringify(names)}`);
});

test("agent-v2 guards: cast-vouched voice, ambience, negation, player body, brackets", () => {
  // A voice WITH committed cast is a paraphrase of an existing speaker.
  assert.deepEqual(detectInventedAgents("A low voice answers from the corner.", { hasCast: true }), []);
  // Weather/ambience never flags — no agent noun present.
  assert.deepEqual(
    detectInventedAgents("The fire crackles in the hearth. A cold wind screams past the shutters. The old door slams shut.", { hasCast: false }),
    []
  );
  // Honest absence stays honest with the new verbs too.
  assert.deepEqual(detectInventedAgents("No creature snarls in the dark tonight.", { hasCast: false }), []);
  // The player's own voice/body is never an agent.
  assert.deepEqual(detectInventedAgents("Your voice screams into the void.", { hasCast: false }), []);
  // Bracketed system/markup tags are not narration ("[GM VOICE]" is not a voice).
  assert.deepEqual(detectInventedAgents("[GM VOICE] You call out into the stillness.", { hasCast: false }), []);
});

test("agent-v2: v1 behavior preserved (social-verb agents, known tokens, paraphrase)", () => {
  assert.ok(detectInventedAgents("Only the creature's unblinking gaze demands an answer.").includes("Creature"));
  assert.deepEqual(detectInventedAgents("The scavenger nods.", { knownAgentTokens: new Set(["scavenger"]) }), []);
  assert.deepEqual(detectInventedAgents("The figure steps forward.", { hasCast: true }), []);
});

// ── ITEM 2: em-dash ban (narration law) ──────────────────────────────────────

test("em-dash: detector flags em, en, and double-hyphen with context", () => {
  const hits = detectEmDashViolations("She pauses — then smiles. A cold read – nothing more -- and done.");
  assert.equal(hits.length, 3);
  assert.deepEqual(hits.map((h) => h.dash), ["—", "–", "--"]);
  assert.ok(hits[0].context.includes("then smiles"));
});

test("em-dash: clean prose and non-string input produce no findings", () => {
  assert.deepEqual(detectEmDashViolations("A comma, a period. A colon: parentheses (fine). Hyphen-joined words survive."), []);
  assert.deepEqual(detectEmDashViolations(null), []);
  assert.deepEqual(detectEmDashViolations(""), []);
});

test("em-dash: a single hyphen in compound words is lawful", () => {
  assert.deepEqual(detectEmDashViolations("The well-worn, rust-eaten sign creaks."), []);
});

test("em-dash: stripAiTells clears every violation the detector finds (enforcement backstop)", () => {
  const dirty = "The keeper leans in — voice low – and slides the key across -- slowly.";
  const clean = stripAiTells(dirty);
  assert.deepEqual(detectEmDashViolations(clean), [], `still dirty: ${clean}`);
  assert.ok(clean.includes("leans in, voice low"), clean);
});

// ── ITEM 3: LAW R10 block-and-regenerate (mocked provider; pending live verification) ──

// A Mainline run with a present romanceable NPC below "courting" — the real
// detector treats physical-romance prose as an over-tier violation.
function mainlineRun(edition = "mainline") {
  return {
    edition,
    currentLocationId: "loc_inn",
    npcs: {
      npc_mira: { npcId: "npc_mira", displayName: "Mira", ageClass: "adult", romanceable: true, currentLocationId: "loc_inn", status: "active" }
    },
    relationships: {}
  };
}
const VIOLATING = "Mira pulls you close and kisses you under the lantern light.";
const CLEAN = "Mira holds your gaze a moment longer than she needs to, then looks away.";

test("R10: clean narration passes through untouched", async () => {
  const out = await enforceRomanceRegister(CLEAN, { run: mainlineRun() });
  assert.equal(out.action, "clean");
  assert.equal(out.narrative, CLEAN);
});

test("R10: Personal-Forbidden stays log-only — prose passes, violations reported", async () => {
  const out = await enforceRomanceRegister(VIOLATING, { run: mainlineRun("forbidden") });
  assert.equal(out.action, "log-only");
  assert.equal(out.narrative, VIOLATING, "forbidden lane never blocks");
  assert.ok(out.violations.length > 0);
});

test("R10: Mainline violation + clean retry → regenerated prose replaces the draft", async () => {
  let regenCalls = 0;
  const out = await enforceRomanceRegister(VIOLATING, {
    run: mainlineRun(),
    regenerate: async () => { regenCalls += 1; return CLEAN; }
  });
  assert.equal(out.action, "regenerated");
  assert.equal(out.narrative, CLEAN);
  assert.equal(regenCalls, 1, "exactly one corrective regeneration");
  assert.deepEqual(out.retryViolations, []);
});

test("R10: Mainline violation + still-dirty retry → blocked, never raw violating prose", async () => {
  const out = await enforceRomanceRegister(VIOLATING, {
    run: mainlineRun(),
    regenerate: async () => "She kisses you again, deeper this time."
  });
  assert.equal(out.action, "blocked");
  assert.equal(out.narrative, null, "blocked result carries NO prose");
  assert.ok(out.retryViolations.length > 0);
});

test("R10: regeneration failure/throw/absence all degrade to blocked", async () => {
  for (const regenerate of [async () => "", async () => { throw new Error("provider down"); }, undefined]) {
    const out = await enforceRomanceRegister(VIOLATING, { run: mainlineRun(), regenerate });
    assert.equal(out.action, "blocked");
    assert.equal(out.narrative, null);
  }
});

test("R10 fallback sanitizer: a template echoing the blocked register is stripped (live-probe finding)", () => {
  const run = mainlineRun();
  // The exact live-probe shape: the deterministic template restated the
  // player's own intent.
  const echo = "The kiss is intense and romantic, both players feeling a deep connection. The tavern hums around you.";
  const fix = stripRomanceRegister(echo, run);
  assert.equal(fix.removed.length, 1);
  assert.doesNotMatch(fix.text, /kiss/i);
  assert.match(fix.text, /tavern hums/);
  // A template that is ENTIRELY violating degrades to a neutral line, never "".
  const allDirty = stripRomanceRegister("She kisses you deeply.", run);
  assert.equal(allDirty.text, "The moment passes.");
  // Clean text passes through untouched, zero removals.
  const clean = stripRomanceRegister("Lyra laughs and waves you off.", run);
  assert.equal(clean.removed.length, 0);
  assert.equal(clean.text, "Lyra laughs and waves you off.");
});

test("R10: explicit content blocks at ANY tier (the SFW wall), corrective clause is hardened", async () => {
  const out = await enforceRomanceRegister("They fall into bed together, making love until dawn.", { run: mainlineRun() });
  assert.equal(out.action, "blocked");
  assert.match(ROMANCE_CORRECTIVE_CLAUSE, /ZERO physical-romantic content/);
  assert.match(ROMANCE_CORRECTIVE_CLAUSE, /ZERO explicit content/);
  // The clause itself obeys the em-dash ban.
  assert.deepEqual(detectEmDashViolations(ROMANCE_CORRECTIVE_CLAUSE), []);
});
