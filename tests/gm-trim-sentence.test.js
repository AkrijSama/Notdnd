import assert from "node:assert/strict";
import test from "node:test";
import { trimToCompleteSentence, isLengthCut } from "../server/gm/trimSentence.js";
import { attributeSceneDialogue } from "../server/solo/gmProvider.js";

// sentence-boundary-trim (owner 2026-07-11): a length-capped generation is
// repaired back to its last complete sentence; a self-completed one is untouched.
// finish_reason is the ONLY trigger — never inferred from the text.

test("isLengthCut detects the cap-cut across provider spellings; normal stops are not cuts", () => {
  for (const r of ["length", "max_tokens", "MAX_OUTPUT_TOKENS", "token_limit"]) {
    assert.equal(isLengthCut(r), true, `${r} is a length cut`);
  }
  for (const r of ["stop", "end_turn", "", null, undefined]) {
    assert.equal(isLengthCut(r), false, `${JSON.stringify(r)} is NOT a length cut`);
  }
});

// (a) mid-sentence length-cut → trims to the prior terminator.
test("(a) a mid-sentence length cut trims to the last complete sentence", () => {
  const raw = "You cross the yard. The gate hangs open, and beyond it the road bends into fog where something dar";
  const out = trimToCompleteSentence(raw, "length");
  assert.equal(out, "You cross the yard.");
  assert.doesNotMatch(out, /dar$/, "the dangling partial word is dropped");
});

// (b) mid-QUOTE length-cut — the owner's EXACT verbatim failure shape.
test("(b) a mid-quote length cut drops the beheaded quote entirely, balanced output", () => {
  const raw = 'The Woman sees you notice. "That\'s new';
  const out = trimToCompleteSentence(raw, "length");
  assert.equal(out, "The Woman sees you notice.");
  // no unclosed double quote remains
  const dquotes = (out.match(/["“”]/g) || []).length;
  assert.equal(dquotes % 2, 0, "double quotes are balanced (none dangling)");
  assert.doesNotMatch(out, /That's new/, "the partial quote is gone");
});

test("(b2) a completed quote followed by a severed one keeps the closed quote, drops the partial", () => {
  const raw = 'She turns the coin over. "Keep it close." Then her eyes narrow. "Whatever you do, don';
  const out = trimToCompleteSentence(raw, "length");
  assert.equal(out, 'She turns the coin over. "Keep it close." Then her eyes narrow.');
  assert.equal((out.match(/"/g) || []).length % 2, 0, "straight quotes balanced");
});

// (c) normal finish → untouched (never trim a complete generation).
test("(c) a self-completed generation is passed through untouched", () => {
  const raw = 'You step inside. "Welcome," she says, and the door clicks shut behind you';
  // NOTE: no trailing period, but finish_reason is a normal stop → do not trim.
  assert.equal(trimToCompleteSentence(raw, "stop"), raw);
  assert.equal(trimToCompleteSentence(raw, null), raw);
  // a complete, length-cut text that happens to end on a terminator is unchanged
  assert.equal(trimToCompleteSentence("You wait. The room is still.", "length"), "You wait. The room is still.");
});

// (3) >40% removed → keep the trim, emit a warning.
test("(3) trimming >40% keeps the trim and logs a warning", () => {
  const raw = 'Fine. "I will tell you everything about the vault and the men who guard it and the price they will dem';
  const warnings = [];
  const out = trimToCompleteSentence(raw, "length", { onWarn: (m) => warnings.push(m) });
  assert.equal(out, "Fine.");
  assert.ok(out.length < raw.length * 0.6, "more than 40% was removed");
  assert.equal(warnings.length, 1, "a tuning warning was logged");
  assert.match(warnings[0], /too tight/i);
});

// safety valve: never blank a turn even if no complete sentence precedes the cut.
test("safety valve: a generation with no complete sentence is not blanked", () => {
  const raw = '"There is no way out of';
  const out = trimToCompleteSentence(raw, "length");
  assert.ok(out.trim().length > 0, "never returns empty narration");
});

// (d) conservation with the VN split: the trimmed (balanced) text splits into
//     dialogue lines with zero loss and zero duplication, and no partial line.
test("(d) trimmed text splits through the VN attributor with no loss or duplication", () => {
  const raw = 'Marta leans in. "Keep it close," she says. Then she frowns. "Whatever you do, don';
  const trimmed = trimToCompleteSentence(raw, "length");
  assert.equal((trimmed.match(/["“”]/g) || []).length % 2, 0, "quotes balanced after trim");
  const lines = attributeSceneDialogue(trimmed, [{ npcId: "npc_marta", displayName: "Marta" }], { playerName: "Wanderer" });
  const npcLines = lines.filter((l) => l.kind === "npc");
  assert.equal(npcLines.length, 1, "exactly the one COMPLETE quote splits out — the beheaded one is gone");
  assert.equal(npcLines[0].speakerId, "npc_marta");
  assert.match(npcLines[0].text, /Keep it close/);
  // no duplication: the completed quote appears once in the trimmed body
  assert.equal((trimmed.match(/Keep it close/g) || []).length, 1);
});

// apostrophes are not quote delimiters (must not desync the analysis).
test("apostrophes ('That's, don't) do not confuse the quote analysis", () => {
  const raw = "It's quiet. She won't move. The lantern doesn't flicke";
  const out = trimToCompleteSentence(raw, "length");
  assert.equal(out, "It's quiet. She won't move.");
});
