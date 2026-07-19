// ELF DEFENSE (per-provider) — the 2026-07-18 relapse regression.
//
// 5cc04ed fixed the POSITIVE prompt (assert "rounded human ears", never a "NOT elf"
// negation that positive-only pollinations renders literally). But the owner's
// anime onboarding portrait still rendered elf ears on the ComfyUI path: an
// anime-native SDXL checkpoint biases toward pointed ears from fantasy framing, and
// ComfyUI's NEGATIVE field carried no elf defense. This asserts, for a human subject
// on the ComfyUI path: the positive asserts rounded human ears and NEVER emits
// "elf"; the negative DOES carry the weighted elf block — on BOTH the generic style
// workflow and the validated per-lane export. Real elves are never suppressed.
import assert from "node:assert/strict";
import test from "node:test";
import {
  comfyuiWorkflowForStyle,
  resolveValidatedComfyWorkflow,
  elfDefenseFor,
  withElfDefense
} from "../server/ai/comfyui.js";
import { buildPlayerPortraitPrompt } from "../server/solo/imageWorker.js";

// The negative CLIPTextEncode text of a graph = the node wired to KSampler.negative.
function negativeText(graph) {
  let negId = null;
  for (const node of Object.values(graph || {})) {
    if (/KSampler/.test(node?.class_type || "")) negId = node.inputs?.negative?.[0];
  }
  return negId && graph[negId] ? String(graph[negId].inputs.text || "") : "";
}

const BECKONED_POSITIVE = buildPlayerPortraitPrompt(
  { name: "Ashe", origin: "The Beckoned", race: "The Beckoned", characterClass: "The Beckoned" },
  { tone: "grimdark", artStyle: "anime" }
);

// ── the positive builder never emits an elf token for a human (guards 5cc04ed) ──
test("Beckoned positive: asserts rounded human ears, no 'elf' token", () => {
  assert.match(BECKONED_POSITIVE, /rounded (human )?ears|naturally rounded ears/i, "rounded-ear assertion present");
  assert.doesNotMatch(BECKONED_POSITIVE, /\belf\b/i, "no 'elf' token in a human positive");
  assert.doesNotMatch(BECKONED_POSITIVE, /pointed ears/i, "no pointed-ear token in a human positive");
});

// ── generic ComfyUI style workflow (the path the owner's draft actually hit) ─────
test("generic anime workflow (human): elf block in NEGATIVE, never in positive", () => {
  const { workflow } = comfyuiWorkflowForStyle("anime", { prompt: BECKONED_POSITIVE });
  const positive = String(workflow["6"].inputs.text || "");
  const negative = String(workflow["7"].inputs.text || "");
  assert.doesNotMatch(positive, /\belf\b/i, "no 'elf' in the positive");
  assert.match(negative, /elf/i, "elf defense present in the negative");
  assert.match(negative, /pointed ears/i, "pointed-ears defended in the negative");
});

// ── sealed anime-lane laws (2026-07-18 relapse: two heads, sketch, age young) ────
test("sealed anime laws (human portrait): quality vocab, single-head, finished, adult", () => {
  const { workflow } = comfyuiWorkflowForStyle("anime", { prompt: BECKONED_POSITIVE });
  const positive = String(workflow["6"].inputs.text || "");
  const negative = String(workflow["7"].inputs.text || "");
  // JANKU booru quality register (v4 anime dialect) — leads the positive.
  assert.match(positive, /masterpiece, best quality/i, "JANKU booru quality vocab present");
  // Multi-head / reference-sheet law (fixes the two heads).
  assert.match(negative, /multiple heads|two heads|extra heads/i, "multi-head defended");
  assert.match(negative, /reference sheet|model sheet|turnaround/i, "reference-sheet defended");
  // Finished-render law (fixes sketch-grade).
  assert.match(negative, /sketch|unfinished|monochrome/i, "sketch/unfinished defended");
  // AGE LAW: weighted adult in the builder positive + young negation in the negative.
  assert.match(BECKONED_POSITIVE, /\(adult[^)]*:1\.3\)/i, "weighted adult in the builder positive");
  assert.match(negative, /young|youthful|teen|child/i, "young default negated");
});

test("AGE-LAW + gender lock: a male Beckoned MC carries a weighted adult-man token", () => {
  const male = buildPlayerPortraitPrompt(
    { name: "Ashe", origin: "The Beckoned", gender: "man", pronouns: "he/him" },
    { tone: "grimdark", artStyle: "anime" }
  );
  assert.match(male, /\(adult man:1\.3\)/i, "weighted adult-man token (anime is female-biased)");
});

// ── validated per-lane export (the path the draft SHOULD hit, post routing fix) ──
test("validated portrait-anime export (human): elf block reaches the recipe negative", () => {
  const selected = resolveValidatedComfyWorkflow("anime", "portrait", {
    positive: BECKONED_POSITIVE,
    negative: withElfDefense(BECKONED_POSITIVE, "lowres, worst quality"),
    seed: 1
  });
  assert.ok(selected && selected.workflow, "validated anime/portrait recipe resolves");
  const negative = negativeText(selected.workflow);
  assert.match(negative, /elf/i, "elf defense reaches the validated recipe negative");
  assert.match(negative, /pointed ears/i);
});

// ── real elves are NEVER suppressed ─────────────────────────────────────────────
test("Elf character: pointed ears kept, no elf block injected", () => {
  const elfPositive = buildPlayerPortraitPrompt(
    { name: "Lira", race: "Elf", characterClass: "Ranger" },
    { tone: "grimdark", artStyle: "anime" }
  );
  assert.match(elfPositive, /pointed ears/i, "an Elf positive declares pointed ears");
  assert.equal(elfDefenseFor(elfPositive), "", "no elf defense for a real elf");
  const { workflow } = comfyuiWorkflowForStyle("anime", { prompt: elfPositive });
  const negative = String(workflow["7"].inputs.text || "");
  assert.doesNotMatch(negative, /\(elf:/i, "the weighted elf block is NOT added for an elf");
});

// ── unit: the derivation itself ─────────────────────────────────────────────────
test("elfDefenseFor / withElfDefense: humans defended, elves + non-humans untouched", () => {
  assert.match(elfDefenseFor("a human person with rounded ears"), /\(elf:/, "human → defended");
  assert.equal(elfDefenseFor("an elf with pointed ears"), "", "elf → skipped");
  assert.equal(elfDefenseFor("a ruined stone chapel at dusk"), "", "scene → skipped (no ears)");
  assert.equal(withElfDefense("a ruined chapel", "lowres"), "lowres", "non-human negative unchanged");
  assert.match(withElfDefense("human, rounded ears", "lowres"), /^lowres, \(elf:/, "human negative appended, base kept");
});
