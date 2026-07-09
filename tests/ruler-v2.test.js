import assert from "node:assert/strict";
import test from "node:test";
import {
  RULER_VERSION,
  RULER_CHECKS,
  assertSameRulerVersion,
  auditUnnamedAgents,
  detectNarratedStateDrift,
  detectPronounMismatch,
  auditIntroductionBeats,
  detectNameCollisions,
  detectHandles,
  detectSingleBlockProse,
  gradeSession,
  renderGradeReport
} from "../scripts/selfplayAudit.mjs";

// Ruler v2 — tightened diagnostic checks. Each check is seeded with a known-bad
// AND a known-good case. The ruler is FROZEN after this session.

const sceneWith = (cast = [], extra = {}) => ({
  location: { name: "The Ember Tavern" },
  player: { displayName: "Bram" },
  cast,
  ...extra
});

// ---- 2a. unnamed invented agents (strict co-located) ----

test("2a known-bad: 'a guard steps out' with no co-located guard → flagged", () => {
  const flags = auditUnnamedAgents("A guard steps out of the alley and blocks your path.", sceneWith([{ npcId: "m", displayName: "Mara", role: "medic", present: true }]));
  assert.equal(flags.length, 1);
  assert.equal(flags[0].noun, "guard");
});

test("2a known-bad: 'the merchant scowls' (quiet social verb) → flagged", () => {
  const flags = auditUnnamedAgents("The merchant scowls at your offer.", sceneWith([{ npcId: "m", displayName: "Mara", role: "medic", present: true }]));
  assert.equal(flags.length, 1);
  assert.equal(flags[0].noun, "merchant");
});

test("2a known-good: 'the medic scowls' IS vouched by co-located medic Mara", () => {
  const flags = auditUnnamedAgents("The medic scowls and waves you to the cot.", sceneWith([{ npcId: "m", displayName: "Mara", role: "medic", present: true }]));
  assert.equal(flags.length, 0);
});

test("2a known-good: person-generic 'a figure' vouched by ANY co-located cast; negation honest", () => {
  const cast = [{ npcId: "m", displayName: "Mara", role: "medic", present: true }];
  assert.equal(auditUnnamedAgents("A figure steps into the lamplight.", sceneWith(cast)).length, 0);
  assert.equal(auditUnnamedAgents("No guard steps out to stop you.", sceneWith(cast)).length, 0);
});

// ---- 2b. narrated-but-uncommitted state (Class C drift) ----

test("2b known-bad: narrated condition the committed state does not hold → flagged with delta", () => {
  const drifts = detectNarratedStateDrift("You are poisoned, the venom crawling up your arm.", sceneWith([], { conditions: [{ name: "Exhausted" }] }));
  assert.equal(drifts.length, 1);
  assert.equal(drifts[0].kind, "condition");
  assert.match(drifts[0].detail, /poisoned/);
  assert.match(drifts[0].detail, /exhausted/i);
});

test("2b known-good: narrated condition that IS committed → clean", () => {
  const drifts = detectNarratedStateDrift("You are exhausted, legs shaking.", sceneWith([], { conditions: [{ name: "Exhausted" }] }));
  assert.equal(drifts.length, 0);
});

test("2b known-bad: grave wounds narrated on full committed HP → flagged", () => {
  const drifts = detectNarratedStateDrift("You are badly wounded, bleeding out onto the stones.", sceneWith([], { player: { resources: { hp: { current: 10, max: 10 } } } }));
  assert.ok(drifts.some((d) => d.kind === "hp"));
});

test("2b known-good: grave wounds narrated while committed HP is actually low → clean", () => {
  const drifts = detectNarratedStateDrift("You are badly wounded.", sceneWith([], { player: { resources: { hp: { current: 2, max: 10 } } } }));
  assert.equal(drifts.filter((d) => d.kind === "hp").length, 0);
});

test("2b known-bad: 'four raiders' narrated with one committed co-located NPC → flagged", () => {
  const drifts = detectNarratedStateDrift("Four raiders circle the fire.", sceneWith([{ npcId: "m", displayName: "Mara", role: "medic", present: true }]));
  assert.ok(drifts.some((d) => d.kind === "agent_count" && /four raiders/.test(d.detail)));
});

test("2b known-bad/good: item count vs committed inventory quantity", () => {
  const inv = { playerInventory: [{ name: "Field Ration", quantity: 1 }] };
  const bad = detectNarratedStateDrift("You still have three rations left.", sceneWith([], inv));
  assert.ok(bad.some((d) => d.kind === "item_count" && /quantity = 1/.test(d.detail)));
  const good = detectNarratedStateDrift("You still have one ration left.", sceneWith([], inv));
  assert.equal(good.filter((d) => d.kind === "item_count").length, 0);
});

// ---- 2c. pronoun/gender enforcement ----

