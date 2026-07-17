import assert from "node:assert/strict";
import test from "node:test";

const { buildPlayerPortraitPrompt } = await import("../server/solo/imageWorker.js");

// Item 7 canon fix (revised 2026-07-17): The Beckoned is a modern-Earth human
// isekai champion, not a fantasy race. The prompt must frame a present-day human
// and assert human features POSITIVELY, and must NOT leak the "The Beckoned"
// placeholder that the Babel creator stuffs into the race + class slots.
// The live path is pollinations (positive-prompt-only), so canon must reach the
// image as a POSITIVE assertion — a "NOT elf ears" negation renders the "elf" token
// literally and backfires (the elf-ears report). The prompt therefore carries NO
// "elf" token at all for a human/Beckoned character.

test("Beckoned origin frames a modern-Earth human POSITIVELY, no 'elf' token, drops placeholder race/class", () => {
  const prompt = buildPlayerPortraitPrompt(
    // Babel creator fills race AND class with the origin string as placeholders.
    { name: "Ash", race: "The Beckoned", class: "The Beckoned", origin: "The Beckoned", pronouns: "they/them" },
    { tone: "grim dark fantasy", artStyle: "illustrated" }
  );
  assert.match(prompt, /modern Earth human/i, "frames a modern-Earth human");
  assert.match(prompt, /newly pulled into a grim dark fantasy world/i, "isekai framing keeps the world tone");
  assert.match(prompt, /rounded ears/i, "human ears asserted POSITIVELY");
  assert.match(prompt, /contemporary real-world appearance/i, "plain-modern emphasis, positive");
  assert.doesNotMatch(prompt, /elf/i, "NO 'elf' token — it backfires on positive-only providers");
  assert.doesNotMatch(prompt, /The Beckoned/, "placeholder origin string never leaks into the prompt");
  assert.match(prompt, /Ash/, "keeps the character name");
});

test("Beckoned keeps a REAL class/background but not the placeholder", () => {
  const prompt = buildPlayerPortraitPrompt(
    { name: "Ash", race: "The Beckoned", class: "hunter", background: "detective", origin: "the beckoned" },
    { tone: "grimdark", artStyle: "cinematic" }
  );
  assert.match(prompt, /hunter/, "real class survives");
  assert.match(prompt, /detective background/, "real background survives");
  assert.doesNotMatch(prompt, /The Beckoned/i, "no placeholder leak");
});

test("explicit Elf race (no Beckoned origin) still renders pointed ears", () => {
  const prompt = buildPlayerPortraitPrompt(
    { name: "Kael", race: "Elf", class: "Ranger" },
    { tone: "grimdark", artStyle: "anime" }
  );
  assert.match(prompt, /pointed ears/i, "elf keeps pointed ears");
  assert.doesNotMatch(prompt, /modern Earth human/i, "not modern-Earth framed");
});

test("Human race asserts rounded ears positively, no 'elf' token", () => {
  const prompt = buildPlayerPortraitPrompt({ name: "Mara", race: "Human", class: "Fighter" }, { artStyle: "illustrated" });
  assert.match(prompt, /rounded (human )?ears/i, "rounded human ears asserted positively");
  assert.doesNotMatch(prompt, /elf/i, "a human must never carry the 'elf' token");
});

test("no race and no origin still asserts human ears positively (safe default)", () => {
  const prompt = buildPlayerPortraitPrompt({ name: "Nemo" }, { artStyle: "illustrated" });
  assert.match(prompt, /rounded human ears/i, "default human asserts rounded ears positively");
  assert.doesNotMatch(prompt, /elf/i, "no 'elf' token on the default human");
});
