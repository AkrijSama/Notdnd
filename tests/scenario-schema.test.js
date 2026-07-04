import test from "node:test";
import assert from "node:assert/strict";
import {
  validateScenario,
  SCENARIO_SUBSTRATE_VERSION,
  FRONT_KINDS,
  FRONT_TOPOLOGIES,
  BEAT_PAYLOAD_KINDS
} from "../server/campaign/scenarioSchema.js";

// TESTS-OF-RECORD for the scenario authoring schema
// (docs/inkborne-scenarios-spec.md). This is the UGC boundary: a scenario is
// declarative JSON, and these tests pin the Dungeon-World-Fronts constraints the
// validator enforces so a genre author (or a CLI) cannot ship a noisy, dangling,
// or un-preventable scenario. The module under test is pure and wired into
// nothing; D.5 Phase 1's loader gates on it.

// A minimal-but-VALID scenario: a cyberpunk delivery with one parallel danger
// front, a secret, grounded refs. Every test derives a mutation from this base.
function baseScenario() {
  return {
    substrate: SCENARIO_SUBSTRATE_VERSION,
    scenarioId: "the_shipment",
    title: "The Shipment",
    genre: "cyberpunk",
    tones: ["cyberpunk"],
    stakes: "A sealed data-case, a sector someone is quietly closing, and a fixer whose cut prices in your funeral.",
    opening: { questObjectiveFrom: "offer_courier", startLocationRef: "start" },
    cast: [
      { npcId: "npc_quest_giver", at: "second_location", role: "fixer", questOffer: "offer_courier" },
      { npcId: "npc_far_witness", at: "third_location", role: "informant" }
    ],
    questOffers: { offer_courier: { title: "Run the case" } },
    quests: { quest_delivery: { title: "Deliver the case" } },
    fronts: [
      {
        frontId: "front_collector",
        kind: "danger",
        foreground: true,
        topology: "linear",
        title: "The Collector's Cut",
        agenda: "The one closing the sector wants the case — and to make an example of the courier.",
        revealState: "hidden",
        groundedIn: { entityRefs: ["npc_quest_giver"], locationRefs: ["second_location", "third_location"], questRefs: ["quest_delivery"] },
        beats: [
          {
            beatId: "beat_flagged",
            label: "Your gig got flagged",
            telegraph: "A drone tags your route and peels off.",
            brief: "Someone with pull on the sector grid knows a courier took the case.",
            decision: "Push on fast, or go dark and reroute.",
            trigger: { descriptive: { onQuestStage: { questRef: "quest_delivery", minStage: 0 } } },
            payload: { fact: { text: "The sector grid flagged the courier the moment the case changed hands." } }
          },
          {
            beatId: "beat_cordon",
            label: "The cordon hardens",
            telegraph: "Checkpoint lights double along the only clean route.",
            brief: "The sector cordon tightens; the clean route is now watched.",
            decision: "Bribe through, find a gap, or risk the run.",
            trigger: { prescriptive: { requiresBeat: "beat_flagged", minTurn: 4 } },
            payload: { objectState: { key: "the-cordon", locationId: "third_location", state: "hardened", retryEffect: "harder" } }
          },
          {
            beatId: "beat_collector",
            label: "The collector arrives",
            telegraph: "A gonk in corp leathers is asking your face by name.",
            brief: "A collector sent by the one closing the sector has found the courier — he wants the case.",
            decision: "Hand it over, talk him down, or refuse and face him.",
            trigger: { prescriptive: { requiresBeat: "beat_cordon", minTurn: 8 } },
            payload: { hostileNpc: { npcId: "npc_collector", statBlockId: "waylayer", placeAt: "{player_location}" } }
          }
        ],
        resolution: [
          { kind: "quest", questRef: "quest_delivery", on: "completed", outcome: "resolved" },
          { kind: "ground_lost", outcome: "resolved" }
        ],
        callbackQuery: { entityRefs: ["npc_quest_giver"], keywords: ["case", "cordon", "collector"] }
      }
    ],
    secrets: [
      {
        secretId: "secret_engram",
        text: "The case isn't cargo. It's someone's engram backup — that's why the tax, and why the collector won't stop.",
        frontRef: "front_collector",
        reveal: { onEntityKnown: "npc_far_witness" }
      }
    ]
  };
}

// ── the happy path ───────────────────────────────────────────────────────────
test("a well-formed cyberpunk scenario validates clean", () => {
  const r = validateScenario(baseScenario());
  assert.deepEqual(r.errors, [], JSON.stringify(r.errors, null, 2));
  assert.equal(r.ok, true);
});

test("exported vocab is frozen and matches the spec", () => {
  assert.equal(SCENARIO_SUBSTRATE_VERSION, 1);
  assert.deepEqual(FRONT_KINDS, ["danger", "secret", "rival", "consequence", "opportunity"]);
  assert.deepEqual(FRONT_TOPOLOGIES, ["linear", "parallel", "gated-sequence"]);
  assert.deepEqual(BEAT_PAYLOAD_KINDS, ["fact", "npc", "objectState", "quest", "hostileNpc"]);
});

