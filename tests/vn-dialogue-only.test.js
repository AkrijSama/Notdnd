import assert from "node:assert/strict";
import test from "node:test";
import { splitVnDialogue, splitVnDialogueForScene } from "../src/components/soloSceneShell.js";

// vn-dialogue-only (owner ruling, absolute): the VN overlay shows the ADDRESSED
// speaker's QUOTED DIALOGUE ONLY; every other word goes to the narration log.
// Conservation: no character of GM output may be dropped or duplicated.

// The owner's live failure (run_5d403dcb, VN with Ilse): a multi-actor beat
// around two quoted lines. Ilse is addressed; Garrick, Marta, the courier present.
const OWNER_BEAT =
  `Ilse's scarred hand tightens on the ledger. "You shouldn't have come back," she says, ` +
  `low enough that only you hear it. Garrick shifts by the door, and the courier's satchel ` +
  `slips from his shoulder. "But since you did — Old Marta's waiting on the north road," Ilse adds.`;

function conserved(source, result) {
  return result.segments.map((s) => s.text).join("") === source;
}

// (a) conservation — no text lost or duplicated (pins the "Ilse's scarred" bug dead)
test("(a) conservation: segments reconstruct the source EXACTLY — no char lost/duplicated", () => {
  const r = splitVnDialogueForScene(OWNER_BEAT, {
    cast: [{ npcId: "ilse", displayName: "Ilse" }, { npcId: "garrick", displayName: "Garrick" }]
  }, "Ilse", "Bram");
  assert.ok(conserved(OWNER_BEAT, r), "segments.join must equal the source verbatim");
  // the orphan fragment "Ilse's scarred" is preserved in the log, never dropped
  assert.match(r.logText, /Ilse's scarred hand tightens on the ledger\./);
  // the truncated tail "Old Marta's waiting on the north road" survives in the VN quote
  assert.match(r.vnText, /Old Marta's waiting on the north road/);
});

// (b) scene beat around dialogue → beat in the LOG, quotes in the VN
test("(b) scene beat around dialogue: beat to log, addressed quotes to VN", () => {
  const r = splitVnDialogueForScene(OWNER_BEAT, {
    cast: [{ npcId: "ilse", displayName: "Ilse" }, { npcId: "garrick", displayName: "Garrick" }]
  }, "Ilse", "Bram");
  // Ilse's two quoted lines are in the VN, WITH their quote marks
  assert.match(r.vnText, /"You shouldn't have come back,"/);
  assert.match(r.vnText, /"But since you did — Old Marta's waiting on the north road,"/);
  assert.equal(r.hasVnDialogue, true);
  // the surrounding beat (hands, Garrick, courier, satchel) is in the log, NOT the VN
  assert.match(r.logText, /Garrick shifts by the door/);
  assert.match(r.logText, /courier's satchel/);
  assert.doesNotMatch(r.vnText, /Garrick/);
  assert.doesNotMatch(r.vnText, /satchel/);
});

// (c) a quote attributable to ANOTHER present NPC → LOG, never the VN
test("(c) other-NPC quote routes to the log, not the addressed speaker's VN", () => {
  const text = `"Hold there," Garrick warns from the door. Ilse only nods. "Let them pass," she says.`;
  const r = splitVnDialogueForScene(text, {
    cast: [{ npcId: "ilse", displayName: "Ilse" }, { npcId: "garrick", displayName: "Garrick" }]
  }, "Ilse", "Bram");
  assert.ok(conserved(text, r));
  assert.match(r.vnText, /"Let them pass,"/, "Ilse's line to the VN");
  assert.doesNotMatch(r.vnText, /Hold there/, "Garrick's line must NOT be in the VN");
  assert.match(r.logText, /"Hold there," Garrick warns/, "Garrick's line goes to the log");
});

// (d) zero-quote response → everything to the log, VN shows nothing new
test("(d) zero-dialogue response: all text to log, no VN content", () => {
  const text = `Ilse turns away, the lantern guttering as she pulls the ledger shut. The room goes quiet.`;
  const r = splitVnDialogueForScene(text, { cast: [{ npcId: "ilse", displayName: "Ilse" }] }, "Ilse", "Bram");
  assert.ok(conserved(text, r));
  assert.equal(r.hasVnDialogue, false);
  assert.equal(r.vnText, "");
  assert.equal(r.logText, text, "the whole response is the log entry");
});

// sole-NPC 1:1: an untagged quote IS the addressed speaker's (the common case)
test("1:1 conversation: an untagged quote is the sole present NPC's → VN", () => {
  const text = `The door creaks. "I wondered when you'd find me," she murmurs.`;
  const r = splitVnDialogueForScene(text, { cast: [{ npcId: "ilse", displayName: "Ilse" }] }, "Ilse", "Bram");
  assert.ok(conserved(text, r));
  assert.match(r.vnText, /"I wondered when you'd find me,"/);
  assert.match(r.logText, /The door creaks\./);
});

// multi-NPC ambiguity: an untagged quote with several NPCs present → LOG (never guess)
test("untagged quote with multiple NPCs present is ambiguous → log (VN never guesses)", () => {
  const text = `Voices tangle in the dark. "Who's there?"`;
  const r = splitVnDialogueForScene(text, {
    cast: [{ npcId: "ilse", displayName: "Ilse" }, { npcId: "garrick", displayName: "Garrick" }]
  }, "Ilse", "Bram");
  assert.ok(conserved(text, r));
  assert.equal(r.hasVnDialogue, false, "ambiguous untagged line is not assumed to be the addressed speaker");
  assert.match(r.logText, /"Who's there\?"/);
});

// the player's own quoted line never appears in the VN speaker box
test("the player's quoted line routes to the log, not the NPC's VN box", () => {
  const text = `"Where is she?" Bram asks. Ilse tilts her head. "Closer than you think," she answers.`;
  const r = splitVnDialogueForScene(text, { cast: [{ npcId: "ilse", displayName: "Ilse" }] }, "Ilse", "Bram");
  assert.ok(conserved(text, r));
  assert.doesNotMatch(r.vnText, /Where is she/, "player's line stays out of the VN");
  assert.match(r.vnText, /"Closer than you think,"/);
  assert.match(r.logText, /"Where is she\?" Bram asks/);
});
