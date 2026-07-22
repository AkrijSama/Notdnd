// W1 — THE VOICE AS A BALL-OF-LIGHT CAST MEMBER. She was routed through the narration
// box because she had no cast row. Now she is a committed babel cast member (ball of
// warm green-gold light, NEVER violet), her opening renders as HER VN speaker surface,
// and her art upgrades per-run to a revealed form on a committed event.
import assert from "node:assert/strict";
import test from "node:test";
import { loadScenarioFile, loadScenarioIntoRun } from "../server/campaign/scenarioLoader.js";
import { createDefaultSoloRun, validateSoloRun } from "../server/solo/schema.js";
import { renderSoloSceneOpening, splitOpeningBeats } from "../src/components/soloSceneShell.js";
import { commitNpcReveal, resolveNpcArtForm, npcPortraitArtKey, isNpcRevealed, VOICE_NPC_ID } from "../server/solo/npcReveal.js";

function babelRun() {
  const run = createDefaultSoloRun({ runId: "voice" });
  loadScenarioIntoRun(run, loadScenarioFile("babel"), {});
  return run;
}

test("the VOICE is a committed cast member — a ball of warm green-gold light, NEVER violet", () => {
  const run = babelRun();
  const v = run.npcs[VOICE_NPC_ID];
  assert.ok(v, "npc_voice is in the committed cast");
  assert.equal(v.displayName, "The VOICE");
  assert.match(v.appearance, /light|radiance|glow|orb/i, "her appearance is a ball of light");
  assert.match(v.appearance, /green|gold/i, "warm green-gold (the Goddess register)");
  assert.doesNotMatch(v.appearance, /violet|purple/i, "NEVER violet (violet is chaos)");
  assert.match(v.portraitPrompt, /light|orb|glow/i, "her portrait prompt is the light form");
  // the run stays schema-valid with the new committed speaker + cast member
  assert.equal(validateSoloRun(run).ok, true, JSON.stringify(validateSoloRun(run).errors));
});

test("WALK-3 V4: the VOICE's opening SPEECH is split OUT of the narration log (routes to the VN box, not yellow prose — the 4×-escaped bug)", () => {
  // Payload shape: beats[0] is scene-setting narration; beats[from..] are the VOICE's
  // spoken lines (authored beatsSpeakerFrom → payload openingBeatsSpeakerFrom).
  const beats = ["The last of the old life is four seconds long: a glass set down.", "[ YOU ARE HEARD. ]", "[ CLIMB. RECLAIM WHAT WAS LEFT OPEN. ]"];
  const { narration, spoken } = splitOpeningBeats(beats, 1);
  assert.deepEqual(narration, [beats[0]], "beats before speakerFrom are scene-setting narration");
  assert.deepEqual(spoken, [beats[1], beats[2]], "beats from speakerFrom are the VOICE's spoken lines (loadScene routes these to the VN box)");
  // brackets are NOT the split: a partial/unclosed bracket still splits by INDEX
  assert.deepEqual(splitOpeningBeats(["n", "[ multi ]\n\n[ block ]", "[ unclosed"], 1).spoken.length, 2, "index split, not bracket-based");
  // The LIVE opening render passes ONLY the narration beats + null speaker, so the VOICE's
  // words never render as narration-log prose / yellow .solo-voice-dialogue / a look-alike frame.
  const log = renderSoloSceneOpening("", narration, null);
  assert.doesNotMatch(log, /YOU ARE HEARD|RECLAIM WHAT WAS LEFT/, "the VOICE's words are NOT in the narration log");
  assert.doesNotMatch(log, /solo-voice-dialogue/, "no yellow bracketed VOICE prose in the log");
  assert.doesNotMatch(log, /solo-opening-vn|VOICE speaks/, "no VN look-alike frame — her words live in the real VN box (.solo-vn-box)");
  assert.match(log, /The GM sets the scene/, "the scene-setting narration renders as GM narration");
});

test("REVEAL LAW: her art upgrades per-run to a revealed form on a committed event (mechanism)", () => {
  const run = babelRun();
  const v = run.npcs[VOICE_NPC_ID];
  assert.equal(v.revealForm, "voice_revealed", "she authors a revealed form");
  // base form + key before any reveal
  assert.equal(resolveNpcArtForm(run, v), "base");
  assert.equal(npcPortraitArtKey(run, v), "img_npc_voice");
  assert.equal(isNpcRevealed(run, VOICE_NPC_ID), false);
  // a committed event fires → permanent per-run swap
  assert.equal(commitNpcReveal(run, VOICE_NPC_ID, "voice_manifest"), true, "reveal flips");
  assert.equal(resolveNpcArtForm(run, v), "revealed");
  assert.equal(npcPortraitArtKey(run, v), "img_npc_voice_revealed", "art key swaps to the revealed slot");
  assert.equal(run.flags.npcRevealedBy[VOICE_NPC_ID], "voice_manifest", "the firing event is recorded");
  // idempotent + run-state only (never global)
  assert.equal(commitNpcReveal(run, VOICE_NPC_ID), false, "second reveal is a no-op");
  const fresh = babelRun();
  assert.equal(isNpcRevealed(fresh, VOICE_NPC_ID), false, "reveal is RUN-STATE, not global");
});

test("narration-box routing is gone: the opening carries her committed speaker id", () => {
  const run = babelRun();
  // the loader wired the opening speaker onto the run for the scene payload to carry
  // (onboarding sets run.openingSpeakerId from opening.beatsSpeaker); the scenario
  // authored beatsSpeaker=npc_voice, so a Babel run attributes the opening to her.
  const scenario = loadScenarioFile("babel");
  assert.equal(scenario.opening.beatsSpeaker, "npc_voice", "the opening set-piece is authored as the VOICE's");
});
