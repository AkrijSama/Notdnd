import { test } from "node:test";
import assert from "node:assert/strict";
import { detectAttackIntent } from "../server/solo/combat.js";
import { deriveAffordances } from "../server/solo/affordances.js";
import { auditAndCommitInventedAgents } from "../server/solo/npcCommit.js";
import { entityNature } from "../server/solo/entityNature.js";
import { applyPreferenceSlots, normalizeAvoidTerm } from "../server/solo/portraitPreferences.js";
import { renderRedoHint, REDO_HINTS } from "../src/components/onboardingFlow.js";

// ---------------------------------------------------------------------------
// WALK-3 COHERENCE F- — regression net calibrated on run_eea2d9e4's ACTUAL turns.
// Every fixture below is the owner's real state/narration, not a synthetic one.
// See docs/design/walk3-coherence-forensics.md for the verdicts.
// ---------------------------------------------------------------------------

// His run, at the moment he pressed the chip: the Grey committed hostile at his
// location, plus the phantom "Fenn" that the invented-agent auditor had minted.
function walk3Run() {
  return {
    runId: "run_eea2d9e4",
    currentLocationId: "loc_waking_mile",
    combat: null,
    npcs: {
      npc_limping_grey: {
        npcId: "npc_limping_grey",
        displayName: "The Limping Grey",
        currentLocationId: "loc_waking_mile",
        statBlockId: "limping_grey",
        tags: ["hostile", "wildlife", "wolf", "chaosling", "corrupted"],
        flags: { hostile: true }
      }
    }
  };
}

// ── V1: THE FENN INCIDENT ───────────────────────────────────────────────────

test("V1: 'Face The Limping Grey.' ENTERS COMBAT (his exact chip string)", () => {
  const run = walk3Run();
  const hit = detectAttackIntent(run, "Face The Limping Grey.");
  assert.ok(hit, "the hostile chip must open the combat door — it fell to an INT check vs DC 12");
  assert.equal(hit.targetNpcId, "npc_limping_grey");
});

test("V1: the other engagement verbs route too", () => {
  const run = walk3Run();
  for (const intent of [
    "Face The Limping Grey.",
    "confront the limping grey",
    "engage the limping grey",
    "square up to the limping grey",
    "challenge the limping grey"
  ]) {
    assert.ok(detectAttackIntent(run, intent), `"${intent}" must enter combat`);
  }
});

test("V1: ENGAGEMENT verbs do NOT start a brawl with a non-hostile", () => {
  const run = walk3Run();
  run.npcs.npc_barkeep = {
    npcId: "npc_barkeep",
    displayName: "Tobias Rourke",
    currentLocationId: "loc_waking_mile",
    tags: ["barkeep"],
    flags: {}
  };
  assert.equal(detectAttackIntent(run, "confront Tobias Rourke"), null, "confronting a barkeep is social, not combat");
  assert.equal(detectAttackIntent(run, "face Tobias Rourke"), null);
  // But an unambiguous attack verb still works on anyone (the lethal game).
  assert.ok(detectAttackIntent(run, "attack Tobias Rourke"), "explicit attack still enters combat");
});

// THE GENERATOR/DETECTOR PAIRING LAW (V5). The server generates the strings a player
// can submit; every one of them must be understood by the detector meant to consume it.
// This is the mechanical prevention of the V1 bug class.
test("V1/V5 ROUTE-INVENTORY: every hostile affordance chip the server emits opens the combat door", () => {
  const run = walk3Run();
  run.locations = { loc_waking_mile: { locationId: "loc_waking_mile", name: "The Waking Mile" } };
  const affs = deriveAffordances(run) || [];
  // The emitted chip carries only { label, intent, source, feasibility } — assert on
  // the INTENT STRING the player actually submits, which is the whole point.
  const hostileChips = affs.filter((a) => a && /^Face\s/i.test(String(a.intent || "")));
  assert.ok(hostileChips.length > 0, "the run must offer a hostile 'Face' chip to test");
  for (const chip of hostileChips) {
    const hit = detectAttackIntent(run, chip.intent);
    assert.ok(
      hit,
      `the server GENERATES chip intent "${chip.intent}" but detectAttackIntent rejects it — ` +
        "a chip whose own detector refuses it is the Fenn bug class"
    );
    assert.equal(hit.targetNpcId, "npc_limping_grey");
  }
});

