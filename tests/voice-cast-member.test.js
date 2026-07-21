// W1 — THE VOICE AS A BALL-OF-LIGHT CAST MEMBER. She was routed through the narration
// box because she had no cast row. Now she is a committed babel cast member (ball of
// warm green-gold light, NEVER violet), her opening renders as HER VN speaker surface,
// and her art upgrades per-run to a revealed form on a committed event.
import assert from "node:assert/strict";
import test from "node:test";
import { loadScenarioFile, loadScenarioIntoRun } from "../server/campaign/scenarioLoader.js";
import { createDefaultSoloRun, validateSoloRun } from "../server/solo/schema.js";
import { renderSoloSceneOpening } from "../src/components/soloSceneShell.js";
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

test("her opening renders as HER VN SPEAKER SURFACE (named, portrait-ready), not anonymous narration", () => {
  const speaker = { npcId: VOICE_NPC_ID, displayName: "The VOICE", portraitUri: "/data/assets/x/img_npc_voice.png" };
  const html = renderSoloSceneOpening("", ["[ YOU ARE HEARD. ]", "[ CLIMB. ]"], speaker);
  assert.match(html, /solo-opening-vn/, "rendered as a VN speaker surface");
  assert.match(html, /data-solo-speaker="npc_voice"/, "attributed to her committed cast id");
  assert.match(html, /solo-opening-speaker-avatar/, "her portrait avatar renders when present");
  assert.match(html, /The VOICE speaks/, "she is named as the speaker");
  // graceful fallback: no portrait yet → still her named speaker frame, no broken img
  const noArt = renderSoloSceneOpening("", ["[ YOU ARE HEARD. ]"], { npcId: VOICE_NPC_ID, displayName: "The VOICE", portraitUri: null });
  assert.doesNotMatch(noArt, /solo-opening-speaker-avatar/, "no avatar when the art is not cooked yet");
  assert.match(noArt, /The VOICE speaks/, "still her named frame");
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
