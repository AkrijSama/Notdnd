import assert from "node:assert/strict";
import test from "node:test";
import { SYSTEM_LORE, buildSystemLoreClause, detectSystemLoreViolations } from "../server/gm/systemLore.js";
import { buildOpeningGmMessage } from "../server/gm/actionNarration.js";
import { repairNarrationPronouns } from "../server/solo/npcCommit.js";
import { enforceHandles } from "../server/gm/handlesEnforcement.js";

// ---- ITEM 1: WINDOW/VOICE system lore ----------------------------------------

test("item1: system lore has the mandatory does / does-not split and the clause carries both", () => {
  assert.ok(SYSTEM_LORE.window.does.length > 0 && SYSTEM_LORE.window.doesNot.length > 0);
  assert.ok(SYSTEM_LORE.window.doesNot.includes("remember"), "the live-observed violation is in the does-not list");
  const clause = buildSystemLoreClause();
  assert.match(clause, /does NOT remember/);
  assert.match(clause, /status display/i);
});

test("item1: 'the window will remember' is flagged; 'the window shows your level' is NOT", () => {
  const bad = detectSystemLoreViolations("The window will remember what direction you go.");
  assert.equal(bad.length, 1);
  assert.equal(bad[0].subject, "window");
  assert.equal(bad[0].verb, "remember");
  assert.deepEqual(detectSystemLoreViolations("The window shows your level and your six measures."), []);
  // negated attribution is the lore stated CORRECTLY — never flagged
  assert.deepEqual(detectSystemLoreViolations("The window does not remember anything; it only displays."), []);
  // voice side
  assert.equal(detectSystemLoreViolations("The voice watches you from the treeline.").length, 1);
  assert.deepEqual(detectSystemLoreViolations("The voice spoke once at your arrival."), []);
});

// ---- ITEM 2: opening re-register (chaos-gradient law) -------------------------

test("item2: opening directive is oriented-and-ordinary — orientation clauses present, wrongness register absent", () => {
  const msg = buildOpeningGmMessage({
    characterName: "Kael",
    world: { tone: "grimdark", startingLocation: { name: "The Fringe Forest" } },
    worldTime: { clock: "07:00", phase: "day" }
  });
  // normal-forest / ordinary register
  assert.match(msg, /ordinary, calm, everyday/i);
  assert.match(msg, /corruption is weakest/i);
  assert.match(msg, /ONE subtle seed/i);
  // VOICE orientation: the four mandatory beats
  assert.match(msg, /brought here from their old life/i);
  assert.match(msg, /what this land is/i);
  assert.match(msg, /town lies nearby.*safety and answers/i);
  assert.match(msg, /WINDOW has been granted/i);
  assert.match(msg, /Clarity outranks mystery/i);
  // handles: town as the unmistakable primary direction
  assert.match(msg, /town as the UNMISTAKABLE primary direction/i);
  // NO wrongness-register terms in the directive text itself
  for (const banned of ["static", "shimmer", "wrong", "hostile"]) {
    assert.ok(!msg.toLowerCase().includes(banned), `directive must not contain "${banned}"`);
  }
});

// ---- ITEM 4: pronoun repair gate width (S5 Talin slip) ------------------------

test("item4 regression: MIXED pronoun usage (the S5 Talin case) is repaired", () => {
  // Reconstructed minimal repro (S5 transcript narration text is not persisted):
  // committed he/him Talin narrated with she/her ×2 ALONGSIDE correct he/his —
  // the old majority-vote gate tied and never fired; the ruler still flagged ×2.
  const npcs = [{ npcId: "npc_t", displayName: "Talin", generatedName: "Talin", gender: "male", pronouns: "he/him" }];
  const r = repairNarrationPronouns(
    "Talin sets the mug down as he studies you. She wipes her hands slow, and his eyes never leave yours.",
    npcs
  );
  assert.equal(r.repairs.length, 1, "mixed usage now triggers the repair");
  assert.doesNotMatch(r.text, /\bShe wipes\b/);
  assert.match(r.text, /He wipes his hands/);
  assert.match(r.text, /his eyes never leave/, "correct pronouns untouched");
});

test("item4: shared sentence with an opposite-gendered NPC is never swapped (ambiguity guard)", () => {
  const npcs = [
    { npcId: "npc_t", displayName: "Talin", generatedName: "Talin", gender: "male", pronouns: "he/him" },
    { npcId: "npc_m", displayName: "Mara", generatedName: "Mara", gender: "female", pronouns: "she/her" }
  ];
  const r = repairNarrationPronouns("Talin hands the mug to Mara as she thanks him.", npcs);
  assert.equal(r.repairs.length, 0, "her/she belongs to Mara — no repair");
  assert.match(r.text, /she thanks him/);
});

// ---- ITEM 5: handles enforcement (one retry, never blocks) --------------------

const HANDLE_LESS = "The rain keeps falling on the ash. Nothing stirs. The night wears on and the fire dims to coals.";
const WITH_HANDLES = "The rain eases.\n\nThe road north waits, and the door to the cellar hangs open. Do you press on or dig in?";

test("item5: a handle-less draft triggers EXACTLY one retry and adopts the retry draft", async () => {
  let calls = 0;
  const out = await enforceHandles(HANDLE_LESS, {
    scene: { cast: [] },
    regenerate: async () => {
      calls += 1;
      return WITH_HANDLES;
    }
  });
  assert.equal(calls, 1, "exactly one retry");
  assert.equal(out.handlesRetry, 1);
  assert.equal(out.narrative, WITH_HANDLES);
});

test("item5: a draft WITH handles never retries; a failed retry keeps the first draft", async () => {
  let calls = 0;
  const ok = await enforceHandles(WITH_HANDLES, { scene: { cast: [] }, regenerate: async () => { calls += 1; return "x"; } });
  assert.equal(calls, 0, "no retry when handles present");
  assert.equal(ok.handlesRetry, 0);
  // retry fails (empty / throws) -> first draft stands, turn never blocked
  const failed = await enforceHandles(HANDLE_LESS, { scene: { cast: [] }, regenerate: async () => { throw new Error("boom"); } });
  assert.equal(failed.handlesRetry, 1);
  assert.equal(failed.narrative, HANDLE_LESS);
});
