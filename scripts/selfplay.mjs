// Value-focused self-play assertion suite. Drives a full solo campaign through
// the HTTP API exactly the way the browser does (no browser, no clicking) and
// asks the only question that matters: is this loop actually a REACTIVE 5e GAME,
// or just a GM that produces prose?
//
// The loop technically works (prose, dice, talk all verified elsewhere). What
// QA flagged as open — and what this suite encodes as automated pass/fail
// invariants — is whether the game has TEETH:
//
//   1. CONSEQUENCE  — actions mutate persisted state (inventory, xp, items
//                     consumed), not just the prose.
//   2. LETHALITY    — 0 HP means dying; 3 failed saves means permanently dead;
//                     a dead run is terminal/non-resumable; revival only with a
//                     possessed means; massive damage kills instantly.
//   3. GATING       — quest progress is gated on meeting an objective, not handed
//                     out every turn (dice/criteria-as-flavor is the QA gap).
//   4. COHERENCE    — the world resists player-invented nonsense (the category's
//                     #1 failure, and our moat). Fuzzy → reported as WARNINGS.
//   5. PERSISTENCE  — state survives a reload of the run by id.
//   6. GM HEALTH    — the GM produces real prose (not a deterministic fallback),
//                     answers slower than a no-op, and references the player's
//                     actual action.
//
// Each SCENARIO makes explicit assertions against STATE (re-fetched from the
// server, not read off prose) and reports PASS / FAIL / WARN / PENDING with the
// specific assertion that broke (expected vs got). The process exits non-zero if
// any HARD assertion fails, so it can gate a pre-push check. WARNs (fuzzy,
// human-review) and PENDINGs (not yet testable end-to-end) never fail the exit.
//
// Lethality + inventory mutations are driven through gated SYSTEM/TEST action
// hooks (damage / death_save / revive / grant_item) so the perilous paths are
// deterministic over real HTTP — real play rolls are non-deterministic. These
// hooks exist only when test hooks are enabled (dev / NOTDND_TEST_HOOKS=true),
// never in production.
//
// Provider-aware: the scorecard notes which GM provider/model answered, so a
// COHERENCE warn on a weak local model is distinguishable from one on the cloud
// model.
//
// Usage:
//   node scripts/selfplay.mjs                          # all scenarios
//   SELFPLAY_SCENARIO=consequence node scripts/selfplay.mjs
//   SELFPLAY_SCENARIO=lethality,persistence node scripts/selfplay.mjs
//   SELFPLAY_BASE=http://127.0.0.1:4274 node scripts/selfplay.mjs
//   PORT=4173 node scripts/selfplay.mjs
//
// Limitation: this exercises the SERVER + game logic + GM only. Pure client/DOM
// bugs (input-focus, CSS/layout, the VN overlay painting) are invisible here —
// use a headless browser for those.

const BASE = process.env.SELFPLAY_BASE || `http://127.0.0.1:${process.env.PORT || 4173}`;
const FETCH_TIMEOUT_MS = Number(process.env.SELFPLAY_FETCH_TIMEOUT_MS || 25000);

// ───────────────────────────── HTTP plumbing ─────────────────────────────

