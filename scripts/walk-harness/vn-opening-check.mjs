#!/usr/bin/env node
// ---------------------------------------------------------------------------
// VN OPENING GUARD (WALK-3 V4). The VOICE's opening speech escaped FOUR fixes by being
// verified at the PAYLOAD layer (vnMode:true) while the CLIENT rendered it as yellow
// bracketed PROSE in the narration log — never through the VN component. This is the
// permanent DOOR guard: it drives a REAL headless-Chrome browser on a REAL Babel run
// from the lobby and asserts, at the DOM level, that on the authored opening:
//   (1) the VOICE's first speech renders through the real VN box (.solo-vn-box), AND
//   (2) it does NOT appear as narration-log text (.solo-voice-dialogue / a look-alike frame).
// VN-PRESENTATION extension: also asserts the owner's TWO-BOXES law at the DOM level — no
// spoken VOICE line leaks into the narration log (JOB 3), the narration box is present during
// the VN beat (JOB 1), and the sprite is staged on the RIGHT when present (JOB 1.2). The
// non-speaker dimming + player-LEFT sprite (JOB 1.3/1.2) are UNBUILT — no player fullbody
// exists — and are reported as NOTEs, never faked green.
//
// Run:  node --experimental-websocket scripts/walk-harness/vn-opening-check.mjs
//       (needs a running play-server on :4173 and google-chrome; it mints its own guest run)
// Exit: 0 = PASS, 1 = FAIL, 2 = harness error (could not reach the opening).
// ---------------------------------------------------------------------------
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const BASE = process.env.NOTDND_HARNESS_BASE_URL || "http://127.0.0.1:4173";
const CHROME = process.env.NOTDND_HARNESS_CHROME || "google-chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mintBabelRun() {
  const g = await (await fetch(BASE + "/api/auth/guest", { method: "POST" })).json();
  const tok = g.token;
  const H = { Authorization: "Bearer " + tok, "Content-Type": "application/json" };
  const body = { world: { scenarioId: "babel" }, character: { name: "Ash", gender: "male", pronouns: "he/him", race: "The Beckoned", characterClass: "The Beckoned" }, scenarioId: "babel" };
  const wr = await (await fetch(BASE + "/api/onboarding/world-run", { method: "POST", headers: H, body: JSON.stringify(body) })).json();
  if (!wr.ok) throw new Error("world-run failed: " + JSON.stringify(wr).slice(0, 200));
  const runId = wr.run?.runId || wr.runId || wr.run?.id;
  // sanity: the server must genuinely commit the opening as the VOICE's VN turn
  const sc = await (await fetch(`${BASE}/api/solo/runs/${runId}/scene`, { headers: H })).json();
  const s = sc.scene || sc;
  if (s.vnMode !== true || s.speakerId !== "npc_voice") throw new Error(`payload not a VN opening (vnMode=${s.vnMode}, speakerId=${s.speakerId})`);
  return { runId, tok };
}

// A representative laptop viewport. JOB 3's off-screen overflow is a VERTICAL bug, so the
// stage must be measured at a bounded height, not the headless default.
const VIEW_W = Number(process.env.NOTDND_HARNESS_VIEW_W || 1440);
const VIEW_H = Number(process.env.NOTDND_HARNESS_VIEW_H || 820);

