import test from "node:test";
import assert from "node:assert/strict";
import {
  COMBAT_ACTIONS,
  COMBAT_STUNT_EFFECTS,
  COMBAT_TURN_COSTS,
  classifyCombatInput,
  validateCombatMapping,
  isInterrogativeCombatInput
} from "../server/solo/combatContract.js";

// TESTS-OF-RECORD for the D.4 Phase 0 combat contract
// (docs/inkborne-combat-d4-phase0-contract.md §1). These pin the in-combat
// interpreter seam — the owner's hard condition — so Phase 1 wires a frozen
// classifier instead of inventing one inside a turn machine. The module under
// test is PURE and wired into nothing; these tests are the contract, not a
// behavior check of the (not-yet-built) resolver.
//
// The invariant every case defends: in a turn machine a MIS-ROUTE corrupts
// initiative, so the classifier fails safe — a question or an ungrounded action
// costs NOTHING (clarify), and only a grounded action or a stunt costs the turn.

const HOUND = { id: "enm_hound_1", name: "Carrion Hound", alive: true, hp: { current: 11, max: 11 } };
const WAYLAYER = { id: "enm_waylayer_1", name: "Waylayer", alive: true, hp: { current: 12, max: 12 } };
const POTION = { itemId: "itm_potion_1", name: "healing draught", noun: "potion" };

const soloEnemy = { enemies: [HOUND], heldItems: [POTION] };

// ── sealed enums ─────────────────────────────────────────────────────────────
test("action space + boons + costs are closed sets", () => {
  assert.deepEqual(COMBAT_ACTIONS, ["attack", "defend", "flee", "use_item", "stunt", "hold_on"]);
  assert.deepEqual(COMBAT_STUNT_EFFECTS, [
    "advantage_next_attack",
    "enemy_disadvantage",
    "enemy_intent_disrupted",
    "apply_condition"
  ]);
  assert.deepEqual(COMBAT_TURN_COSTS, ["turn", "none"]);
  // Frozen — a widening is a contract change, caught here.
  assert.equal(Object.isFrozen(COMBAT_ACTIONS), true);
  assert.equal(Object.isFrozen(COMBAT_STUNT_EFFECTS), true);
});

// ── §1.3 the cost invariant: questions & ungrounded inputs are FREE ──────────
test("ASK ≠ ACT: an interrogative is a free clarification, never a turn", () => {
  for (const q of [
    "how hurt is the hound?",
    "what is it about to do?",
    "is it bleeding",
    "can I reach the door?",
    "which one is closer"
  ]) {
    const d = classifyCombatInput(q, soloEnemy);
    assert.equal(d.route, "clarify", `"${q}" must clarify`);
    assert.equal(d.cost, "none", `"${q}" must cost nothing`);
  }
  assert.equal(isInterrogativeCombatInput("how deep is the wound?"), true);
  assert.equal(isInterrogativeCombatInput("I strike the hound"), false);
});

test("a question about attacking never routes to attack (A1 precedence over attack verb)", () => {
  // Contains the attack verb "attack" but reads as a question — must not fight.
  const d = classifyCombatInput("should I attack the hound?", soloEnemy);
  assert.equal(d.route, "clarify");
  assert.equal(d.cost, "none");
});

test("empty / blank input is a free clarification", () => {
  for (const empty of ["", "   ", null, undefined]) {
    const d = classifyCombatInput(empty, soloEnemy);
    assert.equal(d.route, "clarify");
    assert.equal(d.cost, "none");
  }
});

// ── §1.2 the menu mapping ────────────────────────────────────────────────────
test("attack verb + a present living enemy → attack (grounded), spends the turn", () => {
  for (const a of ["I strike the hound", "attack it", "swing my blade at the beast", "lunge and stab"]) {
    const d = classifyCombatInput(a, soloEnemy);
    assert.equal(d.route, "attack", `"${a}" → attack`);
    assert.equal(d.cost, "turn");
    assert.equal(d.target, "enm_hound_1", `"${a}" grounds on the sole living enemy`);
  }
});

