// THE SOCIAL-COMBAT BRIDGE (W3). Human enemies (socialCapable bandits) route through
// BOTH machineries: combat (the full CTB engine) AND disagreement (a mid-fight PARLEY
// window). The rung's whole point is that a human threat is not just a hostile HP bag.
//
// SUPPRESSION (the pre-mortem hazard): a parley affordance may appear ONLY at LAWFUL
// moments — the enemy's morale break, OR the player opening it on their OWN initiative
// (a talk-intent at the player's turn). NEVER mid-swing (during an enemy attack
// resolution) — that would break the CTB loop. `canParley` is the single gate.
//
// OUTCOMES COMMIT: surrender → captive/loot/reputation; spare-vs-kill → faction + Ledger
// (mercy AND murder are both remembered); fled → committed as fled (a thread-seed hook).
// Reputation lands via applyReputationEffects; the remembered deed lands on run.ledger.

import { applyReputationEffects } from "./reputation.js";

// Morale states at/under which a parley window is LAWFUL (the enemy is wavering/broken).
export const PARLEY_MORALE = Object.freeze(new Set(["wavering", "shaken", "broken"]));

/**
 * Is a parley window LAWFUL right now? THE suppression rule. Only socialCapable foes,
 * never mid-swing, never the dead; lawful when the enemy's morale has broken OR the
 * PLAYER opens it on their own initiative.
 * @param {object} combat
 * @param {object} enemy
 * @param {{ playerInitiated?: boolean, midSwing?: boolean }} [ctx]
 * @returns {boolean}
 */
export function canParley(combat, enemy, { playerInitiated = false, midSwing = false } = {}) {
  if (!enemy || enemy.socialCapable !== true) return false; // only human/social foes
  if (midSwing) return false; // never during an enemy attack resolution (CTB integrity)
  if (enemy.hp && Number(enemy.hp.current) <= 0) return false; // the dead don't parley
  if (PARLEY_MORALE.has(String(enemy.morale || "steady"))) return true; // their break
  if (playerInitiated && combat && combat.activeActor === "player") return true; // player-opened
  return false;
}

// The lawful parley affordances for the current window (what the UI may offer). Empty
// when no window is lawful — the affordance layer must respect this (never mid-swing).
export function parleyAffordances(combat, enemy, ctx = {}) {
  if (!canParley(combat, enemy, ctx)) return [];
  return [
    { id: "demand_surrender", label: "Demand their surrender" },
    { id: "offer_bribe", label: "Offer a bribe to pass" },
    { id: "intimidate", label: "Intimidate them into breaking" }
  ];
}

function faction(enemy) {
  return typeof enemy?.factionId === "string" && enemy.factionId ? enemy.factionId : null;
}

function remember(run, entry) {
  run.ledger = Array.isArray(run.ledger) ? run.ledger : [];
  run.ledger.push({ remembered: true, ...entry });
  return entry;
}

/**
 * Resolve a parley choice into a COMMITTED outcome. `contest` is the three-band verdict
 * of the underlying contested check ("success" | "drama" | "failure") the caller rolled
 * (combat's resolveAbilityCheck → bandFromMargin); parley never rolls its own dice.
 *
 * @param {object} run
 * @param {object} combat
 * @param {object} enemy   the committed enemy combatant (carries factionId, npcId)
 * @param {{ choice: string, contest?: "success"|"drama"|"failure" }} opts
 * @returns {{ outcome: string, committed: boolean, reputation: object[], ledger: object|null }}
 */
export function resolveParley(run, combat, enemy, { choice, contest = "success" } = {}) {
  const fac = faction(enemy);
  const npcId = enemy?.npcId || enemy?.combatantId || null;
  const applyRep = (effects) => (effects.length ? applyReputationEffects(run, effects) : []);

  // SURRENDER accepted → the player then chooses to SPARE or KILL. Both are remembered.
  if (choice === "spare") {
    // Mercy: the surrendered foe becomes a captive/fled; the faction remembers restraint.
    const rep = applyRep(fac ? [{ target: fac, delta: 2, tags: ["mercy", "parley"] }] : []);
    const led = remember(run, { event: "spared", npcId, factionId: fac, band: contest });
    return { outcome: "spared", committed: true, reputation: rep, ledger: led };
  }
  if (choice === "kill") {
    // Murder of a yielding foe: the faction remembers it hard.
    const rep = applyRep(fac ? [{ target: fac, delta: -5, tags: ["murder", "parley"] }] : []);
    const led = remember(run, { event: "killed_surrendered", npcId, factionId: fac, band: contest });
    return { outcome: "killed", committed: true, reputation: rep, ledger: led };
  }
  if (choice === "demand_surrender") {
    // Contested: success → they yield (a spare/kill choice follows); drama → they yield
    // but a cost (a parting cut); failure → they refuse and the fight resumes.
    if (contest === "failure") {
      return { outcome: "refused", committed: true, reputation: [], ledger: null };
    }
    const led = remember(run, { event: "surrendered", npcId, factionId: fac, band: contest });
    return { outcome: "surrendered", committed: true, reputation: [], ledger: led, awaiting: "spare_or_kill" };
  }
  if (choice === "offer_bribe") {
    // A bribe demand met: they let you pass; minor faction warmth, no deaths.
    const rep = applyRep(fac ? [{ target: fac, delta: 1, tags: ["bribe", "parley"] }] : []);
    const led = remember(run, { event: "bribed_passage", npcId, factionId: fac });
    return { outcome: "passage", committed: true, reputation: rep, ledger: led };
  }
  if (choice === "intimidate") {
    // Contested: success → they BREAK and flee (committed as fled, thread-seed); drama →
    // they flee but mark you; failure → provoked, the fight resumes.
    if (contest === "failure") {
      return { outcome: "provoked", committed: true, reputation: [], ledger: null };
    }
    if (enemy) enemy.morale = "broken";
    const led = remember(run, { event: "fled", npcId, factionId: fac, band: contest });
    return { outcome: "fled", committed: true, reputation: [], ledger: led };
  }
  return { outcome: "none", committed: false, reputation: [], ledger: null };
}
