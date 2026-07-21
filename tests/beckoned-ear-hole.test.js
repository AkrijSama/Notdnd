// W6 — BECKONED EAR-HOLE. Every HUMAN-kind origin (the Beckoned/isekai path included)
// must carry the rounded-human-ears assertion so the elf-defense negative fires. It was
// confessed as a residual elf-ears 1/3 on the Beckoned anime lane; now the Beckoned
// routes through the SAME canonical human-ear clause as every other human origin.
import assert from "node:assert/strict";
import test from "node:test";
import { buildPlayerPortraitPrompt } from "../server/solo/imageWorker.js";
import { elfDefenseFor } from "../server/ai/comfyui.js";

const STYLES = ["anime", "illustrated", "cinematic"];

test("CROSS-ORIGIN: every human-kind origin carries the ear assertion AND fires the elf defense", () => {
  const humanOrigins = [
    { label: "Beckoned", char: { name: "Kael", pronouns: "he/him", race: "The Beckoned", characterClass: "The Beckoned", origin: "The Beckoned", gender: "male" } },
    { label: "plain Human", char: { name: "Mara", pronouns: "she/her", race: "Human", characterClass: "Fighter", gender: "female" } },
    { label: "no-race default", char: { name: "Ren", pronouns: "they/them" } },
    { label: "Dwarf", char: { name: "Brun", pronouns: "he/him", race: "Dwarf", characterClass: "Cleric", gender: "male" } }
  ];
  for (const { label, char } of humanOrigins) {
    for (const style of STYLES) {
      const p = buildPlayerPortraitPrompt(char, { tone: "dark fantasy", artStyleOptions: { default: style } });
      assert.match(p, /rounded human ears/i, `${label}/${style}: rounded-human-ears assertion present`);
      // and the elf defense actually fires on that positive (the whole point)
      assert.notEqual(elfDefenseFor(p), "", `${label}/${style}: elf defense fires`);
    }
  }
});

test("the Beckoned isekai/anime lane specifically now triggers the elf defense (the 1/3 hole)", () => {
  const beckoned = { name: "Kael", pronouns: "he/him", race: "The Beckoned", characterClass: "The Beckoned", origin: "The Beckoned", gender: "male" };
  const anime = buildPlayerPortraitPrompt(beckoned, { tone: "dark fantasy", artStyleOptions: { default: "anime" } });
  assert.match(anime, /isekai/i, "still the isekai framing (anime-native)");
  assert.match(anime, /naturally rounded human ears and a natural human face/i, "the canonical ear clause is routed in");
  assert.match(elfDefenseFor(anime), /elf ears/i, "the elf-ears negative is emitted for the Beckoned anime lane");
});

test("a REAL elf is NOT fought (keeps pointed ears; no elf-defense negative)", () => {
  const elf = { name: "Ael", pronouns: "they/them", race: "Elf", characterClass: "Ranger" };
  const p = buildPlayerPortraitPrompt(elf, { tone: "high fantasy", artStyleOptions: { default: "anime" } });
  assert.match(p, /pointed ears/i, "elves keep pointed ears");
  assert.equal(elfDefenseFor(p), "", "the elf defense does not fight a declared elf");
});
