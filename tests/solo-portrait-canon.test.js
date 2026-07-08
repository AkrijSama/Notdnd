import assert from "node:assert/strict";
import test from "node:test";

const { buildPlayerPortraitPrompt } = await import("../server/solo/imageWorker.js");

// Item 7 canon fix: The Beckoned is a modern-Earth human isekai champion, not a
// fantasy race. The prompt must frame a present-day human and hard-negate the
// elf/fantasy default, and must NOT leak the "The Beckoned" placeholder that the
// Babel creator stuffs into the race + class slots (src/main.js).

test("Beckoned origin frames a modern-Earth human, hard-negates elf, drops placeholder race/class", () => {
  const prompt = buildPlayerPortraitPrompt(
    // Babel creator fills race AND class with the origin string as placeholders.
    { name: "Ash", race: "The Beckoned", class: "The Beckoned", origin: "The Beckoned", pronouns: "they/them" },
    { tone: "grim dark fantasy", artStyle: "illustrated" }
  );
  assert.match(prompt, /modern Earth human/i, "frames a modern-Earth human");
  assert.match(prompt, /newly pulled into a grim dark fantasy world/i, "isekai framing keeps the world tone");
  assert.match(prompt, /NOT pointed elf ears/i, "hard elf negation present");
  assert.match(prompt, /NOT high-fantasy costume/i, "modern-Earth negation present");
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
  assert.doesNotMatch(prompt, /NOT pointed elf ears/i, "no negation for a real elf");
});

test("Human race negates elf ears", () => {
  const prompt = buildPlayerPortraitPrompt({ name: "Mara", race: "Human", class: "Fighter" }, { artStyle: "illustrated" });
  assert.match(prompt, /NOT pointed elf ears/i);
});

test("no race and no origin still asserts human (safe default, not a fantasy elf)", () => {
  const prompt = buildPlayerPortraitPrompt({ name: "Nemo" }, { artStyle: "illustrated" });
  assert.match(prompt, /NOT pointed elf ears/i, "default human negation fires even with no race");
});
