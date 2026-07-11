// D.4 PHASE 1 — THE COMBAT RESOLVER (positionless, JRPG-style rounds).
//
// Combat state is SERVER-OWNED TRUTH; the LLM narrates rounds and never
// adjudicates them (docs/inkborne-combat-d4-spec.md §3, phase0-contract §5).
// This module owns the fight: initiative, rounds, the attack/defend/flee/
// use_item/hold_on/stunt resolvers, seeded telegraphed enemy intents, and the
// won/lost/fled close. It consumes the FROZEN in-combat interpreter
// (combatContract.js classifyCombatInput) as its deterministic input layer, the
// bestiary (statBlockId resolution), and the existing lethality spine
// (death.js applyDamage) — so the whole death machinery composes with zero new
// lethality code. `ALLOWED_EFFECT_TYPES` is untouched: combat mutations are
// resolver output, exactly like movement (coherence leak #2).
//
// One HTTP action = one full round: the player's chosen action resolves, then
// every living enemy executes its committed (telegraphed) intent, all inside the
// single action result. The player-drop rule (spec §2.4 / phase0 §2): combat
// ends the moment the player reaches 0 HP; the dying-turn loop owns the
// aftermath, with the momentum/thread clock frozen.

import { rollD20, rollDice, abilityModifier } from "../rules/dice.js";
import { resolveAbilityCheck } from "./rules.js";
import { applyDamage, getHp, isDying, isDead } from "./death.js";
import { awardXp } from "./progression.js";
import { grantItemToRun } from "./search.js";
import { resolveStatBlock, DEFAULT_STAT_BLOCK_ID } from "../campaign/bestiary.js";
import { classifyCombatInput, COMBAT_STUNT_EFFECTS } from "./combatContract.js";