async function inspectDom(tok) {
  const port = 9400 + Math.floor(Math.random() * 500);
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, "--no-sandbox", "--disable-gpu", "--no-first-run", `--window-size=${VIEW_W},${VIEW_H}`, `--user-data-dir=/tmp/vnguard-${crypto.randomBytes(4).toString("hex")}`, "about:blank"], { stdio: "ignore" });
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
    await sleep(4500);
    // Wait (bounded) for the VN sprite (vnBody) to cook + load: the JOB 3 overflow only
    // manifests once the ~600px full-body sprite is present. Without it the layout check is
    // trivially green. If it never loads, spritePresent stays false (reported, not a fake pass).
    for (let i = 0; i < 24; i++) {
      const loaded = await ev(`!!document.querySelector('.solo-vn-sprite-img.is-loaded') || (()=>{const s=document.querySelector('.solo-vn-sprite-img');return !!(s&&s.naturalWidth>0);})()`);
      if (loaded) break;
      await sleep(3000);
    }
    return await ev(`(()=>{
      const VH = window.innerHeight, VWp = window.innerWidth;
      const vn = document.querySelector('.solo-vn-box');
      const vnText = vn ? (vn.querySelector('.solo-vn-box-text')?.innerText || '') : '';
      const vnSpeaker = vn ? (vn.querySelector('.solo-vn-box-speaker')?.innerText || '') : '';
      const log = document.querySelector('.solo-narration-log');
      const logText = log ? log.innerText : '';
      const bottom = (el) => el ? Math.round(el.getBoundingClientRect().bottom) : null;
      const vnTextEl = vn ? vn.querySelector('.solo-vn-box-text') : null;
      const sprite = document.querySelector('.solo-vn-sprite-img');
      // JOB 4.2b — the scene image's PAINTED width (object-fit aware) vs its container width.
      const img = document.querySelector('.solo-scene-art-img');
      const strip = document.querySelector('.solo-stage .solo-scene-art') || document.querySelector('.solo-scene-art');
      let scenePaintedW = null, sceneContainerW = null;
      if (img && strip) {
        const b = img.getBoundingClientRect(); sceneContainerW = Math.round(strip.getBoundingClientRect().width);
        const nW = img.naturalWidth, nH = img.naturalHeight;
        scenePaintedW = (nW && nH) ? Math.round(Math.min(b.width, b.height * nW / nH)) : 0;
      }
      return {
        viewportH: VH, viewportW: VWp,
        hasVnBox: !!vn,
        vnSpeaker,
        vnHasVoiceWords: /YOU ARE HEARD|CLIMB|HEAR ME|CHAOS/.test(vnText),
        logHasVoiceWords: /YOU ARE HEARD|CLIMB|HEAR ME/.test(logText),
        yellowVoiceSpansInLog: log ? log.querySelectorAll('.solo-voice-dialogue').length : -1,
        lookalikeFramesInLog: log ? log.querySelectorAll('.solo-opening-vn').length : -1,
        spritePresent: !!(sprite && sprite.naturalWidth > 0),
        // NARRATION BOX (owner law): the narration log is ALWAYS present during a VN beat —
        // it is never replaced or hidden by the dialogue surface.
        narrationLogPresent: !!log,
        // SPRITE PLACEMENT (owner law: the speaking NPC stands on the RIGHT). When a sprite is
        // present, its horizontal centre must sit right-of-stage-centre. null when absent.
        spriteSide: (() => {
          const sp = document.querySelector('.solo-vn-sprite');
          const st = document.querySelector('.solo-stage');
          if (!sp || !st) return null;
          const a = sp.getBoundingClientRect(), b = st.getBoundingClientRect();
          return (a.left + a.right) / 2 >= (b.left + b.right) / 2 ? 'right' : 'left';
        })(),
        // SPRITE↔HUD overlap (owner JOB 1.5): reported, not enforced — the large-sprite-vs-HUD
        // coexistence is an unresolved owner STOP (the sprite currently overlaps the top-right
        // HUD row; making it "large" per 1.4 deepens the overlap). Surfaces the intersection so
        // a regression that grows it is visible in the guard log.
        hudSpriteOverlap: (() => {
          const sp = document.querySelector('.solo-vn-sprite');
          const hud = document.querySelector('.solo-stage-hud');
          if (!sp || !hud) return null;
          const a = sp.getBoundingClientRect(), h = hud.getBoundingClientRect();
          const ix = Math.max(0, Math.min(a.right, h.right) - Math.max(a.left, h.left));
          const iy = Math.max(0, Math.min(a.bottom, h.bottom) - Math.max(a.top, h.top));
          return Math.round(ix) + 'x' + Math.round(iy) + 'px';
        })(),
        vnTextBottom: bottom(vnTextEl),
        logBottom: bottom(log),
        scenePaintedW, sceneContainerW,
        sceneSpanRatio: (scenePaintedW && sceneContainerW) ? Math.round(100 * scenePaintedW / sceneContainerW) : null
      };
    })()`);
  } finally { try { chrome.kill("SIGKILL"); } catch { /* gone */ } }
}