// ── DW anti-noise cap: ≤3 fronts, ≤1 foreground ──────────────────────────────
test("more than 3 fronts is rejected (anti-noise cap)", () => {
  const s = baseScenario();
  const mk = (id) => ({ ...s.fronts[0], frontId: id, foreground: false });
  s.fronts = [s.fronts[0], mk("f2"), mk("f3"), mk("f4")];
  const r = validateScenario(s);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === "fronts" && /at most 3/.test(e.message)));
});

test("more than one foreground front is rejected", () => {
  const s = baseScenario();
  s.fronts = [s.fronts[0], { ...s.fronts[0], frontId: "front_two", foreground: true }];
  const r = validateScenario(s);
  assert.ok(r.errors.some((e) => e.path === "fronts" && /one foreground/.test(e.message)));
});

// ── the beat ladder cap, conditional on topology ─────────────────────────────
test("a linear/parallel front is capped at 4 beats (grim-portent limit)", () => {
  const s = baseScenario();
  const b = s.fronts[0].beats[0];
  s.fronts[0].beats = [b, { ...b, beatId: "b2" }, { ...b, beatId: "b3" }, { ...b, beatId: "b4" }, { ...b, beatId: "b5" }];
  const r = validateScenario(s);
  assert.ok(r.errors.some((e) => /capped at 4 beats/.test(e.message)));
});

test("a gated-sequence front MAY exceed 4 beats when strictly one-active (the tower concession)", () => {
  const s = baseScenario();
  s.fronts[0].kind = "consequence"; // pressure kind; will need descriptive advancement
  s.fronts[0].topology = "gated-sequence";
  // Build a 6-rung strictly-gated tower: each beat gates on the previous.
  const floor = (i, req) => ({
    beatId: `beat_floor${i}`,
    label: `Floor ${i}`,
    telegraph: `The stair to floor ${i} groans open.`,
    brief: `The seal on floor ${i} gives; there is no going back down.`,
    decision: `Climb, or hold the landing.`,
    // descriptive: reaching the floor commits its pressure (never starves).
    trigger: i === 1
      ? { descriptive: { onPlayerAt: `floor_1_location` } }
      : { descriptive: { requiresBeat: req, onPlayerAt: `floor_${i}_location` } },
    payload: { fact: { text: `Floor ${i} sealed behind the climber.` } }
  });
  s.fronts[0].beats = [
    floor(1, null),
    floor(2, "beat_floor1"),
    floor(3, "beat_floor2"),
    floor(4, "beat_floor3"),
    floor(5, "beat_floor4"),
    floor(6, "beat_floor5")
  ];
  s.fronts[0].resolution = [{ kind: "beat_final", outcome: "resolved" }];
  const r = validateScenario(s);
  assert.deepEqual(r.errors, [], JSON.stringify(r.errors, null, 2));
  assert.equal(r.ok, true, "6-rung gated-sequence is legal");
});

test("a gated-sequence that is NOT strictly ordered is rejected (would surface >1 rung)", () => {
  const s = baseScenario();
  s.fronts[0].kind = "consequence";
  s.fronts[0].topology = "gated-sequence";
  const b = (id, req) => ({
    beatId: id,
    label: id,
    telegraph: "a tell",
    brief: "a committed line",
    decision: "a choice",
    trigger: req ? { descriptive: { requiresBeat: req, onPlayerAt: "second_location" } } : { descriptive: { onPlayerAt: "start" } },
    payload: { fact: { text: "x" } }
  });
  // beat3 gates on beat1, not beat2 — breaks the total order.
  s.fronts[0].beats = [b("beat1", null), b("beat2", "beat1"), b("beat3", "beat1"), b("beat4", "beat3"), b("beat5", "beat4")];
  s.fronts[0].resolution = [{ kind: "beat_final", outcome: "resolved" }];
  const r = validateScenario(s);
  assert.ok(r.errors.some((e) => /gated-sequence beats must gate on the immediately prior beat/.test(e.message)));
});

// ── DW: observable + preventable + committable ───────────────────────────────
test("a beat without a telegraph is rejected (grim portents must be observable)", () => {
  const s = baseScenario();
  delete s.fronts[0].beats[0].telegraph;
  const r = validateScenario(s);
  assert.ok(r.errors.some((e) => /telegraph/.test(e.message)));
});

test("a beat that commits nothing is rejected (must carry exactly one payload kind)", () => {
  const s = baseScenario();
  s.fronts[0].beats[0].payload = {};
  const r = validateScenario(s);
  assert.ok(r.errors.some((e) => /exactly one of/.test(e.message)));
});

