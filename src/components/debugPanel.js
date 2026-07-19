// ---------------------------------------------------------------------------
// In-app debug/status panel — a glanceable corner overlay showing what is LIVE.
//
// It answers, at a glance, the exact questions that cost this project repeated
// confusion: which BUILD the server is on, which GM MODEL is ACTUALLY serving
// turns (the real served attribution, so a silent 429→fallback shows the model
// that truly answered — not the configured one), and which IMAGE provider/
// checkpoint actually rendered. Data comes from GET /api/debug/status, which
// reads the same runtime state the server logs write.
//
// Lives OUTSIDE the #app re-render (appended to <body>) so it survives the SPA's
// innerHTML churn. Toggle: the `~` (backtick) key or the corner ⚙ button; the
// choice persists in localStorage. Default visibility follows the server's
// NODE_ENV (on in dev, off in production) until the user toggles it explicitly.
// ---------------------------------------------------------------------------

const STORAGE_KEY = "inkborne.debugPanel.visible";
const POLL_MS = 3000;

function escape(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function storedVisibility() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === null ? null : v === "1";
  } catch {
    return null;
  }
}

function storeVisibility(visible) {
  try {
    localStorage.setItem(STORAGE_KEY, visible ? "1" : "0");
  } catch {
    // localStorage may be unavailable (private mode) — the panel still works,
    // it just won't remember the toggle across reloads.
  }
}

function ageLabel(iso) {
  if (!iso) {
    return "·";
  }
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return "·";
  }
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) {
    return `${secs}s ago`;
  }
  const mins = Math.round(secs / 60);
  return `${mins}m ago`;
}

function row(label, valueHtml, extraClass = "") {
  return `<div class="dbg-row ${extraClass}"><span class="dbg-k">${escape(label)}</span><span class="dbg-v">${valueHtml}</span></div>`;
}

export function renderBody(status) {
  if (!status) {
    return `<div class="dbg-row"><span class="dbg-v dbg-muted">connecting…</span></div>`;
  }
  const b = status.build || {};
  const gm = status.gm || {};
  const served = gm.served || null;
  const img = status.image || {};
  const imgServed = img.served || null;

  // GM: show the ACTUALLY-served model. Highlight a divergence from configured
  // (fallback / local) in warning color so "configured vs served" can't hide.
  let gmValue;
  if (served) {
    const diverged = served.fallback || served.local;
    const modelText = escape(served.model);
    const provider = escape(served.provider);
    const latency = served.latencyMs != null ? ` · ${served.latencyMs}ms` : "";
    const via = `<span class="dbg-sub">via ${provider}${latency} · ${escape(ageLabel(served.at))}</span>`;
    gmValue = `<span class="${diverged ? "dbg-warn" : "dbg-ok"}">${modelText}</span>${
      diverged ? ` <span class="dbg-tag">${served.local ? "LOCAL FALLBACK" : "FALLBACK"}</span>` : ""
    }<br/>${via}`;
  } else {
    gmValue = `<span class="dbg-muted">${escape(gm.configuredModel || "·")}</span> <span class="dbg-sub">(configured, no turn served yet)</span>`;
  }

  // Image: provider + checkpoint (comfyui) or model, what actually rendered, PLUS
  // the LIVE worker state. A local ComfyUI cook is ~40-70s on the constrained GPU;
  // without an in-flight indicator the IMAGE line reads "none rendered yet" for the
  // whole cook and a WORKING redo looks dead (the 2026-07-19 redo confusion — the
  // job WAS enqueued and rendered, proven by the nonce-incremented draft ids). A
  // wedged worker (image-worker autopsy) now shows loud, distinct from "cooking".
  const worker = img.worker || {};
  const queued = Number(worker.queueDepth) || 0;
  let workerTag = "";
  if (worker.wedged) {
    const stuckS = Math.round((Number(worker.stuckMs) || 0) / 1000);
    workerTag = ` <span class="dbg-warn">WEDGED${stuckS ? ` ${stuckS}s` : ""}</span>`;
  } else if (worker.processing) {
    workerTag = ` <span class="dbg-ok">cooking…${queued > 0 ? ` (+${queued} queued)` : ""}</span>`;
  } else if (queued > 0) {
    workerTag = ` <span class="dbg-sub">queued: ${queued}</span>`;
  }
  let imgValue;
  if (imgServed) {
    const detail = imgServed.checkpoint || imgServed.model;
    const detailText = detail ? ` <span class="dbg-sub">${escape(detail)}</span>` : "";
    const mockTag = imgServed.mock ? ` <span class="dbg-tag">MOCK</span>` : "";
    imgValue = `<span class="dbg-ok">${escape(imgServed.provider)}</span>${detailText}${mockTag} <span class="dbg-sub">· ${escape(ageLabel(imgServed.at))}</span>${workerTag}`;
  } else if (workerTag) {
    // Nothing served yet, but the worker IS busy/wedged — show that, never the
    // misleading "none rendered yet" while a job is actually cooking.
    imgValue = `<span class="dbg-muted">${escape(img.configuredProvider || "·")}</span>${workerTag}`;
  } else {
    imgValue = `<span class="dbg-muted">${escape(img.configuredProvider || "·")}</span> <span class="dbg-sub">(configured, none rendered yet)</span>`;
  }

  const dirty = b.dirty ? ` <span class="dbg-tag">dirty</span>` : "";
  const buildValue = `<span class="dbg-ok">${escape(b.sha)}</span> <span class="dbg-sub">${escape(b.branch)}</span>${dirty}`;
  const envClass = b.nodeEnv === "production" ? "dbg-warn" : "dbg-ok";

  return [
    row("BUILD", buildValue),
    row("GM MODEL", gmValue),
    row("IMAGE", imgValue),
    row("CLOUD CHAIN", `<span class="dbg-sub">${escape(status.cloudChain || "·")}</span>`),
    row("NODE_ENV", `<span class="${envClass}">${escape(b.nodeEnv || "·")}</span>`)
  ].join("");
}