(async () => {
  if (typeof WebSocket === "undefined") { console.error("run with --experimental-websocket"); process.exit(2); }
  let dom;
  try {
    const { tok } = await mintBabelRun();
    dom = await inspectDom(tok);
  } catch (e) { console.error("VN GUARD HARNESS ERROR:", e.message); process.exit(2); }

  const checks = [
    ["VN box present on the opening", dom.hasVnBox === true],
    ["VN box speaker is 'The VOICE'", /VOICE/i.test(dom.vnSpeaker)],
    ["VOICE's words render IN the VN box", dom.vnHasVoiceWords === true],
    ["VOICE's words are NOT in the narration log", dom.logHasVoiceWords === false],
    ["no yellow .solo-voice-dialogue prose in the log", dom.yellowVoiceSpansInLog === 0],
    ["no VN look-alike frame in the log", dom.lookalikeFramesInLog === 0],
    // OWNER LAW (JOB 3): dialogue lives ONLY in the VN box, narration ONLY in the log. This is
    // the durable guard on logNarration's opening-beat split — a spoken VOICE line must never
    // re-file into the narration channel again (the exact regression this dispatch fixed).
    ["no spoken VOICE line leaks into the narration log (JOB 3)", dom.logHasVoiceWords === false],
    // OWNER LAW (JOB 1): the narration box is ALWAYS present during a VN beat, never hidden.
    ["narration box is present during the VN beat (never hidden)", dom.narrationLogPresent === true],
    // OWNER LAW (JOB 1.2): the speaking NPC stands on the RIGHT. Assert-when-present (the sprite
    // is library/quota-gated on a guest run, so a spriteless run reports rather than fails).
    [`VN sprite is staged on the RIGHT when present (side=${dom.spriteSide})`, dom.spriteSide == null || dom.spriteSide === 'right'],
    // JOB 4.2a — LAYOUT: the VN dialogue text and the narration must both stay ON screen. The
    // ~600px VN sprite once pushed them off the bottom (JOB 3). Only meaningful with the sprite
    // present (the overflow condition) — reported below so a spriteless run isn't a silent pass.
    [`VN dialogue text is within the viewport (bottom ${dom.vnTextBottom} <= ${dom.viewportH})`, dom.vnTextBottom == null || dom.vnTextBottom <= dom.viewportH],
    [`narration log is within the viewport (bottom ${dom.logBottom} <= ${dom.viewportH})`, dom.logBottom == null || dom.logBottom <= dom.viewportH],
    // JOB 4.2b — the scene image, when rendered, PAINTS non-zero width in its container. (Full-
    // bleed vs letterbox is an unresolved owner conflict — see JOB 2 — so this checks that it
    // renders and REPORTS the span ratio; it deliberately does NOT enforce edge-to-edge.)
    ["scene image (when present) paints non-zero width in its container", dom.scenePaintedW == null || dom.scenePaintedW > 0]
  ];
  console.log(`=== VN OPENING GUARD (DOM-level, real browser @ ${dom.viewportW}x${dom.viewportH}) ===`);
  for (const [label, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  console.log(`  NOTE  VN sprite present this run: ${dom.spritePresent} (side/layout checks are only a real guard when true)`);
  console.log(`  NOTE  sprite↔HUD overlap: ${dom.hudSpriteOverlap == null ? "no sprite this run" : dom.hudSpriteOverlap + " — reported not enforced (JOB 1.4/1.5 large-sprite-vs-HUD STOP, owner call)"}`);
  console.log(`  NOTE  non-speaker DIMMING + player-LEFT sprite are UNBUILT (JOB 1.2/1.3): no player fullbody asset exists and there is no player-speaking VN beat, so only one (NPC) sprite ever renders — nothing to dim, no left slot to stage. Not asserted (would be a fake green).`);
  console.log(`  NOTE  scene image span: ${dom.sceneSpanRatio == null ? "image not cooked yet this run" : dom.sceneSpanRatio + "% of container width (" + dom.scenePaintedW + "/" + dom.sceneContainerW + "px) — JOB 2 conflict, reported not enforced"}`);
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length) { console.log(`\nFAIL — ${failed.length} check(s) failed. DOM: ${JSON.stringify(dom)}`); process.exit(1); }
  console.log("\nPASS — the VOICE speaks through the real VN box (not narration prose), and the VN dialogue + narration stay on screen.");
  process.exit(0);
})();
