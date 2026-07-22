// FORM-SHIFTING ENTITY (v1). An entity is NOT a default human. It takes a physical FORM,
// and the form is chosen by its DISPOSITION toward the player. The VOICE is a ball of light
// until the player MEETS her; once met she reads her standing and takes a form:
//   non-threat -> ELK,  threat -> DRAGON,  trusted -> WOMAN.
// Before meeting: a ball of green-gold light, no body (CHAOS-IS-PURPLE law: the Goddess is
// green/gold — violet is chaos ONLY, never her).
//
// THE MOAT (server owns the form): the active form is DERIVED from committed disposition
// (reputation) + the "met" flag — both already server-owned state. The art path renders
// whatever form is committed; the narrator DESCRIBES it and never invents which form she is
// in. A form change re-cooks into a per-form asset slot so forms never collide.
//
// GENERAL, not a VOICE special-case (pre-mortem a): ANY entity may declare `forms`. The
// mechanism reads an entity's forms map from the RUN NPC first (`npc.forms`, the authored
// path — a WORLD-BOOK SCHEMA change, proposed for a stamp, NOT shipped here), then falls
// back to this server-side registry (DATA, keyed by npcId). Seeding the VOICE here proves
// the path today; an authored `forms` map later drops in with zero mechanism change.
//
// NON-HUMANOID APPEARANCE LAW: a non-humanoid form's `appearance` is authored WITHOUT
// human-negation words ("no person/no face/no body"). Such negations backfire twice — they
// trip `isCharacterSubject` (which matches \bperson\b) into welding the humanoid wardrobe/
// gender scaffold, and SDXL reads negations-in-the-positive as the thing itself. Instead the
// form is described positively (an orb / an elk / a dragon); the seal's non-character branch
// (SCENE_HUMAN_NEGATIVE) actively suppresses stray people. Verified by cook, not asserted.

import { individualReputation } from "./reputation.js";
import { isNpcRevealed } from "./npcReveal.js";

/**
 * Server-side forms registry (DATA, general). Each entity: a `default` form (used before
 * the player has met it), a `byBand` disposition→form map, and the `forms` themselves.
 * A form: { humanoid, appearance }. humanoid:false SKIPS the standing-character/detailed-
 * face/wardrobe scaffold and takes `appearance` verbatim; humanoid:true uses it (the woman).
 */
export const ENTITY_FORMS = {
  npc_voice: {
    default: "ball_of_light",
    // Individual reputation tiers (reputation.js INDIVIDUAL_TIERS): hostile, wary, neutral,
    // warm, trusted, devoted. Threat -> dragon; non-threat -> elk; trusted -> woman.
    byBand: {
      hostile: "dragon",
      wary: "dragon",
      neutral: "elk",
      warm: "elk",
      trusted: "woman",
      devoted: "woman"
    },
    forms: {
      // 1.4: the default — a ball of green-gold light, no body. Positively described (no
      // "no person/no body" negations — see the header law).
      ball_of_light: {
        humanoid: false,
        appearance:
          "a single hovering orb of warm green and gold light, a luminous glowing sphere of living radiance, soft golden-green halo, gentle rays, ethereal, floating in dark empty space"
      },
      elk: {
        humanoid: false,
        appearance:
          "a great elk wreathed in a soft green and gold aura, calm and watchful, towering antlers haloed in gentle golden light, standing tall, ethereal luminous glow, dim forest"
      },
      dragon: {
        humanoid: false,
        appearance:
          "an immense dragon wreathed in green and gold fire, scales rimmed with golden light, wings spread wide, looming and menacing, an ethereal wrong-light aura about it"
      },
      woman: {
        humanoid: true,
        appearance:
          "a radiant woman haloed in soft green and gold light, warm and luminous, a gentle golden-green glow about her, ethereal, standing"
      }
    }
  }
};

/**
 * The forms spec for an entity: the authored `npc.forms` (world-book path, future/stamped)
 * takes precedence; otherwise the server-side registry. Returns null when the entity
 * declares no forms (the normal case — most NPCs are not form-shifters).
 * @param {object} npc  the committed NPC (run.npcs[id])
 * @returns {object|null}
 */
export function entityFormsSpec(npc) {
  if (!npc || !npc.npcId) {
    return null;
  }
  if (npc.forms && typeof npc.forms === "object" && npc.forms.forms && typeof npc.forms.forms === "object") {
    return npc.forms;
  }
  return ENTITY_FORMS[npc.npcId] || null;
}

/** True when the entity is a form-shifter (declares forms). */
export function entityHasForms(npc) {
  return entityFormsSpec(npc) !== null;
}

/**
 * Resolve which FORM this entity is in, THIS run — server-owned, derived from committed
 * disposition. Before the player has met the entity, the default form (ball-of-light).
 * Once met, the disposition band selects the form. Returns { id, humanoid, appearance } or
 * null when the entity declares no forms.
 * @param {object} run
 * @param {object} npc  the committed NPC (carries npcId; may carry forms)
 * @returns {{id:string, humanoid:boolean, appearance:string}|null}
 */
export function resolveEntityForm(run, npc) {
  const spec = entityFormsSpec(npc);
  if (!spec || !spec.forms) {
    return null;
  }
  let formId = spec.default;
  // "met" = the entity has MANIFESTED to the player — the committed reveal event has fired
  // (isNpcRevealed, the existing moat flag). Before that she is the default ball of light
  // (1.4), regardless of authored `known` (the VOICE is authored known:true because she
  // SPEAKS at the opening, but she has no body until she manifests). Once met, her committed
  // DISPOSITION band (individualReputation) selects the form. Both are server-owned state.
  const met = isNpcRevealed(run, npc.npcId);
  if (met) {
    const rep = run ? individualReputation(run, npc.npcId) : null;
    const band = (rep && typeof rep.tier === "string" && rep.tier) || "neutral";
    formId = (spec.byBand && spec.byBand[band]) || spec.default;
  }
  const form = spec.forms[formId] || spec.forms[spec.default];
  if (!form) {
    return null;
  }
  return {
    id: form === spec.forms[formId] ? formId : spec.default,
    humanoid: form.humanoid === true,
    appearance: String(form.appearance || "").trim()
  };
}

/**
 * VN-body art direction for a NON-HUMANOID form: the whole form centered on a plain dark
 * background, framed as a VN sprite — WITHOUT the humanoid scaffold ("standing character,
 * head to toe, detailed face and clothing") that would fight an orb / beast. The form's own
 * `appearance` carries the subject; this only frames it.
 */
export function nonHumanoidBodyArtDirection(tone) {
  const flavor = typeof tone === "string" && tone.trim() ? tone.trim() : "dark fantasy";
  return `the whole form centered and seen in full, plain dark background, visual novel sprite, ${flavor}, luminous, no cropping`;
}

/**
 * The per-form suffix for an entity's VN-body asset slot, so distinct forms never collide
 * in imageAssets and a disposition-driven form change re-cooks into its own slot. Empty
 * string when the entity declares no forms (the standard single-slot path).
 */
export function entityFormAssetSuffix(form) {
  return form && form.id ? `_${form.id}` : "";
}
