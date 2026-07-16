import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDisagreementDirective,
  detectComplianceViolations,
  resistanceProfile,
  FEAR_METER_THRESHOLD,
  SUSPICION_METER_THRESHOLD
} from "../server/gm/disagreementAudit.js";
import {
  pickVoiceSpec,
  normalizeVoiceSpec,
  describeVoice,
  buildVoiceDirective,
  backfillNpcMannerisms,
  NPC_VOICE_REGISTERS,
  NPC_VOICE_LENGTHS,
  NPC_VOICE_TALKATIVENESS
} from "../server/solo/npcIdentity.js";
import { createDefaultSoloRun, validateSoloRun, validateNpc } from "../server/solo/schema.js";
import { recomputeIndividualTiers } from "../server/solo/reputation.js";

// A run with one present NPC whose relationship meters/affinity we control.
// The rel record is hand-minted in the committed shape (relationships.js
// ensureRelationship is module-private).
function runWith(npcOverrides = {}, relSetup = null) {
  const run = createDefaultSoloRun({ runId: "run_harden" });
  const npc = {
    npcId: "npc_mira",
    displayName: "Mira",
    generatedName: "Mira",
    role: "fence",
    known: true,
    status: "active",
    currentLocationId: run.currentLocationId,
    memoryFactIds: [],
    tags: [],
    flags: {},
    ...npcOverrides
  };
  run.npcs[npc.npcId] = npc;
  const rel = {
    relationshipId: "rel_npc_mira_test",
    sourceEntityId: "player",
    targetEntityId: npc.npcId,
    meters: { trust: 0, affection: 0, fear: 0, debt: 0, suspicion: 0, loyalty: 0, rivalry: 0 },
    memoryFactIds: [],
    flags: {}
  };
  run.relationships[rel.relationshipId] = rel;
  if (relSetup) {
    relSetup(rel, npc);
    recomputeIndividualTiers(rel, npc);
  }
  return run;
}

// ── LAW 1: DISAGREEMENT ──────────────────────────────────────────────────────

test("law1: hostile tier produces a hard refuse directive naming the NPC", () => {
  const run = runWith({}, (rel) => { rel.affinity = -30; });
  const directive = buildDisagreementDirective(run);
  assert.match(directive, /DISAGREEMENT LAW \(hard, server-owned/);
  assert.match(directive, /Mira \(hostile\)/);
  assert.match(directive, /refuses player requests outright/);
  assert.match(directive, /may NOT simply agree/);
});

test("law1: wary tier demands terms; warm tier adds nothing", () => {
  const wary = runWith({}, (rel) => { rel.affinity = -5; });
  assert.match(buildDisagreementDirective(wary), /Mira \(wary\)/);
  const warm = runWith({}, (rel) => { rel.affinity = 15; });
  assert.equal(buildDisagreementDirective(warm), "");
});

test("law1: high fear/suspicion meters bind even at neutral affinity", () => {
  const fearful = runWith({}, (rel) => { rel.meters.fear = FEAR_METER_THRESHOLD; });
  assert.match(buildDisagreementDirective(fearful), /Mira \(fearful\)/);
  const distrustful = runWith({}, (rel) => { rel.meters.suspicion = SUSPICION_METER_THRESHOLD; });
  assert.match(buildDisagreementDirective(distrustful), /Mira \(distrustful\)/);
});

test("law1: resistanceProfile is null for unbound NPCs (no directive spam)", () => {
  const run = runWith({}, (rel) => { rel.affinity = 0; });
  assert.equal(resistanceProfile(run, "npc_mira"), null);
});

test("law1 auditor: flags a hostile NPC simply agreeing, attributed by name", () => {
  const run = runWith({}, (rel) => { rel.affinity = -30; });
  const narration = `Mira says, "Of course, take whatever you need." She waves you toward the shelves.`;
  const violations = detectComplianceViolations(narration, run);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].npcId, "npc_mira");
  assert.equal(violations[0].reason, "hostile");
});

