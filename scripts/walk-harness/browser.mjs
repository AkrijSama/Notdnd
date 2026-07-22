// ---------------------------------------------------------------------------
// WALK-DOOR HARNESS — BROWSER STAGE (the closed blind spot). The HTTP/served-bytes
// harness cannot see the rendered DOM or the browser console; four walks died in
// exactly that gap (a portrait error, a dead websocket, 110 uncounted console
// entries). This stage drives REAL headless Chrome via CDP (node --experimental-
// websocket; no puppeteer) across the lobby, character creation, and a live run, and:
//   • captures EVERY console entry, uncaught exception, browser log, DevTools Issue,
//     and failed network request (including websockets)
//   • asserts expected <img>s rendered with NON-ZERO natural dimensions (pixels, not
//     a resolved URL)
//   • asserts no error-state text is visible where content is expected
// It returns structured findings; the runner fails the walk on any error-level entry,
// failed request, zero-dimension image, or visible error text.
// ---------------------------------------------------------------------------
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const CHROME = process.env.NOTDND_HARNESS_CHROME || "google-chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Error-state phrases that must NOT be visible where content is expected.
const ERROR_PHRASES = [
  "took too long", "art server", "GPU is loaded", "unreachable", "failed to render",
  "returned no image", "something went wrong", "could not load", "try again in a moment"
];