test("attack verb naming a specific present enemy targets THAT enemy", () => {
  const twoEnemies = { enemies: [HOUND, WAYLAYER], heldItems: [] };
  const d = classifyCombatInput("I attack the waylayer", twoEnemies);
  assert.equal(d.route, "attack");
  assert.equal(d.target, "enm_waylayer_1");
});

test("attack verb with NO resolvable target → clarify (none) — never mints a target", () => {
  // No enemies present at all.
  const d1 = classifyCombatInput("I attack", { enemies: [], heldItems: [] });
  assert.equal(d1.route, "clarify");
  assert.equal(d1.cost, "none");
  // Two enemies, none named — ambiguous, so clarify rather than pick a victim.
  const d2 = classifyCombatInput("I attack", { enemies: [HOUND, WAYLAYER], heldItems: [] });
  assert.equal(d2.route, "clarify");
  assert.equal(d2.cost, "none");
  assert.match(d2.ask, /target/);
});

test("attack verb against a DEAD enemy does not target it (grounding is on living)", () => {
  const dead = { enemies: [{ ...HOUND, alive: false, hp: { current: 0, max: 11 } }], heldItems: [] };
  const d = classifyCombatInput("strike the hound", dead);
  assert.equal(d.route, "clarify");
  assert.equal(d.cost, "none");
});

test("flee verbs → flee (highest action precedence: escape mis-map is costliest)", () => {
  for (const f of ["I run away", "flee the fight", "escape through the door", "retreat", "disengage and bolt"]) {
    const d = classifyCombatInput(f, soloEnemy);
    assert.equal(d.route, "flee", `"${f}" → flee`);
    assert.equal(d.cost, "turn");
  }
});

test("defend verbs → defend", () => {
  for (const g of ["I defend", "raise my guard", "brace for the blow", "take cover", "dodge"]) {
    const d = classifyCombatInput(g, soloEnemy);
    assert.equal(d.route, "defend", `"${g}" → defend`);
    assert.equal(d.cost, "turn");
  }
});

test("use-verb + a HELD item → use_item, spends the turn", () => {
  for (const u of ["drink the healing draught", "I quaff my potion", "use the potion"]) {
    const d = classifyCombatInput(u, soloEnemy);
    assert.equal(d.route, "use_item", `"${u}" → use_item`);
    assert.equal(d.cost, "turn");
    assert.equal(d.itemId, "itm_potion_1");
  }
});

test("use-verb naming an item NOT held → clarify (none) — never conjures inventory", () => {
  const d = classifyCombatInput("drink the antidote", soloEnemy); // no antidote held
  assert.equal(d.route, "clarify");
  assert.equal(d.cost, "none");
  assert.match(d.ask, /item/);
});

test("off-menu but actionable creative input → stunt (turn), low-confidence", () => {
  for (const s of ["kick sand in its eyes", "topple the brazier onto it", "taunt it into a mistake"]) {
    const d = classifyCombatInput(s, soloEnemy);
    assert.equal(d.route, "stunt", `"${s}" → stunt`);
    assert.equal(d.cost, "turn");
    assert.equal(d.confidence, "low", "stunt is the escalation point for the optional LLM layer");
  }
});

test("stunt-cue boundary: a disabling/environment maneuver is a stunt, a bare strike is an attack", () => {
  // 6a — an attack-shaped verb + a stunt cue (environment / disabling) → stunt,
  // never a bare damage roll (the owner's hard-condition boundary case).
  for (const stunt of ["blind it with my lantern", "trip the hound", "throw dirt in its face", "knock it off balance"]) {
    const d = classifyCombatInput(stunt, soloEnemy);
    assert.equal(d.route, "stunt", `"${stunt}" → stunt (boon, not damage)`);
  }
  // 6b — the same verbs aimed plainly at the enemy stay attacks.
  for (const atk of ["strike the hound", "kick the hound", "stab it"]) {
    const d = classifyCombatInput(atk, soloEnemy);
    assert.equal(d.route, "attack", `"${atk}" → attack`);
    assert.equal(d.target, "enm_hound_1");
  }
});

