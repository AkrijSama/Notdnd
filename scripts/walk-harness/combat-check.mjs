#!/usr/bin/env node
// COMBAT DOOR GUARD (JOB 5 — closes the blind spot). The walk-door harness walked the opening
// and STOPPED; it never entered a fight, so a combat with NO player interface passed green. This
// drives a REAL fight in a REAL headless-Chrome browser to a CONCLUSION and asserts, at the DOM
// level, that: the combat PANEL renders, the five-action menu is present + correctly enabled, the
// initiative forecast shows portrait chips, a turn can be TAKEN via the Attack button, HP/state
// CHANGES as a result, and the fight REACHES a resolution (victory or death) — control leaving the
// panel. A build where combat starts but cannot be played turns this RED (the Attack button either
// isn't there or does nothing → "a turn changed state" fails). BEFORE this dispatch there was no
// panel and no button, so this guard could not even be written — the old harness passed a fight
// that could not be played.
//
// Run:  node --experimental-websocket scripts/walk-harness/combat-check.mjs
//       (needs a running play-server on :4173 + google-chrome; mints its own guest run)
// Exit: 0 = PASS, 1 = FAIL, 2 = harness error (could not reach combat).
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { guardBrowser } from "./browser-cleanup.mjs";

const BASE = process.env.NOTDND_HARNESS_BASE_URL || "http://127.0.0.1:4173";
const CHROME = process.env.NOTDND_HARNESS_CHROME || "google-chrome";
const VIEW_W = Number(process.env.NOTDND_HARNESS_VIEW_W || 1440);
const VIEW_H = Number(process.env.NOTDND_HARNESS_VIEW_H || 820);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Setup (via the API — exploration + the triggering attack are NOT the surface under test; the
// COMBAT PANEL is): mint a Babel run, MOVE to the Grey's location, and start the fight with one
// attack. The browser then loads INTO the live fight and PLAYS it to a conclusion via the panel.
async function mintInCombat() {
  const g = await (await fetch(BASE + "/api/auth/guest", { method: "POST" })).json();
  const tok = g.token;
  const H = { Authorization: "Bearer " + tok, "Content-Type": "application/json" };
  const body = { world: { scenarioId: "babel" }, character: { name: "Ash", gender: "male", pronouns: "he/him", race: "The Beckoned", characterClass: "The Beckoned" }, scenarioId: "babel" };
  const wr = await (await fetch(BASE + "/api/onboarding/world-run", { method: "POST", headers: H, body: JSON.stringify(body) })).json();
  if (!wr.ok) throw new Error("world-run failed: " + JSON.stringify(wr).slice(0, 200));
  const runId = wr.run?.runId || wr.runId;
  await (await fetch(`${BASE}/api/solo/runs/${runId}/actions`, { method: "POST", headers: H, body: JSON.stringify({ action: { type: "move", actorId: "player", toLocationId: "loc_waking_mile" } }) })).json();
  let sc = await (await fetch(`${BASE}/api/solo/runs/${runId}/scene`, { headers: H })).json();
  let s = sc.scene || sc;
  const grey = (s.cast || []).find((c) => /grey/i.test(c.displayName || "") || /grey/i.test(c.npcId || ""));
  if (!grey) throw new Error("the Limping Grey is not present at the Waking Mile (cast: " + (s.cast || []).map((c) => c.displayName).join(", ") + ")");
  // Start the fight (the free-text attack path — the SAME classifier the input bar reaches).
  // Low fixed rolls make the opening round BLOODLESS (both sides miss) so combat is reliably
  // ACTIVE when the browser loads — the Grey is a lethal fight and a random opening can drop a
  // level-1 player in one round. The browser then plays it out live (its clicks carry no rolls).
  await (await fetch(`${BASE}/api/solo/runs/${runId}/actions`, { method: "POST", headers: H, body: JSON.stringify({ action: { type: "attempt", actorId: "player", intent: `attack the ${grey.displayName}`, testHook: { fixedRolls: Array(24).fill(2) } } }) })).json();
  sc = await (await fetch(`${BASE}/api/solo/runs/${runId}/scene`, { headers: H })).json();
  s = sc.scene || sc;
  if (!s.combat || s.combat.status !== "active") throw new Error("combat did not start after the attack (status=" + (s.combat?.status || "none") + ")");
  // Pre-damage the foe to BLOODIED (deterministic: player hits low, foe misses) so the BROWSER
  // fight resolves in 1-2 clicks. A GM-narrated combat turn is ~12s and variable; a full random
  // multi-turn grind made the resolution flaky (slow turns → skipped clicks). This is NOT
  // loosening — the browser still drives the panel→Attack→turn→resolution loop; it just starts
  // the foe near death so a couple of real clicks finish it. Foe left ALIVE for the browser.
  for (let i = 0; i < 4; i++) {
    const foe = (s.combat?.enemies || [])[0];
    const foeHp = foe?.hp?.current ?? 99;
    const pHp = s.player?.hitPoints?.current ?? 0;
    if (!s.combat || s.combat.status !== "active" || foeHp <= 2 || pHp <= 1) break;
    await (await fetch(`${BASE}/api/solo/runs/${runId}/actions`, { method: "POST", headers: H, body: JSON.stringify({ action: { type: "attempt", actorId: "player", intent: `attack the ${grey.displayName}`, testHook: { fixedRolls: [16, 2, 1, 2, 16, 2, 1, 2] } } }) })).json();
    sc = await (await fetch(`${BASE}/api/solo/runs/${runId}/scene`, { headers: H })).json();
    s = sc.scene || sc;
  }
  // If the pre-damage happened to end the fight, restart a fresh one (rare) so the browser has a live fight.
  if (!s.combat || s.combat.status !== "active") {
    return await mintInCombat();
  }
  return { runId, tok, greyName: grey.displayName };
}

async function run() {
  if (typeof WebSocket === "undefined") { console.error("run with --experimental-websocket"); process.exit(2); }
  let ctx;
  try { ctx = await mintInCombat(); } catch (e) { console.error("COMBAT GUARD HARNESS ERROR (setup):", e.message); process.exit(2); }
  const { runId, tok } = ctx;

  const port = 9500 + Math.floor(Math.random() * 400);
  const userDataDir = `/tmp/combatguard-${crypto.randomBytes(4).toString("hex")}`;
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, "--no-sandbox", "--disable-gpu", "--no-first-run", `--window-size=${VIEW_W},${VIEW_H}`, `--user-data-dir=${userDataDir}`, "about:blank"], { stdio: "ignore" });
  // JOB 0.2: cleanup that SURVIVES a timeout-wrapper SIGTERM (the exact zombie leak) + reaps any
  // prior hard-SIGKILLed orphan on start. Without this the finally below never runs on a signal.
  const cleanupBrowser = guardBrowser(chrome, userDataDir);
  const checks = [];
  const record = (label, ok) => checks.push([label, !!ok]);
  try {
    let wsUrl;
    for (let i = 0; i < 40 && !wsUrl; i++) { await sleep(250); try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); wsUrl = l.find((t) => t.type === "page")?.webSocketDebuggerUrl; } catch { /* not up */ } }
    if (!wsUrl) throw new Error("CDP target never appeared");
    const ws = new WebSocket(wsUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("cdp ws failed")); });
    let id = 0; const pend = new Map(); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (x) => (await cmd("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
    await cmd("Page.enable"); await cmd("Runtime.enable");
    await cmd("Emulation.setDeviceMetricsOverride", { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1, mobile: false });
    await cmd("Page.addScriptToEvaluateOnNewDocument", { source: `try{localStorage.setItem('notdnd_auth_token_v1',${JSON.stringify(tok)})}catch(e){}` });
    await cmd("Page.navigate", { url: BASE + "/" }); await sleep(3500);
    await ev(`(()=>{const b=[...document.querySelectorAll('button,a')].find(x=>/continue|resume|open|enter|play/i.test(x.textContent||''));if(b)b.click();})()`);
    await sleep(3500);
    // The run loads INTO a live fight (combat started in setup): the panel must appear.
    for (let i = 0; i < 20; i++) { const on = await ev(`!!document.querySelector('.solo-combat-panel')`); if (on) break; await sleep(700); }

    const snap = () => ev(`(()=>{
      const panel=document.querySelector('.solo-combat-panel');
      const btns={}; document.querySelectorAll('.solo-combat-menu [data-solo-combat]').forEach(b=>{btns[b.getAttribute('data-solo-combat')]={present:true,disabled:b.hasAttribute('disabled')};});
      const chips=document.querySelectorAll('.solo-init-forecast .solo-init-chip').length;
      const faces=document.querySelectorAll('.solo-init-forecast .solo-init-face-img, .solo-init-forecast .solo-init-face-fallback').length;
      const hpNum=document.querySelector('.solo-combat-hp-num')?.innerText||'';
      const foeBar=document.querySelector('.solo-combat-foes .solo-combat-hp')?.className||'';
      const beat=document.querySelector('[data-solo-combat-beat]')?.innerText||'';
      const logBottom=(el=>el?Math.round(el.getBoundingClientRect().bottom):null)(document.querySelector('.solo-narration-log'));
      const victory=!!document.querySelector('[data-solo-victory]'); const death=!!document.querySelector('[data-solo-death]');
      return {hasPanel:!!panel, btns, chips, faces, hpNum, foeBar, beat, VH:window.innerHeight, logBottom, victory, death};
    })()`);

    const a = await snap();
    record("combat PANEL renders (bottom region swapped)", a.hasPanel === true);
    record("action menu: Attack present + enabled", a.btns.attack && a.btns.attack.present && !a.btns.attack.disabled);
    record("action menu: Guard present + enabled", a.btns.guard && a.btns.guard.present && !a.btns.guard.disabled);
    record("action menu: Escape present + enabled", a.btns.escape && a.btns.escape.present && !a.btns.escape.disabled);
    record("action menu: Skills present + DISABLED (canon: no skills yet)", a.btns.skills && a.btns.skills.present && a.btns.skills.disabled === true);
    record("action menu: Items present (disabled when bag empty)", a.btns.items && a.btns.items.present);
    record("initiative forecast shows portrait chips", a.chips >= 2 && a.faces >= 2);
    record("player HP is shown in the panel", /\d+\/\d+/.test(a.hpNum));
    record(`combat panel fits the bottom region (on-screen ${a.logBottom} <= ${a.VH})`, a.logBottom == null || a.logBottom <= a.VH);

    const isDone = (s) => s.victory || s.death || !s.hasPanel;
    // A combat turn takes ~10-12s (the GM narrates the committed round), so WAIT for it to
    // settle before the next click rather than a fixed pace: the Attack button is disabled
    // while busy and re-enables when the round + re-render land. Bounded so a hang can't stall.
    const clickAttack = () => ev(`(()=>{const b=document.querySelector('.solo-combat-menu [data-solo-combat="attack"]');if(b&&!b.hasAttribute('disabled')){b.click();return true;}return false;})()`);
    const takeTurn = async () => {
      const clicked = await clickAttack();
      if (!clicked) { await sleep(1000); return { ...(await snap()), dispatched: false }; }
      await sleep(600);
      let sawBusy = false;
      // PATIENT: a GM-narrated turn can take 25-35s. Wait for it to FULLY settle (button re-enabled
      // or the fight ended) so the NEXT click always lands — a premature return leaves the button
      // busy and the next click is silently skipped, stalling the fight.
      for (let i = 0; i < 70; i++) { // up to ~42s
        const s = await snap();
        if (isDone(s)) return { ...s, dispatched: true };
        const busy = await ev(`!!document.querySelector('[data-solo-combat="attack"][disabled]')`);
        if (busy) sawBusy = true;
        else if (sawBusy || i >= 5) return { ...s, dispatched: sawBusy }; // busy→clear = a full turn landed
        await sleep(600);
      }
      return { ...(await snap()), dispatched: sawBusy };
    };

    // 2. TAKE A TURN via the Attack button; a REAL turn makes the button go BUSY (dispatched) —
    // a DEAD button never goes busy and never changes state (and the resolution check below also
    // requires real turns, so a dead button can never green this guard).
    let after = await takeTurn();
    record("a turn was TAKEN via Attack — the button dispatched a real turn (not a dead button)", after.dispatched || after.hpNum !== a.hpNum || after.foeBar !== a.foeBar || after.beat !== a.beat || isDone(after));

    // 3. Play to a RESOLUTION and a COHERENT post-fight surface — ONE robust check. Keep
    // attacking until the panel is gone (the fight is decisive: player 8 HP / foe 7 HP, someone
    // drops within ~10 rounds), then wait for the conclusion to render — a death/defeat screen
    // when the player falls, or a return to NORMAL play when the foe is defeated or fled. A
    // GM-narrated turn is slow (~12s), so this is patient, not loosened: a dead button never
    // resolves at all (the "turn was taken" check above already caught that).
    let clicks = 1;
    while (!isDone(after) && clicks < 8) { // foe pre-damaged to ~2 HP → a few LANDED clicks finish it
      clicks++;
      after = await takeTurn();
    }
    let concl = { death: false, victory: false, normal: false, panel: !!after.hasPanel };
    for (let i = 0; i < 20; i++) {
      concl = JSON.parse(await ev(`JSON.stringify({death:!!document.querySelector('[data-solo-death]'),victory:!!document.querySelector('[data-solo-victory]'),normal:!!document.querySelector('.solo-narration-log:not(.is-combat)'),panel:!!document.querySelector('.solo-combat-panel')})`));
      if (concl.death || concl.victory || (concl.normal && !concl.panel)) break;
      await sleep(1000);
    }
    const resolved = concl.death || concl.victory || (concl.normal && !concl.panel);
    record(`the fight was PLAYED to a resolution via the panel — death=${concl.death} / returned-to-play=${concl.normal} (${clicks} attacks)`, resolved);

    console.log(`=== COMBAT DOOR GUARD (DOM-level, real browser @ ${VIEW_W}x${VIEW_H}) ===`);
    for (const [label, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
    const failed = checks.filter(([, ok]) => !ok);
    if (failed.length) { console.log(`\nFAIL — ${failed.length} check(s) failed. runId=${runId}`); process.exit(1); }
    console.log(`\nPASS — a real fight was started, played, and finished IN THE BROWSER via the combat panel. runId=${runId}`);
    process.exit(0);
  } catch (e) {
    console.error("COMBAT GUARD HARNESS ERROR:", e.message); process.exit(2);
  } finally { cleanupBrowser(); }
}
run();