/**
 * Mounts the debug panel once. Idempotent — a second call is a no-op.
 * @param {{ debugStatus: () => Promise<object> }} apiClient
 */
export function mountDebugPanel(apiClient) {
  if (typeof document === "undefined" || document.getElementById("inkborne-debug-panel")) {
    return;
  }

  const wrap = document.createElement("div");
  wrap.id = "inkborne-debug-panel";
  wrap.className = "dbg-wrap";
  wrap.innerHTML = `
    <button type="button" class="dbg-fab" title="Toggle debug panel (~)" aria-label="Toggle debug panel">⚙</button>
    <section class="dbg-card" role="status" aria-live="polite" hidden>
      <header class="dbg-head">
        <span class="dbg-title">LIVE STATUS</span>
        <button type="button" class="dbg-close" title="Hide (~)" aria-label="Hide debug panel">×</button>
      </header>
      <div class="dbg-body"></div>
    </section>`;
  document.body.appendChild(wrap);

  const card = wrap.querySelector(".dbg-card");
  const body = wrap.querySelector(".dbg-body");
  const fab = wrap.querySelector(".dbg-fab");
  const closeBtn = wrap.querySelector(".dbg-close");

  let visible = false;
  let lastStatus = null;
  let serverDefault = null; // filled from the first poll (NODE_ENV-derived)
  let pollTimer = null;

  function applyVisibility() {
    card.hidden = !visible;
    fab.classList.toggle("dbg-fab-active", visible);
  }

  function setVisible(next, persist = true) {
    visible = Boolean(next);
    if (persist) {
      storeVisibility(visible);
    }
    applyVisibility();
    if (visible) {
      paint();
      startPolling();
    } else {
      stopPolling();
    }
  }

  function paint() {
    body.innerHTML = renderBody(lastStatus);
  }

  async function poll() {
    try {
      const status = await apiClient.debugStatus();
      lastStatus = status;
      // On the very first successful poll, if the user has no stored preference,
      // adopt the server's default (dev → shown, prod → hidden).
      if (serverDefault === null) {
        serverDefault = Boolean(status.debugDefault);
        if (storedVisibility() === null && serverDefault) {
          setVisible(true, false);
        }
      }
      if (visible) {
        paint();
      }
    } catch {
      lastStatus = lastStatus || null;
      if (visible) {
        paint();
      }
    }
  }

  function startPolling() {
    if (pollTimer) {
      return;
    }
    poll();
    pollTimer = setInterval(poll, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  fab.addEventListener("click", () => setVisible(!visible));
  closeBtn.addEventListener("click", () => setVisible(false));

  // `~` (backtick) toggles — but never while typing into an input/textarea, so
  // the shortcut can't eat a keystroke in the action box.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "`" && event.key !== "~") {
      return;
    }
    const el = event.target;
    const tag = el && el.tagName ? el.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || (el && el.isContentEditable)) {
      return;
    }
    event.preventDefault();
    setVisible(!visible);
  });

  // Initial state: an explicit stored preference wins; otherwise stay hidden
  // until the first poll reveals the server default (so prod never flashes it).
  const stored = storedVisibility();
  if (stored === true) {
    setVisible(true, false);
  } else {
    applyVisibility();
    // Poll once even while hidden so the server default can promote it in dev.
    poll();
  }
}
