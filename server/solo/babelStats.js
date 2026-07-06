// THE BABEL STAT CANON — the single source of truth for the six-stat spine.
//
// Babel's world-book (§2.3 / §4) speaks six stats: STR / DEX / VIT / Spirit /
// INT / Luck. The chassis stores ability scores under the 5e keys
// (strength/dexterity/constitution/intelligence/wisdom/charisma) that the d20
// resolver reads (rules.js resolveAbilityCheck → run.player.abilities[ability]).
// Rather than fork the sealed resolver by renaming its store, this module BINDS
// the Babel canon labels to that one store. Everything that must agree — the
// STATUS WINDOW (display), resolveAbilityCheck (resolution), the interpreter's
// stat pick, and the Awakening-Origin write — reads the SAME variable
// (run.player.abilities[ability]) through THIS one binding.
//
// "THE WINDOW DOES NOT LIE": the value the WINDOW shows for Spirit and the value
// a Spirit check resolves against are, by construction, the same number from the
// same field (abilities.wisdom) — see babelStatBlock + abilityForBabelWord.

// The locked binding, in display order. `label` is the Babel canon name; `ability`
// is the chassis ability key the resolver reads for it.
export const BABEL_STATS = Object.freeze([
  Object.freeze({ label: "STR", ability: "strength" }),
  Object.freeze({ label: "DEX", ability: "dexterity" }),
  Object.freeze({ label: "VIT", ability: "constitution" }),
  Object.freeze({ label: "Spirit", ability: "wisdom" }),
  Object.freeze({ label: "INT", ability: "intelligence" }),
  Object.freeze({ label: "Luck", ability: "charisma" })
]);

// Babel canon words (and the common abbreviations a provider or author might use)
// → the chassis ability key the resolver reads. Lets a Babel-worded check
// (recommendedAbility "spirit"/"vit"/"luck") resolve against the SAME ability the
// WINDOW displays for that stat, instead of falling back to an intent heuristic.
// Additive: the 5e keys already resolve directly; this only rescues the Babel
// vocabulary that previously mapped to nothing.
const BABEL_WORD_TO_ABILITY = Object.freeze({
  str: "strength", strength: "strength",
  dex: "dexterity", dexterity: "dexterity",
  vit: "constitution", vitality: "constitution", con: "constitution", constitution: "constitution",
  spirit: "wisdom", spr: "wisdom", wis: "wisdom", wisdom: "wisdom",
  int: "intelligence", intelligence: "intelligence",
  luck: "charisma", cha: "charisma", charisma: "charisma"
});

/** A Babel canon word / abbreviation → the chassis ability key, or null. Pure. */
export function abilityForBabelWord(word) {
  if (word === undefined || word === null) return null;
  return BABEL_WORD_TO_ABILITY[String(word).trim().toLowerCase()] || null;
}

/**
 * Build the STATUS WINDOW stat block from the chassis ability store — using the
 * EXACT lookup resolveAbilityCheck does (abilities[ability]). The score the WINDOW
 * renders for a stat is therefore byte-identical to the score a check against that
 * stat's bound ability resolves against. Missing scores default to 10 (the same
 * default the resolver's safeNumber uses). Pure.
 * @param {object} abilities run.player.abilities
 * @returns {Array<{label:string, ability:string, score:number}>}
 */
export function babelStatBlock(abilities) {
  const ab = abilities && typeof abilities === "object" ? abilities : {};
  return BABEL_STATS.map(({ label, ability }) => {
    const raw = Number(ab[ability]);
    return { label, ability, score: Number.isFinite(raw) ? raw : 10 };
  });
}