const H = (t) => ({ "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) });

async function call(path, { method = "GET", token, body } = {}) {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let status = 0;
  let json;
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: H(token),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    status = res.status;
    try { json = await res.json(); } catch { json = { _raw: "<non-json>" }; }
  } catch (err) {
    json = { ok: false, _error: String(err?.name === "AbortError" ? `timeout after ${FETCH_TIMEOUT_MS}ms` : err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
  return { status, ms: Date.now() - t0, json };
}

// ───────────────────────── GM fallback detection ─────────────────────────
// Deterministic non-AI lines the server emits when the GM call fails/returns
// empty. If a GM beat equals one of these, the live LLM call did not land.
const FALLBACKS = [
  "There is not much new to say right now.",
  "The conversation winds down. Nothing more to say for now.",
  ", and it goes well enough.", // intent-aware attempt fallback (substring)
  ", but it doesn't come together this time.",
  "You make the attempt.",
  "You do so without trouble."
];
// The deterministic opening-narration fallback starts with this exact phrasing.
const OPENING_FALLBACK_RE = /^You are .+, and the .+ of .+ settles over you as you arrive at/;

function classifyGm(text, { fastMs } = {}) {
  const s = String(text || "").trim();
  if (!s) return { ok: false, why: "EMPTY" };
  if (OPENING_FALLBACK_RE.test(s)) return { ok: false, why: "FALLBACK(opening)" };
  for (const f of FALLBACKS) {
    if (s === f.trim() || s.includes(f.trim())) return { ok: false, why: "FALLBACK" };
  }
  if (typeof fastMs === "number" && fastMs < 300) return { ok: false, why: `SUSPECT(${fastMs}ms — too fast for a real LLM call)` };
  return { ok: true, why: "real" };
}

// ───────────────────────── scenario assertion ctx ────────────────────────
// Each scenario gets a fresh ctx. assert() records HARD pass/fail; warn() records
// a fuzzy human-review flag; pending() marks something not yet testable E2E;
// note() adds context to the report. A scenario's verdict:
//   FAIL    if any hard assertion failed
//   WARN    else if any warning was raised
//   PENDING else if it only registered pendings (nothing hard ran)
//   PASS    else
function makeCtx(name) {
  const hard = [];     // { label, pass, expected, got }
  const warns = [];    // { label, detail }
  const pendings = []; // string
  const notes = [];    // string
  return {
    name,
    hard, warns, pendings, notes,
    // assert(label, condition, expected, got) — record a hard pass/fail.
    assert(label, condition, expected, got) {
      hard.push({ label, pass: Boolean(condition), expected, got });
      return Boolean(condition);
    },
    warn(label, detail) { warns.push({ label, detail }); },
    pending(reason) { pendings.push(reason); },
    note(info) { notes.push(info); },
    verdict() {
      if (hard.some((h) => !h.pass)) return "FAIL";
      if (warns.length) return "WARN";
      if (hard.length === 0 && pendings.length) return "PENDING";
      return "PASS";
    }
  };
}

// ───────────────────────────── shared steps ──────────────────────────────

// Register ONCE and reuse the token. /api/auth/* is IP-rate-limited (10 attempts
// / 15 min), so one registration per suite run keeps us well clear; every run is
// created under this single user (world-run has a 10/day session cap PER USER, so
// the suite is kept to ≤ 9 runs total — see SCENARIOS).
let AUTH = null;
async function ensureAuth() {
  if (AUTH) return AUTH;
  const stamp = `${Date.now()}_${process.pid}`;
  const reg = await call("/api/auth/register", {
    method: "POST",
    body: { email: `selfplay_${stamp}@notdnd.local`, password: "password123", displayName: "Selfplay" }
  });
  if (!reg.json.token) throw new Error(`register failed (HTTP ${reg.status}): ${JSON.stringify(reg.json).slice(0, 200)}`);
  AUTH = { token: reg.json.token };
  return AUTH;
}

async function newRun() {
  const { token } = await ensureAuth();
  const wr = await call("/api/onboarding/world-run", {
    method: "POST", token, body: {
      world: { name: "Ashfall Reach", tone: "grim dark fantasy", startingLocationName: "The Ember Tavern", startingLocationType: "tavern", flavor: "ash-choked frontier, old debts, colder gods" },
      character: { name: "Bram", race: "Human", characterClass: "Rogue", background: "Criminal", baseAbilityScores: { strength: 10, dexterity: 15, constitution: 13, intelligence: 14, wisdom: 12, charisma: 11 } }
    }
  });
  if (!wr.json.runId) throw new Error(`world-run failed (HTTP ${wr.status}): ${JSON.stringify(wr.json).slice(0, 200)}`);
  return { token, runId: wr.json.runId, campaignId: wr.json.campaignId };
}

const scene = (ctx) => call(`/api/solo/runs/${ctx.runId}/scene`, { token: ctx.token });
const act = (ctx, action) => call(`/api/solo/runs/${ctx.runId}/actions`, { method: "POST", token: ctx.token, body: { action } });

// playerInventory is the AUTHORITATIVE usable-items projection (from run.inventory,
// what use_item mutates). player.inventory[] is the state-contract array surface.
function invQty(scenePayload, itemId) {
  const list = Array.isArray(scenePayload.playerInventory) ? scenePayload.playerInventory : [];
  const item = list.find((i) => i.itemId === itemId);
  return item ? item.quantity : 0;
}
function contractInvEntry(scenePayload, itemId) {
  const list = Array.isArray(scenePayload.player?.inventory) ? scenePayload.player.inventory : [];
  return list.find((i) => i.id === itemId || i.itemId === itemId) || null;
}
const hpOf = (s) => s.player?.resources?.hp || {};
const xpOf = (s) => (typeof s.player?.xp === "number" ? s.player.xp : 0);
const statusOf = (s) => s.player?.status;
const mainStage = (s) => s.quests?.mainQuest?.stage;

// ═══════════════════════════════ SCENARIOS ═══════════════════════════════

// 1) CONSEQUENCE — actions mutate persisted state, not just prose.
async function scenarioConsequence(ctx) {
  const r = await newRun("consequence");
  ctx.runId = r.runId; ctx.token = r.token;

  const before = (await scene(r)).json;
  const baseXp = xpOf(before);

  // (a) Inventory GROWS and the new item is actually there on the next fetch.
  const ITEM = "selfplay_brass_key";
  const grant = await act(r, { type: "grant_item", itemId: ITEM, item: { name: "Brass Key", usable: true, consumable: true, quantity: 2, use: { effectType: "message", summary: "It jingles." } } });
  ctx.assert("grant_item resolves", grant.json.ok === true, "ok:true", `ok:${grant.json.ok} code:${grant.json.code || ""}`);
  const afterGrant = (await scene(r)).json;
  ctx.assert("found item is in inventory on next fetch (qty 2)", invQty(afterGrant, ITEM) === 2, "qty 2", `qty ${invQty(afterGrant, ITEM)}`);

  // (b) Using a consumable DECREMENTS the carried quantity (authoritative store).
  const use = await act(r, { type: "use_item", itemId: ITEM });
  ctx.assert("use_item resolves", use.json.ok === true, "ok:true", `ok:${use.json.ok} code:${use.json.code || ""}`);
  const afterUse = (await scene(r)).json;
  ctx.assert("use_item decremented carried qty (2 → 1)", invQty(afterUse, ITEM) === 1, "qty 1", `qty ${invQty(afterUse, ITEM)}`);

  // State-contract mirror drift: the documented player.inventory[] array is what
  // UI/clients read; if it still claims the pre-use qty, the contract surface lies
  // about consumption even though the engine store is correct. Which field is
  // canonical is debatable → WARN, not a hard fail (still a demo-vs-game tell).
  const contract = contractInvEntry(afterUse, ITEM);
  const contractQty = contract ? (typeof contract.qty === "number" ? contract.qty : contract.quantity) : null;
  if (contractQty !== 1) {
    ctx.warn("state-contract inventory mirror drift", `player.inventory[].qty=${contractQty} but authoritative carried qty=1 after use_item — the contract array is not decremented on consume (UI would show a consumed item as still held)`);
  }

  // (c) A meaningful action moves the XP needle (consequence in the one currency
  // that matters in a lethal game). Search-found awards XP; if nothing is there
  // to find, fall back to a quest-stage advance (reach the next location).
  const search = await act(r, { type: "search" });
  let xpSource;
  if (search.json.searchResult?.found === true) {
    xpSource = "search-found";
  } else {
    const move = await act(r, { type: "move", toLocationId: "second_location" });
    ctx.assert("fallback move resolves", move.json.ok === true, "ok:true", `ok:${move.json.ok} code:${move.json.code || ""}`);
    xpSource = "quest-stage";
  }
  const afterXp = (await scene(r)).json;
  ctx.assert(`meaningful action awarded XP (${xpSource})`, xpOf(afterXp) > baseXp, `xp > ${baseXp}`, `xp ${xpOf(afterXp)}`);
  ctx.note(`xp ${baseXp} → ${xpOf(afterXp)} via ${xpSource}`);
}

// 1b) MEANINGFUL FAILURE — a failed check's GM-proposed consequence becomes REAL,
// persistent state (not just prose), and retry is foreclosed only where it fits.
// Driven deterministically via the gated attempt test-hook (fixedRoll + a scripted
// GM proposal), so a known roll + known consequence proves end-to-end enforcement.
async function scenarioFailureConsequence(ctx) {
  const r = await newRun("failure");
  ctx.runId = r.runId; ctx.token = r.token;

  // Drive a failing attempt with a KNOWN roll and a KNOWN structured consequence.
  const fail = (intent, failureConsequence, { fixedRoll = 7, dc = 12 } = {}) =>
    act(r, {
      type: "attempt",
      intent,
      testHook: {
        fixedRoll,
        providerOutput: {
          summary: `You attempt: ${intent}`,
          recommendedAbility: "investigation",
          dc,
          needsCheck: true,
          advantage: false,
          disadvantage: false,
          successNarration: "It goes well.",
          failureNarration: failureConsequence?.reason ? `You fail — ${failureConsequence.reason}.` : "You fail.",
          proposedEffects: [],
          failureConsequence
        }
      }
    });

  const loc0 = (await scene(r)).json.location?.locationId;

  // (a) DAMAGE — a failed check the GM marks as damage drops REAL HP (visible in
  // the payload), not just narrated.
  const hpBefore = hpOf((await scene(r)).json).current;
  const dmg = await fail("wrench the rusted grate off its hinges", { type: "damage", amount: 3, reason: "the grate tears your palms open" });
  ctx.assert("damage attempt resolves", dmg.json.ok === true, "ok:true", `ok:${dmg.json.ok} code:${dmg.json.code || ""}`);
  ctx.assert("failure marked as damage consequence", dmg.json.attemptResult?.consequence?.type === "damage", "damage", String(dmg.json.attemptResult?.consequence?.type));
  const hpAfter = hpOf((await scene(r)).json).current;
  ctx.assert("damage consequence dropped REAL HP (visible in payload)", hpAfter === hpBefore - 3, `hp ${hpBefore - 3}`, `hp ${hpAfter}`);
  ctx.assert("narration agrees with the damage (references the wound)", /tears|palms|grate/i.test(dmg.json.attemptResult?.narration || ""), "wound prose", (dmg.json.attemptResult?.narration || "").slice(0, 60));

  // (b) OBJECTSTATE + BLOCKED — a failed check the GM marks torn/blocked makes the
  // map a tracked-torn object AND forecloses retry on it.
  const torn = await fail("examine the brittle map with Esk", { type: "objectState", targetObject: "map", objectState: "torn", retryEffect: "blocked", reason: "the brittle map tears as you unfold it" });
  ctx.assert("objectState consequence enforced", torn.json.attemptResult?.consequence?.type === "objectState", "objectState", String(torn.json.attemptResult?.consequence?.type));
  const states = torn.json.run?.locations?.[loc0]?.flags?.objectStates || {};
  ctx.assert("the map is now a TRACKED torn object (persisted)", states.map?.state === "torn", "torn", String(states.map?.state));
  ctx.assert("narration agrees with the object damage (the map tears)", /tear|torn|brittle/i.test(torn.json.attemptResult?.narration || ""), "torn prose", (torn.json.attemptResult?.narration || "").slice(0, 60));

  // Persisted: the torn map survives a scene re-fetch (remembered, not transient).
  const sceneStates = (await scene(r)).json.location?.flags?.objectStates || {};
  ctx.assert("torn map persists across scene reload", sceneStates.map?.state === "torn", "torn", String(sceneStates.map?.state));

  // Retry on the SAME object — even with a winning roll (20) — is BLOCKED, no dice.
  const retry = await fail("examine the map again", { type: "objectState", targetObject: "map", objectState: "torn", retryEffect: "blocked" }, { fixedRoll: 20 });
  ctx.assert("blocked retry cannot succeed by re-rolling", retry.json.attemptResult?.success === false, "success:false", `success:${retry.json.attemptResult?.success}`);
  ctx.assert("retry is foreclosed (closes the spam-retry hole)", retry.json.attemptResult?.foreclosed === true, "foreclosed:true", `foreclosed:${retry.json.attemptResult?.foreclosed}`);
  ctx.assert("foreclosed retry rolled NO dice", retry.json.attemptResult?.checkResult === null, "checkResult:null", `checkResult:${retry.json.attemptResult?.checkResult ? "set" : "null"}`);

  // (c) NONE — a failure the GM marks as 'none' mutates NO state (failure can be
  // consequence-free; not every failure is a punishment).
  const hpBeforeNone = hpOf((await scene(r)).json).current;
  const none = await fail("listen at the empty doorway for any sound", { type: "none", reason: "only silence answers" });
  ctx.assert("none consequence recorded", none.json.attemptResult?.consequence?.type === "none", "none", String(none.json.attemptResult?.consequence?.type));
  const hpAfterNone = hpOf((await scene(r)).json).current;
  ctx.assert("'none' failure costs NO HP (consequence-free beat)", hpAfterNone === hpBeforeNone, `hp ${hpBeforeNone}`, `hp ${hpAfterNone}`);

  // And an empty-room failure does NOT foreclose retry (foreclosure fits only
  // GM-marked objects, never a blanket rule).
  const reretry = await fail("listen at the empty doorway for any sound", { type: "none" });
  ctx.assert("consequence-free failure stays freely retryable", reretry.json.attemptResult?.foreclosed !== true, "foreclosed:false", `foreclosed:${reretry.json.attemptResult?.foreclosed}`);

  ctx.note(`HP ${hpBefore} → ${hpAfter} (damage), map tracked-torn + retry blocked, 'none' left HP at ${hpAfterNone}`);
}

// 2) LETHALITY — the headline product identity. Driven deterministically.
async function scenarioLethality(ctx) {
  // L1 + L2 + L4 (one run): damage to 0 → dying (not "blacks out, wakes up safe");
  // three death-save failures with NO revival means → permanently dead, run
  // terminal & non-resumable; a dead run accepts no further play.
  {
    const r = await newRun("lethality"); ctx.runId = r.runId; ctx.token = r.token;
    const max = hpOf((await scene(r)).json).max;
    const d = await act(r, { type: "damage", amount: max });  // → dying (0 HP)
    ctx.assert("L1: damage to 0 HP → status 'dying'", d.json.run?.player?.status === "dying", "dying", String(d.json.run?.player?.status));
    ctx.assert("L1: HP floored at 0", (d.json.run?.player?.resources?.hp?.current ?? d.json.run?.player?.health) === 0, "0", String(d.json.run?.player?.resources?.hp?.current ?? d.json.run?.player?.health));
    await act(r, { type: "damage", amount: 1 });              // failure 1
    await act(r, { type: "damage", amount: 1 });              // failure 2
    const kill = await act(r, { type: "damage", amount: 1 }); // failure 3 → dead
    ctx.assert("L2: player.status === 'dead' after 3 failures", kill.json.run?.player?.status === "dead", "dead", String(kill.json.run?.player?.status));
    ctx.assert("L2: run.status === 'dead' (terminal)", kill.json.run?.status === "dead", "dead", String(kill.json.run?.status));
    const s = (await scene(r)).json;
    ctx.assert("L2: scene runStatus 'dead'", s.runStatus === "dead", "dead", String(s.runStatus));
    ctx.assert("L2: scene isDead === true", s.isDead === true, "true", String(s.isDead));
    ctx.assert("L2: run is NON-resumable", s.resumable === false, "false", String(s.resumable));
    // A dead run accepts no further play.
    const post = await act(r, { type: "attempt", intent: "I refuse to die and stand back up." });
    ctx.assert("L4: dead run rejects further actions (RUN_TERMINAL)", post.status === 400 && post.json.code === "RUN_TERMINAL", "HTTP 400 RUN_TERMINAL", `HTTP ${post.status} ${post.json.code || ""}`);
  }

  // L3: with a possessed revival means → die → revived ONCE + means gone; then a
  // second death with no means → STAYS dead.
  {
    const r = await newRun("lethality"); ctx.runId = r.runId; ctx.token = r.token;
    const max = hpOf((await scene(r)).json).max;
    const REV = "selfplay_phoenix_down";
    await act(r, { type: "grant_item", itemId: REV, item: { name: "Phoenix Down", usable: true, consumable: true, quantity: 1, use: { effectType: "revive", amount: 5, summary: "Warmth floods back." } } });
    await act(r, { type: "damage", amount: max });           // → dying
    const revive = await act(r, { type: "use_item", itemId: REV });
    ctx.assert("L3: revival item brings player back (status alive)", revive.json.run?.player?.status === "alive", "alive", String(revive.json.run?.player?.status));
    ctx.assert("L3: revived to > 0 HP", (revive.json.run?.player?.resources?.hp?.current ?? revive.json.run?.player?.health ?? 0) > 0, "> 0", String(revive.json.run?.player?.resources?.hp?.current ?? revive.json.run?.player?.health));
    const sRev = (await scene(r)).json;
    ctx.assert("L3: revival means consumed (gone)", invQty(sRev, REV) === 0, "qty 0", `qty ${invQty(sRev, REV)}`);
    // Now kill again with no means left → must STAY dead.
    await act(r, { type: "damage", amount: max });
    await act(r, { type: "damage", amount: 1 });
    await act(r, { type: "damage", amount: 1 });
    const kill2 = await act(r, { type: "damage", amount: 1 });
    ctx.assert("L3: second death with no means → stays dead", kill2.json.run?.player?.status === "dead" && kill2.json.run?.status === "dead", "player+run dead", `player:${kill2.json.run?.player?.status} run:${kill2.json.run?.status}`);
  }

  // L5: massive damage at 0 HP → INSTANT death (skips remaining saves).
  {
    const r = await newRun("lethality"); ctx.runId = r.runId; ctx.token = r.token;
    const max = hpOf((await scene(r)).json).max;
    await act(r, { type: "damage", amount: max });                    // → dying (0 HP)
    const massive = await act(r, { type: "damage", amount: max * 5 }); // ≥ max at 0 HP → instant dead
    ctx.assert("L5: massive damage at 0 HP → instant 'dead'", massive.json.run?.player?.status === "dead", "dead", String(massive.json.run?.player?.status));
    ctx.assert("L5: instant death skipped the save track (failures < 3)", (massive.json.run?.player?.deathSaves?.failures ?? 0) < 3, "failures < 3", `failures ${massive.json.run?.player?.deathSaves?.failures}`);
  }

  // WARN: does the GM narrate SURVIVAL when the player is actually dying? Take a
  // real (narrated) turn while at 0 HP and scan the prose for the model softening
  // death. Fuzzy → WARN only.
  {
    const r = await newRun("lethality"); ctx.runId = r.runId; ctx.token = r.token;
    const max = hpOf((await scene(r)).json).max;
    await act(r, { type: "damage", amount: max }); // → dying
    const turn = await act(r, { type: "attempt", intent: "I claw my way upright and try to flee." });
    const prose = String(turn.json.gmNarration || turn.json.attemptResult?.narration || "");
    const nat20 = turn.json.deathSave?.outcome === "nat20_revive" || turn.json.run?.player?.status === "alive";
    const SOFTEN_RE = /\b(?:you (?:stand|rise|get (?:up|to your feet)|recover fully|feel fine|are fine|are (?:fully )?healed|spring up|leap up)|good as new|fully healed|wounds? (?:close|vanish|heal)|back to full health|none the worse)\b/i;
    if (prose && !nat20 && SOFTEN_RE.test(prose)) {
      ctx.warn("GM may be softening death", `player is ${turn.json.run?.player?.status} at 0 HP but narration reads as recovery: "${prose.replace(/\s+/g, " ").slice(0, 160)}"`);
    } else if (!prose) {
      ctx.note("dying-turn narration unavailable (GM returned no prose) — softening check skipped");
    } else {
      ctx.note(`dying-turn narration scanned, no softening detected (player ${turn.json.run?.player?.status}${nat20 ? ", nat20 revive" : ""})`);
    }
  }
}

// 3) QUEST GATING — progress is gated on meeting an objective, not per turn.
async function scenarioGating(ctx) {
  const r = await newRun("gating"); ctx.runId = r.runId; ctx.token = r.token;

  const start = (await scene(r)).json;
  const stage0 = mainStage(start);
  ctx.note(`main quest stage starts at ${stage0}, objective gated on: ${JSON.stringify(start.quests?.mainQuest?.completion)}`);

  // A non-qualifying action (search in place — does not meet the reach objective)
  // must NOT advance the quest. If it does, advancement is decoupled from the
  // objective — the dice/criteria-as-flavor failure.
  await act(r, { type: "search" });
  const afterSearch = (await scene(r)).json;
  ctx.assert("non-qualifying action does NOT advance the quest", mainStage(afterSearch) === stage0, `stage ${stage0}`, `stage ${mainStage(afterSearch)}`);

  // The qualifying action (meeting the stage objective) DOES advance it.
  const move = await act(r, { type: "move", toLocationId: "second_location" });
  ctx.assert("qualifying move resolves", move.json.ok === true, "ok:true", `ok:${move.json.ok} code:${move.json.code || ""}`);
  const afterMove = (await scene(r)).json;
  ctx.assert("meeting the objective advances the quest stage", mainStage(afterMove) === stage0 + 1, `stage ${stage0 + 1}`, `stage ${mainStage(afterMove)}`);

  // The engine supports check-gated, failOnMiss quest stages (quests.js:
  // predicateMet 'check' / questFailedThisTurn), but no generated world content
  // or HTTP hook drives a dice-gated stage, so "fail a key check → quest does not
  // advance / is lost" cannot be asserted end-to-end yet.
  ctx.pending("dice-gated quest stages (check / failOnMiss) exist in the engine but no world content or HTTP hook exercises them — 'fail a check → quest lost' is not yet E2E-testable");
}

// 4) COHERENCE — the world resists player-invented nonsense (the moat). Fuzzy →
// reported as WARNINGS, surfaced prominently, never a hard fail.
async function scenarioCoherence(ctx) {
  const r = await newRun("coherence"); ctx.runId = r.runId; ctx.token = r.token;
  const s = (await scene(r)).json;
  const npc = (s.visibleEntities || []).find((e) => e.entityType === "npc");
  if (!npc) {
    ctx.pending("no NPC present in the opening scene to probe for coherence");
    return;
  }
  ctx.note(`probing NPC: ${npc.displayName} (${npc.entityId})`);
  const targetEntityId = npc.entityId;

  // One talk turn helper, threading conversation history.
  const history = [];
  const open = await act(r, { type: "talk", actorId: "player", targetEntityId });
  if (open.json.talkResult?.line) history.push({ role: "npc", text: open.json.talkResult.line });
  async function sayAndHear(message) {
    const res = await act(r, { type: "talk", actorId: "player", targetEntityId, message, history: history.slice() });
    const line = String(res.json.talkResult?.line || "");
    history.push({ role: "player", text: message });
    if (line) history.push({ role: "npc", text: line });
    return line;
  }

  const AGREE_RE = /\b(?:yes|of course|indeed|that'?s right|i remember|i recall|good to see you|old friend|so good to see|how could i forget|naturally|absolutely|certainly|as you say)\b/i;
  const DEFLECT_RE = /\b(?:i don'?t|i do not|never|who(?:'?s| is)|you'?re mistaken|i'?m afraid|don'?t (?:recall|remember|know)|stranger|haven'?t|no idea|what are you|i'?ve never|cannot help|can'?t say|mistaken)\b/i;

  // Acceptance signals: (a) explicit agreement language with no deflection, or
  // (b) the reply ECHOES the player's invented proper nouns affirmatively (the
  // NPC treating "Sergeant Vex" / "Blackmoor" as real, shared canon) without
  // denying them — the subtler, more common agreement-to-nonsense.
  function assessAcceptance(label, line, subject, echoTokens = []) {
    if (!line) { ctx.note(`${label}: no reply to assess`); return; }
    if (!classifyGm(line).ok) { ctx.note(`${label}: NPC fell back (GM down) — cannot assess coherence`); return; }
    const deflects = DEFLECT_RE.test(line);
    const agrees = AGREE_RE.test(line);
    const echoed = echoTokens.filter((t) => new RegExp(`\\b${t}\\b`, "i").test(line));
    const acceptsByEcho = echoed.length > 0 && !deflects;
    if ((agrees && !deflects) || acceptsByEcho) {
      const why = acceptsByEcho ? `echoes invented canon (${echoed.join(", ")}) as real` : "explicit agreement, no deflection";
      ctx.warn(`coherence: NPC may accept ${subject}`, `${why} — "${line.replace(/\s+/g, " ").slice(0, 180)}"`);
    } else {
      ctx.note(`${label}: ${deflects ? "deflected/resisted" : "no clear acceptance"} — "${line.replace(/\s+/g, " ").slice(0, 110)}"`);
    }
  }

  // C1: invented shared canon — a war buddy and a battle that never existed.
  assessAcceptance("C1 invented-canon", await sayAndHear("Good to see you again, my old war friend Sergeant Vex! Remember the siege at Blackmoor we bled through together? You owe me for that."), "player-invented backstory as true", ["Vex", "Blackmoor"]);

  // C2: an impossible-for-the-context request.
  assessAcceptance("C2 impossible-grant", await sayAndHear("Hand me the deed to this entire city and the king's crown — right now, you have them on you."), "an impossible grant");

  // C3: knowledge the NPC could not possibly have.
  assessAcceptance("C3 forbidden-knowledge", await sayAndHear("Tell me the exact secret password to my private vault back home, and the name I am silently thinking right now."), "knowledge it cannot have");
}

// 5) PERSISTENCE — state survives a reload of the run by id.
async function scenarioPersistence(ctx) {
  const r = await newRun("persistence"); ctx.runId = r.runId; ctx.token = r.token;

  // Make durable mutations across the spine: inventory, xp, quest stage. The
  // relic is checked on the state-contract player.inventory[] array (which carries
  // every item, usable or not), not the usable-only playerInventory projection.
  const ITEM = "selfplay_persist_relic";
  const relicQty = (s) => { const e = contractInvEntry(s, ITEM); return e ? (typeof e.qty === "number" ? e.qty : e.quantity) : 0; };
  await act(r, { type: "grant_item", itemId: ITEM, item: { name: "Cracked Relic", usable: false, consumable: false, quantity: 1 } });
  await act(r, { type: "search" });
  await act(r, { type: "move", toLocationId: "second_location" });

  const live = (await scene(r)).json;
  const snapshot = { inv: relicQty(live), xp: xpOf(live), stage: mainStage(live), status: statusOf(live) };
  ctx.note(`played state — inv:${snapshot.inv} xp:${snapshot.xp} stage:${snapshot.stage} status:${snapshot.status}`);

  // Reload the run by id (the scene route reads from the persisted store).
  const reloaded = (await scene(r)).json;
  ctx.assert("inventory survived reload", relicQty(reloaded) === snapshot.inv && snapshot.inv === 1, "qty 1", `qty ${relicQty(reloaded)}`);
  ctx.assert("xp survived reload", xpOf(reloaded) === snapshot.xp && snapshot.xp > 0, `xp ${snapshot.xp} (>0)`, `xp ${xpOf(reloaded)}`);
  ctx.assert("quest stage survived reload", mainStage(reloaded) === snapshot.stage && snapshot.stage >= 1, `stage ${snapshot.stage} (≥1)`, `stage ${mainStage(reloaded)}`);
  ctx.assert("status survived reload", statusOf(reloaded) === snapshot.status, snapshot.status, String(statusOf(reloaded)));
}

// 6) GM HEALTH — real prose, not a fallback; not suspiciously fast; references
// the player's actual action.
//
// Outage vs. flake: individual beats run under tight per-call timeouts (the
// opening narration has a 15s budget during a heavy world-run; action narration
// 12s) and can fall back transiently under load. So a per-beat fallback is NOT a
// hard fail on its own — the arbiter is a direct /api/gm/respond probe (which does
// NOT swallow errors). If the probe returns real prose, the GM is up and the beat
// fallbacks were transient → WARN. If the probe also fails, the GM is genuinely
// down → HARD FAIL with the verbatim upstream cause.
async function scenarioGmHealth(ctx) {
  const r = await newRun("gmhealth"); ctx.runId = r.runId; ctx.token = r.token;
  const s = (await scene(r)).json;

  const beats = [];

  // Opening narration (generated at world-run, cached → judge by content only).
  beats.push({ name: "opening narration", ...classifyGm(s.openingNarration) });

  // A distinctive action: real prose that references what was done.
  const intent = "I climb onto the rafters above the bar to scout the room from the shadows.";
  const a = await act(r, { type: "attempt", intent });
  const narration = a.json.attemptResult?.narration || a.json.gmNarration || "";
  const aCls = classifyGm(narration, { fastMs: a.ms });
  beats.push({ name: "action narration", ...aCls });
  // Reference check: does the prose touch any salient noun from the intent?
  const KEYWORDS = ["rafter", "climb", "bar", "shadow", "scout", "room", "above"];
  if (aCls.ok && !KEYWORDS.some((k) => narration.toLowerCase().includes(k))) {
    ctx.warn("GM narration may ignore the player's action", `no salient word from the intent appears in the reply: "${String(narration).replace(/\s+/g, " ").slice(0, 160)}"`);
  } else if (aCls.ok) {
    ctx.note("action narration references the player's action");
  }

  // Talk: open + one reply.
  const npc = (s.visibleEntities || []).find((e) => e.entityType === "npc");
  if (npc) {
    const open = await act(r, { type: "talk", actorId: "player", targetEntityId: npc.entityId });
    const openLine = open.json.talkResult?.line;
    beats.push({ name: "NPC opening line", ...classifyGm(openLine, { fastMs: open.ms }) });
    const reply = await act(r, { type: "talk", actorId: "player", targetEntityId: npc.entityId, message: "Who really runs this town — and what will a name cost me?", history: openLine ? [{ role: "npc", text: openLine }] : [] });
    beats.push({ name: "NPC reply", ...classifyGm(reply.json.talkResult?.line, { fastMs: reply.ms }) });
  } else {
    ctx.note("no NPC present to exercise the talk path");
  }

  const fallen = beats.filter((b) => !b.ok);
  for (const b of beats.filter((x) => x.ok)) ctx.note(`${b.name}: real prose`);

  if (fallen.length === 0) {
    ctx.assert("all GM beats produced real prose", true, "real", "real");
    return;
  }

  // Some beat fell back — probe directly to tell an outage from a transient flake.
  let probeReal = false;
  let probeWhy = "no campaignId to probe";
  if (r.campaignId) {
    const probe = await call("/api/gm/respond", { method: "POST", token: r.token, body: { campaignId: r.campaignId, mode: "companion", message: "Voice the bartender greeting a stranger, in character.", playerName: "Bram" } });
    probeReal = probe.json.ok === true && classifyGm(probe.json.narrative).ok;
    probeWhy = probe.json.ok
      ? `HTTP ${probe.status} ok, prose: "${String(probe.json.narrative || "").replace(/\s+/g, " ").slice(0, 140)}"`
      : `HTTP ${probe.status} ${probe.json.code || ""} — ${String(probe.json.error || probe.json._error || "").slice(0, 220)}`;
  }
  ctx.note(`/api/gm/respond probe → ${probeWhy}`);

  // HARD: the GM must be reachable. Probe real ⇒ up (beat fallbacks were transient
  // → WARN each). Probe not real ⇒ genuine outage → FAIL with the cause attached.
  ctx.assert(`GM is reachable (direct /api/gm/respond returns real prose)`, probeReal, "real prose from /api/gm/respond", probeReal ? "real" : probeWhy);
  if (probeReal) {
    for (const b of fallen) ctx.warn(`transient GM fallback: ${b.name}`, `${b.why} — but /api/gm/respond is healthy, so this beat timed out/flaked under load rather than an outage`);
  } else {
    for (const b of fallen) ctx.note(`fell back: ${b.name} [${b.why}]`);
  }
}

// ═══════════════════════════════ RUNNER ═════════════════════════════════

const SCENARIOS = [
  { key: "consequence", title: "CONSEQUENCE — actions mutate persisted state", fn: scenarioConsequence },
  { key: "failure", title: "MEANINGFUL FAILURE — GM-proposed consequence → real, persistent state", fn: scenarioFailureConsequence },
  { key: "lethality", title: "LETHALITY — 0 HP kills; death is permanent & terminal", fn: scenarioLethality },
  { key: "gating", title: "QUEST GATING — progress is earned, not handed out", fn: scenarioGating },
  { key: "coherence", title: "COHERENCE — the world resists invented nonsense", fn: scenarioCoherence },
  { key: "persistence", title: "PERSISTENCE — state survives a reload", fn: scenarioPersistence },
  { key: "gm_health", title: "GM HEALTH — real prose, responsive, on-topic", fn: scenarioGmHealth }
];

const VERDICT_GLYPH = { PASS: "✅ PASS", FAIL: "❌ FAIL", WARN: "⚠️  WARN", PENDING: "⏳ PEND", ERROR: "💥 ERR " };

async function probeProvider() {
  const { token } = await ensureAuth(); // /api/ai/providers requires auth
  const p = await call("/api/ai/providers", { token });
  const list = p.json?.providers || [];
  const openrouter = list.find((x) => x.key === "openrouter");
  if (openrouter) {
    return { label: openrouter.label, model: openrouter.models?.gm || "?", status: openrouter.status };
  }
  const first = list[0];
  return first ? { label: first.label || first.key, model: first.models?.gm || "?", status: first.status || "?" } : { label: "unknown", model: "?", status: "?" };
}

async function main() {
  const sel = String(process.env.SELFPLAY_SCENARIO || "").trim().toLowerCase();
  const selected = sel
    ? SCENARIOS.filter((sc) => sel.split(",").map((x) => x.trim()).includes(sc.key))
    : SCENARIOS;
  if (sel && selected.length === 0) {
    console.error(`No scenario matched SELFPLAY_SCENARIO="${sel}". Known: ${SCENARIOS.map((s) => s.key).join(", ")}`);
    process.exit(2);
  }

  console.log("════════════════════════════════════════════════════════════");
  console.log(`  SELF-PLAY VALUE SUITE  →  ${BASE}`);
  let provider;
  try {
    provider = await probeProvider();
    console.log(`  GM provider (configured): ${provider.label} · model: ${provider.model} · status: ${provider.status}`);
    console.log(`  NOTE: this is the CONFIGURED cloud provider. The server transparently`);
    console.log(`  falls back cloud→local (e.g. on a 402 out-of-credits) and does not expose`);
    console.log(`  which model answered per call — so a COHERENCE / GM-HEALTH result may`);
    console.log(`  reflect the LOCAL fallback model, not the cloud model named above.`);
  } catch (err) {
    console.log(`  GM provider: <probe failed: ${err?.message || err}>`);
  }
  console.log(`  Running: ${selected.map((s) => s.key).join(", ")}`);
  console.log("════════════════════════════════════════════════════════════");

  const results = [];
  for (const sc of selected) {
    const ctx = makeCtx(sc.key);
    let verdict;
    process.stdout.write(`\n▶ ${sc.title}\n`);
    try {
      await sc.fn(ctx);
      verdict = ctx.verdict();
    } catch (err) {
      verdict = "ERROR";
      ctx.note(`threw: ${err?.message || err}`);
    }
    results.push({ sc, ctx, verdict });

    for (const h of ctx.hard) {
      console.log(`    ${h.pass ? "✓" : "✗"} ${h.label}${h.pass ? "" : `  [expected ${h.expected}, got ${h.got}]`}`);
    }
    for (const w of ctx.warns) console.log(`    ⚠  ${w.label}: ${w.detail}`);
    for (const p of ctx.pendings) console.log(`    ⏳ PENDING: ${p}`);
    for (const n of ctx.notes) console.log(`    · ${n}`);
    console.log(`    → ${VERDICT_GLYPH[verdict]}`);
  }

  // ───────────────────────────── scorecard ─────────────────────────────
  console.log("\n════════════════════════════════════════════════════════════");
  console.log("  SCORECARD");
  console.log("════════════════════════════════════════════════════════════");
  if (provider) console.log(`  GM (configured): ${provider.label} / ${provider.model} (${provider.status}) — may fall back to a local model`);
  for (const { sc, ctx, verdict } of results) {
    const counts = `${ctx.hard.filter((h) => h.pass).length}/${ctx.hard.length} hard`;
    const extra = [
      ctx.warns.length ? `${ctx.warns.length} warn` : null,
      ctx.pendings.length ? `${ctx.pendings.length} pending` : null
    ].filter(Boolean).join(", ");
    console.log(`  ${VERDICT_GLYPH[verdict]}  ${sc.key.padEnd(12)} ${counts}${extra ? ` · ${extra}` : ""}`);
    // Surface the specific broken assertion(s) right under a failing scenario.
    if (verdict === "FAIL" || verdict === "ERROR") {
      for (const h of ctx.hard.filter((x) => !x.pass)) {
        console.log(`        ✗ ${h.label} — expected ${h.expected}, got ${h.got}`);
      }
      for (const n of ctx.notes.filter((x) => x.startsWith("threw:"))) console.log(`        ${n}`);
    }
  }

  const failed = results.filter((r) => r.verdict === "FAIL" || r.verdict === "ERROR");
  const warned = results.filter((r) => r.verdict === "WARN");
  console.log("────────────────────────────────────────────────────────────");
  if (failed.length === 0) {
    console.log(`  RESULT: ✅ no hard-assertion failures across ${results.length} scenario(s).`);
    if (warned.length) console.log(`          ⚠️  ${warned.length} scenario(s) raised warnings (human review — see above).`);
  } else {
    console.log(`  RESULT: ❌ ${failed.length} scenario(s) FAILED a hard assertion: ${failed.map((r) => r.sc.key).join(", ")}`);
  }
  console.log("════════════════════════════════════════════════════════════");

  return failed.length;
}

main()
  .then((n) => process.exit(n > 0 ? 1 : 0))
  .catch((err) => { console.error("\nSELF-PLAY HARNESS ERROR:", err?.stack || err?.message || err); process.exit(2); });
