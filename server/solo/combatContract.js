// D.4 PHASE 0 — THE IN-COMBAT INTERPRETER CONTRACT (pure; no engine wiring).
//
// This module is the executable form of the combat-input seam described in
// docs/inkborne-combat-d4-phase0-contract.md §1. It is intentionally PURE:
// it mutates nothing, imports no state/resolver code, rolls no dice, and is
// wired into NOTHING in Phase 0. Phase 1's `server/solo/combat.js` imports
// `classifyCombatInput` as the deterministic default layer of the in-combat
// interpreter, and `validateCombatMapping` as the filter-back firewall for the
// optional LLM classifier. The tests-of-record (tests/combat-contract.test.js)
// pin this mapping so Phase 1 builds against a frozen contract.
//
// WHY THIS EXISTS AS A CONTRACT, NOT JUST PROSE: while `run.combat` is active
// the game is a turn machine, and a MIS-ROUTE corrupts initiative — routing an
// intended flee as an attack traps the player in a fight they tried to leave;
// routing a question as an action burns a turn the player never spent. This is
// the same class of hazard as the M.1 move-commit and the A1 ask≠act guard
// (server/solo/actions.js:72), and it gets the same treatment: a deterministic,
// grounded, word-boundary-anchored classifier whose failure mode is a SAFE
// no-cost clarification, never a wrong committed action.
//
// THE CENTRAL RULE: the interpreter CLASSIFIES; it never adjudicates. It maps
// free text onto the legal combat menu (or onto a stunt, or onto a free
// clarification). The combat resolver rolls and mutates. The model — when it is
// consulted at all — only proposes a classification, which is filtered back
// against this closed set exactly like the momentum ranker
// (server/solo/momentum.js rankFn filter-back).

// The legal in-combat action space. Closed set — the interpreter can route to
// nothing outside it. `hold_on` is the dying-turn action (roll the death save).
export const COMBAT_ACTIONS = Object.freeze([
  "attack",
  "defend",
  "flee",
  "use_item",
  "stunt",
  "hold_on"
]);

// The ONLY boons a successful stunt may buy. Never direct damage, never an
// instant win — the sealed mirror of FAILURE_CONSEQUENCE_TYPES
// (server/solo/attempt.js). Combat damage is resolver output only; a stunt
// shapes the next exchange, it does not resolve it.
export const COMBAT_STUNT_EFFECTS = Object.freeze([
  "advantage_next_attack",
  "enemy_disadvantage",
  "enemy_intent_disrupted",
  "apply_condition"
]);

// What a routed input costs the player's turn.
//   "turn" — a real action resolves and the round advances.
//   "none" — free clarification: nothing rolls, no enemy acts, the round does
//            NOT advance. The player may re-declare with full information.
export const COMBAT_TURN_COSTS = Object.freeze(["turn", "none"]);

// Reuses the A1 ask≠act discipline verbatim (server/solo/actions.js:72). A
// question in combat is NEVER an action: "how hurt is the hound?", "what's it
// about to do?" are answered from committed state (enemy hp band, telegraph)
// for free — the telegraph system exists to be asked about.
const INTERROGATIVE_RE =
  /(^\s*(?:are|is|am|was|were|does|do|did|can|could|how|what|where|when|who|whose|whom|why|will|would|should|which)\b)|\?/i;

// FLEE is checked first among actions and held to high precision: mis-routing an
// intended escape into an attack is the single most costly mis-map (it traps the
// player in the fight they tried to leave). Unambiguous disengagement verbs only.
const FLEE_RE =
  /\b(flee|fleeing|fled|run away|running away|run for it|escape|escaping|retreat|retreating|withdraw|withdrawing|disengage|disengaging|break away|get away|getting away|get out|bolt|bolting)\b/i;

// DEFEND: adopt a guard until your next turn (attacks against you at
// disadvantage). Evasive/bracing verbs. "dodge" lives here (a defensive stance),
// not under flee.
const DEFEND_RE =
  /\b(defend|defending|guard|guarding|block|blocking|parry|parrying|brace|bracing|shield|shielding|take cover|hunker|dodge|dodging|deflect|deflecting|on the defensive)\b/i;

