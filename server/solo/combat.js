// D.4 — THE COMBAT RESOLVER (positionless, CTB-timed).
//
// Combat state is SERVER-OWNED TRUTH; the LLM narrates turns and never adjudicates
// them (docs/inkborne-combat-d4-spec.md §3, phase0-contract §5). This module owns
// the fight: the attack/defend/flee/use_item/hold_on/stunt resolvers, seeded
// telegraphed enemy intents, three-band resolution, and the won/lost/fled close.
// The turn CLOCK is the CTB queue (ctb.js, docs/handbook/ctb-turn-engine-spec.md
// [LOCKED]) — no rounds, no initiative; Speed (from DEX, luck excluded) sets the
// order and the order-only forecast. It consumes the FROZEN in-combat interpreter
// (combatContract.js classifyCombatInput) as its deterministic input layer, the
// bestiary (statBlockId resolution), and the existing lethality spine
// (death.js applyDamage) — so the whole death machinery composes with zero new
// lethality code. `ALLOWED_EFFECT_TYPES` is untouched: combat mutations are
// resolver output, exactly like movement (coherence leak #2).
//
// One HTTP action = one PLAYER decision: the player's action resolves, then the CTB
// queue runs every enemy whose next_tick precedes the player's next turn, and control
// returns to the player. The player-drop rule (spec §2.4 / phase0 §2): combat ends the
// moment the player reaches 0 HP; the dying-turn loop owns the aftermath, clock frozen.