// A CDP session over a raw WebSocket (Node --experimental-websocket global).
async function cdpConnect(port) {
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    await sleep(250);
    try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = l.find((t) => t.type === "page"); if (p) wsUrl = p.webSocketDebuggerUrl; } catch { /* not up yet */ }
  }
  if (!wsUrl) throw new Error("CDP target never appeared");
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP ws failed")); });
  let id = 0; const pending = new Map(); const listeners = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) for (const fn of listeners) fn(m);
  };
  const cmd = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const on = (fn) => listeners.push(fn);
  const evalJs = async (expr) => { const r = await cmd("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };
  return { cmd, on, evalJs, close: () => ws.close() };
}

export async function runBrowserStage({ base, guestToken, runId, viewport = { width: 1440, height: 900 } } = {}) {
  const port = 9200 + Math.floor(Math.random() * 400);
  const userDir = "/tmp/harness-chrome-" + crypto.randomBytes(4).toString("hex");
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, "--no-sandbox", "--disable-gpu", "--no-first-run", `--user-data-dir=${userDir}`, `--window-size=${viewport.width},${viewport.height}`, "about:blank"], { stdio: "ignore" });
  const kill = () => { try { chrome.kill("SIGKILL"); } catch { /* already gone */ } };
  process.on("exit", kill);

  const pages = [];
  try {
    const cdp = await cdpConnect(port);
    // one shared console/network/issue sink, tagged by the page currently loading
    let tag = "boot";
    const consoleEntries = [], exceptions = [], browserLogs = [], issues = [], netFailures = [], netAborted = [], wsEvents = [];
    await cdp.cmd("Page.enable"); await cdp.cmd("Runtime.enable"); await cdp.cmd("Log.enable"); await cdp.cmd("Network.enable"); await cdp.cmd("Network.setCacheDisabled", { cacheDisabled: true });
    try { await cdp.cmd("Audits.enable"); } catch { /* older chrome: no Audits domain */ }
    cdp.on((m) => {
      if (m.method === "Runtime.consoleAPICalled") { const a = (m.params.args || []).map((x) => x.value ?? x.description ?? x.type).join(" "); consoleEntries.push({ page: tag, level: m.params.type, text: String(a).slice(0, 300) }); }
      else if (m.method === "Runtime.exceptionThrown") { const e = m.params.exceptionDetails; exceptions.push({ page: tag, text: String(e?.exception?.description || e?.text || "exception").slice(0, 300) }); }
      else if (m.method === "Log.entryAdded") { const e = m.params.entry; browserLogs.push({ page: tag, level: e.level, source: e.source, text: String(e.text || "").slice(0, 300), url: e.url }); }
      else if (m.method === "Audits.issueAdded") { issues.push({ page: tag, code: m.params.issue?.code || "issue" }); }
      else if (m.method === "Network.loadingFailed") {
        // ERR_ABORTED / canceled = the PAGE cancelled the request (navigation, element
        // removed, a fresh cook superseding an in-flight one) — a cancellation, NOT a
        // server/connection failure. Recorded for visibility but non-fatal. A genuine
        // failure (connection refused, DNS, 4xx/5xx delivered as a load error) stays fatal.
        const rec = { page: tag, type: m.params.type, error: m.params.errorText, canceled: m.params.canceled };
        if (m.params.canceled || /ERR_ABORTED/.test(m.params.errorText || "")) netAborted.push(rec);
        else netFailures.push(rec);
      }
      else if (m.method === "Network.webSocketCreated") { wsEvents.push({ page: tag, kind: "created", url: m.params.url }); }
      else if (m.method === "Network.webSocketClosed") { wsEvents.push({ page: tag, kind: "closed" }); }
      else if (m.method === "Network.webSocketHandshakeResponseReceived") { wsEvents.push({ page: tag, kind: "handshake", status: m.params.response?.status }); }
      else if (m.method === "Network.webSocketFrameError") { wsEvents.push({ page: tag, kind: "frameError", error: m.params.errorMessage }); }
    });

    const nav = async (url) => { await cdp.cmd("Page.navigate", { url }); await sleep(800); };
    const probeImages = async () => cdp.evalJs(`(() => [...document.images].filter(i => i.src && !/^data:/.test(i.src)).map(i => ({ src: i.src.slice(-60), w: i.naturalWidth, h: i.naturalHeight, shown: i.offsetParent !== null })))()`);
    const visibleText = async () => cdp.evalJs(`(document.body && document.body.innerText || "").replace(/\\s+/g, " ")`);

    async function capturePage(name, { expectImages = false } = {}) {
      tag = name;
      await sleep(2500); // let async fetches / cooks / renders settle
      const imgs = (await probeImages()) || [];
      const text = (await visibleText()) || "";
      const zeroDim = imgs.filter((i) => i.shown && (i.w === 0 || i.h === 0)); // shown but did not render pixels
      const errText = ERROR_PHRASES.filter((p) => text.toLowerCase().includes(p.toLowerCase()));
      const page = {
        name,
        images: imgs, zeroDimImages: zeroDim,
        imageAssertion: expectImages ? (imgs.length === 0 ? "NO IMAGES (expected at least one)" : zeroDim.length ? `${zeroDim.length} image(s) rendered 0×0` : "ok") : "n/a",
        errorTextVisible: errText,
        screenText: text.slice(0, 140)
      };
      pages.push(page);
      return page;
    }

    // Seed the guest token BEFORE any page script runs, so the very FIRST load is the
    // authenticated-guest experience the owner actually sees — not an artificial tokenless
    // boot (which would flag benign pre-login 401 probes the real returning guest never hits).
    await cdp.cmd("Page.addScriptToEvaluateOnNewDocument", { source: `try { localStorage.setItem('notdnd_auth_token_v1', ${JSON.stringify(guestToken)}); } catch (e) {}` });
    await nav(base + "/"); await sleep(1800);

    // ── PAGE 1: LOBBY ──
    await capturePage("lobby", { expectImages: true });

    // ── PAGE 2: CHARACTER CREATION (the JOB 1 surface) ──
    // Click a ready-made world card DIRECTLY — that is the entry to the character wizard
    // (onWorldFieldSelect → confirmWorld). No "Play/guest" pre-click: on the authed lobby
    // that only opens the sign-in panel and never reaches the wizard. This is the screen
    // where JOB 1's "The art server took too long…" rendered — so the error-text scan on
    // this page is the direct regression guard for a failed portrait cook.
    tag = "character-creation";
    await cdp.evalJs(`(() => { const w = document.querySelector('.solo-home-worlds [data-world-scenario], [data-world-scenario], [data-world-userworld]'); if (w) w.click(); })()`);
    await sleep(3000);
    await capturePage("character-creation", { expectImages: false });

    // ── PAGE 3: LIVE RUN (API-created run; load it) ──
    if (runId) {
      tag = "live-run";
      await nav(base + "/");
      await sleep(1500);
      await cdp.evalJs(`(() => { const b = [...document.querySelectorAll('button, a')].find(x => /continue|resume|open|play/i.test(x.textContent || '')); if (b) b.click(); })()`);
      await sleep(3500);
      await capturePage("live-run", { expectImages: false });
    }

    cdp.close();
    // categorize the shared sinks
    const errors = [
      ...consoleEntries.filter((c) => c.level === "error"),
      ...exceptions.map((e) => ({ ...e, level: "error", text: "[uncaught] " + e.text })),
      ...browserLogs.filter((l) => l.level === "error")
    ];
    const warnings = [...consoleEntries.filter((c) => c.level === "warning"), ...browserLogs.filter((l) => l.level === "warning")];
    const wsFailed = wsEvents.some((e) => e.kind === "frameError") || netFailures.some((n) => n.type === "WebSocket") || browserLogs.some((l) => /websocket/i.test(l.text) && l.level === "error");
    return {
      ok: true,
      counts: { errors: errors.length, warnings: warnings.length, issues: issues.length, netFailures: netFailures.length, netAborted: netAborted.length, wsEvents: wsEvents.length },
      errors, warnings, issues, netFailures, netAborted, wsEvents, browserLogs, consoleEntries, exceptions,
      wsFailed,
      pages
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), pages };
  } finally {
    kill();
  }
}