test("law1 auditor: refusals and conditional terms never false-flag", () => {
  const run = runWith({}, (rel) => { rel.affinity = -30; });
  for (const line of [
    `Mira says, "Of course not. Get out."`,
    `Mira says, "Sure — once you've paid what you owe."`,
    `Mira says, "No. Not for you, not ever."`,
    `Mira says, "Prove it first, then we talk."`
  ]) {
    assert.deepEqual(detectComplianceViolations(line, run), [], line);
  }
});

test("law1 auditor: a friendly NPC agreeing is lawful (no flags)", () => {
  const run = runWith({}, (rel) => { rel.affinity = 30; });
  const narration = `Mira says, "Of course, take whatever you need."`;
  assert.deepEqual(detectComplianceViolations(narration, run), []);
});

// ── LAW 2: VOICE CONTRACT ────────────────────────────────────────────────────

test("law2: pickVoiceSpec is deterministic and enum-valid", () => {
  for (const seed of [0, 1, 7, 42, 999999]) {
    const a = pickVoiceSpec(seed);
    assert.deepEqual(a, pickVoiceSpec(seed));
    assert.ok(NPC_VOICE_REGISTERS.includes(a.register));
    assert.ok(NPC_VOICE_LENGTHS.includes(a.sentenceLength));
    assert.ok(NPC_VOICE_TALKATIVENESS.includes(a.talkativeness));
  }
  // Nearby seeds land different combinations (the co-prime strides).
  assert.notDeepEqual(pickVoiceSpec(1), pickVoiceSpec(2));
});

test("law2: normalizeVoiceSpec rejects malformed values (never half-applied)", () => {
  assert.equal(normalizeVoiceSpec(null), null);
  assert.equal(normalizeVoiceSpec({ register: "rough" }), null);
  assert.equal(normalizeVoiceSpec({ register: "shouty", sentenceLength: "clipped", talkativeness: "chatty" }), null);
  assert.deepEqual(
    normalizeVoiceSpec({ register: "learned", sentenceLength: "rambling", talkativeness: "chatty", extra: 1 }),
    { register: "learned", sentenceLength: "rambling", talkativeness: "chatty" }
  );
});

test("law2: backfill gives a legacy NPC a voice (same pass as mannerism)", () => {
  const run = runWith({ identitySeed: 13 });
  delete run.npcs.npc_mira.voice;
  delete run.npcs.npc_mira.mannerism;
  const touched = backfillNpcMannerisms(run, ["npc_mira"]);
  assert.deepEqual(touched, ["npc_mira"]);
  assert.deepEqual(run.npcs.npc_mira.voice, pickVoiceSpec(13));
  assert.equal(typeof run.npcs.npc_mira.mannerism, "string");
  // Idempotent: a second pass touches nothing.
  assert.deepEqual(backfillNpcMannerisms(run, ["npc_mira"]), []);
});

test("law2: voice validates in the schema; malformed voice rejects", () => {
  const run = runWith({ voice: pickVoiceSpec(5) });
  assert.equal(validateSoloRun(run).ok, true);
  const bad = validateNpc({ ...run.npcs.npc_mira, voice: { register: "shouty", sentenceLength: "clipped", talkativeness: "chatty" } });
  assert.equal(bad.ok, false);
  // Legacy NPC without voice stays valid.
  const legacy = { ...run.npcs.npc_mira };
  delete legacy.voice;
  assert.equal(validateNpc(legacy).ok, true);
});

test("law2: the voice directive is per-NPC law text fed to the narrator", () => {
  const run = runWith({ voice: { register: "rough", sentenceLength: "clipped", talkativeness: "taciturn" } });
  const directive = buildVoiceDirective(run);
  assert.match(directive, /COMMITTED VOICES/);
  assert.match(directive, /Mira — rough, blunt vocabulary; short clipped sentences; says as little as possible/);
  assert.match(directive, /MUST match its speaker's committed voice/);
  assert.equal(describeVoice(null), "");
  // No voiced NPCs → zero tokens added.
  const bare = runWith({});
  delete bare.npcs.npc_mira.voice;
  assert.equal(buildVoiceDirective(bare), "");
});