import { rollD20, rollDice, abilityModifier } from "../rules/dice.js";
import { resolveAbilityCheck, bandFromMargin, RESOLUTION_BANDS } from "./rules.js";
import { applyDamage, getHp, isDying, isDead } from "./death.js";
import { awardXp } from "./progression.js";
import { grantItemToRun } from "./search.js";
import { resolveStatBlock, DEFAULT_STAT_BLOCK_ID } from "../campaign/bestiary.js";
import { classifyCombatInput, COMBAT_STUNT_EFFECTS } from "./combatContract.js";
import { advanceCombatRounds } from "./worldClock.js";
import {
  seedCombatantQueue, nextActor, commitTurn, buildForecast, ACTION_WEIGHT
} from "./ctb.js";
import {
  applyCombatStatus, tickStatusesOnTurnStart,
  statusAttackDisadvantage, statusSkillsLocked, statusAsleep, statusMisdirects, wakeOnDamage, absorbWithShield
} from "./combatStatus.js";

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
// DEX modifier feeds CTB Speed (the ONLY queue input — luck excluded, §2.2).
function playerDexMod(run) {
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
export function selectEnemyIntent(run, combat, combatant, round) {
  const block = resolveStatBlock(combatant.statBlockId);
  const intents = block?.intents || [];
  if (!intents.length) {
    return { intentId: "wait", kind: "defend", telegraph: "watches, waiting", hidden: false };
  }
  const chosen = pickTacticIntent(run, combat, combatant, block, intents, round);
  // TELEPATHY (A3.4, intent-mask): a foe that speaks mind-to-mind hides its tell — the
  // telegraph reads "???" until the player FOCUSes it (sets combatant.revealed).
  const masked = enemyHasSkill(combatant, "telepathy") && !combatant.revealed;
  return {
    intentId: chosen.intentId,
    kind: chosen.kind,
    attackId: chosen.attackId || null,
    telegraph: masked ? "???" : (chosen.telegraph || ""),
    hidden: chosen.hidden === true,
    masked
  };
}

// TACTIC POLICY (A2, audit 5d548ac) — a small data-driven layer over the weighted
// intents (Law-6), replacing the pure dice-bag. Rules, in order:
//   (1) OPENER — a creature leads with its SIGNATURE on its first turn: the
//       rider-bearing attack (the Grey opens with the chill-bite, so its tempo-sapping
//       signature is FELT immediately), else the highest-weight attack.
//   (2) BELOW-HALF SHIFT — a vicious creature turns DESPERATE (drops circling/defensive
//       intents, presses attacks); a cowardly one leans defensive.
//   (3) PRESS ADVANTAGE — if the player is already slowed/controlled, a vicious
//       creature favors attacks to keep the tempo it just stole.
// A block with NO behaviors falls back to the plain weighted pick (backward-compatible
// with every existing creature + test). Deterministic (seeded), like before.
function pickTacticIntent(run, combat, combatant, block, intents, round) {
  const b = block?.behaviors || {};
  const attacks = intents.filter((i) => i.kind === "attack");
  // (1) Opener — first turn leads with the signature attack.
  if (!combatant.hasOpened && attacks.length) {
    const withRider = attacks.find((i) => (block?.attacks || []).some((a) => a.attackId === i.attackId && a.rider));
    return withRider || attacks.reduce((m, i) => ((i.weight || 1) > (m.weight || 1) ? i : m), attacks[0]);
  }
  const hasBehaviors = b && (b.vicious || b.cowardly || b.defensive);
  if (!hasBehaviors) return weightedPick(run, combat, combatant, intents, round); // backward-compatible
  const hpFrac = (combatant.hp?.current ?? 0) / (combatant.hp?.max ?? 1);
  const desperate = b.vicious && hpFrac <= 0.5;
  const pressing = b.vicious && playerIsControlled(combat);
  const pool = intents.map((i) => {
    let w = i.weight || 1;
    if (i.kind === "attack" && (desperate || pressing)) w *= 3;   // press the attack
    if (i.kind !== "attack" && desperate) w = 0;                   // a desperate beast stops circling
    if (i.kind !== "attack" && b.cowardly && hpFrac <= 0.5) w *= 2; // a coward turtles
    return { intent: i, w: Math.max(0, w) };
  }).filter((x) => x.w > 0);
  const usable = pool.length ? pool : intents.map((i) => ({ intent: i, w: i.weight || 1 }));
  const total = usable.reduce((s, x) => s + x.w, 0);
  const seed = hashSeed(`${run.worldSeed || run.runId}|combat|${combat.combatId}|${round}|${combatant.combatantId}`);
  let pick = seed % total;
  for (const x of usable) { pick -= x.w; if (pick < 0) return x.intent; }
  return usable[0].intent;
}

function weightedPick(run, combat, combatant, intents, round) {
  const seed = hashSeed(`${run.worldSeed || run.runId}|combat|${combat.combatId}|${round}|${combatant.combatantId}`);
  const total = intents.reduce((s, i) => s + (i.weight || 1), 0);
  let pick = seed % total;
  for (const intent of intents) { pick -= intent.weight || 1; if (pick < 0) return intent; }
  return intents[0];
}

// Is the player currently under a tempo/turn-denial control (the signal a vicious
// creature presses)? slow (the Grey's chill), stun, or sleep.
function playerIsControlled(combat) {
  const p = combat?.combatants?.player;
  return Array.isArray(p?.conditions) && p.conditions.some((c) => ["slow", "stun", "sleep"].includes(c.engineStatus));
}

function livingEnemies(combat) {
  return Object.values(combat.combatants).filter((c) => c.kind === "enemy" && (c.hp?.current ?? 0) > 0 && c.fled !== true);
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
    conditions: [],
    morale: "steady",
    revealed: true // v1 entry is a face-off, not an ambush → visible in the forecast
  };

  // CTB start (ctb-turn-engine-spec §3.4): NO initiative roll. Every combatant
  // enters at next_tick = standard delay; the queue (Speed from DEX) decides order.
  const player = { kind: "player", combatantId: "player", name: "You", dexMod: playerDexMod(run) };
  const combat = {
    combatId,
    status: "active",
    turn: 1, // player-decision counter (replaces the JRPG round; clock is `now`)
    now: 0, // CTB queue clock, integer ticks
    queueSeed: hashSeed(`${run.worldSeed || run.runId}|queue|${combatId}`),
    combatants: { player, [combatantId]: enemy },
    enemyIntents: {},
    forecast: [],
    startedAt: isoNow(options),
    endedAtTurn: null,
    outcome: null
  };
  seedCombatantQueue(player, { now: 0 });
  seedCombatantQueue(enemy, { now: 0 });
  combat.enemyIntents[combatantId] = selectEnemyIntent(run, combat, enemy, 1);
  run.combat = combat;

  // The initiator gets the opening strike: the player's declared attack is turn 1,
  // applied before the queue governs (you struck first to open the fight).
  const playerAction = { route: "attack", target: combatantId };
  const combatTurn = resolveCombatTurn(run, playerAction, { ...options, entryIntent: intent });
  return { ok: true, run, combatRound: combatTurn };
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
    const combatRound = resolveCombatTurn(run, playerAction, options);
    return { ok: true, run, combatRound };
  }

  const context = { isDying: isDying(run), enemies, heldItems };
  const decision = classifyCombatInput(action.intent, context);

  if (decision.route === "clarify") {
    // No turn spent; the queue does not advance, no enemy acts (phase0 §1.3).
    return { ok: true, run, clarify: { reason: decision.reason, ask: decision.ask } };
  }
  const playerAction = {
    route: decision.route,
    target: decision.target || null,
    itemId: decision.itemId || null,
    stuntEffect: decision.stuntEffect || null,
    intent: action.intent
  };
  const combatRound = resolveCombatTurn(run, playerAction, options);
  return { ok: true, run, combatRound };
}