// USE-ITEM signal: an explicit consume/apply verb. Grounding (does the player
// actually hold the named item?) is the caller's job via context.heldItems —
// this regex only detects the INTENT to use an item, mirroring how the reroute
// chain detects intent and the resolver enforces possession
// (server/solo/attempt.js resolvePossessionClaim).
const USE_ITEM_RE =
  /\b(use|drink|quaff|swig|apply|consume|eat|swallow|imbibe|administer|uncork|pop)\b/i;

// ATTACK: directed violence. A curated combat subset of CONTESTED_INTENT_RE
// (server/solo/attempt.js) — the aggressive verbs, not the whole contested set
// (which also covers social/stealth/skill intents that are stunts in combat).
const ATTACK_RE =
  /\b(attack|attacking|strike|striking|hit|hitting|fight|fighting|swing|swinging|slash|slashing|stab|stabbing|cut|cutting|cleave|thrust|lunge|lunging|punch|punching|kick|kicking|shove|shoving|smash|smashing|bash|bashing|slam|slamming|club|charge|charging|shoot|shooting|fire at|loose|throw .* at|hurl .* at|grapple|grappling|tackle|tackling|wrestle|wrestling|maim|kill|killing|slay|slaying|behead|impale|skewer|gut|run through)\b/i;

// STUNT CUE — a structural tell that an aggressive-sounding input is actually a
// creative maneuver (blind it, trip it, use the environment), NOT a bare strike.
// Checked BEFORE ATTACK so "kick sand in its eyes" resolves as a stunt (buys a
// boon: enemy_disadvantage / apply_condition) rather than a plain damage roll.
// Deliberately narrow — a bare "kick the hound" still reads as attack; only an
// instrument/environment object or an explicitly disabling verb trips this.
const STUNT_CUE_RE =
  /\b(sand|dirt|dust|gravel|ash|grit|mud)\b|\bin(?:to)?\s+(?:its|his|her|their|the)\s+(?:eyes|face|footing)\b|\boff[-\s]?balance\b|\b(topple|toppling|distract|distracting|blind|blinding|trip|tripping|feint|feinting|taunt|taunting|unbalance|unbalancing)\b|\bknock(?:s|ing)?\s+(?:it|him|her|them|the\s+\w+)\s+(?:over|down|back)\b/i;

function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function isInterrogativeCombatInput(intent) {
  return INTERROGATIVE_RE.test(String(intent || ""));
}

// Does the free text name one of the player's held items? Substring match on the
// item name / a distinctive noun — the same loose grounding the possession path
// uses. Returns the matched itemId or null. Never throws.
function matchHeldItem(intent, heldItems) {
  const text = String(intent || "").toLowerCase();
  if (!Array.isArray(heldItems)) {
    return null;
  }
  for (const item of heldItems) {
    const name = isString(item?.name) ? item.name.toLowerCase() : "";
    if (name && text.includes(name)) {
      return item.itemId ?? name;
    }
    // Also match a distinctive category noun if provided (e.g. "potion").
    const noun = isString(item?.noun) ? item.noun.toLowerCase() : "";
    if (noun && new RegExp(`\\b${noun}\\b`).test(text)) {
      return item.itemId ?? noun;
    }
  }
  return null;
}

// Resolve the attack target from present, living enemies. Grounding discipline
// (server/solo/take.js — never mint a target): a named enemy must be present and
// alive; when unnamed and exactly one enemy lives, default to it; otherwise the
// target is ambiguous and the caller must clarify (no turn spent).
function resolveAttackTarget(intent, enemies) {
  const living = (Array.isArray(enemies) ? enemies : []).filter(
    (e) => e && e.alive !== false && (e.hp?.current ?? 1) > 0
  );
  if (!living.length) {
    return { target: null, reason: "no_living_enemy" };
  }
  const text = String(intent || "").toLowerCase();
  const named = living.filter((e) => {
    const name = isString(e?.name) ? e.name.toLowerCase() : "";
    return name && text.includes(name);
  });
  if (named.length === 1) {
    return { target: named[0].id, reason: "named" };
  }
  if (named.length > 1) {
    return { target: null, reason: "ambiguous_named" };
  }
  if (living.length === 1) {
    return { target: living[0].id, reason: "sole_enemy" };
  }
  return { target: null, reason: "ambiguous_unnamed" };
}