test("2c known-bad: committed he/him narrated 'her' 3x (live medic-Mara case) → flagged", () => {
  const prose = "Mara looks up. The lamplight catches the scar along her forearm. She already has a scanner in her other hand, and her eyes are on your pupils.";
  const flags = detectPronounMismatch(prose, [{ displayName: "Mara", gender: "male", pronouns: "he/him" }]);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].name, "Mara");
  assert.match(flags[0].observed, /she\/her/);
});

test("2c known-good: committed she/her narrated 'her' → clean; mixed window → conservative no-flag", () => {
  const proseF = "Mara smiles. Her hands are steady as she works.";
  assert.equal(detectPronounMismatch(proseF, [{ displayName: "Mara", gender: "female" }]).length, 0);
  // one contradicting pronoun only — below the >=2 conservative bar
  const one = "Mara nods. Her jaw tightens once as he speaks of the road.";
  assert.equal(detectPronounMismatch(one, [{ displayName: "Mara", pronouns: "he/him" }]).length, 0);
});

test("2c focusName anchors unnamed VN prose to the committed speaker", () => {
  const prose = "The lamplight catches the scar along her forearm. She already has a scanner in her other hand.";
  const flags = detectPronounMismatch(prose, [{ displayName: "Mara", pronouns: "he/him" }], { focusName: "Mara" });
  assert.equal(flags.length, 1);
});

// ---- 2d. introduction-beat check (run-level) ----

const introRun = (overrides = {}) => ({
  npcs: {
    npc_medic: {
      npcId: "npc_medic", displayName: "Mara", role: "medic", origin: "procedural",
      memoryFactIds: ["fact_talk_1"], dialogueBeats: [{ beatId: "b0", revealed: true }]
    },
    npc_courier: {
      npcId: "npc_courier", displayName: "Vex", role: "courier", origin: "procedural",
      memoryFactIds: ["fact_talk_2"], dialogueBeats: []
    },
    npc_unmet: {
      npcId: "npc_unmet", displayName: "Ruth", role: "warden", origin: "procedural",
      memoryFactIds: [], dialogueBeats: [{ beatId: "b1", revealed: false }]
    }
  },
  timeline: [
    { type: "momentum_event", title: "A courier stumbles in", summary: "A road-worn courier collapses through the door." }
  ],
  ...overrides
});

test("2d known-bad: pre-seeded NPC surfacing cold in a talk beat → committed-but-never-introduced", () => {
  const flags = auditIntroductionBeats(introRun());
  assert.equal(flags.length, 1, "only the cold-surfaced medic is flagged");
  assert.equal(flags[0].npcId, "npc_medic");
  assert.match(flags[0].detail, /committed-but-never-introduced/);
});

test("2d known-good: the courier arrival-event pattern vouches the courier; unmet NPCs unjudged", () => {
  const flags = auditIntroductionBeats(introRun());
  assert.ok(!flags.some((f) => f.npcId === "npc_courier"), "arrival event (role match) introduces the courier");
  assert.ok(!flags.some((f) => f.npcId === "npc_unmet"), "never-surfaced NPC is not judged");
});

test("2d live-miss regression: a PLAYER attempt echoing the name does NOT vouch an introduction", () => {
  // The live run's miss: 'You attempt: Pull out the message i got from mara'
  // (type=attempt) mentioned the name — player echoes are not world introductions.
  const run = introRun({
    timeline: [
      { type: "momentum", title: "A courier stumbles in", summary: "A road-worn courier collapses through the door." },
      { type: "attempt", title: "Attempt Failed", summary: "You attempt: Pull out the message i got from mara" }
    ]
  });
  const flags = auditIntroductionBeats(run);
  assert.ok(flags.some((f) => f.npcId === "npc_medic"), "medic still flagged despite the player-attempt echo");
});

// ---- 2e. name-collision detection ----

test("2e known-bad: two committed Maras + two Sables → two collisions (live case)", () => {
  const collisions = detectNameCollisions({
    a: { npcId: "npc_medic", displayName: "Mara", role: "medic" },
    b: { npcId: "npc_courier", displayName: "Mara", role: "courier" },
    c: { npcId: "npc_x", displayName: "Sable", role: "figure" },
    d: { npcId: "npc_y", displayName: "Sable", role: "figure" },
    e: { npcId: "npc_z", displayName: "Yarrow", role: "barkeep" }
  });
  assert.equal(collisions.length, 2);
  const names = collisions.map((c) => c.name).sort();
  assert.deepEqual(names, ["mara", "sable"]);
});

test("2e known-good: unique first names → no collisions", () => {
  assert.equal(detectNameCollisions({ a: { npcId: "1", displayName: "Mara" }, b: { npcId: "2", displayName: "Yarrow" } }).length, 0);
});

// ---- 3a. handles ----

test("3a known-good: closing question + exit affordance → handles present", () => {
  const r = detectHandles("The room settles.\n\nThe north door stands ajar. Do you follow the sound or wait?", sceneWith([]));
  assert.equal(r.verdict, "present");
});