test("a beat carrying two payload kinds is rejected", () => {
  const s = baseScenario();
  s.fronts[0].beats[0].payload = { fact: { text: "a" }, objectState: { key: "k" } };
  const r = validateScenario(s);
  assert.ok(r.errors.some((e) => /exactly one of/.test(e.message)));
});

test("a hostileNpc payload without a statBlockId string is rejected (D.4 contract)", () => {
  const s = baseScenario();
  s.fronts[0].beats[2].payload = { hostileNpc: { npcId: "npc_x" } };
  const r = validateScenario(s);
  assert.ok(r.errors.some((e) => /statBlockId/.test(e.message)));
});

// ── DW dual advancement / anti-starvation ────────────────────────────────────
test("a danger/rival/consequence front with NO descriptive advancement is rejected (would starve)", () => {
  const s = baseScenario();
  // Strip descriptive from every beat → only prescriptive remains.
  s.fronts[0].beats[0].trigger = { prescriptive: { minTurn: 2 } };
  const r = validateScenario(s);
  assert.ok(r.errors.some((e) => /descriptive advancement/.test(e.message)));
});

test("a beat with neither trigger mode is rejected", () => {
  const s = baseScenario();
  s.fronts[0].beats[1].trigger = {};
  const r = validateScenario(s);
  assert.ok(r.errors.some((e) => /prescriptive and\/or descriptive/.test(e.message)));
});

// ── referential integrity (fail-loud, D.5 §6.2) ──────────────────────────────
test("a front grounded in a nonexistent entity is rejected", () => {
  const s = baseScenario();
  s.fronts[0].groundedIn.entityRefs = ["npc_ghost"];
  const r = validateScenario(s);
  assert.ok(r.errors.some((e) => /unresolved entity ref "npc_ghost"/.test(e.message)));
});

test("a beat placing a hostile at an unresolved location is rejected", () => {
  const s = baseScenario();
  s.fronts[0].beats[2].payload.hostileNpc.placeAt = "nowhere_location";
  const r = validateScenario(s);
  assert.ok(r.errors.some((e) => /unresolved location ref "nowhere_location"/.test(e.message)));
});

test("a requiresBeat naming a later/unknown beat is rejected (ladder order)", () => {
  const s = baseScenario();
  s.fronts[0].beats[0].trigger = { prescriptive: { requiresBeat: "beat_collector" } }; // forward ref
  const r = validateScenario(s);
  assert.ok(r.errors.some((e) => /requiresBeat/.test(e.message)));
});

test("a resolution quest ref that does not exist is rejected", () => {
  const s = baseScenario();
  s.fronts[0].resolution = [{ kind: "quest", questRef: "quest_missing", outcome: "resolved" }];
  const r = validateScenario(s);
  assert.ok(r.errors.some((e) => /unresolved quest ref "quest_missing"/.test(e.message)));
});

test("a danger front resolving ONLY by expiry is rejected (dangers never silently lapse)", () => {
  const s = baseScenario();
  s.fronts[0].resolution = [{ kind: "expiry", outcome: "expired" }];
  const r = validateScenario(s);
  assert.ok(r.errors.some((e) => /must not resolve solely by expiry/.test(e.message)));
});

// ── secrets pool (tweet-sized, tied to a front) ──────────────────────────────
test("a scenario without a secrets pool is rejected", () => {
  const s = baseScenario();
  delete s.secrets;
  const r = validateScenario(s);
  assert.ok(r.errors.some((e) => e.path === "secrets"));
});

test("a secret longer than a tweet is rejected", () => {
  const s = baseScenario();
  s.secrets[0].text = "x".repeat(281);
  const r = validateScenario(s);
  assert.ok(r.errors.some((e) => /tweet-sized/.test(e.message)));
});

test("a secret tied to a nonexistent front is rejected", () => {
  const s = baseScenario();
  s.secrets[0].frontRef = "front_imaginary";
  const r = validateScenario(s);
  assert.ok(r.errors.some((e) => /declared front/.test(e.message)));
});

// ── UGC version lock + top-level shape ───────────────────────────────────────
test("a scenario missing the substrate version is rejected (UGC lock)", () => {
  const s = baseScenario();
  delete s.substrate;
  const r = validateScenario(s);
  assert.ok(r.errors.some((e) => e.path === "substrate"));
});

test("genre + tones metadata is required (genre-agnostic format needs the label)", () => {
  const s = baseScenario();
  delete s.genre;
  s.tones = [];
  const r = validateScenario(s);
  assert.ok(r.errors.some((e) => e.path === "genre"));
  assert.ok(r.errors.some((e) => e.path === "tones"));
});

test("validateScenario never throws on garbage input", () => {
  for (const junk of [null, undefined, 42, "scenario", [], {}]) {
    const r = validateScenario(junk);
    assert.equal(r.ok, false);
    assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
  }
});