test("V1: a committed creature's SPECIES vouches its noun (no phantom mint)", () => {
  const run = walk3Run();
  // His turn-2 narration, verbatim. It correctly describes the committed Limping Grey.
  const narration =
    "A grey shape shifts at the base of a gnarled oak twenty paces to your left. " +
    "It is a wolf, one hind leg held off the ground. It watches you.";
  const committed = auditAndCommitInventedAgents(run, narration, ["The Limping Grey"]);
  assert.deepEqual(committed, [], "describing the committed wolf as 'a wolf' must not mint a new NPC");
  assert.deepEqual(Object.keys(run.npcs), ["npc_limping_grey"], "no phantom cast member");
});

test("V1: a genuinely-new animal keeps SPECIES TRUTH through the mint (no human identity)", () => {
  const run = { runId: "r", currentLocationId: "loc_x", npcs: {} };
  auditAndCommitInventedAgents(run, "A wolf lunges from the treeline.", []);
  const minted = Object.values(run.npcs)[0];
  assert.ok(minted, "a genuinely un-vouched animal is still committed");
  const nat = entityNature(minted);
  assert.equal(nat.isAnimal, true, "a minted wolf must read as an ANIMAL, not the human default");
  assert.notEqual(nat.kind, "human", "tags:['unnamed'] used to make entityNature call it human");
  // The human-identity pipeline must refuse it: this is what gave a wolf arms to fold.
  assert.equal(nat.socialCapable, false, "an animal is not social-capable");
});

// ── V4: THE AVOID BOX ───────────────────────────────────────────────────────

test("V4: his EXACT avoid text no longer produces the defects it names", () => {
  const avoid = "cut-off shoulders, floating, no arms";
  const { positive, negative } = applyPreferenceSlots({
    positive: "(adult man:1.3), a man in his 30s",
    negative: "lowres, bad anatomy",
    avoid,
    provider: "comfyui"
  });
  // THE BUG: "no arms" appended raw to a NEGATIVE prompt embeds *arms* and steers
  // away from arms — producing exactly the armless portrait he asked to avoid.
  assert.ok(!/\bno arms\b/i.test(negative), "the prohibition wrapper must be stripped, never negated");
  assert.match(negative, /missing arms/i, "translated to effective negative vocabulary");
  assert.match(negative, /cropped/i);
  assert.match(negative, /floating head|disembodied/i);
  // Positive counter-cues ride too — positives beat negatives.
  assert.match(positive, /shoulders and upper torso fully in frame/i);
  assert.match(positive, /both arms visible/i);
  assert.match(positive, /grounded/i);
  // Identity still wins.
  assert.match(positive, /\(adult man:1\.3\)/);
});

test("V4: normalizeAvoidTerm strips every prohibition wrapper", () => {
  for (const raw of ["no arms", "without arms", "avoid arms", "not arms", "don't want arms"]) {
    const { negative } = normalizeAvoidTerm(raw);
    assert.ok(!/^\s*(no|not|without|avoid|don)/i.test(negative), `"${raw}" left a prohibition wrapper: "${negative}"`);
    assert.match(negative, /missing arms/i);
  }
});

test("V4: an unknown avoid term still loses its prohibition wrapper", () => {
  const { negative } = normalizeAvoidTerm("no hats");
  assert.equal(negative, "hats", "the defect is named, not the prohibition negated");
});

test("V4: empty slots remain an exact no-op", () => {
  const before = { positive: "p", negative: "n" };
  const after = applyPreferenceSlots({ ...before, appearance: "", avoid: "", provider: "comfyui" });
  assert.deepEqual(after, before);
});

test("V4: the safety floor still cannot be avoided (wardrobe/species/age)", () => {
  const { negative } = applyPreferenceSlots({
    positive: "p",
    negative: "n",
    avoid: "no shirt, no clothing, human, adult",
    provider: "comfyui"
  });
  assert.ok(!/shirt|clothing|human|adult/i.test(negative), "safety-floor terms are stripped even when wrapped in 'no'");
});

test("V4: the redo tip rotates and teaches positive phrasing", () => {
  const first = renderRedoHint(0);
  const second = renderRedoHint(1);
  assert.notEqual(first, second, "the hint must rotate as they keep rerolling");
  const all = REDO_HINTS.join(" ");
  assert.match(all, /chest-up/i);
  assert.match(all, /grounded/i);
  // The core lesson: describe what you want, don't write "no X".
  assert.match(all, /can backfire/i);
});
