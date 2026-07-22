#!/usr/bin/env node
// ---------------------------------------------------------------------------
// VN OPENING GUARD (WALK-3 V4). The VOICE's opening speech escaped FOUR fixes by being
// verified at the PAYLOAD layer (vnMode:true) while the CLIENT rendered it as yellow
// bracketed PROSE in the narration log — never through the VN component. This is the
// permanent DOOR guard: it drives a REAL headless-Chrome browser on a REAL Babel run
// from the lobby and asserts, at the DOM level, that on the authored opening:
//   (1) the VOICE's first speech renders through the real VN box (.solo-vn-box), AND
//   (2) it does NOT appear as narration-log text (.solo-voice-dialogue / a look-alike frame).
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

async function inspectDom(tok) {
  const port = 9400 + Math.floor(Math.random() * 500);
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, "--no-sandbox", "--disable-gpu", "--no-first-run", `--user-data-dir=/tmp/vnguard-${crypto.randomBytes(4).toString("hex")}`, "about:blank"], { stdio: "ignore" });
  try {
    let wsUrl;
    for (let i = 0; i < 40 && !wsUrl; i++) { await sleep(250); try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); wsUrl = l.find((t) => t.type === "page")?.webSocketDebuggerUrl; } catch { /* not up */ } }
    if (!wsUrl) throw new Error("CDP target never appeared");
    const ws = new WebSocket(wsUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("cdp ws failed")); });
    let id = 0; const pend = new Map(); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (x) => (await cmd("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
    await cmd("Page.enable"); await cmd("Runtime.enable");
    await cmd("Page.addScriptToEvaluateOnNewDocument", { source: `try{localStorage.setItem('notdnd_auth_token_v1',${JSON.stringify(tok)})}catch(e){}` });
    await cmd("Page.navigate", { url: BASE + "/" }); await sleep(3500);
    await ev(`(()=>{const b=[...document.querySelectorAll('button,a')].find(x=>/continue|resume|open|enter|play/i.test(x.textContent||''));if(b)b.click();})()`);
    await sleep(4500);
    return await ev(`(()=>{
      const vn = document.querySelector('.solo-vn-box');
      const vnText = vn ? (vn.querySelector('.solo-vn-box-text')?.innerText || '') : '';
      const vnSpeaker = vn ? (vn.querySelector('.solo-vn-box-speaker')?.innerText || '') : '';
      const log = document.querySelector('.solo-narration-log');
      const logText = log ? log.innerText : '';
      return {
        hasVnBox: !!vn,
        vnSpeaker,
        vnHasVoiceWords: /YOU ARE HEARD|CLIMB|HEAR ME|CHAOS/.test(vnText),
        logHasVoiceWords: /YOU ARE HEARD|CLIMB|HEAR ME/.test(logText),
        yellowVoiceSpansInLog: log ? log.querySelectorAll('.solo-voice-dialogue').length : -1,
        lookalikeFramesInLog: log ? log.querySelectorAll('.solo-opening-vn').length : -1
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
    ["no VN look-alike frame in the log", dom.lookalikeFramesInLog === 0]
  ];
  console.log("=== VN OPENING GUARD (DOM-level, real browser) ===");
  for (const [label, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length) { console.log(`\nFAIL — the VOICE's opening speech is NOT rendering through the VN component (${failed.length} check(s) failed). DOM: ${JSON.stringify(dom)}`); process.exit(1); }
  console.log("\nPASS — the VOICE speaks through the real VN box; her words never appear as narration-log prose.");
  process.exit(0);
})();
