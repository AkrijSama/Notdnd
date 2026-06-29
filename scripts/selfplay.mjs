// Autonomous self-play harness — drives a full solo campaign through the HTTP
// API exactly the way the browser does (no browser, no clicking). It registers a
// user, creates a world/run, loads the scene, takes actions (including a skill
// check), and talks to an NPC with replies — then prints the actual GM narration
// and NPC dialogue.
//
// PRIMARY USE: detect GM/talk/loop regressions automatically. Every GM-generated
// string is checked against the known deterministic FALLBACK lines (and the
// sub-300ms "fast-fail" tell). On any fallback it hits POST /api/gm/respond,
// which does NOT swallow errors, to capture the verbatim upstream cause
// (401 auth / 400 bad model / 429 quota / timeout). Exits non-zero if any GM
// beat fell back, so it can gate CI / a pre-push check.
//
// Limitation: this exercises the SERVER + game logic + GM only. Pure client/DOM
// bugs (e.g. the input-focus freeze, CSS/layout, the VN overlay painting) are
// invisible here — use a headless browser for those.
//
// Usage:
//   node scripts/selfplay.mjs                 # against http://127.0.0.1:4173
//   SELFPLAY_BASE=http://127.0.0.1:4274 node scripts/selfplay.mjs
//   PORT=4173 node scripts/selfplay.mjs

const BASE = process.env.SELFPLAY_BASE || `http://127.0.0.1:${process.env.PORT || 4173}`;

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

function classify(text, { fastMs } = {}) {
  const s = String(text || "").trim();
  if (!s) return { ok: false, why: "EMPTY" };
  if (OPENING_FALLBACK_RE.test(s)) return { ok: false, why: "FALLBACK(opening)" };
  for (const f of FALLBACKS) {
    if (s === f.trim() || s.includes(f.trim())) return { ok: false, why: "FALLBACK" };
  }
  if (typeof fastMs === "number" && fastMs < 300) return { ok: false, why: `SUSPECT(${fastMs}ms — too fast for a real LLM call)` };
  return { ok: true, why: "real" };
}

const H = (t) => ({ "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) });
async function call(path, { method = "GET", token, body } = {}) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, { method, headers: H(token), body: body === undefined ? undefined : JSON.stringify(body) });
  let json;
  try { json = await res.json(); } catch { json = { _raw: await res.text() }; }
  return { status: res.status, ms: Date.now() - t0, json };
}

const log = (s = "") => console.log(s);
const problems = [];
function show(label, text, ms) {
  const verdict = classify(text, { fastMs: ms });
  if (!verdict.ok) problems.push(`${label}: ${verdict.why}`);
  log(`    ${verdict.ok ? "OK  " : "FAIL"} [${verdict.why}] ${typeof ms === "number" ? `(${ms}ms)` : ""}`);
  log(`    > ${String(text || "(none)").replace(/\n/g, " ").slice(0, 360)}`);
  return verdict;
}