// Deterministic non-negative hash (same construction as momentum/quests) — the
// seed for telegraph selection, so a run replays identically.
function hashSeed(value) {
  let hash = 0;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Is a fight live? The single predicate the reroute chain / scene menu read. */
export function combatActive(run) {
  return isPlainObject(run?.combat) && run.combat.status === "active";
}

// The aggressive-verb subset (combat ENTRY). Mirrors combatContract's ATTACK_RE;
// entry grounds on a PRESENT NPC (never minted), the take/move discipline.
const ATTACK_ENTRY_RE =
  /\b(attack|attacking|strike|striking|hit|hitting|fight|fighting|swing|swinging|slash|slashing|stab|stabbing|cut|cutting|cleave|thrust|lunge|lunging|punch|punching|kick|kicking|shove|shoving|smash|smashing|bash|bashing|slam|slamming|club|charge|charging|shoot|shooting|fire at|gun down|grapple|tackle|wrestle|maim|kill|killing|slay|slaying|behead|impale|skewer|gut|run through|take (?:him|her|them|it) (?:down|out)|draw .*(?:blade|sword|knife|gun|weapon))\b/i;
const STOPWORD_TOKENS = new Set(["the", "a", "an", "of", "and", "reeve's", "reeves", "mr", "ms"]);

/**
 * Combat ENTRY detector (Change A). Fires only OUT of combat, on a clear attack
 * verb aimed at a PRESENT, resolvable NPC — never minting a target (the
 * detectTakeIntent/detectMoveIntent precedent). Returns { targetNpcId } or null.
 * A hostile placed by a thread `hostileNpc` beat is the canonical trigger, but
 * attacking any present NPC is allowed (the lethal game).
 */
export function detectAttackIntent(run, intent) {
  if (combatActive(run)) return null;
  const text = String(intent || "").toLowerCase();
  if (!ATTACK_ENTRY_RE.test(text)) return null;

  const present = Object.values(run?.npcs || {}).filter(
    (npc) => npc && npc.currentLocationId === run.currentLocationId && npc.status !== "dead" && npc.flags?.defeated !== true
  );
  if (!present.length) return null;

  // Named target: any distinctive token of an NPC's display name appears in the text.
  const named = present.filter((npc) => {
    const tokens = String(npc.displayName || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !STOPWORD_TOKENS.has(t));
    return tokens.some((t) => text.includes(t));
  });
  if (named.length === 1) return { targetNpcId: named[0].npcId };
  if (named.length > 1) return null; // ambiguous — clarify via the honest attempt path

  // Bare "attack him / attack": default to the sole present HOSTILE, never a bystander.
  const hostiles = present.filter((npc) => npc.flags?.hostile === true);
  if (hostiles.length === 1) return { targetNpcId: hostiles[0].npcId };
  return null;
}

// ── player-derived combat numbers (read canonical; never duplicated) ──────────
function playerDerived(run) {
  return run?.player?.character?.derivedStats || run?.player?.derivedStats || {};
}
function playerAbilityMod(run, ability) {
  const score = run?.player?.abilities?.[ability];
  return abilityModifier(typeof score === "number" ? score : 10);
}
function playerAC(run) {
  const d = playerDerived(run);
  if (typeof d.armorClass === "number") return d.armorClass;
  if (typeof run?.player?.ac === "number") return run.player.ac;
  return 10 + playerAbilityMod(run, "dexterity");
}
function playerInitiativeMod(run) {
  const d = playerDerived(run);
  if (typeof d.initiative === "number") return d.initiative;
  return playerAbilityMod(run, "dexterity");
}
function playerProficiency(run) {
  const pb = run?.player?.proficiencyBonus ?? playerDerived(run).proficiencyBonus;
  return typeof pb === "number" ? pb : 2; // level-1 default
}

// A tiny weapon table keyed on category nouns carried in the run's inventory —
// the ITEM_CATEGORY_NOUNS approach. No weapon → unarmed (1 + STR mod). Finesse
// weapons pick the better of STR/DEX (D.4 §2.3).
const WEAPON_TABLE = [
  { nouns: ["sword", "blade", "katana", "saber", "longsword", "shortsword"], die: "1d8", finesse: false, label: "blade" },
  { nouns: ["knife", "dagger", "shiv", "stiletto"], die: "1d4", finesse: true, label: "knife" },
  { nouns: ["pistol", "gun", "revolver", "sidearm"], die: "1d8", finesse: true, label: "sidearm" },
  { nouns: ["rifle", "smg", "carbine"], die: "1d10", finesse: true, label: "rifle" },
  { nouns: ["club", "bat", "pipe", "baton", "cudgel", "mace"], die: "1d6", finesse: false, label: "club" },
  { nouns: ["axe", "hatchet", "cleaver"], die: "1d8", finesse: false, label: "axe" },
  { nouns: ["staff", "spear", "polearm"], die: "1d6", finesse: false, label: "haft" }
];
function playerWeapon(run) {
  const names = [];
  for (const it of Object.values(run?.inventory || {})) if (it?.name) names.push(String(it.name).toLowerCase());
  for (const it of Array.isArray(run?.player?.inventory) ? run.player.inventory : []) if (it?.name) names.push(String(it.name).toLowerCase());
  const equip = Array.isArray(run?.player?.startingEquipment) ? run.player.startingEquipment : [];
  for (const e of equip) if (typeof e === "string") names.push(e.toLowerCase());
  const text = names.join(" ");
  for (const w of WEAPON_TABLE) {
    if (w.nouns.some((n) => new RegExp(`\\b${n}\\b`).test(text))) return w;
  }
  return null; // unarmed
}
function playerAttackProfile(run) {
  const strMod = playerAbilityMod(run, "strength");
  const dexMod = playerAbilityMod(run, "dexterity");
  const weapon = playerWeapon(run);
  if (!weapon) {
    return { die: null, mod: strMod, label: "bare hands", unarmed: true };
  }
  const mod = weapon.finesse ? Math.max(strMod, dexMod) : strMod;
  return { die: weapon.die, mod, label: weapon.label, unarmed: false };
}

// ── enemy combatant + intents ─────────────────────────────────────────────────
function makeCombatantId(npcId) {
  return `enm_${String(npcId).replace(/^npc_/, "")}`;
}

// Select ONE intent for an enemy this round — seeded-deterministic (hashSeed on
// worldSeed|combatId|round|enemyId), weighted by the stat block. Telegraphed by
// default: the returned telegraph is a committed fact the narrator speaks forward.
function selectEnemyIntent(run, combat, combatant, round) {
  const block = resolveStatBlock(combatant.statBlockId);
  const intents = block?.intents || [];
  if (!intents.length) {
    return { intentId: "wait", kind: "defend", telegraph: "watches, waiting", hidden: false };
  }
  const seed = hashSeed(`${run.worldSeed || run.runId}|combat|${combat.combatId}|${round}|${combatant.combatantId}`);
  const totalWeight = intents.reduce((s, i) => s + (i.weight || 1), 0);
  let pick = seed % totalWeight;
  let chosen = intents[0];
  for (const intent of intents) {
    pick -= intent.weight || 1;
    if (pick < 0) { chosen = intent; break; }
  }
  return {
    intentId: chosen.intentId,
    kind: chosen.kind,
    attackId: chosen.attackId || null,
    telegraph: chosen.telegraph || "",
    hidden: chosen.hidden === true
  };
}

function livingEnemies(combat) {
  return Object.values(combat.combatants).filter((c) => c.kind === "enemy" && (c.hp?.current ?? 0) > 0);
}
function enemyHpBand(c) {
  const cur = c.hp?.current ?? 0;
  const max = c.hp?.max ?? 1;
  return cur <= 0 ? "down" : cur <= max / 2 ? "bloodied" : "steady";
}

// ── combat entry ──────────────────────────────────────────────────────────────
/**
 * Enter combat from a grounded player attack intent (D.4 Phase 1's only built
 * entry). The target NPC is already committed in run.npcs (placed by the player's
 * scene or by a thread `hostileNpc` beat). Its statBlockId is read off the NPC if
 * present, else the `civilian` default. Rolls initiative, writes run.combat, and
 * resolves round 1 with the player's declared attack.
 *
 * @returns {{ ok, run, combatRound }} or {{ ok:false, code }}
 */
export function enterCombatFromAttackIntent(run, { targetNpcId, intent }, options = {}) {
  const npc = run.npcs?.[targetNpcId];
  if (!npc) {
    return { ok: false, code: "COMBAT_NO_TARGET" };
  }
  const statBlockId = npc.statBlockId || npc.flags?.statBlockId || DEFAULT_STAT_BLOCK_ID;
  const block = resolveStatBlock(statBlockId);
  if (!block) {
    // Unknown stat block → never narrate a phantom fight (coherence leak #9).
    return { ok: false, code: "COMBAT_UNKNOWN_STATBLOCK" };
  }

  const combatId = `cbt_${hashSeed(`${run.worldSeed || run.runId}|${targetNpcId}|${run.timeline?.length || 0}`)}`;
  const combatantId = makeCombatantId(targetNpcId);
  const enemy = {
    combatantId,
    kind: "enemy",
    npcId: targetNpcId,
    statBlockId,
    name: npc.displayName || block.name,
    hp: { current: block.maxHp, max: block.maxHp },
    ac: block.ac,
    dexMod: block.dexMod || 0,
    initiative: 0,
    conditions: [],
    morale: "steady"
  };

  // Initiative (D.4 §3.3): player d20 + init mod, enemy d20 + dex mod; ties → player.
  const playerInit = rollD20(options) + playerInitiativeMod(run);
  const enemyInit = rollD20(options) + enemy.dexMod;
  enemy.initiative = enemyInit;
  const playerFirst = playerInit >= enemyInit;
  const turnOrder = playerFirst ? ["player", combatantId] : [combatantId, "player"];

  const combat = {
    combatId,
    status: "active",
    round: 1,
    turnOrder,
    turnIndex: 0,
    combatants: { player: { kind: "player" }, [combatantId]: enemy },
    enemyIntents: {},
    startedAt: isoNow(options),
    endedAtRound: null,
    outcome: null,
    initiative: { player: playerInit, [combatantId]: enemyInit }
  };
  // Round-1 intent is selected at round start (before the player acts).
  combat.enemyIntents[combatantId] = selectEnemyIntent(run, combat, enemy, 1);
  run.combat = combat;

  // The declared attack IS round 1's player action.
  const playerAction = { route: "attack", target: combatantId };
  const combatRound = resolveRound(run, playerAction, { ...options, entryIntent: intent });
  return { ok: true, run, combatRound };
}

/**
 * Resolve one in-combat turn from free text (subsequent rounds). Classifies the
 * intent onto the legal menu via the FROZEN classifier, then dispatches. A
 * `clarify` route spends NO turn (ask ≠ act / ungrounded). Anything else runs a
 * full round.
 *
 * @returns {{ ok, run, combatRound }} | {{ ok, run, clarify }} | {{ ok:false, code }}
 */
export function resolveCombatInput(run, action, options = {}) {
  if (!combatActive(run)) return { ok: false, code: "NOT_IN_COMBAT" };
  const combat = run.combat;
  const enemies = livingEnemies(combat).map((c) => ({
    id: c.combatantId,
    name: c.name,
    alive: (c.hp?.current ?? 0) > 0,
    hp: c.hp
  }));
  const heldItems = collectHeldItems(run);

  // A structured use_item menu action (not free text) — counts as the combat
  // turn, then the enemy responds within the round (phase0 §1.5 Change B). In
  // Phase 1 the effect is combat.js's own minimal applier; full item effects
  // compose in Phase 2 via the existing use_item resolver.
  if (action.type === "use_item" || action.combatAction === "use_item") {
    const itemId = action.itemId || action.item || null;
    const playerAction = { route: "use_item", itemId };
    const combatRound = resolveRound(run, playerAction, options);
    return { ok: true, run, combatRound };
  }

  const context = { isDying: isDying(run), enemies, heldItems };
  const decision = classifyCombatInput(action.intent, context);

  if (decision.route === "clarify") {
    // No turn spent; the round does not advance, no enemy acts (phase0 §1.3).
    return { ok: true, run, clarify: { reason: decision.reason, ask: decision.ask } };
  }
  const playerAction = {
    route: decision.route,
    target: decision.target || null,
    itemId: decision.itemId || null,
    stuntEffect: decision.stuntEffect || null,
    intent: action.intent
  };
  const combatRound = resolveRound(run, playerAction, options);
  return { ok: true, run, combatRound };
}

// ── the round ─────────────────────────────────────────────────────────────────
// One round: resolve each combatant's turn in initiative order (the player's
// declared action + each living enemy's committed intent), then close or advance.
function resolveRound(run, playerAction, options = {}) {
  const combat = run.combat;
  const round = combat.round;
  const actions = [];
  const order = combat.turnOrder;

  for (const id of order) {
    if (combat.status !== "active") break;
    if (id === "player") {
      resolvePlayerTurn(run, combat, playerAction, actions, options);
      if (combat.status === "fled") { closeCombat(run, combat, "fled", options); break; }
    } else {
      const enemy = combat.combatants[id];
      if (!enemy || (enemy.hp?.current ?? 0) <= 0) continue; // dead enemies don't act
      resolveEnemyTurn(run, combat, enemy, actions, options);
      if ((getHp(run.player).current ?? 0) <= 0) {
        // Player-drop rule: combat ends the instant the player drops (§2.4).
        combat.status = "lost";
        closeCombat(run, combat, "lost", options);
        break;
      }
    }
  }

  // Round end — victory check + next-round telegraphs.
  let nextIntents = [];
  if (combat.status === "active") {
    if (livingEnemies(combat).length === 0) {
      combat.status = "won";
      closeCombat(run, combat, "won", options);
    } else {
      combat.round += 1;
      for (const enemy of livingEnemies(combat)) {
        combat.enemyIntents[enemy.combatantId] = selectEnemyIntent(run, combat, enemy, combat.round);
      }
      nextIntents = livingEnemies(combat).map((e) => ({
        id: e.combatantId,
        telegraph: combat.enemyIntents[e.combatantId]?.hidden ? "coils, unreadable" : combat.enemyIntents[e.combatantId]?.telegraph || ""
      }));
    }
  }

  const hp = getHp(run.player);
  return {
    combatId: combat.combatId,
    round,
    status: combat.status,
    location: { locationId: run.currentLocationId, name: run.locations?.[run.currentLocationId]?.name || "" },
    actions,
    playerHp: { current: hp.current, max: hp.max, status: run.player.status },
    enemies: Object.values(combat.combatants)
      .filter((c) => c.kind === "enemy")
      .map((c) => ({ id: c.combatantId, name: c.name, hpBand: enemyHpBand(c), morale: c.morale })),
    nextIntents,
    outcome: combat.outcome || null
  };
}

function resolvePlayerTurn(run, combat, playerAction, actions, options) {
  const route = playerAction.route;
  if (route === "hold_on") {
    // Dying-turn death save is owned by finalizeQuestProgress; nothing to roll here.
    actions.push({ actor: "player", kind: "hold_on", roll: null, damage: null, targetTransition: null });
    return;
  }
  if (route === "use_item") {
    const applied = applyHeldItem(run, playerAction.itemId);
    actions.push({ actor: "player", kind: "use_item", itemId: playerAction.itemId, healed: applied.healed, targetTransition: null });
    return;
  }
  if (route === "defend") {
    run.player.flags = run.player.flags || {};
    run.player.flags.defendingUntilRound = combat.round + 1; // disadvantage on attacks against the player until next turn
    actions.push({ actor: "player", kind: "defend", roll: null, damage: null, targetTransition: null });
    return;
  }
  if (route === "flee") {
    resolvePlayerFlee(run, combat, actions, options);
    return;
  }
  if (route === "stunt") {
    resolvePlayerStunt(run, combat, playerAction, actions, options);
    return;
  }
  // attack (default)
  resolvePlayerAttack(run, combat, playerAction, actions, options);
}

function resolvePlayerAttack(run, combat, playerAction, actions, options) {
  const targetId = playerAction.target || livingEnemies(combat)[0]?.combatantId;
  const enemy = combat.combatants[targetId];
  if (!enemy || (enemy.hp?.current ?? 0) <= 0) {
    actions.push({ actor: "player", kind: "attack", target: targetId, roll: null, damage: null, targetTransition: null, note: "no_target" });
    return;
  }
  const profile = playerAttackProfile(run);
  const d20 = rollD20(options);
  const crit = d20 === 20;
  const toHit = d20 + playerProficiency(run) + profile.mod;
  const hit = crit || (d20 !== 1 && toHit >= enemy.ac);
  let damage = 0;
  if (hit) {
    if (profile.unarmed) {
      damage = Math.max(1, 1 + profile.mod) * (crit ? 2 : 1);
    } else {
      const base = rollDice(profile.die, { rng: options.rng }).total + (crit ? rollDice(profile.die, { rng: options.rng }).total : 0);
      damage = Math.max(1, base + profile.mod);
    }
    enemy.hp.current = Math.max(0, enemy.hp.current - damage);
  }
  const transition = !hit ? null : enemy.hp.current <= 0 ? "dead" : enemyHpBand(enemy);
  if (enemy.hp.current <= 0) enemy.morale = "broken";
  actions.push({
    actor: "player",
    kind: "attack",
    target: targetId,
    roll: { total: toHit, vs: "ac", dc: enemy.ac, hit, crit },
    damage: hit ? { amount: damage, type: profile.unarmed ? "bludgeoning" : "physical" } : null,
    targetTransition: transition
  });
}

function resolvePlayerFlee(run, combat, actions, options) {
  // Contested DEX check vs a DC from the fastest living enemy (D.4 §2.3).
  const fastest = livingEnemies(combat).reduce((m, c) => Math.max(m, c.dexMod || 0), 0);
  const dc = 10 + fastest;
  const check = resolveAbilityCheck(run, { ability: "dexterity", dc, checkId: "combat_flee" }, options);
  const success = check.ok && check.success;
  if (success) {
    combat.status = "fled";
    // Real relocation (M.1): move to a connected location if one exists; never teleport to nowhere.
    const here = run.locations?.[run.currentLocationId];
    const exits = Array.isArray(here?.connections) ? here.connections
      : Array.isArray(here?.exits) ? here.exits.map((e) => e.locationId || e.toLocationId || e).filter(Boolean)
      : [];
    const dest = exits.find((id) => run.locations?.[id]);
    if (dest) run.currentLocationId = dest;
    // Leave the enemy alive; flag the location hostile so re-entry can re-trigger.
    if (here) { here.flags = here.flags || {}; here.flags.hostile = true; }
  }
  actions.push({ actor: "player", kind: "flee", roll: { total: check.total ?? null, vs: "dc", dc, hit: success }, damage: null, targetTransition: null });
}

function resolvePlayerStunt(run, combat, playerAction, actions, options) {
  // A stunt is a normal ability check whose SUCCESS buys ONE enumerated boon —
  // never direct damage, never a win (phase0 §1.3, COMBAT_STUNT_EFFECTS sealed).
  const check = resolveAbilityCheck(run, { ability: "dexterity", dc: 12, checkId: "combat_stunt" }, options);
  const success = check.ok && check.success;
  let boon = null;
  if (success) {
    boon = COMBAT_STUNT_EFFECTS.includes(playerAction.stuntEffect) ? playerAction.stuntEffect : "enemy_disadvantage";
    const target = combat.combatants[playerAction.target] || livingEnemies(combat)[0];
    if (target) {
      target.conditions = target.conditions || [];
      if (boon === "apply_condition") target.conditions.push({ id: "off_balance", name: "off-balance", kind: "debuff" });
      if (boon === "enemy_disadvantage" || boon === "enemy_intent_disrupted") target.flags = { ...(target.flags || {}), disadvantageNextTurn: true };
    }
    if (boon === "advantage_next_attack") { run.player.flags = { ...(run.player.flags || {}), advantageNextAttack: true }; }
  }
  actions.push({ actor: "player", kind: "stunt", roll: { total: check.total ?? null, vs: "dc", dc: 12, hit: success }, boon, damage: null, targetTransition: null });
}

function resolveEnemyTurn(run, combat, enemy, actions, options) {
  const intent = combat.enemyIntents[enemy.combatantId] || selectEnemyIntent(run, combat, enemy, combat.round);
  if (intent.kind !== "attack") {
    // defend/other: mutate only combat state (no player damage).
    actions.push({ actor: enemy.combatantId, kind: intent.kind, intentId: intent.intentId, roll: null, damage: null, targetTransition: null });
    return;
  }
  const block = resolveStatBlock(enemy.statBlockId);
  const atk = (block?.attacks || []).find((a) => a.attackId === intent.attackId) || block?.attacks?.[0];
  const defending = run.player.flags?.defendingUntilRound && combat.round <= run.player.flags.defendingUntilRound;
  const disadvantage = Boolean(defending) || Boolean(enemy.flags?.disadvantageNextTurn);
  if (enemy.flags) enemy.flags.disadvantageNextTurn = false;
  // Enemy attack vs the player's REAL AC (finally load-bearing).
  const rolls = disadvantage ? [rollD20(options), rollD20(options)] : [rollD20(options)];
  const d20 = disadvantage ? Math.min(...rolls) : rolls[0];
  const crit = d20 === 20;
  const toHit = d20 + (atk?.toHit ?? 0);
  const hit = crit || (d20 !== 1 && toHit >= playerAC(run));
  let damageRecord = null;
  let transition = null;
  if (hit && atk) {
    const dmg = Math.max(1, rollDice(atk.damage, { rng: options.rng }).total);
    const rec = applyDamage(run, dmg, { crit, now: isoNow(options) });
    damageRecord = { amount: rec.amount, type: atk.damageType || "physical" };
    transition = rec.dead ? "dead" : rec.dying ? "dying" : rec.downed ? "downed" : "hurt";
  }
  actions.push({
    actor: enemy.combatantId,
    kind: "attack",
    intentId: intent.intentId,
    roll: { total: toHit, vs: "ac", dc: playerAC(run), hit, crit },
    damage: damageRecord,
    targetTransition: transition
  });
}

// ── close ─────────────────────────────────────────────────────────────────────
// Writes the structured outcome + a timeline event + a CANONICAL memory fact
// (the D.5 write-back: `ground_lost` resolution and `onCanon` triggers consume
// it — both sides speak memoryFacts/timeline, no new plumbing). Clears run.combat.
function closeCombat(run, combat, status, options) {
  const now = isoNow(options);
  const defeated = Object.values(combat.combatants).filter((c) => c.kind === "enemy" && (c.hp?.current ?? 0) <= 0);
  const enemyNames = Object.values(combat.combatants).filter((c) => c.kind === "enemy").map((c) => c.name);
  const locName = run.locations?.[run.currentLocationId]?.name || "the fight";

  let xp = 0;
  const loot = [];
  if (status === "won") {
    for (const c of defeated) {
      const block = resolveStatBlock(c.statBlockId);
      xp += block?.xp || 0;
      for (const drop of block?.loot || []) {
        const seed = hashSeed(`${run.worldSeed || run.runId}|loot|${combat.combatId}|${drop.itemId}`);
        if ((seed % 100) / 100 < (drop.chance ?? 0)) {
          grantItemToRun(run, { templateId: drop.itemId, name: drop.name, quantity: 1 });
          loot.push({ itemId: drop.itemId, name: drop.name });
        }
      }
    }
    if (xp > 0) awardXp(run, xp);
  }

  combat.outcome = { result: status, defeated: defeated.map((c) => ({ combatantId: c.combatantId, npcId: c.npcId, name: c.name })), xp, loot };
  combat.endedAtRound = combat.round;

  // Canonical fact — stable, keyword-bearing text the thread engine reads. Enemy
  // display names carry the meaningful noun (e.g. "collector"), so an onCanon
  // trigger matches without any new plumbing.
  const factId = `fact_combat_${combat.combatId}`;
  const nameList = enemyNames.join(", ");
  const text =
    status === "won" ? `You put down ${nameList} at ${locName}. ${nameList} is dead.`
    : status === "fled" ? `You broke away from ${nameList} and slipped out of ${locName}; ${nameList} is still out there.`
    : `${nameList} left you bleeding at ${locName}.`;
  run.memoryFacts = run.memoryFacts || [];
  run.memoryFacts.push({
    factId,
    entityIds: [...new Set([run.runId, run.currentLocationId, ...defeated.map((c) => c.npcId)])],
    type: "combat_outcome",
    text,
    source: "system",
    createdAt: now,
    tags: ["system", "combat", status],
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    contentTags: [],
    canonical: true,
    confidence: 1,
    supersedesFactIds: [],
    payload: { combatId: combat.combatId, result: status, defeated: defeated.map((c) => c.npcId), xp }
  });
  run.timeline = run.timeline || [];
  run.timeline.push({
    eventId: `event_combat_${combat.combatId}`,
    type: "combat",
    title: status === "won" ? "Fight won" : status === "fled" ? "Broke away" : "Struck down",
    summary: text,
    createdAt: now,
    locationId: run.currentLocationId,
    entityIds: [...new Set([run.runId, ...defeated.map((c) => c.npcId)])],
    memoryFactIds: [factId],
    tags: ["combat", status],
    edition: run.edition,
    policyProfileId: run.policyProfileId,
    contentTags: [],
    payload: { result: status, xp, loot }
  });

  // Mark defeated enemies dead on the roster (so the cast/scene reflects it) and
  // record the outcome for the thread lifecycle (ground_lost reads run.npcs).
  for (const c of defeated) {
    const npc = run.npcs?.[c.npcId];
    if (npc) {
      npc.flags = npc.flags || {};
      npc.flags.defeated = true;
      npc.flags.hostile = false;
      npc.status = "dead";
    }
  }

  // Clear the fight (D.4 §3.3). The lost-aftermath (death saves) runs OUT of
  // combat in the dying loop, with the clock frozen (phase0 §2).
  run.combat = null;
}

// ── item + util ────────────────────────────────────────────────────────────────
function collectHeldItems(run) {
  const items = [];
  for (const it of Object.values(run?.inventory || {})) if (it?.itemId) items.push({ itemId: it.itemId, name: it.name, noun: it.flags?.noun });
  for (const it of Array.isArray(run?.player?.inventory) ? run.player.inventory : []) if (it?.itemId) items.push({ itemId: it.itemId, name: it.name });
  return items;
}
// Minimal in-combat item use for the slice: apply a healing consumable if the
// named item is one; consume it. (Richer item effects compose in Phase 2 via the
// existing use_item resolver.)
function applyHeldItem(run, itemId) {
  const inv = run?.inventory?.[itemId];
  const heal = inv?.use?.effectType === "recover_resource" && inv?.use?.resource === "hitPoints" ? inv.use.amount : null;
  if (heal && run.player) {
    const hp = getHp(run.player);
    const setHpTo = Math.min(hp.max, hp.current + heal);
    run.player.resources = run.player.resources || {};
    run.player.resources.hitPoints = { current: setHpTo, max: hp.max };
    if (inv.consumable !== false) delete run.inventory[itemId];
    return { healed: heal };
  }
  return { healed: 0 };
}

function isoNow(options) {
  if (typeof options?.now === "string") return options.now;
  if (options?.now instanceof Date) return options.now.toISOString();
  return new Date().toISOString();
}

/**
 * The combat action menu — surfaced by getAvailableSoloActions while a fight is
 * live (the exploration menu is illegal in combat, phase0 §1.1).
 */
export function getCombatActionMenu(run) {
  if (!combatActive(run)) return [];
  const dying = isDying(run);
  if (dying) {
    return [
      { type: "attempt", combatAction: "hold_on", label: "Hold on (roll a death save)" },
      { type: "use_item", combatAction: "use_item", label: "Use an item" }
    ];
  }
  return [
    { type: "attempt", combatAction: "attack", label: "Attack" },
    { type: "attempt", combatAction: "defend", label: "Defend" },
    { type: "attempt", combatAction: "flee", label: "Flee" },
    { type: "use_item", combatAction: "use_item", label: "Use an item" }
  ];
}
