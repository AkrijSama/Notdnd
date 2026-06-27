import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyCandidates,
  normalizeCandidates,
  parseSourcebookText
} from "../server/homebrew/pdfImport.js";

const LONG_TEXT = "Sourcebook content. ".repeat(40); // > MIN_USEFUL_CHARS

function stubGenerate(content) {
  return async () => ({ content });
}

test("normalizeCandidates forces shape, drops unnamed, caps lists, sanitizes", () => {
  const out = normalizeCandidates({
    races: [
      { name: "  Goliath  ", size: "Medium", speed: 30, traits: ["Stone's Endurance", "Powerful Build"] },
      { name: "", traits: ["dropped"] } // unnamed -> dropped
    ],
    subclasses: [{ name: "Path of the Giant", className: "Barbarian", features: ["Giant's Might"] }],
    backgrounds: [{ name: "Sage", skillProficiencies: ["Arcana", "History"], feature: { name: "Researcher", description: "You know where to find lore." } }],
    feats: [{ name: "Lucky", prerequisite: "", description: "Reroll dice." }],
    junk: "ignored"
  });
  assert.equal(out.races.length, 1);
  assert.equal(out.races[0].name, "Goliath"); // trimmed
  assert.equal(out.races[0].kind, "race");
  assert.equal(out.subclasses[0].className, "Barbarian");
  assert.equal(out.backgrounds[0].feature.name, "Researcher");
  assert.equal(out.feats[0].name, "Lucky");
});

test("normalizeCandidates clamps bad speed + non-arrays to safe defaults", () => {
  const out = normalizeCandidates({ races: [{ name: "Weird", speed: 9999, traits: "not-an-array" }] });
  assert.equal(out.races[0].speed, 30); // out-of-range -> default
  assert.deepEqual(out.races[0].traits, []); // non-array -> []
});

test("normalizeCandidates on garbage returns empty well-formed shape", () => {
  assert.deepEqual(normalizeCandidates(null), emptyCandidates());
  assert.deepEqual(normalizeCandidates("nope"), emptyCandidates());
});

test("parseSourcebookText: too-short text -> ok:false with a manual-entry hint", async () => {
  const res = await parseSourcebookText("tiny", { generate: stubGenerate("{}") });
  assert.equal(res.ok, false);
  assert.match(res.reason, /manually|manual entry|paste/i);
  assert.deepEqual(res.candidates, emptyCandidates());
});

test("parseSourcebookText: valid model JSON -> ok:true with parsed candidates", async () => {
  const json = JSON.stringify({
    races: [{ name: "Aarakocra", size: "Medium", speed: 25, traits: ["Flight"] }],
    feats: [{ name: "Telekinetic", description: "Move objects with your mind." }]
  });
  const res = await parseSourcebookText(LONG_TEXT, { generate: stubGenerate(`Here you go: ${json}`) });
  assert.equal(res.ok, true);
  assert.equal(res.candidates.races[0].name, "Aarakocra");
  assert.equal(res.candidates.feats[0].name, "Telekinetic");
  assert.ok(res.count >= 2);
});

test("parseSourcebookText: model returns no recognizable content -> ok:false (not a crash)", async () => {
  const res = await parseSourcebookText(LONG_TEXT, { generate: stubGenerate("I could not find anything useful.") });
  assert.equal(res.ok, false);
  assert.deepEqual(res.candidates, emptyCandidates());
});

test("parseSourcebookText: model throws -> graceful ok:false, never rejects", async () => {
  const res = await parseSourcebookText(LONG_TEXT, {
    generate: async () => {
      throw new Error("provider down");
    }
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /failed|timed out|manual/i);
});