// ── the turn (CTB) ──────────────────────────────────────────────────────────────
// One HTTP action = one PLAYER decision. The player's chosen action resolves, then
// the CTB queue runs every enemy whose next_tick precedes the player's next turn,
// and control returns to the player. There are no rounds and no initiative — the
// queue (Speed from DEX) is the clock (ctb-turn-engine-spec §1).
function resolveCombatTurn(run, playerAction, options = {}) {
  const combat = run.combat;
  const actions = [];

  // 1. The player's turn — statuses tick at turn start (poison/regen; ch8), then act.
  const ptick = tickStatusesOnTurnStart(run, combat, combat.combatants.player, options);
  if (ptick.length) actions.push({ actor: "player", kind: "status", events: ptick });
  if ((getHp(run.player).current ?? 0) <= 0 && combat.status === "active") {
    combat.status = "lost"; closeCombat(run, combat, "lost", options); return buildTurnResult(run, combat, actions);
  }
  resolvePlayerTurn(run, combat, playerAction, actions, options);
  if (combat.status === "fled") { closeCombat(run, combat, "fled", options); return buildTurnResult(run, combat, actions); }
  // The player-drop rule can fire on the player's OWN turn (an at-cost counter-blow).
  if ((getHp(run.player).current ?? 0) <= 0 && combat.status === "active") {
    combat.status = "lost"; closeCombat(run, combat, "lost", options); return buildTurnResult(run, combat, actions);
  }
  if (combat.status === "active") {
    commitTurn(combat, combat.combatants.player, { weight: actionWeight(playerAction.route) });
  }

  // 2. Victory the instant the last enemy drops (no wasted enemy phase).
  if (combat.status === "active" && livingEnemies(combat).length === 0) {
    combat.status = "won"; closeCombat(run, combat, "won", options); return buildTurnResult(run, combat, actions);
  }

  // 3. Run the queue until it is the player's turn again (or the fight ends).
  runEnemyTurnsUntilPlayer(run, combat, actions, options);

  // 4. Close or advance to the next player decision.
  if (combat.status === "active") {
    if (livingEnemies(combat).length === 0) {
      combat.status = "won"; closeCombat(run, combat, "won", options);
    } else if ((getHp(run.player).current ?? 0) <= 0) {
      combat.status = "lost"; closeCombat(run, combat, "lost", options);
    } else {
      combat.turn += 1;
      for (const enemy of livingEnemies(combat)) {
        if (!combat.enemyIntents[enemy.combatantId]) {
          combat.enemyIntents[enemy.combatantId] = selectEnemyIntent(run, combat, enemy, combat.turn);
        }
      }
    }
  }
  return buildTurnResult(run, combat, actions);
}

// Drive the CTB queue: while a fight is live and the NEXT actor is an enemy, resolve
// its committed (telegraphed) intent, advance its queue slot, and pick its next
// intent. Stop when the player is next to act. The player-drop rule ends combat the
// instant the player reaches 0 HP (the guard caps a pathological loop).
function runEnemyTurnsUntilPlayer(run, combat, actions, options) {
  let guard = 0;
  while (combat.status === "active" && guard < 64) {
    guard += 1;
    const actor = nextActor(combat);
    if (!actor || actor.kind === "player") break; // hand the decision back to the player
    // Statuses tick at the enemy's turn start; a poison tick can drop it before it acts.
    const etick = tickStatusesOnTurnStart(run, combat, actor, options);
    if (etick.length) actions.push({ actor: actor.combatantId, kind: "status", events: etick });
    if ((actor.hp?.current ?? 0) <= 0) { actor.morale = "broken"; continue; } // died from a tick — leaves the queue (nextActor filters the dead)
    resolveEnemyTurn(run, combat, actor, actions, options);
    if ((getHp(run.player).current ?? 0) <= 0) {
      combat.status = "lost"; closeCombat(run, combat, "lost", options); break;
    }
    commitTurn(combat, actor, { weight: ACTION_WEIGHT.standard });
    combat.enemyIntents[actor.combatantId] = selectEnemyIntent(run, combat, actor, combat.turn + 1);
  }
}