test("3a known-bad: dead-end closing beat → handles missing", () => {
  const r = detectHandles("The rain keeps falling. Nothing moves. The silence continues.", sceneWith([]));
  assert.equal(r.verdict, "missing");
});

// ---- 3b. paragraph structure (raw GM output) ----

test("3b known-bad: 600-char single block → flagged; known-good: multi-paragraph → clean", () => {
  const wall = "The tavern breathes and shifts around you every moment you stand there watching the crowd move between the tables. ".repeat(6);
  assert.ok(detectSingleBlockProse(wall));
  const structured = `${wall.slice(0, 300)}\n\n${wall.slice(300, 600)}`;
  assert.equal(detectSingleBlockProse(structured), null);
});

// ---- schema: polarity + compliments carry no weight ----

function realTurn(n, extra = {}) {
  return {
    n, intent: "look", model: "deepseek/deepseek-v4-pro", fallback: false, latencyMs: 5000,
    narration: "Mara watches from the counter.", attemptResult: {},
    scene: sceneWith([{ npcId: "m", displayName: "Mara", role: "medic", present: true, gender: "female", pronouns: "she/her" }]),
    sceneBefore: { a: 1 }, sceneAfter: { a: 2 },
    ...extra
  };
}

test("findings carry polarity; compliments deduct nothing", () => {
  const g = gradeSession([realTurn(1)]);
  assert.ok(g.findings.every((f) => f.polarity === "complaint" || f.polarity === "compliment"));
  const compliments = g.findings.filter((f) => f.polarity === "compliment");
  assert.ok(compliments.length >= 1, "grounded narration compliment logged");
  // an all-clean turn still scores AXIS_BASE on coherence despite compliments
  assert.equal(g.axes.coherence.numeric, 95);
  // complaints sort before compliments
  const firstComplimentIdx = g.findings.findIndex((f) => f.polarity === "compliment");
  const lastComplaintIdx = g.findings.map((f) => f.polarity).lastIndexOf("complaint");
  if (firstComplimentIdx !== -1 && lastComplaintIdx !== -1) {
    assert.ok(lastComplaintIdx < firstComplimentIdx);
  }
});

test("possession-gate refusal is logged as a compliment (regression guard)", () => {
  const g = gradeSession([realTurn(1, { attemptResult: { refused: true, outcomeLabel: "Refused" } })]);
  assert.ok(g.findings.some((f) => f.polarity === "compliment" && /possession gate held/i.test(f.finding)));
});

test("v2 complaints fire inside gradeSession (drift + pronoun + agent)", () => {
  const t = realTurn(1, {
    narration: "A guard steps out and blocks you. You are poisoned. Mara frowns; the light catches her jaw and her eyes and her scarred hands.",
    scene: sceneWith(
      [{ npcId: "m", displayName: "Mara", role: "medic", present: true, gender: "male", pronouns: "he/him" }],
      { conditions: [] }
    )
  });
  const g = gradeSession([t]);
  assert.ok(g.findings.some((f) => /unnamed invented agent/.test(f.finding)), "strict agent check fired");
  assert.ok(g.findings.some((f) => /narrated-state drift/.test(f.finding)), "Class C drift fired");
  assert.ok(g.findings.some((f) => /pronoun mismatch/.test(f.finding)), "pronoun enforcement fired");
  assert.ok(g.axes.coherence.numeric < 95, "coherence dropped — the ruler tightened");
});

test("run-level checks fire via opts.run (collisions + cold introduction)", () => {
  const g = gradeSession([realTurn(1)], { run: {
    npcs: {
      a: { npcId: "a", displayName: "Mara", role: "medic", origin: "procedural", memoryFactIds: ["f1"], dialogueBeats: [] },
      b: { npcId: "b", displayName: "Mara", role: "courier", origin: "procedural", memoryFactIds: [], dialogueBeats: [] }
    },
    timeline: []
  } });
  assert.ok(g.findings.some((f) => /name collision/.test(f.finding)));
  assert.ok(g.findings.some((f) => /committed-but-never-introduced/.test(f.finding)));
});

// ---- 4. ruler versioning ----

test("gradeSession stamps ruler=v2 + the frozen check list; report renders it", () => {
  const g = gradeSession([realTurn(1)]);
  assert.equal(g.ruler.version, "v2");
  assert.equal(g.ruler.version, RULER_VERSION);
  assert.ok(g.ruler.checks.length >= 10);
  assert.deepEqual([...g.ruler.checks], [...RULER_CHECKS]);
  const md = renderGradeReport(g, { timestamp: "t", runId: "r", sha: "s" });
  assert.match(md, /ruler=v2/);
  assert.match(md, /What worked/);
});

test("assertSameRulerVersion refuses to mix rulers", () => {
  assert.equal(assertSameRulerVersion(["v2", "v2"]), "v2");
  assert.equal(assertSameRulerVersion([]), null);
  assert.throws(() => assertSameRulerVersion(["v1", "v2"]), /refusing to aggregate/);
});