function decision(route, cost, extra = {}) {
  return { route, cost, ...extra };
}

/**
 * THE DETERMINISTIC IN-COMBAT CLASSIFIER (pure).
 *
 * Maps a free-text combat `intent` onto exactly one closed routing decision.
 * This is the ALWAYS-ON default layer: it runs with no network and no model,
 * and its output is safe to resolve directly. The optional LLM classifier
 * (contract doc §1.4) only runs when this layer reports `confidence: "low"`,
 * and its proposal is filtered back through `validateCombatMapping` — so the
 * deterministic result is also the guaranteed fallback if the model is absent,
 * slow, or off-menu.
 *
 * @param {string} intent  the player's raw free text
 * @param {object} context
 *   @param {boolean} [context.isDying]  player at 0 HP in the death-save loop
 *   @param {Array<{id,name,alive?,hp?}>} [context.enemies]  present combatants
 *   @param {Array<{itemId,name,noun?}>} [context.heldItems]  usable inventory
 * @returns {{route:string, cost:string, confidence?:string, target?:string|null, itemId?:string|null, reason?:string, ask?:string}}
 */
export function classifyCombatInput(intent, context = {}) {
  const text = String(intent || "").trim();
  const isDying = context.isDying === true;

  // (0) Empty / unusable input: a free clarification, never a spent turn.
  if (!text) {
    return decision("clarify", "none", { confidence: "high", reason: "empty", ask: "declare_action" });
  }

  // (1) ASK ≠ ACT — the highest guard, in or out of the dying loop. A question
  // is answered from state for free; it NEVER consumes the turn or the death
  // save. (A1 discipline, server/solo/actions.js:72.)
  if (isInterrogativeCombatInput(text)) {
    return decision("clarify", "none", { confidence: "high", reason: "interrogative", ask: "answer_from_state" });
  }

  // (2) DYING-TURN COLLAPSE. While the player bleeds out the menu is exactly two
  // options: play a held item (the existing use_item exemption) or Hold On (roll
  // the death save — the dying-turn rule, server/solo/actions.js:353). Everything
  // that is not a grounded item-use collapses to Hold On; nothing summons a new
  // action, and nothing server-side fires (see the momentum×dying freeze, §2).
  if (isDying) {
    if (USE_ITEM_RE.test(text)) {
      const itemId = matchHeldItem(text, context.heldItems);
      if (itemId) {
        return decision("use_item", "turn", { confidence: "high", itemId, reason: "dying_item" });
      }
      // Named an item they don't hold — clarify (no death save burned on a typo).
      return decision("clarify", "none", { confidence: "high", reason: "dying_item_not_held", ask: "which_item" });
    }
    return decision("hold_on", "turn", { confidence: "high", reason: "dying_default" });
  }

  // (3) FLEE — checked first among live actions, highest precision. Mis-routing
  // an escape into a committed attack is the costliest mis-map.
  if (FLEE_RE.test(text)) {
    return decision("flee", "turn", { confidence: "high", reason: "flee_verb" });
  }

  // (4) DEFEND.
  if (DEFEND_RE.test(text)) {
    return decision("defend", "turn", { confidence: "high", reason: "defend_verb" });
  }

  // (5) USE ITEM — only when grounded on a real held item. A use verb naming an
  // item the player does not hold clarifies (never fabricates the item, never
  // silently spends the turn on nothing) — resolvePossessionClaim discipline.
  if (USE_ITEM_RE.test(text)) {
    const itemId = matchHeldItem(text, context.heldItems);
    if (itemId) {
      return decision("use_item", "turn", { confidence: "high", itemId, reason: "use_verb" });
    }
    return decision("clarify", "none", { confidence: "high", reason: "item_not_held", ask: "which_item" });
  }

  // (6a) STUNT CUE — an aggressive input that is really a maneuver (blind/trip/
  // use the environment) is a stunt, not a bare strike. Checked before ATTACK so
  // the boon path (never direct damage) owns "kick sand in its eyes".
  if (STUNT_CUE_RE.test(text)) {
    return decision("stunt", "turn", { confidence: "low", reason: "stunt_cue" });
  }

  // (6) ATTACK — only when grounded on a present, living enemy (never mints a
  // target). An aggressive verb with no resolvable target clarifies rather than
  // swinging at no one or picking a victim for the player.
  if (ATTACK_RE.test(text)) {
    const { target, reason } = resolveAttackTarget(text, context.enemies);
    if (target) {
      return decision("attack", "turn", { confidence: "high", target, reason });
    }
    return decision("clarify", "none", { confidence: "high", reason: `attack_${reason}`, ask: "which_target" });
  }

  // (7) STUNT — the honest catch-all for creative, off-menu, but ACTIONABLE
  // input ("kick sand in its eyes", "topple the brazier onto it"). It resolves
  // as a normal ability check whose SUCCESS buys one COMBAT_STUNT_EFFECTS boon
  // and whose FAILURE spends the turn. This is a real action with real stakes —
  // the opposite of auto-failing creative play — but it can never deal direct
  // damage or end the fight. Marked low-confidence so Phase 1 MAY consult the
  // optional LLM to instead map it onto a menu action; absent the model, the
  // stunt stands.
  return decision("stunt", "turn", { confidence: "low", reason: "off_menu_actionable" });
}

