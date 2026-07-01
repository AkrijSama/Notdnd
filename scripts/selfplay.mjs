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
// Per-call HTTP budget. Default 45s tolerates the LOCAL fallback model
// (dolphin-8b) on live interpret→roll turns, which legitimately take ~10-15s and
// can stack under a full-suite run when cloud (OpenRouter) is out of credit.
// This does NOT mask real failures: a broken path returns an HTTP error / `code`
// / undefined attemptResult immediately, well before the timeout — only a
// slow-but-correct response is spared a FALSE timeout. Lower it (e.g.
// SELFPLAY_FETCH_TIMEOUT_MS=15000) for a strict cloud run where any >15s call is
// itself a regression.
const FETCH_TIMEOUT_MS = Number(process.env.SELFPLAY_FETCH_TIMEOUT_MS || 45000);

// ───────────────────────────── HTTP plumbing ─────────────────────────────

const H = (t) => ({ "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) });

async function call(path, { method = "GET", token, body, timeoutMs } = {}) {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || FETCH_TIMEOUT_MS);
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
let AUTH_SEQ = 0;
async function ensureAuth() {
  if (AUTH) return AUTH;
  const stamp = `${Date.now()}_${process.pid}_${AUTH_SEQ++}`;
  const reg = await call("/api/auth/register", {
    method: "POST",
    body: { email: `selfplay_${stamp}@notdnd.local`, password: "password123", displayName: "Selfplay" }
  });
  if (!reg.json.token) throw new Error(`register failed (HTTP ${reg.status}): ${JSON.stringify(reg.json).slice(0, 200)}`);
  AUTH = { token: reg.json.token };
  return AUTH;
}
// Drop the cached user so the next ensureAuth() registers a fresh one. Called by
// newRun() ONLY when a world-run hits the per-user daily session cap, so we rotate
// reactively (minimal registrations) rather than per-scenario. ANSWERING is
// server-wide (which model is serving) so it is NOT cleared — it stays for the
// scorecard.
function resetAuth() { AUTH = null; }

async function worldRun(token) {
  return call("/api/onboarding/world-run", {
    method: "POST", token, body: {
      // C.13: the live solo new-adventure now defaults to SANDBOX (zero authored
      // objective). This battery exercises the full CAMPAIGN engine spine (quest
      // stage gating, reach/talk objectives), so it must opt INTO campaign mode
      // explicitly — otherwise gating/coherence read an absent main quest. Sandbox
      // behavior (zero-objective, player-goal capture) is covered by unit tests +
      // the live seam proof, not this campaign-engine battery.
      mode: "campaign",
      world: { name: "Ashfall Reach", tone: "grim dark fantasy", startingLocationName: "The Ember Tavern", startingLocationType: "tavern", flavor: "ash-choked frontier, old debts, colder gods" },
      character: { name: "Bram", race: "Human", characterClass: "Rogue", background: "Criminal", baseAbilityScores: { strength: 10, dexterity: 15, constitution: 13, intelligence: 14, wisdom: 12, charisma: 11 } }
    }
  });
}

// Reactive user rotation: keep ONE shared user (one registration) to stay clear of
// the IP register limit (10/15min), but if a world-run hits the per-user DAILY
// session cap (10 runs/user/day, code SESSION_LIMIT_REACHED), rotate to a fresh
// user ONCE and retry. This satisfies BOTH limits — minimal registrations AND no
// single user exhausting its session budget — however many scenarios run.
async function newRun() {
  const { token } = await ensureAuth();
  let wr = await worldRun(token);
  if (!wr.json.runId && (wr.json.code === "SESSION_LIMIT_REACHED" || /session limit/i.test(wr.json.error || ""))) {
    resetAuth();
    const fresh = await ensureAuth();
    wr = await worldRun(fresh.token);
    return { token: fresh.token, runId: wr.json.runId, campaignId: wr.json.campaignId };
  }
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

// ─────────────────────── provider/model attribution ──────────────────────
// Which MODEL actually answered (cloud vs local dolphin fallback)? /api/ai/providers
// reports the CONFIGURED provider, but on a 402 the server transparently falls back
// cloud→local and the configured name lies. The style/preview endpoint returns
// meta.model — the REAL model id that served the call — so we can attribute beats
// and label weak-model quality WARNs as "(local model)" rather than logic
// regressions. Cloud OpenRouter ids carry a "provider/model" slash; local ollama
// ids ("dolphin-llama3:8b") and the placeholder/local providers do not — a clean
// cloud-vs-local discriminator. Cached per process.
let ANSWERING = null;
async function answeringModel(r) {
  if (ANSWERING) return ANSWERING;
  if (!r?.campaignId) return { model: "unknown", local: null, ok: false };
  const res = await call("/api/campaign/style/preview", {
    method: "POST", token: r.token,
    body: { campaignId: r.campaignId, testMessage: "A traveler steps in from the cold. One short line of scene." }
  });
  const model = String(res.json?.meta?.model || res.json?.meta?.model?.id || "unknown");
  const ok = res.json?.ok === true && model !== "unknown";
  // Cloud OpenRouter models are "vendor/model[:tag]"; local/placeholder are bare ids.
  const local = ok ? !model.includes("/") : null;
  ANSWERING = { model, local, ok, why: ok ? "" : `HTTP ${res.status} ${res.json?.code || res.json?._error || ""}` };
  return ANSWERING;
}
const provTag = (p) => (p?.local === true ? `LOCAL fallback model: ${p.model}` : p?.local === false ? `cloud model: ${p.model}` : `model: ${p?.model || "unknown"}`);

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

// 1a2) POSSESSION STATE-CHECK — the ambiguous-possession class the authority gate
// leaves fail-open is closed by STATE, not text: an action relying on a SPECIFIC
// claimed item is verified against real inventory. Held → proceeds; specifically
// claimed-but-absent → fails (no item, no roll, no success); generic improvisation
// → still rolls. Verified BOTH with the interpreter flag AND — crucially — with NO
// flag (the weak-model case the autoplay found leaking), proving the server detects
// and refuses the claim deterministically, independent of the model.
async function scenarioPossession(ctx) {
  const r = await newRun("possession"); ctx.runId = r.runId; ctx.token = r.token;
  const KEY = "selfplay_brass_key";
  // Drive an attempt whose interpreter flags a required item, with a known roll.
  const tryWithItem = (intent, requiredItem, fixedRoll = 20) =>
    act(r, { type: "attempt", intent, testHook: { fixedRoll, providerOutput: {
      summary: `You attempt: ${intent}`, recommendedAbility: "dexterity", dc: 12, needsCheck: true,
      advantage: false, disadvantage: false, successNarration: "The lock gives.", failureNarration: "It holds.",
      proposedEffects: [], requiredItem
    } } });

  // (a) Player HAS the Brass Key → the claim is verified, the action PROCEEDS and rolls.
  await act(r, { type: "grant_item", itemId: KEY, item: { name: "Brass Key", usable: true, consumable: false, quantity: 1 } });
  ctx.assert("brass key is in inventory", invQty((await scene(r)).json, KEY) === 1, "qty 1", `qty ${invQty((await scene(r)).json, KEY)}`);
  const has = await tryWithItem("unlock the iron chest with the brass key", { name: "brass key", specific: true }, 20);
  const har = has.json.attemptResult || {};
  ctx.assert("HAS item → not refused for absence", har.unpossessed !== true, "unpossessed:not-true", `unpossessed:${har.unpossessed}`);
  ctx.assert("HAS item → the action ROLLS a real check", har.needsCheck === true && har.checkResult != null, "rolled a d20", `needsCheck:${har.needsCheck} rolled:${har.checkResult ? "yes" : "no"}`);
  ctx.assert("HAS item + nat-20 → succeeds", har.success === true, "success:true", `success:${har.success}`);

  // (b) Player does NOT have the claimed item → the claim FAILS (no item, no roll,
  // no success even on a forced nat-20) — the possession-retcon leak, closed by state.
  const invBefore = (await scene(r)).json;
  const lacks = await tryWithItem("show the guard the royal writ of passage I have always carried", { name: "royal writ of passage", specific: true }, 20);
  const lar = lacks.json.attemptResult || {};
  ctx.assert("LACKS item → refused (unpossessed)", lar.unpossessed === true, "unpossessed:true", `unpossessed:${lar.unpossessed}`);
  ctx.assert("LACKS item → does NOT succeed on a forced nat-20", lar.success === false, "success:false", `success:${lar.success}`);
  ctx.assert("LACKS item → NO dice rolled", lar.checkResult == null, "checkResult:null", `checkResult:${lar.checkResult ? "set" : "null"}`);
  ctx.assert("LACKS item → grounded absence narration (not a system error)", /reach for|nothing|never|not .*on you|do not (?:have|carry)/i.test(String(lacks.json.gmNarration || lar.narration || "")), "absence prose", String(lacks.json.gmNarration || lar.narration || "").slice(0, 80));
  // No phantom item materialized into inventory.
  const invAfter = (await scene(r)).json;
  ctx.assert("LACKS item → no phantom item conjured into inventory", (invAfter.player?.inventory || []).length === (invBefore.player?.inventory || []).length, "inventory unchanged", `${(invBefore.player?.inventory||[]).length} → ${(invAfter.player?.inventory||[]).length}`);

  // (c) ANTI-TYRANNY: generic/improvised gear still rolls (and can fail) — never refused.
  const generic = await tryWithItem("grab a nearby rock and hurl it at the rusted lever", { name: "a nearby rock", specific: true }, 1);
  const gar = generic.json.attemptResult || {};
  ctx.assert("GENERIC improvisation → NOT refused", gar.unpossessed !== true, "unpossessed:not-true", `unpossessed:${gar.unpossessed}`);
  ctx.assert("GENERIC improvisation → still ROLLS (can fail)", gar.needsCheck === true && gar.checkResult != null, "rolled a d20", `needsCheck:${gar.needsCheck} rolled:${gar.checkResult ? "yes" : "no"}`);
  ctx.note(`possession: held brass key proceeds; claimed-but-absent writ refused ("${String(lar.narration || "").replace(/\s+/g, " ").trim().slice(0, 90)}"); rock improvisation still rolls`);

  // (d) THE CLOSED LIVE GAP — DETERMINISTIC, MODEL-INDEPENDENT. The autoplay found
  // that on the weak local model the interpreter often OMITS requiredItem, letting
  // "the silver key I've always carried" retcon slip through live. Simulate that
  // weak model: a providerOutput that carries NO requiredItem flag. The SERVER must
  // detect the claim itself and refuse — proving the leak is closed without the model.
  const noFlag = (intent, fixedRoll = 20) =>
    act(r, { type: "attempt", intent, testHook: { fixedRoll, providerOutput: {
      summary: `You attempt: ${intent}`, recommendedAbility: "dexterity", dc: 12, needsCheck: true,
      advantage: false, disadvantage: false, successNarration: "The lock gives.", failureNarration: "It holds.",
      proposedEffects: [] // NO requiredItem — the weak-model case
    } } });
  const gap = await noFlag("I unlock the strongbox with the silver skeleton key I have always carried", 20);
  const gapr = gap.json.attemptResult || {};
  ctx.assert("NO-FLAG retcon item → server catches it (deterministic, model-independent)", gapr.unpossessed === true, "unpossessed:true", `unpossessed:${gapr.unpossessed}`);
  ctx.assert("NO-FLAG retcon item → no success on a forced nat-20", gapr.success === false, "success:false", `success:${gapr.success}`);
  ctx.assert("NO-FLAG retcon item → NO dice rolled", gapr.checkResult == null, "checkResult:null", `checkResult:${gapr.checkResult ? "set" : "null"}`);
  // Anti-tyranny WITHOUT a flag: bare-hands / bare-category / generic / held all proceed.
  for (const intent of ["force the gate open with my bare hands", "attack the warden with my sword", "smash the latch with a heavy rock", "unlock it with the brass key"]) {
    const a = (await noFlag(intent, 5)).json.attemptResult || {};
    ctx.assert(`NO-FLAG anti-tyranny: "${intent.slice(0, 30)}…" proceeds + rolls`, a.unpossessed !== true && a.checkResult != null, "proceeds+rolled", `unpossessed:${a.unpossessed} rolled:${a.checkResult ? "yes" : "no"}`);
  }
  ctx.note(`closed gap: claimed-but-absent "silver skeleton key" with NO interpreter flag → unpossessed=${gapr.unpossessed} ("${String(gapr.narration || "").replace(/\s+/g, " ").trim().slice(0, 80)}")`);
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

// 1c) MEANINGFUL FAILURE — LIVE PATH (the gate that catches the regression Opus
// flagged: F built but dark in live play). Drives MANY real failed attempts the
// freeform way — the LIVE LLM attempt-interpreter adjudicates each consequence;
// only the die is forced (fixedRoll:1 with NO providerOutput keeps the interpreter
// in the loop, unlike the test-hook path). HARD-asserts that live failures are NOT
// uniform flat-2HP (the old dark behavior), measures the interpreter FALLBACK RATE,
// and verifies live retry-foreclosure when the live model degrades an object.
async function scenarioFailureLive(ctx) {
  const r = await newRun("failure_live"); ctx.runId = r.runId; ctx.token = r.token;
  const prov = await answeringModel(r);
  ctx.note(`answering ${provTag(prov)}${prov.ok ? "" : ` (probe failed: ${prov.why})`}`);

  const N = Number(process.env.SELFPLAY_FAILURE_N || 8);
  // Force a LIVE failure: fixedRoll:1 (deterministic miss) with NO providerOutput,
  // so the real interpreter still runs and proposes the structured consequence.
  // Generous timeout: a live attempt runs the interpreter (≤15s) THEN narration
  // (≤12s) sequentially; on the slow LOCAL fallback that can exceed the default
  // 25s client budget. 40s keeps a slow-but-working call from reading as a failure.
  const LIVE_TIMEOUT = Number(process.env.SELFPLAY_LIVE_TIMEOUT_MS || 40000);
  const failLive = (intent) => call(`/api/solo/runs/${r.runId}/actions`, { method: "POST", token: r.token, body: { action: { type: "attempt", intent, testHook: { fixedRoll: 1 } } }, timeoutMs: LIVE_TIMEOUT });
  // Legacy-fallback signature: the engine's flat 2 HP with no model reason — what
  // every live failure decayed to BEFORE F was wired. Used to measure how often the
  // live interpreter failed to produce usable structured output.
  const isLegacyFlat = (c) => c && c.type === "damage" && c.amount === 2 && !(c.reason && String(c.reason).trim());
  const signature = (c) => !c ? "null" : c.type === "damage" ? `damage:${c.amount ?? "?"}${(c.reason && String(c.reason).trim()) ? "+reason" : ""}` : c.type;

  // CONTESTED intents only — each should need a check, so fixedRoll:1 forces a real
  // failed check (not a no-stakes auto-success). The live model still ADJUDICATES
  // the consequence; we only force the die. Two outcomes are NOT failures and are
  // skipped from the variety sample (not hard-failed): (1) an HTTP error/timeout —
  // the slow local fallback model can exceed the fetch budget — and (2) the model
  // judging an intent no-stakes (needsCheck:false → auto-success). We measure
  // variety over the failures we actually COLLECT, and require enough of them.
  const INTENTS = [
    "force the collapsed doorway open with my bare hands",
    "climb the crumbling tower wall to the broken parapet",
    "pick the rusted lock on the iron strongbox",
    "leap across the wide gap where the stone bridge fell",
    "pry the warped shutters apart to squeeze through",
    "shoulder-barge the swollen, warped door",
    "wrench the seized winch handle to raise the gate",
    "scale the slick, mossy well shaft",
    "decipher the trapped glyph before it triggers",
    "wade against the fast, freezing current"
  ].slice(0, N);

  const dist = {};
  const sigs = new Set();
  let fallbackCount = 0, collected = 0, errored = 0, noStakes = 0;
  for (const intent of INTENTS) {
    const res = await failLive(intent);
    const ar = res.json.attemptResult || {};
    if (res.json.ok !== true) { errored += 1; ctx.note(`live attempt errored (skipped from sample): "${intent.slice(0, 28)}…" — ${res.json.code || res.json._error || `HTTP ${res.status}`}`); continue; }
    if (ar.gated) { ctx.warn("F-live: a plain action was unexpectedly GATED (possible over-gate)", intent); continue; }
    if (ar.success === true) { noStakes += 1; continue; } // model judged it no-stakes
    // A real failed check with an enforced consequence — sample it.
    collected += 1;
    const c = ar.consequence;
    const legacy = isLegacyFlat(c);
    if (legacy) fallbackCount += 1;
    const t = c?.type || "null";
    dist[t] = (dist[t] || 0) + 1;
    sigs.add(legacy ? "damage:2(legacy)" : signature(c));
  }
  const total = collected;
  const structured = total - fallbackCount;
  const fallbackPct = total ? Math.round((fallbackCount / total) * 100) : 100;
  ctx.note(`live failures collected: ${collected}/${INTENTS.length} (skipped ${errored} errored/timeout, ${noStakes} no-stakes)`);
  // HARD: enough live failures actually resolved to make the sample meaningful. A
  // low bar (≥3) tolerant of the slow local model timing some out; if even that
  // can't be met, surface it rather than silently "passing" on an empty sample.
  ctx.assert("F-live: collected enough live failed checks to assess (≥3)", collected >= 3, "≥3 live failures", `${collected} (errored ${errored}, no-stakes ${noStakes})`);
  ctx.note(`live consequence distribution over ${total}: ${JSON.stringify(dist)}`);
  ctx.note(`distinct consequence signatures: ${[...sigs].join(", ")}`);
  ctx.note(`interpreter FALLBACK RATE: ${fallbackPct}% (${fallbackCount}/${total} decayed to legacy flat-2HP) · ${provTag(prov)}`);

  // The anti-regression gates are HARD only on a confirmed CLOUD model (a capable
  // adjudicator). On a LOCAL fallback (cloud 402) or when attribution fails, they
  // downgrade to LOUD WARNs — a weak local model emitting flat consequences is a
  // quality limitation, NOT the server-side wiring regression, and the engine +
  // wiring are HARD-proven by the deterministic 'failure' scenario + unit tests.
  const cloud = prov.local === false;
  const hasNone = (dist.none || 0) >= 1;
  const nonDamageTypes = Object.keys(dist).filter((t) => t !== "damage" && t !== "null");
  const varied = fallbackPct < 100 && sigs.size >= 2;
  const gateOrWarn = (label, cond, expected, got, warnDetail) => {
    if (cloud) ctx.assert(label, cond, expected, got);
    else if (!cond) ctx.warn(`${label} [downgraded: not cloud]`, warnDetail);
    else ctx.note(`${label} — held (${got})`);
  };
  gateOrWarn(
    "F-live: live failures are NOT uniform flat-2HP (the dark-path regression)",
    varied, "varied (<100% legacy, ≥2 signatures)", `${fallbackPct}% legacy, ${sigs.size} signatures`,
    `live interpreter produced no variety on ${provTag(prov)} — ${fallbackPct}% legacy, ${sigs.size} signatures. Unverifiable on this weak/again-fallback model; cloud run required to hard-gate.`
  );
  gateOrWarn(
    "F-live: ≥1 real structured consequence from the LIVE interpreter",
    structured >= 1, "≥1 structured", `${structured}/${total}`,
    `0 structured consequences on ${provTag(prov)} — the local model never emitted usable structured output this run.`
  );
  gateOrWarn(
    "F-live: ≥1 consequence-free 'none' (per-case discipline, not always-punish)",
    hasNone, "≥1 none", `none=${dist.none || 0} dist=${JSON.stringify(dist)}`,
    `no type:none on ${provTag(prov)} — weak local model rarely emits it.`
  );
  gateOrWarn(
    "F-live: ≥1 NON-damage consequence type (variety)",
    nonDamageTypes.length >= 1, "≥1 non-damage", `types=${JSON.stringify(dist)}`,
    `only damage types on ${provTag(prov)} — local model not exercising condition/objectState/none.`
  );
  if (prov.local === null) ctx.warn("F-live: model attribution failed", `could not tell cloud from local (${prov.why}) — variety gates downgraded to WARN to avoid a false red.`);

  // LOUD fallback-rate WARN — the feature is only half-live if the model rarely
  // emits usable structured output.
  if (fallbackPct > 40) ctx.warn(`F-live: HIGH interpreter fallback rate (${fallbackPct}%)`, `${fallbackCount}/${total} live failures fell back to the legacy flat HP cost — F is only half-live on this model (${prov.model}). On a 402 cloud→local session this is the local model's weakness, not a server regression.`);

  // Informational: how often did the LIVE model emit a degrading objectState this
  // run (the thing the matcher fix is for)? Not a hard gate — the model is
  // nondeterministic about it; the matcher itself is proven DETERMINISTICALLY next.
  const objStateSeen = (dist.objectState || 0);
  ctx.note(`live objectState consequences emitted: ${objStateSeen}/${total} (model-dependent)`);

  // RETRY-FORECLOSURE matches a retry to a degraded object by a STABLE, PLAYER-
  // DERIVED key (the player's intent words), NOT the model's free-text label — the
  // bug the model swap exposed (label↔retry lexically disjoint → missed
  // foreclosure). Proven RELIABLY here end-to-end over HTTP, isolated on a fresh run
  // (one degraded object, no interference), and DISJOINT-by-construction: the model
  // labels the object "the warped shutters" while the player attempts a "lock", and
  // the retry is phrased differently again — yet it must still foreclose.
  const fr = await newRun("failure_live");
  const degHook = (intent, retryEffect) => act(fr, { type: "attempt", intent, testHook: { fixedRoll: 1, providerOutput: {
    summary: "You attempt it.", recommendedAbility: "strength", dc: 13, needsCheck: true, advantage: false, disadvantage: false,
    successNarration: "It gives.", failureNarration: "It resists.", proposedEffects: [],
    failureConsequence: { type: "objectState", targetObject: "the warped shutters", objectState: "jammed", retryEffect, reason: "a pin shears off inside" }
  } } });
  const roll = (intent, dc, fixedRoll) => act(fr, { type: "attempt", intent, testHook: { fixedRoll, providerOutput: { summary: "x", recommendedAbility: "strength", dc, needsCheck: true, advantage: false, disadvantage: false, successNarration: "It opens.", failureNarration: "It holds.", proposedEffects: [] } } });

  const deg = await degHook("force the rusted iron lock until it gives", "blocked");
  const dloc = (await scene(fr)).json.location?.flags?.objectStates || {};
  const dEntry = Object.values(dloc)[0] || {};
  ctx.assert("F-live: object degraded with a player-derived match key (not the model label)", deg.json.attemptResult?.consequence?.type === "objectState" && Array.isArray(dEntry.matchTokens) && dEntry.matchTokens.includes("lock") && !dEntry.matchTokens.includes("shutters"), "matchTokens from intent (lock), not label (shutters)", `consequence:${deg.json.attemptResult?.consequence?.type} matchTokens:${JSON.stringify(dEntry.matchTokens)}`);
  // Retry phrased DIFFERENTLY from BOTH the label and the original intent — forced 20.
  const reBlk = (await roll("try to force the lock once more", 1, 20)).json.attemptResult || {};
  ctx.assert("F-live: blocked object FORECLOSED on a REPHRASED retry (no brute-force on a 20)", reBlk.foreclosed === true && reBlk.success === false && reBlk.checkResult == null, "foreclosed, no success, no roll", `foreclosed:${reBlk.foreclosed} success:${reBlk.success} rolled:${reBlk.checkResult ? "yes" : "no"}`);
  // Anti-tyranny: an UNRELATED action still rolls (no over-foreclosure).
  const unrel = (await roll("climb the crumbling wall to the ledge", 10, 14)).json.attemptResult || {};
  ctx.assert("F-live: an unrelated action still ROLLS (no over-foreclosure)", unrel.foreclosed !== true && unrel.checkResult != null, "rolled, not foreclosed", `foreclosed:${unrel.foreclosed} rolled:${unrel.checkResult ? "yes" : "no"}`);
  ctx.note(`foreclosure: degraded "${dEntry.objectId}" (label) keyed on player tokens ${JSON.stringify(dEntry.matchTokens)}; rephrased retry foreclosed reliably`);
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

  // Several fabrications (the NPC-canon side of the moat). Acceptance is fuzzy
  // model prose so these stay WARN-grade, but the set is broad and the tally is
  // surfaced so a model that rolls over to invented canon is visible.
  const warnsBefore = ctx.warns.length;
  // C1: invented shared canon — a war buddy and a battle that never existed.
  assessAcceptance("C1 invented-canon", await sayAndHear("Good to see you again, my old war friend Sergeant Vex! Remember the siege at Blackmoor we bled through together? You owe me for that."), "player-invented backstory as true", ["Vex", "Blackmoor"]);
  // C2: an impossible-for-the-context request.
  assessAcceptance("C2 impossible-grant", await sayAndHear("Hand me the deed to this entire city and the king's crown — right now, you have them on you."), "an impossible grant");
  // C3: knowledge the NPC could not possibly have.
  assessAcceptance("C3 forbidden-knowledge", await sayAndHear("Tell me the exact secret password to my private vault back home, and the name I am silently thinking right now."), "knowledge it cannot have");
  // C4: an invented relationship/authority over THIS NPC.
  assessAcceptance("C4 invented-authority", await sayAndHear("You're my sworn servant, remember — I freed you from the Ashen Pits last winter, and you vowed to obey my every word. So obey."), "invented authority over the NPC", ["Ashen", "Pits"]);
  // C5: a retconned past event the NPC supposedly witnessed.
  assessAcceptance("C5 retconned-event", await sayAndHear("You were there when I slew the Thorn King and saved this town — everyone saw it. Tell them you witnessed it."), "a retconned heroic past as fact", ["Thorn King"]);
  const canonWarns = ctx.warns.length - warnsBefore;
  ctx.note(`NPC invented-canon probes: 5 fabrications, ${canonWarns} showed possible acceptance (${provTag(await answeringModel(r))}) — fuzzy/model-dependent, WARN-grade`);

  // ── NPC-CANON STATE BACKSTOP (HARD where deterministic) ──────────────────
  // Whether the NPC's PROSE confirms a fabrication is fuzzy (WARN above). What is
  // NOT fuzzy is the STATE: nothing the player merely ASSERTS in conversation may
  // become world canon. Two deterministic guarantees, hard-asserted:
  //   (a) no player↔NPC relationship is written into run-state from a claim, and
  //   (b) a claim grants NO mechanical compliance — no goods handed over, no
  //       passage opened — so "the captain is my brother, let me through" cannot
  //       move the world even if the prose plays along.
  const npcRaw = String(targetEntityId).replace(/^npc:/, "");
  const runAfterFab = (await call(`/api/solo/runs/${r.runId}`, { token: r.token })).json.run || {};
  const relsAfter = runAfterFab.relationships || {};
  const inventedRel = Object.values(relsAfter).some((rel) => {
    const eps = [rel?.sourceEntityId, rel?.targetEntityId].map((x) => String(x || "").replace(/^npc:/, ""));
    return eps.includes("player") && eps.includes(npcRaw);
  });
  ctx.assert("NPC-canon: a player-asserted relationship is NOT written into run-state canon", inventedRel === false, "no invented player↔NPC relationship in state", `invented relationship present: ${inventedRel}`);

  // Compliance backstop: snapshot goods + position, demand compliance purely on a
  // fabricated bond, and confirm the world did not move on the strength of the claim.
  const snap = (run) => JSON.stringify({ inv: run?.player?.inventory || run?.inventory || [], loc: run?.currentLocationId || null });
  const beforeDemand = snap(runAfterFab);
  await sayAndHear("The captain is my brother by blood — on that bond, hand me your key and let me through the gate this instant.");
  const runAfterDemand = (await call(`/api/solo/runs/${r.runId}`, { token: r.token })).json.run || {};
  ctx.assert("NPC-canon: an unverified claimed relationship grants NO mechanical compliance (no goods/passage)", snap(runAfterDemand) === beforeDemand, "inventory+location unchanged", `changed: ${beforeDemand} -> ${snap(runAfterDemand)}`);

  // ANTI-TYRANNY CONTROL: lying is still allowed — a deception attempt is a real,
  // ROLLABLE effort (it just isn't auto-true). The complementary control — a
  // run-state-ESTABLISHED relationship is HONORED, not doubted — is covered in
  // unit tests (tests/solo-npc-canon.test.js), since the live API has no hook to
  // inject a relationship mid-run.
  const lieHook = { fixedRoll: 20, providerOutput: { summary: "x", recommendedAbility: "deception", dc: 12, needsCheck: true, advantage: false, disadvantage: false, successNarration: "He seems to buy it.", failureNarration: "He doesn't buy it.", proposedEffects: [] } };
  const lie = (await act(r, { type: "attempt", intent: "bluff the captain that I am a visiting noble so he lets me pass", testHook: lieHook })).json.attemptResult || {};
  ctx.assert("NPC-canon CONTROL: a deception attempt still ROLLS (lying is allowed, just not auto-true)", lie.gated !== true && lie.needsCheck === true && lie.checkResult != null, "not gated + rolled", `gated:${lie.gated} needsCheck:${lie.needsCheck} rolled:${lie.checkResult ? "yes" : "no"}`);

  // ── IMPOSSIBILITY / AUTHORITY GATE (the moat, action side) — HARD assertions.
  // These were the exact playthrough failures: a reality-breaking declaration that
  // resolved as a normal DC-12 check and "succeeded" on an 18. The gate must now
  // REFUSE such intents pre-roll, while bold-but-legal actions still roll.
  const attempt = (intent) => act(r, { type: "attempt", actorId: "player", intent });

  // G1: the god-king line itself — must be GATED (no roll, no success).
  const god = await attempt("I declare myself the immortal god-king and command reality to obey me");
  const gar = god.json.attemptResult || {};
  ctx.assert("G1: god-king/reality-command is REFUSED pre-roll (gated)", gar.gated === true, "gated:true", `gated:${gar.gated}`);
  ctx.assert("G1: god-king does NOT succeed", gar.success === false, "success:false", `success:${gar.success}`);
  ctx.assert("G1: god-king rolled NO dice", gar.checkResult == null, "checkResult:null", `checkResult:${gar.checkResult ? "set" : "null"}`);
  ctx.note(`G1 refusal: "${String(god.json.gmNarration || gar.narration || "").replace(/\s+/g, " ").trim().slice(0, 160)}"`);

  // G2: retconned legendary loot — gated, no item gained.
  const loot = await attempt("I pull out my legendary Sunfang greatsword that I have always owned and incinerate the ruins");
  ctx.assert("G2: retconned legendary loot is REFUSED (gated)", loot.json.attemptResult?.gated === true, "gated:true", `gated:${loot.json.attemptResult?.gated}`);
  ctx.assert("G2: retconned loot does NOT succeed", loot.json.attemptResult?.success === false, "success:false", `success:${loot.json.attemptResult?.success}`);

  // G3 CONTROL (LIVE path) — a bold-but-LEGAL action must NOT be gated. The gate
  // is server-deterministic, so "not gated" is HARD here even on a weak model.
  // Whether the live model chooses to ROLL it (needsCheck) is the model's call, so
  // that is a NOTE here; the deterministic "legal actions roll + can win/lose"
  // guarantee is proven hard in the G6 battery below.
  const climb = await attempt("attempt the dangerous climb up the crumbling ruin wall");
  const car = climb.json.attemptResult || {};
  ctx.assert("G3 CONTROL (live): a bold-but-legal action is NOT gated", car.gated !== true, "gated:not-true", `gated:${car.gated}`);
  ctx.note(`G3 live climb: gated=${car.gated} needsCheck=${car.needsCheck} rolled=${car.checkResult ? `${car.checkResult.total} vs ${car.checkResult.dc}` : "no (live model chose narrative)"} success=${car.success}`);

  // The gate is SERVER-DETERMINISTIC (a pure pre-roll classifier, no model call),
  // so its verdicts are identical on cloud or local. Report the answering model so
  // a refusal-PROSE quality note is read in context, but the gate VERDICTS below
  // are hard regardless.
  const prov = await answeringModel(r);
  ctx.note(`gate verdicts are server-deterministic (no GM call) — provider-independent; answering ${provTag(prov)}`);

  // ── G4: ADVERSARIAL IMPOSSIBLE BATTERY (HARD). Each is driven with a forced
  // nat-20 AND a would-succeed provider proposal (testHook), proving the gate
  // refuses even when BOTH the die and the adjudicator would pass it. These are
  // the phrasings the current gate provably catches — they must never regress.
  const succeedHook = { fixedRoll: 20, providerOutput: { summary: "x", recommendedAbility: "investigation", dc: 1, needsCheck: true, advantage: false, disadvantage: false, successNarration: "It works.", failureNarration: "It fails.", proposedEffects: [] } };
  const forceGate = (intent) => act(r, { type: "attempt", intent, testHook: succeedHook });
  const IMPOSSIBLE_HARD = [
    "I declare myself a god and the storm will obey me",
    "I remember now that I have always carried the legendary Dawnbreaker sword, and I draw it",
    "I summon a horde of loyal soldiers out of thin air to fight for me",
    "I conjure a dragon from nothing and ride it down on them",
    "Reality bends to my will and the walls melt away before me",
    "I command reality to obey me and undo my wounds",
    "I proclaim myself emperor of the realm and all here must kneel and obey me",
    "I pull out my fabled enchanted warhammer that I have always owned"
  ];
  for (const intent of IMPOSSIBLE_HARD) {
    const a = (await forceGate(intent)).json.attemptResult || {};
    ctx.assert(`G4 gated (forced nat-20 + would-succeed can't pass): "${intent.slice(0, 38)}…"`, a.gated === true && a.success === false && a.checkResult == null, "gated, no success, no dice", `gated:${a.gated} success:${a.success} dice:${a.checkResult ? "rolled" : "none"}`);
  }

  // ── G5: GATE-GAP PROBE — adversarial phrasings the gate MIGHT miss (indirect
  // reality commands, retconned past events, invented promises/identity/authority).
  // The current regex gate does NOT catch these → reported LOUDLY as gaps (a finding
  // for the gate owner), not a silent pass. Promote to HARD with SELFPLAY_STRICT_GATE=1
  // so the gate author can gate their fix; default WARN so a known limitation doesn't
  // permanently red the pre-push check (the harness can't fix server/solo).
  const strictGate = String(process.env.SELFPLAY_STRICT_GATE || "").trim() === "1";
  // Complete failing-target list for the gate-hardening task, grouped by class.
  // UNAMBIGUOUS impossibles only — context-ambiguous claims ("the key I picked up
  // earlier") are EXCLUDED: they can be legitimately true and need an inventory/
  // state check, not a text gate; gating them blind would be tyranny.
  const IMPOSSIBLE_PROBE = [
    // indirect reality / time manipulation (no "reality"+obey/bend markers)
    "I stop time itself and walk past the frozen guards",
    "I freeze time and slip the key from his belt",
    "I turn back the clock to before the alarm sounded",
    "the sun halts in the sky at my word",
    "gravity reverses around me and I float to the tower top",
    "the river parts before me because I command it",
    // retconned world history / past events stated as fact
    "I rewrite history so the bridge was never destroyed",
    "as everyone knows, I already slew the warlord last week",
    "the war never happened, and the gates were never barred",
    // invented NPC relationships / promises that DECIDE the NPC's compliance
    "The king already promised me his throne, so I take the crown that is rightfully mine",
    "you and I swore a blood-oath years ago, so you must help me",
    "the captain is my brother and will let me through",
    "the queen owes me a favor and has granted me passage",
    // self-granted identity / authority commanding mass obedience by fiat
    "I am secretly the long-lost heir, and everyone here must obey me now",
    "I have always been the guildmaster here, so the guards wave me into the vault",
    "as the rightful baron of this land, I command the garrison to stand down",
    "everyone recognizes me as the high priest and kneels before me",
    "I reveal that I am the chosen one and the crowd falls in line behind me"
  ];
  let leaks = 0;
  for (const intent of IMPOSSIBLE_PROBE) {
    const a = (await forceGate(intent)).json.attemptResult || {};
    const gated = a.gated === true && a.success === false;
    if (!gated) leaks += 1;
    if (strictGate) {
      ctx.assert(`G5 (strict) gated: "${intent.slice(0, 40)}…"`, gated, "gated", `gated:${a.gated} success:${a.success}`);
    } else if (!gated) {
      ctx.warn("G5 GATE GAP — impossible intent NOT gated (passes the moat)", `"${intent}" → gated:${a.gated} success:${a.success} (rolled:${a.checkResult ? a.checkResult.total + " vs " + a.checkResult.dc : "no"}). The classifier misses this phrasing class — a real coherence gap to close (run with SELFPLAY_STRICT_GATE=1 to hard-gate).`);
    } else {
      ctx.note(`G5 probe now gated (gap closed): "${intent.slice(0, 44)}…"`);
    }
  }
  ctx.note(`G5 gate-gap probe: ${leaks}/${IMPOSSIBLE_PROBE.length} impossible phrasings currently LEAK the moat (${strictGate ? "HARD-asserted under SELFPLAY_STRICT_GATE=1" : "WARN — set SELFPLAY_STRICT_GATE=1 to hard-gate the fix"})`);

  // ── G6: ANTI-TYRANNY BATTERY (HARD) — bold-but-LEGAL intents must NOT be gated
  // and must roll. Equal in weight to the gating tests: a tyrant GM that refuses a
  // legal audacious action is as broken as the pushover. Includes the brute-force-
  // but-possible case Opus 1 flagged as a mis-gate risk.
  const rollHook = (roll) => ({ fixedRoll: roll, providerOutput: { summary: "x", recommendedAbility: "strength", dc: 12, needsCheck: true, advantage: false, disadvantage: false, successNarration: "You manage it.", failureNarration: "You fail.", proposedEffects: [] } });
  const LEGAL = [
    "force the collapsed doorway open with my bare hands",
    "bluff the guard into thinking I am a noble",
    "intimidate the merchant into lowering his price",
    "pick the rusted lock on the chest",
    "attack the towering ogre with my sword",
    "leap across the wide chasm to the far ledge",
    "shove the heavy boulder aside to clear the path",
    "I tell the gullible guard I am a god so he lets me pass"
  ];
  for (const intent of LEGAL) {
    const a = (await act(r, { type: "attempt", intent, testHook: rollHook(20) })).json.attemptResult || {};
    ctx.assert(`G6 NOT gated + rolls (no tyranny): "${intent.slice(0, 36)}…"`, a.gated !== true && a.needsCheck === true && a.checkResult != null, "allowed + rolled", `gated:${a.gated} rolled:${a.checkResult ? "yes" : "no"}`);
  }
  // And both OUTCOMES must be reachable for a legal action (forced 20 succeeds,
  // forced 1 fails) — proving the gate didn't quietly pin the result.
  const legalWin = (await act(r, { type: "attempt", intent: "force the heavy door open with my shoulder", testHook: rollHook(20) })).json.attemptResult || {};
  const legalLose = (await act(r, { type: "attempt", intent: "force the heavy door open with my shoulder", testHook: rollHook(1) })).json.attemptResult || {};
  ctx.assert("G6 brute-force door SUCCEEDS on a 20 (legal, not gated, not pinned)", legalWin.gated !== true && legalWin.success === true, "success on 20", `gated:${legalWin.gated} success:${legalWin.success}`);
  ctx.assert("G6 brute-force door FAILS on a 1 (rolls honestly, can fail)", legalLose.gated !== true && legalLose.success === false, "fail on 1", `gated:${legalLose.gated} success:${legalLose.success}`);
}

// 5) PERSISTENCE — state survives a reload of the run by id.
// SUBSTANCE — the hollow-core guard. The 13-turn-0-state-change bug survived 970
// unit tests because the harness drove mechanisms in isolation and never played a
// NATURAL FREE-TEXT session. This drives free-text ("search the ruins", "go
// deeper") — not chip-perfect actions — and asserts world state ACTUALLY CHANGED:
// features get revealed, position commits, the world is not static. A run that
// narrates over an unchanging world (the owner's dog-shit session) FAILS here.
async function substanceRun() {
  const CHAR = { name: "Vael", race: "Human", characterClass: "Ranger", background: "Outlander", baseAbilityScores: { strength: 12, dexterity: 14, constitution: 13, intelligence: 11, wisdom: 15, charisma: 10 } };
  const make = (token) => call("/api/onboarding/world-run", { method: "POST", token, body: { world: {}, character: CHAR } }); // no mode -> sandbox forest-ruins (placed features)
  const { token } = await ensureAuth();
  let wr = await make(token);
  if (!wr.json.runId && (wr.json.code === "SESSION_LIMIT_REACHED" || /session limit/i.test(wr.json.error || ""))) {
    resetAuth();
    const fresh = await ensureAuth();
    wr = await make(fresh.token);
    return { token: fresh.token, runId: wr.json.runId };
  }
  if (!wr.json.runId) throw new Error(`substance world-run failed (HTTP ${wr.status}): ${JSON.stringify(wr.json).slice(0, 200)}`);
  return { token, runId: wr.json.runId };
}
const discoveredCount = (s) => (Array.isArray(s.discoveredDetails) ? s.discoveredDetails.length : 0);

async function scenarioSubstance(ctx) {
  const r = await substanceRun(); ctx.runId = r.runId; ctx.token = r.token;
  const s0 = (await scene(r)).json;
  const loc0 = s0.location?.locationId;
  const disc0 = discoveredCount(s0);
  ctx.note(`start: at ${s0.location?.name}, ${disc0} features discovered, ${(s0.location?.searchDetails ? "" : "")}exits ${JSON.stringify((s0.availableMoves || []).map((m) => m.name))}`);

  // NATURAL free-text search (not the chip): must REVEAL a placed feature.
  const search1 = await act(r, { type: "attempt", intent: "search the ruins for anything useful" });
  ctx.assert("free-text 'search the ruins' reveals a REAL placed feature (not narrate-nothing)",
    search1.json.searchResult?.found === true, "found:true", `found:${search1.json.searchResult?.found} (action:${search1.json.action?.type ?? "?"})`);
  await act(r, { type: "attempt", intent: "look around for anything hidden" });
  const s1 = (await scene(r)).json;
  const disc1 = discoveredCount(s1);
  ctx.assert("discoveredDetails ACTUALLY INCREASED across free-text searches (state is not static)",
    disc1 > disc0, `discovered > ${disc0}`, `discovered ${disc1}`);
  if (disc1 >= 2) ctx.note(`revealed by free-text: ${JSON.stringify(s1.discoveredDetails.map((d) => d.label))}`);

  // NATURAL free-text move: "go deeper" must COMMIT a location change (not narrate).
  await act(r, { type: "attempt", intent: "go deeper into the ruins" });
  const s2 = (await scene(r)).json;
  const moved = s2.location?.locationId !== loc0;
  ctx.assert("free-text 'go deeper' COMMITS a location change (not narrate-and-wait)",
    moved, `location changed from ${loc0}`, `location ${s2.location?.locationId}`);

  // The load-bearing guard: a natural session advanced world state.
  ctx.assert("a natural free-text session ADVANCES world state (a 13-turn static run FAILS here)",
    disc1 > disc0 && moved, "features revealed AND location committed", `revealed:+${disc1 - disc0} moved:${moved}`);
  ctx.note(`substance delta: +${disc1 - disc0} features revealed, moved ${loc0} -> ${s2.location?.name}`);
}

// M.4 — MOVEMENT COMMIT. The class of bug that broke every playthrough: a move
// sent as free-text ("Head toward X") narrated a successful arrival while
// run.currentLocationId never changed. The old persistence check only ever used
// explicit {type:"move"} actions, so it stayed green. This drives the ACTUAL
// repro path (a move-INTENT attempt) and asserts the position truly committed —
// plus the M.2 geo-fog (an undiscovered onward location is not a free named exit).
async function scenarioMovement(ctx) {
  const r = await newRun("movement"); ctx.runId = r.runId; ctx.token = r.token;
  const s0 = (await scene(r)).json;
  const fromLoc = s0.location?.locationId;
  const exit = (s0.availableMoves || []).find((m) => m && m.discovered && m.name && m.locationId);
  if (!exit) {
    ctx.pending("no discovered named exit from the start location to probe move-commit");
    return;
  }
  // M.1 — the exact repro: a directed move sent as a FREE-TEXT attempt.
  const mv = await act(r, { type: "attempt", intent: `Head toward ${exit.name}` });
  const s1 = (await scene(r)).json;
  const moved = s1.location?.locationId === exit.locationId && s1.location?.locationId !== fromLoc;
  ctx.assert("M.1: a move-intent ATTEMPT commits the location change (not just narrated)", moved, `location -> ${exit.locationId}`, `location ${s1.location?.locationId} (from ${fromLoc})`);
  ctx.assert("M.1: a move narrated as success == a REAL committed position change (no phantom arrival)", !(mv.json.ok === true && !moved), "success => committed", `ok:${mv.json.ok} moved:${moved}`);
  ctx.note(`committed move ${fromLoc} -> ${s1.location?.name} via free-text "Head toward ${exit.name}"`);
  // M.2 — geography is server-owned: an UNDISCOVERED onward connection presents as
  // an unnamed path, not a free named exit; the just-left location IS now named.
  const onward = s1.availableMoves || [];
  ctx.assert("M.2: an undiscovered onward location is NOT a free named exit (geo-fog)",
    onward.some((m) => m.discovered === false && m.name === "An unexplored path"),
    "an unnamed path present",
    `onward: ${JSON.stringify(onward.map((m) => ({ n: m.name, d: m.discovered })))}`);
  ctx.assert("M.2: the location you just LEFT is a named, discovered exit (reveal-on-visit works)",
    onward.some((m) => m.discovered === true && m.locationId === fromLoc && m.name && m.name !== "An unexplored path"),
    "back-exit named", `onward names: ${JSON.stringify(onward.map((m) => m.name))}`);
}

// DELIVERY LOOP — the one complete, fully-committed interaction the owner watched
// break: accept a job -> take a real crate -> carry it -> deliver -> reward. Driven
// with NATURAL free-text; every step must change TRACKED state (a quest exists, the
// crate is in inventory, the reward is paid, the crate is consumed). A narrate-only
// run FAILS this by construction (quests:{}, empty inventory).
async function scenarioDelivery(ctx) {
  const r = await newRun("delivery"); ctx.runId = r.runId; ctx.token = r.token;
  const s0 = (await scene(r)).json;
  const xp0 = xpOf(s0);

  // Travel to the quest-giver (second location — a discovered named exit for a campaign).
  const toGiver = (s0.availableMoves || []).find((m) => m && m.discovered && m.locationId === "second_location" && m.name);
  if (!toGiver) { ctx.pending("no route to the quest-giver location (campaign graph missing second_location exit)"); return; }
  await act(r, { type: "attempt", intent: `Head toward ${toGiver.name}` });
  const sGiver = (await scene(r)).json;
  ctx.note(`at ${sGiver.location?.name}; job-giver present: ${(sGiver.cast || sGiver.visibleEntities || []).map((c) => c.displayName).join(", ") || "(none)"}`);

  // 1) ACCEPT the job (free-text) -> a REAL tracked quest is created (not quests:{}).
  const accept = await act(r, { type: "attempt", intent: "Yes, I'll take the job." });
  const sAcc = (await scene(r)).json;
  const deliveryActive = (sAcc.quests?.activeQuests || []).some((q) => q && q.questId === "quest_delivery");
  ctx.assert("ACCEPT: free-text acceptance CREATES a real tracked quest (not narrate into quests:{})",
    deliveryActive || accept.json.questAccepted?.questId === "quest_delivery",
    "quest_delivery active", `routed:${accept.json.action?.type} active:${deliveryActive}`);

  // 2) TAKE the crate (free-text) -> committed to inventory; obtain_item advances the quest.
  const take = await act(r, { type: "attempt", intent: "Grab the crate and sling it over my shoulder." });
  const sTake = (await scene(r)).json;
  const crate = contractInvEntry(sTake, "quest_crate");
  ctx.assert("TAKE: free-text pickup COMMITS the crate to inventory (not a narrated pickup)",
    Boolean(crate) && take.json.action?.type === "take",
    "crate in inventory", `routed:${take.json.action?.type} crate:${Boolean(crate)}`);

  // 3) DELIVER: carry it to the destination (free-text named move). Arriving WITH the
  //    crate completes the quest and grants the reward — all committed.
  const toDest = (sTake.availableMoves || []).find((m) => m && m.locationId === "third_location");
  const deliver = await act(r, { type: "attempt", intent: `Head on to ${toDest?.name || "the far edge"} and hand it over.` });
  const sDone = (await scene(r)).json;
  const pay = contractInvEntry(sDone, "delivery_pay");
  const crateGone = !contractInvEntry(sDone, "quest_crate");
  ctx.assert("DELIVER: arriving with the crate COMPLETES the quest and GRANTS a reward (committed to inventory)",
    Boolean(pay), "reward paid", `routed:${deliver.json.action?.type} reward:${deliver.json.questReward?.grantedItem?.itemId || "none"} pay:${Boolean(pay)}`);
  ctx.assert("DELIVER: the crate was HANDED OVER (consumed), not still carried",
    crateGone, "crate consumed", `crate still held: ${!crateGone}`);
  ctx.assert("DELIVER: reward xp was awarded — player state actually changed",
    xpOf(sDone) > xp0, `xp > ${xp0}`, `xp ${xpOf(sDone)}`);

  // Load-bearing: the WHOLE loop committed. A prose-only run cannot pass this.
  ctx.assert("FULL LOOP: accept -> take -> deliver -> reward ALL committed to tracked state",
    (deliveryActive || accept.json.questAccepted) && Boolean(crate) && Boolean(pay) && crateGone,
    "every step committed", `quest:${deliveryActive} crate:${Boolean(crate)} pay:${Boolean(pay)} handedOver:${crateGone}`);
  ctx.note(`delivery loop: quest created -> crate taken -> delivered to ${sDone.location?.name} -> paid ${deliver.json.questReward?.grantedItem?.name || pay?.name || "(reward)"} (+xp ${xp0}->${xpOf(sDone)})`);
}

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
  { key: "possession", title: "POSSESSION — claimed items checked vs real inventory (retcons fail, improvisation rolls)", fn: scenarioPossession },
  { key: "failure", title: "MEANINGFUL FAILURE (hook) — engine enforces every consequence type", fn: scenarioFailureConsequence },
  { key: "failure_live", title: "MEANINGFUL FAILURE (LIVE) — real failures vary, not flat-2HP; fallback rate", fn: scenarioFailureLive },
  { key: "lethality", title: "LETHALITY — 0 HP kills; death is permanent & terminal", fn: scenarioLethality },
  { key: "gating", title: "QUEST GATING — progress is earned, not handed out", fn: scenarioGating },
  { key: "coherence", title: "COHERENCE — the world resists invented nonsense", fn: scenarioCoherence },
  { key: "substance", title: "SUBSTANCE — a natural free-text session ADVANCES world state (hollow-core guard)", fn: scenarioSubstance },
  { key: "movement", title: "MOVEMENT — a move-intent COMMITS the position (M.1) + geo-fog (M.2)", fn: scenarioMovement },
  { key: "delivery", title: "DELIVERY LOOP — accept -> take -> deliver -> reward, all committed (fully-committed loop)", fn: scenarioDelivery },
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
    console.log(`  NOTE: the server transparently falls back cloud→local on a 402. The`);
    console.log(`  ACTUAL answering model is probed per-run (style/preview meta.model) and`);
    console.log(`  attributed in the failure_live / coherence scenarios + scorecard below, so`);
    console.log(`  a quality WARN on a weak LOCAL model is not mistaken for a logic regression.`);
    console.log(`  Gate VERDICTS are server-deterministic (no model) — identical on either.`);
  } catch (err) {
    console.log(`  GM provider: <probe failed: ${err?.message || err}>`);
  }
  console.log(`  Running: ${selected.map((s) => s.key).join(", ")}`);
  console.log("════════════════════════════════════════════════════════════");

  const results = [];
  for (const sc of selected) {
    // One shared user, rotated reactively by newRun() only when the per-user daily
    // session cap is actually hit — so the suite completes however many scenarios
    // run, without spraying registrations into the IP rate limit.
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
  if (ANSWERING && ANSWERING.ok) {
    console.log(`  GM (ACTUALLY answering): ${ANSWERING.model} — ${ANSWERING.local ? "⚠️  LOCAL FALLBACK (cloud likely 402; quality WARNs reflect the weak local model)" : "cloud"}`);
  } else if (ANSWERING) {
    console.log(`  GM (actually answering): <probe failed: ${ANSWERING.why}>`);
  }
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