// ── §1.2 row 2 the dying-turn collapse ───────────────────────────────────────
test("DYING + use-verb + held item → use_item (the exemption)", () => {
  const d = classifyCombatInput("drink the healing draught", { ...soloEnemy, isDying: true });
  assert.equal(d.route, "use_item");
  assert.equal(d.itemId, "itm_potion_1");
});

test("DYING + any non-item action → hold_on (roll the death save)", () => {
  for (const a of ["I strike the hound", "flee", "defend", "keep fighting", "crawl toward the exit"]) {
    const d = classifyCombatInput(a, { ...soloEnemy, isDying: true });
    assert.equal(d.route, "hold_on", `dying + "${a}" → hold_on`);
    assert.equal(d.cost, "turn");
  }
});

test("DYING + a question → clarify (no save burned on a question)", () => {
  const d = classifyCombatInput("am I going to die?", { ...soloEnemy, isDying: true });
  assert.equal(d.route, "clarify");
  assert.equal(d.cost, "none");
});

test("DYING + use-verb naming an item NOT held → clarify, not a wasted death save", () => {
  const d = classifyCombatInput("drink the elixir", { ...soloEnemy, isDying: true }); // no elixir held
  assert.equal(d.route, "clarify");
  assert.equal(d.cost, "none");
});

// ── §1.4 the LLM filter-back firewall ────────────────────────────────────────
test("firewall: an off-menu route is discarded → deterministic fallback stands", () => {
  const fallback = classifyCombatInput("kick sand in its eyes", soloEnemy); // stunt
  for (const bad of [{ route: "instant_kill" }, { route: "hold_on" }, { route: "clarify" }, { route: "end_combat" }, null, "attack", {}]) {
    const d = validateCombatMapping(bad, soloEnemy, fallback);
    assert.equal(d.route, fallback.route, `${JSON.stringify(bad)} rejected → fallback`);
  }
});

test("firewall: a proposed attack on an unpresent target is discarded", () => {
  const fallback = classifyCombatInput("do something clever", soloEnemy);
  const d = validateCombatMapping({ route: "attack", target: "enm_ghost_999" }, soloEnemy, fallback);
  assert.equal(d.route, fallback.route, "minted target rejected");
});

test("firewall: a proposed attack on a REAL present enemy is accepted", () => {
  const d = validateCombatMapping({ route: "attack", target: "enm_hound_1" }, soloEnemy, null);
  assert.equal(d.route, "attack");
  assert.equal(d.target, "enm_hound_1");
  assert.equal(d.cost, "turn");
});

test("firewall: a proposed use_item for an unheld item is discarded", () => {
  const fallback = classifyCombatInput("hmm", soloEnemy);
  const d = validateCombatMapping({ route: "use_item", itemId: "itm_nonexistent" }, soloEnemy, fallback);
  assert.equal(d.route, fallback.route, "unheld item rejected");
});

test("firewall: an invented stunt effect is dropped to no-boon; a sealed one is kept", () => {
  const invented = validateCombatMapping({ route: "stunt", stuntEffect: "delete_enemy" }, soloEnemy, null);
  assert.equal(invented.route, "stunt");
  assert.equal(invented.stuntEffect, null, "off-list boon → no boon (server picks)");
  const legal = validateCombatMapping({ route: "stunt", stuntEffect: "enemy_disadvantage" }, soloEnemy, null);
  assert.equal(legal.stuntEffect, "enemy_disadvantage");
});

test("firewall: defend/flee proposals pass through (no payload to mint)", () => {
  assert.equal(validateCombatMapping({ route: "defend" }, soloEnemy, null).route, "defend");
  assert.equal(validateCombatMapping({ route: "flee" }, soloEnemy, null).route, "flee");
});

// ── purity guard: the classifier mutates nothing it is handed ─────────────────
test("classifier is pure — context is not mutated", () => {
  const ctx = { enemies: [HOUND], heldItems: [POTION], isDying: false };
  const snapshot = JSON.stringify(ctx);
  classifyCombatInput("attack the hound", ctx);
  classifyCombatInput("drink the potion", ctx);
  classifyCombatInput("how hurt is it?", ctx);
  assert.equal(JSON.stringify(ctx), snapshot, "no side effects on context");
});