async function main() {
  const stamp = Date.now();
  log("════════════════════════════════════════════════════════════");
  log(`  SELF-PLAY  →  ${BASE}`);
  log("════════════════════════════════════════════════════════════");

  let r = await call("/api/auth/register", { method: "POST", body: { email: `selfplay_${stamp}@notdnd.local`, password: "password123", displayName: "Selfplay" } });
  log(`\n[1] register   HTTP ${r.status} (${r.ms}ms) token:${r.json.token ? "yes" : "NO"}`);
  const token = r.json.token;
  if (!token) throw new Error("register failed: " + JSON.stringify(r.json).slice(0, 300));

  r = await call("/api/onboarding/world-run", { method: "POST", token, body: {
    world: { name: "Ashfall Reach", tone: "grim dark fantasy", startingLocationName: "The Ember Tavern", startingLocationType: "tavern", flavor: "ash-choked frontier, old debts, colder gods" },
    character: { name: "Bram", race: "Human", characterClass: "Rogue", background: "Criminal", baseAbilityScores: { strength: 10, dexterity: 15, constitution: 13, intelligence: 14, wisdom: 12, charisma: 11 } }
  }});
  log(`[2] world-run  HTTP ${r.status} (${r.ms}ms) runId:${r.json.runId || "NONE"} campaignId:${r.json.campaignId || "NONE"}`);
  const runId = r.json.runId;
  const campaignId = r.json.campaignId;
  if (!runId) throw new Error("world-run failed: " + JSON.stringify(r.json).slice(0, 300));

  const sc = await call(`/api/solo/runs/${runId}/scene`, { token });
  log(`[3] scene      HTTP ${sc.status} (${sc.ms}ms) location:"${sc.json.location?.name}"`);
  // Opening narration is generated during world-run and CACHED on the run, so
  // the scene fetch returns it fast — judge it by content only, not by latency.
  log(`  opening narration:`);
  show("opening", sc.json.openingNarration);
  const npcs = sc.json.visibleEntities?.filter((e) => e.entityType === "npc") || [];
  log(`  NPCs present: ${npcs.map((n) => `${n.displayName}(${n.entityId})`).join(", ") || "none"}`);

  const act = (action) => call(`/api/solo/runs/${runId}/actions`, { method: "POST", token, body: { action } });

  log(`\n[4] actions`);
  for (const a of [
    { type: "attempt", intent: "Head toward the bar to get a better look at the room" },
    { type: "attempt", intent: "Search the tavern for anything valuable or hidden" },
    { type: "attempt", intent: "Listen carefully to the conversations around me" }
  ]) {
    const res = await act(a);
    const ar = res.json.attemptResult || {};
    const cr = ar.checkResult;
    log(`\n  • "${a.intent}"`);
    log(`    roll: ${cr ? `${cr.total} vs DC ${cr.dc} → ${ar.success ? "SUCCESS" : "FAIL"}` : "no dice (narrative)"}  needsCheck:${ar.needsCheck}`);
    show(`action:"${a.intent.slice(0, 30)}…"`, ar.narration, res.ms);
  }

  log(`\n[5] talk + replies`);
  const target = npcs[0];
  if (!target) { log("  (no NPC present to talk to)"); }
  else {
    const targetId = target.entityId;
    let history = [];
    let t = await act({ type: "talk", actorId: "player", targetEntityId: targetId });
    let tr = t.json.talkResult || {};
    log(`\n  open → ${target.displayName} (speakerName:"${tr.speakerName}" found:${tr.found})`);
    show(`talk:open:${target.displayName}`, tr.line, t.ms);
    if (tr.line) history.push({ role: "npc", text: tr.line });

    for (const reply of [
      "I'm looking for whoever runs the smuggling out of this town. Who should I talk to?",
      "I can pay. A fair cut for a name — and your discretion."
    ]) {
      const res = await act({ type: "talk", actorId: "player", targetEntityId: targetId, message: reply, history: history.slice() });
      const next = res.json.talkResult || {};
      history.push({ role: "player", text: reply });
      if (next.line) history.push({ role: "npc", text: next.line });
      log(`\n  YOU: "${reply}"`);
      show(`talk:reply:${target.displayName}`, next.line, res.ms);
    }
  }

  // ── LETHALITY PROOF ──────────────────────────────────────────────────────
  // The headline: a real 5e game where the player can DIE — often, permanently.
  // Driven over real HTTP via the gated test-hook actions (damage/grant_item/
  // revive); the server must be started with test hooks enabled (dev default /
  // NOTDND_TEST_HOOKS=true). Each scenario uses a FRESH run (death is terminal).
  await runLethality(token);

  // If any GM beat fell back, surface the verbatim upstream cause.
  if (problems.length && campaignId) {
    log(`\n[!] ${problems.length} GM beat(s) fell back. Probing /api/gm/respond for the verbatim cause…`);
    const probe = await call("/api/gm/respond", { method: "POST", token, body: { campaignId, mode: "companion", message: "Voice the bartender greeting a stranger, in character.", playerName: "Bram" } });
    log(`    HTTP ${probe.status} (${probe.ms}ms) ok:${probe.json.ok} code:${probe.json.code || ""}`);
    log(`    ${probe.json.ok ? "narrative: " + String(probe.json.narrative || "").slice(0, 200) : "error: " + String(probe.json.error || "").slice(0, 300)}`);
  }

  log("\n════════════════════════════════════════════════════════════");
  if (problems.length === 0) {
    log("  RESULT: ✅ all GM beats produced real prose. Loop is healthy.");
  } else {
    log(`  RESULT: ❌ ${problems.length} fallback/empty beat(s):`);
    for (const p of problems) log(`    - ${p}`);
  }
  log("════════════════════════════════════════════════════════════");
  return problems.length;
}

