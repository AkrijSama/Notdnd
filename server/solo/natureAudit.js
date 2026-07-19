// NATURE-CONTRADICTION AUDITOR (species coherence). When a committed NON-HUMAN ANIMAL
// is the only third-person presence in the scene, narration must not dress it as a
// person — "a man sits against a tree… one hand pressed to the bark… he speaks" is a
// coherence crime (it reached the owner: run_61fb9c16). Per the auditor-teeth precedent
// (scrubFabricatedCombatNumbers), this STRIPS-OR-CORRECTS at the trim layer, not
// log-only: the human noun is rewritten to the committed species, human hands/voice are
// neutralized. The IMPROVED BRIEFING is the primary prevention; this is the backstop.
//
// GUARDS (no false positives): only fires when a present ANIMAL is unambiguous — i.e.
// NO present social/human NPC (bandit/human/demon) and NO shapeshifter, so a
// third-person human descriptor can only mean the animal. Uncanny is canon ("watching
// with patient intelligence" is fine — that's not a human CLAIM).
import { entityNature } from "./entityNature.js";

function isPlainObject(v) { return Boolean(v) && typeof v === "object" && !Array.isArray(v); }

// The unambiguous-animal context, or null. Present animal + no present human/shapeshifter.
function animalContext(run) {
  const here = run?.currentLocationId;
  const present = Object.values(run?.npcs || {}).filter(
    (n) => isPlainObject(n) && n.currentLocationId === here && n.status !== "gone" && n.status !== "dead"
  );
  const rated = present.map((npc) => ({ npc, nat: entityNature(npc) })).filter((x) => x.nat);
  const animals = rated.filter((x) => x.nat.isAnimal && !x.nat.shapeshifter);
  const humansOrAmbiguous = rated.filter((x) => !x.nat.isAnimal || x.nat.shapeshifter);
  if (!animals.length || humansOrAmbiguous.length) return null; // ambiguous → don't audit
  return animals[0];
}

// Human-class descriptors — things only a person has. Global flags for scrub.
const HUMAN_NOUN_RE = /\b(a|an|the|another|one|that)\s+(man|woman|guy|gentleman|lady|fellow|person|traveler|traveller|figure|human|male|female|boy|girl)\b/gi;
const HUMAN_HANDS_RE = /\b(his|her|its|the|one|a)\s+(hand|hands|finger|fingers|fist|fists|palm|palms|thumb)\b/gi;
const HUMAN_SPEAK_RE = /\b(he|she)\s+(speaks|spoke|says|said|whispers|whispered|mutters|muttered|asks|asked|replies|replied|calls out|called out)\b|\b(his|her)\s+voice\b/gi;
const HUMAN_CLOTHES_RE = /\b(his|her|its|the|a)\s+(coat|cloak|shirt|clothes|clothing|jacket|hood|boots|trousers|robe|tunic|cap|hat|sleeve|sleeves|collar)\b/gi;

const speciesNoun = (nat, npc) => nat?.species ? `the ${nat.species}` : (npc?.displayName ? `the ${npc.displayName.replace(/^the\s+/i, "")}` : "the creature");

/**
 * Detect human-class descriptors attributed to a committed animal (log form). Returns
 * [{ kind, phrase }] (empty when clean, ambiguous, or no animal present). Never throws.
 */
export function detectNatureContradiction(narrationText, run) {
  const text = String(narrationText || "");
  if (!text.trim()) return [];
  const ctx = animalContext(run);
  if (!ctx) return [];
  const hits = [];
  for (const [kind, re] of [["noun", HUMAN_NOUN_RE], ["hands", HUMAN_HANDS_RE], ["speaks", HUMAN_SPEAK_RE], ["clothing", HUMAN_CLOTHES_RE]]) {
    for (const m of text.matchAll(re)) hits.push({ kind, phrase: m[0].trim() });
  }
  return hits;
}

/**
 * STRIP-OR-CORRECT the human descriptors at the trim layer. Rewrites the human noun to
 * the committed species ("a man" → "the grey wolf"), neutralizes hands/voice/clothing.
 * Returns { text, scrubbed:[phrases] }. A no-op when clean/ambiguous. Fires before the
 * narration reaches the player, so the leaked human never lands.
 */
export function scrubNatureContradiction(narrationText, run) {
  const text = String(narrationText || "");
  const ctx = animalContext(run);
  if (!text.trim() || !ctx) return { text, scrubbed: [] };
  const noun = speciesNoun(ctx.nat, ctx.npc);
  const scrubbed = [];
  let out = text;
  out = out.replace(HUMAN_NOUN_RE, (m) => { scrubbed.push(m.trim()); return noun; });
  // Human hands → the beast's paws (singular/plural preserved; it has no hands).
  out = out.replace(HUMAN_HANDS_RE, (m, det, part) => {
    scrubbed.push(m.trim());
    const d = /^(his|her)$/i.test(det) ? "its" : det;
    const plural = /s$/i.test(part);
    const noun2 = /finger|thumb|palm/i.test(part) ? (plural ? "claws" : "claw") : (plural ? "forepaws" : "forepaw");
    return `${d} ${noun2}`;
  });
  // Human speech → a beast sound; "his/her voice" → "its low growl".
  out = out.replace(HUMAN_SPEAK_RE, (m) => { scrubbed.push(m.trim()); return /voice/i.test(m) ? "its low growl" : "it watches"; });
  // Human clothing → its coat (an animal has fur, not garments).
  out = out.replace(HUMAN_CLOTHES_RE, (m) => { scrubbed.push(m.trim()); return "its matted coat"; });
  // De-human the beast's pronouns: in this gated animal-only scene (no human NPC),
  // a third-person he/she/his/her can only be the animal — an animal is "it", not "he".
  if (scrubbed.length) {
    const cap = (repl, m) => (/^[A-Z]/.test(m) ? repl.charAt(0).toUpperCase() + repl.slice(1) : repl);
    out = out.replace(/\b(he|him)\b/gi, (m) => cap("it", m));
    out = out.replace(/\b(his|her)\b/gi, (m) => cap("its", m));
    out = out.replace(/\bshe\b/gi, (m) => cap("it", m));
    out = out.replace(/\s{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
  }
  return { text: out, scrubbed };
}
