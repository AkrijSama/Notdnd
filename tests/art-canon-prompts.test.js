// ART CANON — the live-run image prompts must be built from COMMITTED identity/world
// data (positively), never from a poetic name alone or a backfiring negation.
// Regressions fixed 2026-07-17: (biplane) scene prompts dropped the committed
// location description; (elf ears) the human/Beckoned portrait fed "NOT elf ears"
// text to pollinations (positive-prompt-only), which rendered the "elf" token.
import assert from "node:assert/strict";
import test from "node:test";
import { buildPlayerPortraitPrompt, locationCanonFragment } from "../server/solo/imageWorker.js";

// ── scene canon (biplane fix) ────────────────────────────────────────────────
test("locationCanonFragment: extracts the committed first sentence, sanitized + capped", () => {
  const loc = {
    name: "The Green Static — Fringe",
    description: "The corrupted edge of an old Pacific-Northwest rainforest, Exclusion Zone EZ-44. From here the air shimmers."
  };
  const frag = locationCanonFragment(loc);
  assert.match(frag, /Pacific-Northwest rainforest/, "the canon geography reaches the fragment");
  assert.match(frag, /Exclusion Zone EZ-44/);
  assert.doesNotMatch(frag, /From here the air/, "only the FIRST sentence (the setting anchor)");
  assert.ok(frag.length <= 200, "capped");
});

test("locationCanonFragment: empty when no committed description (no invented canon)", () => {
  assert.equal(locationCanonFragment({ name: "Nowhere" }), "");
  assert.equal(locationCanonFragment({}), "");
  assert.equal(locationCanonFragment({ description: "   " }), "");
});

// ── portrait canon (elf-ears fix) ────────────────────────────────────────────
test("player portrait (Babel Beckoned MC): frames a modern human, no 'elf' token", () => {
  const prompt = buildPlayerPortraitPrompt(
    { race: "The Beckoned", origin: "The Beckoned", class: "The Beckoned", pronouns: "he/him" },
    { name: "Babel", tone: "modern arcane", artStyleOptions: { default: "anime" } }
  );
  assert.match(prompt, /modern Earth human/i, "canon HUMAN reaches the prompt");
  assert.match(prompt, /rounded (human )?ears/i, "human ears asserted POSITIVELY");
  assert.doesNotMatch(prompt, /elf/i, "no 'elf' token — pollinations is positive-prompt-only and would render it");
});

test("player portrait (plain Human race): rounded ears positively, no 'elf' token", () => {
  const prompt = buildPlayerPortraitPrompt({ race: "Human", pronouns: "she/her", name: "Mara" }, { tone: "dark fantasy", artStyleOptions: { default: "dark-fantasy" } });
  assert.match(prompt, /rounded (human )?ears/i);
  assert.doesNotMatch(prompt, /elf/i, "a human must never carry the 'elf' token on a positive-only provider");
});

test("player portrait (actual Elf): pointed ears preserved (fix does not flatten real elves)", () => {
  const prompt = buildPlayerPortraitPrompt({ race: "Elf", pronouns: "they/them", name: "Ael" }, { tone: "high fantasy", artStyleOptions: { default: "anime" } });
  assert.match(prompt, /pointed ears/i, "elves still render with pointed ears");
});

test("player portrait: no race carries a positive human default, no 'elf' token", () => {
  const prompt = buildPlayerPortraitPrompt({ pronouns: "he/him" }, { tone: "grim", artStyleOptions: { default: "dark-fantasy" } });
  assert.match(prompt, /rounded human ears/i, "the default (Human) asserts rounded ears positively");
  assert.doesNotMatch(prompt, /elf/i);
});