/**
 * THE FILTER-BACK FIREWALL (pure) for the optional LLM classifier.
 *
 * When Phase 1 escalates a low-confidence input to the model, the model returns
 * a proposed classification. This function is the ONLY gate that proposal passes
 * through — mirroring the momentum ranker's filter-back
 * (server/solo/momentum.js): anything the model proposes that is not a legal,
 * grounded routing is discarded and replaced by the safe deterministic fallback.
 * The model can never widen the action space, invent a target/item, deal damage,
 * or end combat, because those proposals do not survive this function.
 *
 * @param {object} candidate  the model's proposed { route, target?, itemId?, stuntEffect? }
 * @param {object} context     same shape as classifyCombatInput's context
 * @param {object} fallback    the deterministic decision to fall back to (from classifyCombatInput)
 * @returns {object} a validated routing decision (either the accepted candidate or the fallback)
 */
export function validateCombatMapping(candidate, context = {}, fallback = null) {
  const safe = fallback || decision("stunt", "turn", { confidence: "low", reason: "no_fallback" });
  if (!candidate || typeof candidate !== "object") {
    return safe;
  }
  const route = candidate.route;
  // The model may only route within the closed menu, and may NOT propose the
  // dying-only action or a clarify (those are server-decided, never model-picked).
  if (!["attack", "defend", "flee", "use_item", "stunt"].includes(route)) {
    return safe;
  }
  if (route === "attack") {
    // Target must be a present, living enemy — the model cannot mint one.
    const living = (Array.isArray(context.enemies) ? context.enemies : []).filter(
      (e) => e && e.alive !== false && (e.hp?.current ?? 1) > 0
    );
    const ok = living.some((e) => e.id === candidate.target);
    return ok
      ? decision("attack", "turn", { confidence: "high", target: candidate.target, reason: "llm_mapped" })
      : safe;
  }
  if (route === "use_item") {
    // Item must be really held — the model cannot conjure inventory.
    const held = (Array.isArray(context.heldItems) ? context.heldItems : []).some(
      (i) => i.itemId === candidate.itemId
    );
    return held
      ? decision("use_item", "turn", { confidence: "high", itemId: candidate.itemId, reason: "llm_mapped" })
      : safe;
  }
  if (route === "stunt") {
    // A proposed stunt effect must be in the sealed set, or the stunt resolves
    // with no boon (server picks) — the model never invents a boon.
    const effect = COMBAT_STUNT_EFFECTS.includes(candidate.stuntEffect) ? candidate.stuntEffect : null;
    return decision("stunt", "turn", { confidence: "high", stuntEffect: effect, reason: "llm_mapped" });
  }
  // defend | flee — no payload to validate.
  return decision(route, "turn", { confidence: "high", reason: "llm_mapped" });
}
