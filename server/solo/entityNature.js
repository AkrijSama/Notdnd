// ENTITY NATURE (species/kind coherence). One place that resolves an NPC's COMMITTED
// nature from its stat block + tags: kind (beast / chaosling / demon / human), whether
// it is an ANIMAL (an animal-bodied creature — a wolf, a corrupted wolf), whether it is
// SOCIAL-CAPABLE (can be talked to — the threat ladder's human-tier rung), its visible
// condition, and its species word. The briefing, the nature auditor, and the cast
// affordances all read this — so "is the Grey a person?" is answered in exactly one
// place, from committed data, never from model output.
import { resolveStatBlock, THREAT_LADDER } from "../campaign/bestiary.js";

const ANIMAL_TAGS = new Set(["wolf", "bear", "boar", "lion", "elk", "deer", "coyote", "snake", "rattlesnake", "raven", "otter", "beast", "wildlife", "animal", "hound", "cat", "bird"]);
const SPECIES_TAGS = ["wolf", "bear", "boar", "lion", "elk", "deer", "coyote", "rattlesnake", "snake", "raven", "otter"];

function isPlainObject(v) { return Boolean(v) && typeof v === "object" && !Array.isArray(v); }

/**
 * The committed nature of an NPC. Returns null for a non-object. For a plain human NPC
 * (no stat block, no beast tags) returns { kind:"human", isAnimal:false, socialCapable:true }.
 */
export function entityNature(npc) {
  if (!isPlainObject(npc)) return null;
  const statBlockId = npc.statBlockId || npc.flags?.statBlockId || null;
  const block = statBlockId ? resolveStatBlock(statBlockId) : null;
  const tags = (Array.isArray(npc.tags) ? npc.tags : []).map((t) => String(t).toLowerCase());

  // Kind: the stat block is truth; else infer from tags; else a person.
  let kind = (block && typeof block.kind === "string") ? block.kind : null;
  if (!kind) {
    if (tags.includes("chaosling")) kind = "chaosling";
    else if (tags.includes("demon")) kind = "demon";
    else if (tags.includes("bandit") || tags.includes("enforcer")) kind = "bandit";
    else if ([...tags].some((t) => ANIMAL_TAGS.has(t))) kind = "wildlife";
    else kind = "human";
  }

  // The species word (base animal chassis, or an animal tag).
  const species = (block && typeof block.baseAnimalId === "string" ? block.baseAnimalId.replace(/_/g, " ") : null)
    || tags.find((t) => SPECIES_TAGS.includes(t))
    || null;

  // ANIMAL = an animal-bodied creature (wildlife, or a chaosling whose chassis is an
  // animal). This is the gate the human-descriptor auditor keys on — a demon may be
  // humanoid/ambiguous and is NOT audited as an animal.
  const chassisIsAnimal = Boolean(species) || [...tags].some((t) => ANIMAL_TAGS.has(t));
  const isAnimal = kind === "wildlife" || (kind === "chaosling" && chassisIsAnimal);

  // SOCIAL-CAPABLE = can be talked to (threat ladder rung). Humans/bandits/demons yes;
  // wildlife/chaoslings no. A shapeshifter tag forces social-capable + non-animal audit.
  const shapeshifter = tags.includes("shapeshifter") || tags.includes("doppelganger");
  const ladder = THREAT_LADDER && THREAT_LADDER[kind] ? THREAT_LADDER[kind] : null;
  const socialCapable = shapeshifter || (ladder ? ladder.socialCapable === true : kind === "human");

  const corrupted = tags.includes("corrupted") || kind === "chaosling";
  const injured = Boolean(block?.behaviors?.injured);

  return {
    kind,
    species,
    corrupted,
    injured,
    isAnimal: isAnimal && !shapeshifter, // a shapeshifter is never "just an animal"
    socialCapable,
    shapeshifter,
    statBlockId,
    block: block || null
  };
}

/** A short committed-nature phrase for a creature ("a corrupted grey wolf, injured"),
 *  or "" for a plain human. Used in the NPC briefing so the narrator can't invent a
 *  species. */
export function naturePhrase(npc) {
  const nat = entityNature(npc);
  // No nature line for actual PEOPLE (humans + the human-tier bandit rung). A demon or
  // a beast is not a person and DOES get one, even if social-capable.
  if (!nat || nat.kind === "human" || nat.kind === "bandit") return "";
  const parts = [];
  if (nat.injured) parts.push("injured");
  if (nat.corrupted) parts.push("corrupted");
  if (nat.species) parts.push(nat.species);
  else if (nat.kind === "chaosling") parts.push("chaos-beast");
  else if (nat.kind === "demon") parts.push("demon");
  else parts.push(nat.kind);
  const noun = nat.isAnimal ? "beast" : (nat.kind === "demon" ? "demon" : nat.kind);
  const art = (w) => (/^[aeiou]/i.test(String(w || "")) ? "an" : "a");
  const phrase = parts.join(" ");
  return `${art(phrase)} ${phrase} (${art(noun)} ${noun}, not a person)`;
}