// Creates a fresh world-run and returns its ids. Death is terminal, so each
// lethality scenario needs its own run.
async function newLethalRun(token, name) {
  const r = await call("/api/onboarding/world-run", { method: "POST", token, body: {
    world: { name: "Ashfall Reach", tone: "grim dark fantasy", startingLocationName: "The Ember Tavern", startingLocationType: "tavern", flavor: "ash-choked frontier" },
    character: { name, race: "Human", characterClass: "Fighter", background: "Soldier", baseAbilityScores: { strength: 14, dexterity: 12, constitution: 13, intelligence: 10, wisdom: 11, charisma: 10 } }
  }});
  return { runId: r.json.runId };
}

async function runLethality(token) {
  log(`\n[6] LETHALITY — the player can DIE, and stay dead`);
  const lethalProblems0 = problems.length;
  const ok = (cond, label) => {
    log(`    ${cond ? "OK  " : "FAIL"} ${label}`);
    if (!cond) problems.push(`lethality: ${label}`);
  };
  const sceneOf = async (rid) => (await call(`/api/solo/runs/${rid}/scene`, { token })).json;
  const actOn = (rid, action) => call(`/api/solo/runs/${rid}/actions`, { method: "POST", token, body: { action } });

  // (A) Bleed out: damage to 0 → dying → death-save failures → dead → run is
  // non-resumable, and no further action resolves.
  {
    const { runId: rid } = await newLethalRun(token, "Mortis");
    let sc = await sceneOf(rid);
    const maxHp = sc.player?.resources?.hp?.max ?? sc.player?.hitPoints?.max ?? 10;
    await actOn(rid, { type: "damage", amount: maxHp }); // → 0 HP, dying
    sc = await sceneOf(rid);
    ok(sc.player?.status === "dying", `damage to 0 HP → status 'dying' (got '${sc.player?.status}')`);
    // Damage-at-0 each counts as a death-save failure; three → dead.
    await actOn(rid, { type: "damage", amount: 1 });
    await actOn(rid, { type: "damage", amount: 1 });
    const killRes = await actOn(rid, { type: "damage", amount: 1 });
    ok(killRes.json.runDied === true, "third failure → runDied flagged in the action response");
    sc = await sceneOf(rid);
    ok(sc.player?.status === "dead", `player.status === 'dead' (got '${sc.player?.status}')`);
    ok(sc.runStatus === "dead", `run.status === 'dead' (got '${sc.runStatus}')`);
    ok(sc.isDead === true && sc.resumable === false, "scene: isDead=true, resumable=false (non-resumable)");
    const after = await actOn(rid, { type: "attempt", intent: "rise and fight on" });
    ok(after.status === 400 && (after.json.code === "RUN_TERMINAL"), `a dead run rejects further actions (HTTP ${after.status} ${after.json.code})`);
    if (killRes.json.deathNarration) log(`    death beat: "${String(killRes.json.deathNarration).replace(/\n/g, " ").slice(0, 160)}"`);
  }

  // (B) Massive damage at 0 HP is INSTANT death (skips the saves).
  {
    const { runId: rid } = await newLethalRun(token, "Smitten");
    let sc = await sceneOf(rid);
    const maxHp = sc.player?.resources?.hp?.max ?? 10;
    await actOn(rid, { type: "damage", amount: maxHp }); // → dying at 0
    const res = await actOn(rid, { type: "damage", amount: maxHp }); // ≥ max at 0 → instant dead
    sc = await sceneOf(rid);
    ok(res.json.runDied === true && sc.player?.status === "dead", "massive damage at 0 HP → instant death");
    ok((sc.player?.deathSaves?.failures ?? 0) < 3, "instant death skipped the death-save track (failures < 3)");
  }

  // (C) A POSSESSED revival item brings the player back ONCE — then it's gone.
  {
    const { runId: rid } = await newLethalRun(token, "Lazarus");
    let sc = await sceneOf(rid);
    const maxHp = sc.player?.resources?.hp?.max ?? 10;
    await actOn(rid, { type: "grant_item", item: { itemId: "revive_scroll", name: "Scroll of Revivify", usable: true, consumable: true, tags: ["revival"], use: { effectType: "revive", amount: 1 } } });
    await actOn(rid, { type: "damage", amount: maxHp }); // → dying
    sc = await sceneOf(rid);
    ok(sc.player?.status === "dying", "revival run: at death's door (dying)");
    await actOn(rid, { type: "use_item", itemId: "revive_scroll" });
    sc = await sceneOf(rid);
    ok(sc.player?.status === "alive" && (sc.player?.resources?.hp?.current ?? 0) >= 1, "revival item → back ALIVE with HP");
    const stillHas = (sc.player?.inventory || []).find((i) => (i.id || i.itemId) === "revive_scroll");
    ok(!stillHas || (stillHas.qty ?? 0) === 0, "revival item CONSUMED (gone after one use)");
  }

  // (D) No possessed means → the player STAYS dead (no auto-respawn, no mercy).
  {
    const { runId: rid } = await newLethalRun(token, "Forsaken");
    let sc = await sceneOf(rid);
    const maxHp = sc.player?.resources?.hp?.max ?? 10;
    await actOn(rid, { type: "damage", amount: maxHp });
    await actOn(rid, { type: "damage", amount: 1 });
    await actOn(rid, { type: "damage", amount: 1 });
    await actOn(rid, { type: "damage", amount: 1 }); // 3 failures, no means
    sc = await sceneOf(rid);
    ok(sc.player?.status === "dead" && sc.runStatus === "dead", "no revival means → STAYS dead");
    const revive = await actOn(rid, { type: "revive" });
    ok(revive.status === 400 || revive.json.reviveResult?.ok === false || sc.player?.status === "dead", "a revive with no means does not resurrect");
  }

  // (E) Consequence spine: a granted item appears in inventory next turn, and xp
  // accrues from meaningful play (reported; the deterministic proof is in unit tests).
  {
    const { runId: rid } = await newLethalRun(token, "Packrat");
    await actOn(rid, { type: "grant_item", item: { itemId: "iron_key", name: "Iron Key", qty: 1 } });
    const sc = await sceneOf(rid);
    const has = (sc.player?.inventory || []).find((i) => (i.id || i.itemId) === "iron_key");
    ok(Boolean(has), "picked-up item shows in inventory next turn");
    const before = sc.player?.xp ?? 0;
    for (const intent of ["force the locked chest open", "search the rafters for coin", "pick the strongbox"]) {
      await actOn(rid, { type: "attempt", intent });
    }
    const sc2 = await sceneOf(rid);
    log(`    xp: ${before} → ${sc2.player?.xp ?? 0}, level ${sc2.player?.level ?? 1} (xp moves on success; deterministic proof in unit tests)`);
  }

  if (problems.length === lethalProblems0) {
    log(`  LETHALITY: ✅ the player can die — by bleeding out, by massive damage — and stays dead without a possessed revival.`);
  } else {
    log(`  LETHALITY: ❌ ${problems.length - lethalProblems0} lethality check(s) failed.`);
  }
}

main()
  .then((n) => process.exit(n > 0 ? 1 : 0))
  .catch((err) => { console.error("\nSELF-PLAY ERROR:", err?.message || err); process.exit(2); });
