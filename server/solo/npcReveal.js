// NPC ART REVEAL (W1). A committed cast member's art can UPGRADE permanently, per-run,
// to a revealed form when a committed story event fires (the VOICE's ball-of-light form
// → a revealed form at Her Clearing / an Elk-Dragon manifestation / a vision-class
// event). The SWAP MECHANISM ships now; the revealed-form ART is deferred content, so
// the mapping resolves to a placeholder until that art lands.
//
// Lifecycle: the base (light-form) art is a LIBRARY KEEP; a run's REVEALED state is
// RUN-STATE (run.flags.npcRevealed), never global. Keyed on a committed event flag so a
// reveal is a real story consequence, not a cosmetic toggle.

/** The committed cast id for the VOICE. */
export const VOICE_NPC_ID = "npc_voice";

/**
 * Has this NPC's revealed form been unlocked for THIS run? Reads run-state only.
 * @param {object} run
 * @param {string} npcId
 * @returns {boolean}
 */
export function isNpcRevealed(run, npcId) {
  const map = run && run.flags && run.flags.npcRevealed;
  return Boolean(map && map[npcId] === true);
}

/**
 * Commit a reveal for THIS run, keyed on the event that fired. Idempotent. Returns
 * true if it flipped (a fresh reveal), false if already revealed. The caller passes the
 * committed event id so the reveal is auditable (stored alongside the flag).
 * @param {object} run
 * @param {string} npcId
 * @param {string} [eventId]
 * @returns {boolean}
 */
export function commitNpcReveal(run, npcId, eventId = null) {
  if (!run || typeof run !== "object" || !npcId) {
    return false;
  }
  run.flags = run.flags || {};
  run.flags.npcRevealed = run.flags.npcRevealed || {};
  if (run.flags.npcRevealed[npcId] === true) {
    return false;
  }
  run.flags.npcRevealed[npcId] = true;
  run.flags.npcRevealedBy = run.flags.npcRevealedBy || {};
  if (eventId) {
    run.flags.npcRevealedBy[npcId] = String(eventId);
  }
  return true;
}

/**
 * Resolve which art FORM a cast member's portrait/body should render this run:
 * "base" (the committed appearance, e.g. the ball of light) or "revealed" (once the
 * committed reveal event has fired). The revealed-form art itself is deferred — the
 * caller maps "revealed" to the npc.revealForm key (placeholder until that art lands).
 * @param {object} run
 * @param {object} npc  the committed NPC (carries revealForm)
 * @returns {"base"|"revealed"}
 */
export function resolveNpcArtForm(run, npc) {
  if (!npc || !npc.npcId) {
    return "base";
  }
  // A revealed form only exists if the cast member authored one (npc.revealForm).
  if (npc.revealForm && isNpcRevealed(run, npc.npcId)) {
    return "revealed";
  }
  return "base";
}

/**
 * The art-asset key for a cast member's portrait, form-aware. Base form uses the
 * standard per-npc slot; revealed form uses a distinct slot so the swap is permanent
 * per-run and the two never collide in imageAssets.
 * @param {object} run
 * @param {object} npc
 * @returns {string}
 */
export function npcPortraitArtKey(run, npc) {
  const base = `img_${npc.npcId}`;
  return resolveNpcArtForm(run, npc) === "revealed" ? `${base}_revealed` : base;
}