function actionWeight(route) {
  if (route === "use_item") return ACTION_WEIGHT.light;
  if (route === "defend") return ACTION_WEIGHT.heavy; // guarding trades tempo for safety (the DEFEND tick trade)
  return ACTION_WEIGHT.standard;
}

// The per-turn payload: the ORDER-ONLY forecast (never raw ticks) + wound-band
// enemies (never raw enemy HP — the narrator speaks wounds). Persists the forecast
// on combat so the scene payload serves the same truth.
function buildTurnResult(run, combat, actions) {
  const hp = getHp(run.player);
  const forecast = combat.status === "active"
    ? buildForecast(combat, { isRevealed: (c) => c.kind === "player" || c.revealed !== false })
    : [];
  combat.forecast = forecast;
  return {
    combatId: combat.combatId,
    turn: combat.turn,
    round: combat.turn, // back-compat alias for readers that still key on "round"
    status: combat.status,
    location: { locationId: run.currentLocationId, name: run.locations?.[run.currentLocationId]?.name || "" },
    actions,
    forecast,
    playerHp: { current: hp.current, max: hp.max, status: run.player.status },
    enemies: Object.values(combat.combatants)
      .filter((c) => c.kind === "enemy")
      .map((c) => ({ id: c.combatantId, name: c.name, hpBand: enemyHpBand(c), morale: c.morale })),
    nextIntents: livingEnemies(combat).map((e) => ({
      id: e.combatantId,
      telegraph: combat.enemyIntents[e.combatantId]?.hidden ? "coils, unreadable" : combat.enemyIntents[e.combatantId]?.telegraph || ""
    })),
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
  // PLAYER control statuses (A2.2): SLEEP loses the turn (damage wakes it); CONFUSE /
  // charm may misdirect the action so it fizzles.
  const pc = combat.combatants.player;
  if (statusAsleep(pc)) { actions.push({ actor: "player", kind: "asleep", roll: null, damage: null, targetTransition: null }); return; }
  if (statusMisdirects(pc, `${run.worldSeed || run.runId}|pconfuse|${combat.combatId}|${combat.turn}`)) {
    actions.push({ actor: "player", kind: "confused", roll: null, damage: null, targetTransition: null });
    return;
  }
  if (route === "use_item") {
    const applied = applyHeldItem(run, playerAction.itemId);
    actions.push({ actor: "player", kind: "use_item", itemId: playerAction.itemId, healed: applied.healed, targetTransition: null });
    return;
  }
  if (route === "defend") {
    run.player.flags = run.player.flags || {};
    run.player.flags.defendingUntilRound = combat.turn + 1; // disadvantage on attacks against the player until next turn
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
  if (route === "focus") {
    // Essence-sight FOCUS is the Babel MC's origin active; anyone else "studying" the
    // foe gets a plain maneuver (a stunt for the opening).
    if (playerHasFocus(run)) resolvePlayerFocus(run, combat, playerAction, actions, options);
    else resolvePlayerStunt(run, combat, { ...playerAction, stuntEffect: "advantage_next_attack" }, actions, options);
    return;
  }
  // attack (default)
  resolvePlayerAttack(run, combat, playerAction, actions, options);
}

// The essence-sight FOCUS active (The Beckoned's origin grant). Others fall back to a
// stunt (see resolvePlayerTurn).
function playerHasFocus(run) {
  const o = `${run.player?.origin || ""} ${run.player?.originFeat || ""}`.toLowerCase();
  return /beckoned|status window|essence/.test(o) || Boolean(run.flags?.essenceSight);
}

// ESSENCE-SIGHT FOCUS (A2, the MC's defining trait as a combat verb): a one-turn READ.
// It reveals the target's next intent (its telegraph + kind — the "intent weighting"
// the audit asked to surface) AND grants advantage on the player's next attack against
// that target (the bloodhound advantage). No damage; it spends the turn — info + an
// opening traded for a turn of offense. Counters a hidden telegraph ("???").
function resolvePlayerFocus(run, combat, playerAction, actions, options) {
  const targetId = playerAction.target || livingEnemies(combat)[0]?.combatantId;
  const enemy = combat.combatants[targetId];
  if (!enemy) {
    actions.push({ actor: "player", kind: "focus", target: null, note: "no_target", roll: null, damage: null, targetTransition: null });
    return;
  }
  // Read (or select + lock) the target's next intent, so its telegraph is revealed even
  // if the creature was masking it (telepathy's intent-mask is countered here).
  const intent = combat.enemyIntents[targetId] || selectEnemyIntent(run, combat, enemy, combat.turn + 1);
  combat.enemyIntents = combat.enemyIntents || {};
  combat.enemyIntents[targetId] = intent;
  enemy.revealed = true;
  run.player.flags = run.player.flags || {};
  run.player.flags.advantageNextAttack = true; // the read grants the opening
  actions.push({
    actor: "player",
    kind: "focus",
    target: targetId,
    read: { intentId: intent.intentId, kind: intent.kind, telegraph: intent.telegraph || "" },
    roll: null,
    damage: null,
    targetTransition: null
  });
}

// THREE-BAND ATTACK (Ch3 Law 2 applied to combat, per the CTB spec §"survives
// untouched"). margin = attack total − enemy AC → success / success-at-a-cost (the
// drama band: the hit lands AND a cost commits — damage BOTH ways) / failure-with-
// consequence (miss + the enemy gains edge; never "nothing happens"). Crit (nat 20)
// forces success + doubles the die; fumble (nat 1) forces failure.
function resolvePlayerAttack(run, combat, playerAction, actions, options) {
  const targetId = playerAction.target || livingEnemies(combat)[0]?.combatantId;
  const enemy = combat.combatants[targetId];
  if (!enemy || (enemy.hp?.current ?? 0) <= 0) {
    actions.push({ actor: "player", kind: "attack", target: targetId, roll: null, damage: null, targetTransition: null, note: "no_target" });
    return;
  }
  const profile = playerAttackProfile(run);
  const advantage = Boolean(run.player.flags?.advantageNextAttack);
  if (run.player.flags) run.player.flags.advantageNextAttack = false;
  // BLIND (A2.2): a blinded player swings at disadvantage; nets against any advantage.
  const net = (advantage ? 1 : 0) - (statusAttackDisadvantage(combat.combatants.player) ? 1 : 0);
  const rolls = net !== 0 ? [rollD20(options), rollD20(options)] : [rollD20(options)];
  const d20 = net > 0 ? Math.max(...rolls) : net < 0 ? Math.min(...rolls) : rolls[0];
  const crit = d20 === 20;
  const fumble = d20 === 1;
  const toHit = d20 + playerProficiency(run) + profile.mod;
  const margin = toHit - enemy.ac;
  const band = fumble ? RESOLUTION_BANDS.FAILURE : crit ? RESOLUTION_BANDS.SUCCESS : bandFromMargin(margin);

  let damage = 0;
  let cost = null;
  if (band !== RESOLUTION_BANDS.FAILURE) {
    damage = rollWeaponDamage(profile, crit, options);
    // SHIELD (A2.2): an enemy damage-absorb pool soaks the hit before HP drops.
    const sh = absorbWithShield(enemy, damage);
    damage = sh.amount;
    enemy.hp.current = Math.max(0, enemy.hp.current - damage);
    if (damage > 0) wakeOnDamage(enemy); // SLEEP breaks on damage
    if (band === RESOLUTION_BANDS.SUCCESS_AT_COST) {
      // The drama band: a real cost commits alongside the hit — the enemy lands a
      // parting nip in the same exchange (Ch3 "Resource = your own vitality"),
      // routed through the real death spine so a lethal cost still ends the fight.
      cost = resolveAtCostBite(run, enemy, options);
    }
  } else {
    // Failure with consequence: the miss leaves you exposed — the enemy's next
    // strike gains edge. The scene is left different, never "try again".
    enemy.flags = { ...(enemy.flags || {}), edgeNextTurn: true };
  }
  const transition = band === RESOLUTION_BANDS.FAILURE ? null : enemy.hp.current <= 0 ? "dead" : enemyHpBand(enemy);
  if (enemy.hp.current <= 0) enemy.morale = "broken";
  actions.push({
    actor: "player",
    kind: "attack",
    target: targetId,
    band,
    roll: { total: toHit, vs: "ac", dc: enemy.ac, margin, crit, fumble },
    damage: damage > 0 ? { amount: damage, type: profile.unarmed ? "bludgeoning" : "physical" } : null,
    cost,
    targetTransition: transition
  });
}

function rollWeaponDamage(profile, crit, options) {
  if (profile.unarmed) return Math.max(1, 1 + profile.mod) * (crit ? 2 : 1);
  const base = rollDice(profile.die, { rng: options.rng }).total + (crit ? rollDice(profile.die, { rng: options.rng }).total : 0);
  return Math.max(1, base + profile.mod);
}

// The at-cost counter-blow: a REDUCED hit from the enemy in the same exchange (half
// its normal damage, floored at 1) — a committed cost, never a free full turn.
function resolveAtCostBite(run, enemy, options) {
  const block = resolveStatBlock(enemy.statBlockId);
  const atk = block?.attacks?.[0];
  if (!atk) return null;
  const raw = Math.max(1, Math.ceil(rollDice(atk.damage, { rng: options.rng }).total / 2));
  const rec = applyDamage(run, raw, { now: isoNow(options) });
  return { kind: "counter", amount: rec.amount, type: atk.damageType || "physical", from: enemy.combatantId };
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
    const exits = Array.isArray(here?.connectedLocationIds) ? here.connectedLocationIds
      : Array.isArray(here?.connections) ? here.connections
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
  // MORALE (item 10): a wounded, outmatched creature may break and flee instead of
  // fighting. Flee is a fortune's verb (luck MAY touch it) — the check is seeded, not
  // a queue op. A fled creature COMMITS as fled: it stays ALIVE, leaves the fight, and
  // the world remembers (a thread-seed fact at close). Vicious things hold unless the
  // stat block also marks them injured (a wounded animal still bolts — the Grey).
  applyPackVisionShare(combat); // VISION-SHARE (A3.4): pack sight-reveal + shared advantage/haste
  if (maybeEnemyFlee(run, combat, enemy, actions, options)) return;
  // SLEEP — a sleeping combatant loses its turn (damage would already have woken it).
  if (statusAsleep(enemy)) { actions.push({ actor: enemy.combatantId, kind: "sleep", roll: null, damage: null, targetTransition: null }); return; }
  const intent = combat.enemyIntents[enemy.combatantId] || selectEnemyIntent(run, combat, enemy, combat.turn);
  enemy.hasOpened = true; // the opener fires once; subsequent turns run the full policy
  // CONFUSE — a confused combatant may misdirect its action (it fizzles this turn).
  if (statusMisdirects(enemy, `${run.worldSeed || run.runId}|confuse|${combat.combatId}|${enemy.combatantId}|${combat.turn}`)) {
    actions.push({ actor: enemy.combatantId, kind: "confused", intentId: intent.intentId, roll: null, damage: null, targetTransition: null });
    return;
  }
  // SKILL intents (charm etc.) — the chaos-skill layer resolves them; SILENCE locks them.
  if (intent.kind === "skill") {
    if (statusSkillsLocked(enemy)) { actions.push({ actor: enemy.combatantId, kind: "silenced", intentId: intent.intentId, roll: null, damage: null, targetTransition: null }); return; }
    resolveEnemySkill(run, combat, enemy, intent, actions, options);
    return;
  }
  if (intent.kind !== "attack") {
    // defend/other: mutate only combat state (no player damage).
    actions.push({ actor: enemy.combatantId, kind: intent.kind, intentId: intent.intentId, roll: null, damage: null, targetTransition: null });
    return;
  }
  const block = resolveStatBlock(enemy.statBlockId);
  const atk = (block?.attacks || []).find((a) => a.attackId === intent.attackId) || block?.attacks?.[0];
  const defending = run.player.flags?.defendingUntilRound && combat.turn <= run.player.flags.defendingUntilRound;
  // BLIND — a blinded attacker swings at disadvantage (stacks with defend/disrupt).
  const disadvantage = Boolean(defending) || Boolean(enemy.flags?.disadvantageNextTurn) || statusAttackDisadvantage(enemy);
  // Advantage from a player's failure band OR the chaos-pack aura (scaling-advantage
  // when multiple chaos-touched stand together — verdance bestiary).
  const advantage = Boolean(enemy.flags?.edgeNextTurn) || chaosPackAdvantage(combat, enemy);
  if (enemy.flags) { enemy.flags.disadvantageNextTurn = false; enemy.flags.edgeNextTurn = false; }
  // Net edge/burden cancel (2d20 keep high/low; both → straight roll). Enemy attack
  // vs the player's REAL AC.
  const net = (advantage ? 1 : 0) - (disadvantage ? 1 : 0);
  const rolls = net !== 0 ? [rollD20(options), rollD20(options)] : [rollD20(options)];
  const d20 = net > 0 ? Math.max(...rolls) : net < 0 ? Math.min(...rolls) : rolls[0];
  const crit = d20 === 20;
  const toHit = d20 + (atk?.toHit ?? 0);
  const hit = crit || (d20 !== 1 && toHit >= playerAC(run));
  let damageRecord = null;
  let transition = null;
  let riderApplied = null;
  if (hit && atk) {
    let dmg = Math.max(1, rollDice(atk.damage, { rng: options.rng }).total);
    // DEFEND (A2): a guarding player HALVES the blow that lands (in addition to the
    // to-hit disadvantage above). The tempo cost of guarding is the heavier action
    // weight (actionWeight("defend") = heavy) — damage reduction bought with tempo.
    if (defending) dmg = Math.max(1, Math.ceil(dmg * 0.5));
    // SHIELD (A2.2): a damage-absorb pool on the player soaks the blow before it lands.
    const shielded = absorbWithShield(combat.combatants.player, dmg);
    dmg = shielded.amount;
    if (dmg > 0) {
      const rec = applyDamage(run, dmg, { crit, now: isoNow(options) });
      wakeOnDamage(combat.combatants.player); // SLEEP breaks on any damage
      damageRecord = { amount: rec.amount, type: atk.damageType || "physical", ...(shielded.absorbed ? { absorbed: shielded.absorbed } : {}) };
      transition = rec.dead ? "dead" : rec.dying ? "dying" : rec.downed ? "downed" : "hurt";
      // CHAOS RIDER (inverted-element): the attack carries the WRONG rider (the Grey's
      // chaos_bite → "chill"), applied to the player on hit and compiled to one of the
      // sealed ten (chill → Slow). Suppressed if the blow drops the player.
      if (atk.rider && !rec.dead && !rec.dying) {
        const applied = applyCombatStatus(combat, combat.combatants.player, atk.rider, { worldName: riderLabel(atk.rider), run });
        if (applied) riderApplied = { rider: atk.rider, status: applied.engineStatus };
      }
    } else {
      // Fully absorbed by the shield — a landed blow that did no damage.
      damageRecord = { amount: 0, absorbed: shielded.absorbed, type: atk.damageType || "physical" };
    }
  }
  actions.push({
    actor: enemy.combatantId,
    kind: "attack",
    intentId: intent.intentId,
    roll: { total: toHit, vs: "ac", dc: playerAC(run), hit, crit },
    damage: damageRecord,
    rider: riderApplied,
    targetTransition: transition
  });
}

// Morale: is this enemy injured AND outmatched enough to consider bolting, and does
// the seeded morale roll break it? Returns true if it fled (and commits the flee).
function maybeEnemyFlee(run, combat, enemy, actions, options) {
  const block = resolveStatBlock(enemy.statBlockId);
  const b = block?.behaviors || {};
  const hpFrac = (enemy.hp?.current ?? 0) / (enemy.hp?.max ?? 1);
  const playerHp = getHp(run.player);
  const playerFrac = (playerHp.current ?? 0) / (playerHp.max ?? 1);
  const injured = hpFrac <= 0.34; // bloodied and then some
  const outmatched = playerFrac >= 0.5; // the player is still strong
  if (!injured || !outmatched) return false;
  // Flee is a deliberate creature trait, not the default: only a COWARDLY creature or
  // one the block marks INJURED (a wounded animal — the limping Grey) will break. A
  // plain enforcer (the waylayer: not vicious, not cowardly) fights to the end.
  const willConsider = b.cowardly === true || b.injured === true;
  if (!willConsider) return false;
  // Luck-confined flee check: deterministic per seed+turn; the lower the HP, the more
  // likely to break. (Fortune's verb — never touches the queue/tempo.)
  const roll = hashSeed(`${run.worldSeed || run.runId}|flee|${combat.combatId}|${enemy.combatantId}|${combat.turn}`) % 100;
  const breakChance = Math.round((1 - hpFrac) * 70) + (b.cowardly ? 20 : 0); // ≤ ~90%
  if (roll >= breakChance) return false;

  enemy.fled = true;
  enemy.morale = "broken";
  const npc = run.npcs?.[enemy.npcId];
  if (npc) { npc.flags = { ...(npc.flags || {}), fled: true, hostile: true, defeated: false }; npc.status = "active"; }
  actions.push({ actor: enemy.combatantId, kind: "flee", roll: { chance: breakChance, hit: true }, damage: null, targetTransition: "fled" });
  return true;
}

// Chaos-pack aura: the "scaling-advantage" skill grants edge when 2+ chaos-touched
// share the field. In v1's 1-v-1 Limping Grey fight it never triggers (data-honest).
function chaosPackAdvantage(combat, enemy) {
  const block = resolveStatBlock(enemy.statBlockId);
  const hasAura = (block?.carriedSkills || []).some((s) => s.skillId === "chaos-pack-aura");
  if (!hasAura) return false;
  const chaoslings = livingEnemies(combat).filter((c) => resolveStatBlock(c.statBlockId)?.kind === "chaosling");
  return chaoslings.length >= 2;
}

// ── HIGH-TIER CHAOS SKILLS (A3.4) ───────────────────────────────────────────────
export function enemyHasSkill(combatant, skillId) {
  const block = resolveStatBlock(combatant?.statBlockId);
  return (block?.carriedSkills || []).some((s) => s.skillId === skillId);
}
function playerWisMod(run) { return Math.floor(((run.player?.abilities?.wisdom ?? 10) - 10) / 2); }

// Active skill resolution. CHARM-PERSON is a contested read (enemy tier vs the player's
// WIS): on the enemy's win the player is CHARMED → CONFUSE (their next action may
// misdirect). Locked upstream by SILENCE; the read is counterable by the player's FOCUS.
function resolveEnemySkill(run, combat, enemy, intent, actions, options) {
  const skillId = intent.skillId;
  if (skillId === "charm-person") {
    const block = resolveStatBlock(enemy.statBlockId);
    const total = rollD20(options) + (block?.tier || 2);
    const dc = 10 + playerWisMod(run);
    const success = total >= dc;
    if (success) applyCombatStatus(combat, combat.combatants.player, "confuse", { worldName: "Charmed", run });
    actions.push({ actor: enemy.combatantId, kind: "skill", intentId: intent.intentId, skillId, roll: { total, vs: "dc", dc, hit: success }, damage: null, targetTransition: null });
    return;
  }
  actions.push({ actor: enemy.combatantId, kind: "skill", intentId: intent.intentId, skillId, roll: null, damage: null, targetTransition: null });
}

// VISION-SHARE (pack passive): a foe carrying it shares sight — hidden pack-mates are
// REVEALED — and, when 2+ stand together, shares advantage + tempo (HASTE). This is
// where the haste applier is wired. Idempotent per turn (haste re-applies only when off).
export function applyPackVisionShare(combat) {
  const enemies = livingEnemies(combat);
  if (!enemies.some((e) => enemyHasSkill(e, "vision-share"))) return;
  for (const e of enemies) {
    e.revealed = true;
    if (enemies.length > 1) {
      e.flags = { ...(e.flags || {}), edgeNextTurn: true };
      if (!e.ctb?.haste) applyCombatStatus(combat, e, "haste", { turns: 2 });
    }
  }
}

function riderLabel(rider) {
  const s = String(rider || "");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
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
  combat.endedAtTurn = combat.turn;
  // The fight burned game-time: advance the world clock by the turns spent (6s each),
  // the lawful post-combat clock hook (worldClock.advanceCombatRounds).
  advanceCombatRounds(run, combat.turn || 1, { now });

  // Canonical fact — stable, keyword-bearing text the thread engine reads. Enemy
  // display names carry the meaningful noun (e.g. "collector"), so an onCanon
  // trigger matches without any new plumbing.
  const factId = `fact_combat_${combat.combatId}`;
  const nameList = enemyNames.join(", ");
  // An enemy that broke and fled COMMITS as fled (the world remembers — a thread-seed
  // hook for a later re-encounter): it is alive, gone from the field, not a corpse.
  const escaped = Object.values(combat.combatants).filter((c) => c.kind === "enemy" && c.fled === true);
  const killedList = defeated.map((c) => c.name).join(", ");
  const escapedList = escaped.map((c) => c.name).join(", ");
  const text =
    status === "won" && defeated.length && escaped.length ? `You put down ${killedList} at ${locName}; ${escapedList} broke and fled, still out there.`
    : status === "won" && escaped.length ? `${escapedList} broke and fled the field at ${locName}; still out there, and it will remember.`
    : status === "won" ? `You put down ${killedList || nameList} at ${locName}. ${killedList || nameList} is dead.`
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
