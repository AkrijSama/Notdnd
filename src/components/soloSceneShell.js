import { completeSoloRun, fetchSoloGmScene, fetchSoloScene, postSoloAction, redoLocationImage, saveLocationImage } from "./soloSceneApi.js";
import textFit from "../vendor/textFit.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function typeLabel(value) {
  return String(value || "entity").replaceAll("_", " ");
}

function labelForAction(action = {}) {
  if (action.label) {
    return action.label;
  }
  if (action.type === "move" && action.toLocationId) {
    return `Move to ${action.toLocationId}`;
  }
  return typeLabel(action.type || "Action");
}

function titleCase(value) {
  return typeLabel(value)
    .split(" ")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function renderEmpty(label) {
  return `<div class="solo-empty-state">${escapeHtml(label)}</div>`;
}

function renderTags(tags = []) {
  if (!Array.isArray(tags) || tags.length === 0) {
    return "";
  }
  return `<div class="solo-tag-row">${tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>`;
}

function renderStats(stats = {}) {
  const entries = Object.entries(stats || {});
  if (entries.length === 0) {
    return renderEmpty("No stats available yet.");
  }
  return `
    <div class="solo-stat-grid">
      ${entries
        .map(
          ([key, value]) => `
            <div class="solo-stat">
              <span>${escapeHtml(typeLabel(key))}</span>
              <strong>${escapeHtml(value)}</strong>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderCompactList(items, emptyLabel, renderItem) {
  if (!Array.isArray(items) || items.length === 0) {
    return renderEmpty(emptyLabel);
  }
  return `<div class="solo-compact-list">${items.map(renderItem).join("")}</div>`;
}

export function createMoveAction(scene, move) {
  return {
    type: "move",
    actorId: "player",
    fromLocationId: scene?.location?.locationId || null,
    toLocationId: move?.locationId || move?.toLocationId,
    direction: move?.direction || null
  };
}

export function createInspectAction(entity) {
  return {
    type: "inspect",
    actorId: "player",
    entityId: entity?.entityId
  };
}

export function createSearchAction() {
  return {
    type: "search",
    actorId: "player"
  };
}

export function createTalkAction(entityOrAction = {}) {
  const action = {
    type: "talk",
    actorId: "player",
    targetEntityId: entityOrAction.entityId || entityOrAction.targetEntityId
  };
  // A reply carries the player's typed line + the conversation so far, so the GM
  // answers IN CHARACTER to what was said instead of re-emitting the intro beat.
  // Absent (the initial approach), the talk stays a plain beat reveal.
  const message = typeof entityOrAction.message === "string" ? entityOrAction.message.trim() : "";
  if (message) {
    action.message = message;
  }
  if (Array.isArray(entityOrAction.history) && entityOrAction.history.length > 0) {
    action.history = entityOrAction.history
      .filter((entry) => entry && typeof entry.text === "string" && entry.text.trim())
      .map((entry) => ({ role: entry.role === "player" ? "player" : "npc", text: String(entry.text).trim() }));
  }
  return action;
}

export function createRestAction(action = {}) {
  return {
    type: "rest",
    actorId: "player",
    restType: action.restType || "short"
  };
}

export function createUseItemAction(itemOrAction = {}) {
  return {
    type: "use_item",
    actorId: "player",
    itemId: itemOrAction.itemId || null,
    targetEntityId: itemOrAction.targetEntityId || null,
    targetLocationId: itemOrAction.targetLocationId || null
  };
}

export function createAttemptAction(attempt = {}) {
  return {
    type: "attempt",
    actorId: "player",
    intent: attempt.intent || "",
    // #37/#38: carry the client's classification so CLI 1's intent router
    // (task #39) doesn't have to re-sniff. Additive + defaulted — the server
    // ignores it until the router consumes it, so this can't regress today.
    mode: attempt.mode || "action",
    targetId: attempt.targetId || null
  };
}

// #39: hard cap on a turn's text — long enough for an elaborate action or a line
// of speech, short enough to keep interpreter token cost bounded.
export const SOLO_INPUT_MAXLEN = 500;

// #37/#38: the three input modes, in the shape CLI 1's router (#39) expects.
export const SOLO_INPUT_MODE_META = Object.freeze({
  action: { label: "Action", hint: "Your character acts" },
  speech: { label: "Speech", hint: "Your character speaks aloud" },
  ooc: { label: "OOC", hint: "Out of character — a note to the GM" }
});

// Classify a free-text turn the way the director set the routing:
//   leading /ooc      -> OOC   (a note to the GM; the marker is stripped)
//   leading quote     -> SPEECH (said aloud; quotes are KEPT so the GM sees it spoken)
//   anything else     -> ACTION (done)
// Returns { mode, intent, display }: `intent` is what the server resolves,
// `display` is the raw text. Pure + exported so it's unit-testable and shared
// by the render (mode chip) and the submit path (payload).
export function classifyInput(raw = "") {
  const trimmed = String(raw || "").trim();
  if (/^\/ooc\b/i.test(trimmed)) {
    return { mode: "ooc", intent: trimmed.replace(/^\/ooc\b\s*/i, ""), display: trimmed };
  }
  if (trimmed.length > 1 && /^["'“”‘’]/.test(trimmed)) {
    return { mode: "speech", intent: trimmed, display: trimmed };
  }
  return { mode: "action", intent: trimmed, display: trimmed };
}

export function renderSceneHeader(scene = {}, state = {}) {
  const location = scene.location || {};
  const time = scene.world?.time || scene.time || {};
  const timeLabel = [time.day !== undefined ? `Day ${time.day}` : "", time.tick !== undefined ? `Tick ${time.tick}` : ""]
    .filter(Boolean)
    .join(" / ");

  return `
    <header class="solo-scene-header">
      <div class="solo-scene-title">
        <div class="small">Solo Run ${escapeHtml(scene.runId || state.runId || "Unknown")}</div>
        <h2>${escapeHtml(location.name || "Unknown Location")}</h2>
      </div>
      <div class="solo-scene-badges">
        ${timeLabel ? `<span class="tag">${escapeHtml(timeLabel)}</span>` : ""}
        <span class="tag">${escapeHtml(scene.edition || "mainline")}</span>
      </div>
    </header>
  `;
}

export function renderGmStatusPanel(gmStatus = null, selectedMode = "placeholder") {
  const status = gmStatus || {
    mode: "placeholder",
    providerAttempted: false,
    providerName: "placeholder",
    providerKind: "placeholder",
    providerSucceeded: false,
    fallbackUsed: false,
    evaluationScore: null,
    warningCodes: [],
    narrationLength: null
  };
  const warnings = Array.isArray(status.warningCodes) ? status.warningCodes : [];
  const mode = status.mode || "placeholder";
  const providerLabel = [status.providerName, status.providerKind].filter(Boolean).join(" / ") || "placeholder";

  return `
    <div class="solo-gm-status-panel" data-gm-mode="${escapeHtml(mode)}">
      <div class="solo-gm-status-topline">
        <span class="tag">GM Mode: ${escapeHtml(titleCase(mode))}</span>
        ${status.fallbackUsed ? `<span class="tag danger">Fallback</span>` : ""}
        ${status.providerSucceeded ? `<span class="tag success">Provider OK</span>` : ""}
      </div>
      <div class="small">
        Provider: ${escapeHtml(providerLabel)}
        ${Number.isFinite(status.evaluationScore) ? ` / Eval ${escapeHtml(status.evaluationScore)}` : ""}
        ${Number.isFinite(status.narrationLength) ? ` / ${escapeHtml(status.narrationLength)} chars` : ""}
      </div>
      ${
        warnings.length
          ? `<div class="solo-tag-row">${warnings.map((warning) => `<span class="tag">${escapeHtml(warning)}</span>`).join("")}</div>`
          : ""
      }
      <div class="solo-gm-mode-toggle" role="group" aria-label="GM narration mode">
        <button
          class="ghost ${selectedMode === "placeholder" ? "selected" : ""}"
          data-solo-gm-mode="placeholder"
          type="button"
        >
          Placeholder
        </button>
        <button
          class="ghost ${selectedMode === "provider" ? "selected" : ""}"
          data-solo-gm-mode="provider"
          type="button"
        >
          Provider
        </button>
      </div>
    </div>
  `;
}

// World-entry opening: the AI-generated GM welcome, shown prominently at the top
// of the scene the first time the player enters (server gates scene.openingNarration
// to the opening moment). Styled as GM voice, distinct from the location copy.
// #24 EM-DASH HARD STRIP (render-side, guaranteed 0% at display). The prompt-level
// ban leaks ~1 in 3 turns, so this mechanically removes em-dashes (—), en-dashes
// (–), horizontal bars (―), and double-hyphens (--) from ALL narration before it
// is shown, replacing the clause break with a comma so the prose still reads. This
// is deterministic: nothing dash-shaped survives to the screen regardless of model
// or path. (Applies to authored beats too — a normalized beat still reads cleanly,
// and the guarantee is literal 0% on screen.)
function stripDashes(text) {
  return String(text || "")
    .replace(/\s*[—–―]+\s*/g, ", ") // em / en / bar (with surrounding space)
    .replace(/\s+--+\s+/g, ", ")                    // " -- " double-hyphen as clause break
    .replace(/--+/g, ", ")                          // any remaining double-hyphen
    .replace(/\s+,/g, ",")                          // tidy " ," -> ","
    .replace(/,\s*,+/g, ",")                         // collapse ",," -> ","
    .replace(/,(?=[A-Za-z])/g, ", ")                // space after a comma ONLY before a letter
                                                     // (never before a closing quote, digit, or punctuation)
    .replace(/,\s*([.!?;:])/g, "$1")                 // ", ." -> "." when a real terminator follows
    .trim();
}

// #23 Is a quoted run actually SPOKEN DIALOGUE (vs. a sign/label/emphasis)? The
// old detector styled EVERY quoted run, so board notices ("LICENSED CLEANSING.")
// and emphasized words ("clean") were miscolored as speech. Spoken dialogue is:
// not ALL-CAPS (that's signage), and either a full utterance (3+ words) or a short
// line that ends on real sentence punctuation ("Run!"). Emphasis (a short quoted
// fragment with no terminal punctuation) and all-caps labels are excluded.
function isSpokenDialogue(quotedRun) {
  const core = String(quotedRun || "").replace(/^[“"]/, "").replace(/[”"]$/, "").trim();
  const letters = core.replace(/[^A-Za-z]/g, "");
  if (letters.length < 2) {
    return false; // "..." / "!" / a stray mark
  }
  if (core === core.toUpperCase()) {
    return false; // ALL-CAPS -> a sign/notice/label, not speech
  }
  const words = core.split(/\s+/).filter(Boolean).length;
  const hasTerminal = /[.!?]["”]?$/.test(core) || /[.!?]/.test(core);
  return words >= 3 || hasTerminal;
}

// Quoted SPOKEN dialogue inside narration prose gets a distinct color (#19),
// gated by isSpokenDialogue (#23) so signs/emphasis are left as plain prose. We
// have no structured speaker for in-prose speech (only the talk/VN path carries a
// name), so this is a render-time pass: split each paragraph on quoted runs
// (straight OR curly), escape every segment, wrap only genuine speech in
// .solo-dialogue. Escaping is per-segment so the wrapper markup is the only HTML.
// Speech runs: quoted NPC dialogue (light blue) OR bracketed VOICE god-speech
// ("[ YOU ARE HEARD. ]" — yellow). The VOICE speaks in brackets by convention,
// so bracket runs are divine dialogue wherever they appear (opening + turns).
const DIALOGUE_RE = /(“[^”]*”|"[^"]*"|\[[^\]\n]+\])/g;
function paragraphInnerHtml(text) {
  const raw = String(text || "");
  if (!raw) {
    return "";
  }
  return raw
    .split(DIALOGUE_RE)
    .filter((seg) => seg !== "" && seg !== undefined)
    .map((seg) => {
      const looksBracketed = /^\[[\s\S]*\]$/.test(seg);
      if (looksBracketed) {
        return `<span class="solo-voice-dialogue">${escapeHtml(seg)}</span>`;
      }
      const looksQuoted = /^“[\s\S]*”$/.test(seg) || (/^"[\s\S]*"$/.test(seg) && seg.length >= 2);
      return looksQuoted && isSpokenDialogue(seg)
        ? `<span class="solo-dialogue">${escapeHtml(seg)}</span>`
        : escapeHtml(seg);
    })
    .join("");
}

// Split a narration string into spaced <p> paragraphs on blank lines, with
// em-dashes stripped (#24) and quoted dialogue colored (#19/#23). The ONE
// narration renderer — every prose surface (opening, ambient location copy,
// per-turn GM narration) routes through this so treatment is consistent
// (#12/#18/#19/#23/#24): real paragraph breaks, real spacing, zero dashes.
// Spacing pass: the GM frequently emits a single block with NO blank lines, which
// rendered as one giant <p> — the "wall of text". Chunk any long paragraph at
// sentence boundaries into readable visual paragraphs (~2-3 sentences each).
// Quote-aware: never splits inside quoted dialogue (an unbalanced-quote chunk is
// merged forward), so #19/#23 dialogue coloring still sees whole quotes.
const SENTENCE_BOUNDARY_RE = /(?<=[.!?][”"’']?)\s+/;
const PARA_CHUNK_THRESHOLD = 360; // chars — below this a paragraph renders as-is
const PARA_CHUNK_TARGET = 280; // chars — start a new visual paragraph past this

function quotesUnbalanced(text) {
  const straight = ((text.match(/"/g) || []).length) % 2 === 1;
  const open = (text.match(/“/g) || []).length;
  const close = (text.match(/”/g) || []).length;
  return straight || open !== close;
}

function chunkLongParagraph(text) {
  const t = String(text || "").trim();
  if (t.length <= PARA_CHUNK_THRESHOLD) {
    return [t];
  }
  const sentences = t.split(SENTENCE_BOUNDARY_RE).filter(Boolean);
  if (sentences.length < 3) {
    return [t];
  }
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length >= PARA_CHUNK_TARGET && !quotesUnbalanced(current)) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) {
    // A trailing unbalanced/short remainder folds into the previous chunk.
    if (chunks.length && (quotesUnbalanced(current) || current.length < 60)) {
      chunks[chunks.length - 1] += ` ${current}`;
    } else {
      chunks.push(current);
    }
  }
  return chunks.length ? chunks : [t];
}

function beatToParas(beat) {
  const paras = String(beat || "")
    .split(/\n{2,}/)
    .map((part) => stripDashes(part))
    .filter(Boolean)
    .flatMap((part) => chunkLongParagraph(part));
  return (paras.length ? paras : [stripDashes(beat)]).map((part) => `<p>${paragraphInnerHtml(part)}</p>`).join("");
}

export function renderSoloSceneOpening(openingNarration = "", openingBeats = null) {
  // PACED set-piece: when the opening is an authored BEAT SEQUENCE (openingBeats),
  // reveal the beats one at a time in a staggered cascade instead of dumping the
  // whole VOICE monologue as one scroll-wall — so it lands. Each beat is its own
  // framed block, fading in after the previous; reduced-motion users get them all
  // at once (no animation). Falls back to the single-string rendering otherwise.
  const beats = Array.isArray(openingBeats)
    ? openingBeats.map((b) => String(b || "").trim()).filter(Boolean)
    : null;
  if (beats && beats.length) {
    const blocks = beats
      .map((beat, i) => `<div class="solo-opening-beat" style="animation-delay:${(i * 1.1).toFixed(2)}s">${beatToParas(beat)}</div>`)
      .join("");
    return `
      <section class="solo-scene-opening solo-opening-paced solo-measure" role="note" aria-label="Opening narration">
        <style>
          .solo-opening-paced .solo-opening-beat { opacity: 0; animation: soloBeatIn 0.9s ease forwards; }
          .solo-opening-paced .solo-opening-beat + .solo-opening-beat { margin-top: 0.9rem; padding-top: 0.9rem; border-top: 1px solid rgba(255,255,255,0.08); }
          @keyframes soloBeatIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
          @media (prefers-reduced-motion: reduce) { .solo-opening-paced .solo-opening-beat { opacity: 1; animation: none; } }
        </style>
        <span class="solo-scene-opening-kicker">The VOICE speaks</span>
        ${blocks}
      </section>
    `;
  }
  const text = typeof openingNarration === "string" ? openingNarration.trim() : "";
  if (!text) {
    return "";
  }
  const body = beatToParas(text);
  return `
    <section class="solo-scene-opening solo-measure" role="note" aria-label="Opening narration">
      <span class="solo-scene-opening-kicker">The GM sets the scene</span>
      ${body}
    </section>
  `;
}

// Soft, non-blocking upgrade prompt. Surfaced only for a free user (no BYOK)
// who is at/near their daily image quota or has hit the session cap. Gameplay is
// never blocked — this is a gentle nudge with a placeholder /pricing CTA. Reads
// the entitlement summary the /scene route attaches; returns "" when not
// applicable (paid/BYOK users, or a free user with quota to spare).
export function renderSoloUpgradePrompt(scene = {}) {
  const ent = scene && typeof scene.entitlement === "object" ? scene.entitlement : null;
  if (!ent || ent.tier !== "free" || ent.byok === true || ent.unlimited === true) {
    return "";
  }
  const remaining = ent.imageQuotaRemaining;
  const lowImages = typeof remaining === "number" && remaining <= 2;
  const sessionReached = ent.sessionLimitReached === true;
  if (!lowImages && !sessionReached) {
    return "";
  }
  const message = sessionReached
    ? "You've reached your free daily session limit — upgrade to Adventurer for unlimited play."
    : remaining <= 0
      ? "You've used your free images today — upgrade to Adventurer for unlimited portraits and scenes."
      : `Only ${remaining} free image${remaining === 1 ? "" : "s"} left today — upgrade to Adventurer for unlimited portraits and scenes.`;
  return `
    <aside class="solo-upgrade-prompt" role="note" aria-label="Upgrade prompt" data-solo-upgrade-prompt>
      <span class="solo-upgrade-prompt-msg">${escapeHtml(message)}</span>
      <a class="solo-upgrade-prompt-cta" href="/pricing" data-solo-upgrade-cta>Upgrade</a>
    </aside>
  `;
}

export function renderGmNarrationPanel(gmNarration = null, gmStatus = null, selectedMode = "placeholder", debug = false) {
  const narration = gmNarration?.narration || null;
  if (!narration) {
    return `
      <div class="solo-gm-placeholder">
        <span>Future GM Narration</span>
        <p>Scene narration will appear here later, generated from server truth and memory.</p>
        ${debug ? renderGmStatusPanel(gmStatus, selectedMode) : ""}
      </div>
    `;
  }

  return `
    <div class="solo-gm-placeholder solo-gm-narration">
      <span>${escapeHtml(narration.tone || "neutral")} GM Narration</span>
      ${beatToParas(narration.body || "")}
      ${
        Array.isArray(narration.sensoryDetails) && narration.sensoryDetails.length
          ? `<div class="solo-tag-row">${narration.sensoryDetails
              .map((detail) => `<span class="tag">${escapeHtml(detail)}</span>`)
              .join("")}</div>`
          : ""
      }
      ${debug ? renderGmStatusPanel(gmStatus, selectedMode) : ""}
    </div>
  `;
}

export function renderLocationPanel(location = {}, gmNarration = null, gmStatus = null, selectedMode = "placeholder", debug = false, options = {}) {
  const imageLabel = location.imageAssetId ? `Image asset: ${location.imageAssetId}` : "No image assigned yet.";
  // location.tags is AUTHORING/classification metadata ("modern arcane", "zone",
  // "wilderness") — internal only. It is deliberately NOT rendered to the player;
  // the data is left untouched on the payload for internal use (home-base
  // classification, etc.). (Defect 9: metadata must not surface in the scene.)
  return `
    <section class="solo-location-card solo-measure">
      <div class="solo-location-image" data-image-asset-id="${escapeHtml(location.imageAssetId || "")}">
        <div>
          <div class="solo-image-kicker">Location Image</div>
          <strong>${escapeHtml(imageLabel)}</strong>
        </div>
      </div>
      <div class="solo-location-copy">
        ${beatToParas(location.description || "No location description is available.")}
        ${options.suppressGm ? "" : renderGmNarrationPanel(gmNarration, gmStatus, selectedMode, debug)}
      </div>
    </section>
  `;
}

// #25 APPEND-ONLY NARRATION LOG. Renders the accumulated turn history (oldest at
// top, newest at bottom) so the player can scroll back through the story. Each
// entry shows an optional "You: <intent>" header + roll/DC, then the turn's prose
// (dashes stripped, dialogue colored via beatToParas). #20: when a turn's prose
// contains dialogue AND a single speaker is known for it (a lone present NPC, or
// the VOICE), a speaker nameplate is shown on the entry — full per-line
// attribution in a crowded scene needs the GM to tag speakers (server-side).
// #45/#46: label for a non-attempt turn's action header, derived from the
// committed timeline event type when it carries no title of its own.
const TURN_ACTION_LABELS = Object.freeze({
  move: "Move on",
  search: "Search the area",
  talk: "Speak",
  inspect: "Look closer",
  rest: "Rest",
  use_item: "Use an item",
  ooc: "(out of character)"
});

// Bug B (provenance, owner 2026-07-10): resolve what renders under the YOU
// badge for a turn. The rule is ABSOLUTE — YOU is the player's OWN words, never
// a GM-generated beat title. Priority: the verbatim text the player just
// submitted this turn; else the attempt result's intent (also the raw input);
// else the raw intent the server preserved on a rerouted non-attempt event
// (payload.intent); else a deterministic action label for click-driven
// affordances. A GM narration `title` (e.g. "Smoke on the horizon") is NEVER a
// source. Pure + exported so the provenance rule is unit-testable in isolation.
export function resolveTurnHeaderIntent({ submitted, attemptResult, lastEvent, isFirst } = {}) {
  if (isFirst) {
    return "";
  }
  const clean = (s) => String(s || "").trim();
  if (clean(submitted)) {
    return clean(submitted);
  }
  if (attemptResult && clean(attemptResult.intent)) {
    return clean(attemptResult.intent);
  }
  const ev = lastEvent || null;
  if (ev && ev.type && ev.type !== "attempt") {
    const rawIntent = clean(ev.payload && ev.payload.intent);
    if (rawIntent) {
      return rawIntent;
    }
    return clean(TURN_ACTION_LABELS[ev.type] || "");
  }
  return "";
}

export function renderNarrationLog(entries = []) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && String(e.text || "").trim()) : [];
  if (!list.length) {
    return `<div class="solo-narration-empty">Your story begins…</div>`;
  }
  return list
    .map((entry) => {
      // Bug A (#37/#38): the GM's OUT-OF-CHARACTER reply. Rendered as a distinct
      // muted, bracketed aside — NEVER a story beat (no YOU header, no roll, no
      // speaker plate). Self-contained inline styling (theme vars) so it reads as
      // meta across all skins without a shared CSS dependency.
      if (entry.kind === "ooc") {
        return `<aside class="solo-log-entry solo-measure solo-log-ooc" role="note" style="border-left:3px solid var(--muted,#8b8e96);background:var(--inset,#070708);padding:10px 14px;border-radius:8px;margin:0 auto 34px;font-style:italic;color:var(--text-2,#b0b3bb);"><span style="display:block;text-transform:uppercase;letter-spacing:.1em;font-size:10px;font-weight:800;font-style:normal;color:var(--muted,#8b8e96);margin-bottom:6px;">GM · out of character</span><div>${escapeHtml(String(entry.text || ""))}</div></aside>`;
      }
      const cr = entry.checkResult || null;
      const hasRoll = cr && cr.total != null;
      // #33: band-code the log roll tag (success / cost / failure), matching the
      // stage strip so the three outcomes read identically wherever they appear.
      const b = outcomeBandInfo(entry);
      const rollTag = hasRoll
        ? `<span class="solo-log-roll band-${b.key}"><span class="solo-log-roll-glyph" aria-hidden="true">${b.glyph}</span>Rolled ${escapeHtml(cr.total)}${cr.dc != null ? ` · DC ${escapeHtml(cr.dc)}` : ""}</span>`
        : "";
      // #44/#46: the player-action line is the ANCHOR of a turn unit — a prominent
      // "YOU" badge + the intent in heavier weight + the (band-coded) roll. Present
      // on every action turn; absent only on the opening (no player action).
      const intent = entry.intent && String(entry.intent).trim();
      // Bug B: YOU renders the player's VERBATIM words. Long inputs truncate with
      // an ellipsis for layout, but the full text is preserved in the title attr
      // (hover) and in the stored entry (transcript / grader player-echo).
      const intentDisplay = intent && intent.length > 120 ? `${intent.slice(0, 119)}…` : intent;
      const header = intent
        ? `<header class="solo-log-action"><span class="solo-log-you">You</span><span class="solo-log-intent" title="${escapeHtml(intent)}">${escapeHtml(intentDisplay)}</span>${rollTag}</header>`
        : "";
      const hasDialogue = /[“"][^”"]+[”"]/.test(String(entry.text));
      // #20-full: prefer the server's grounded per-line speakers — a multi-NPC beat
      // shows a plate for each distinct NPC who spoke. Player/unknown lines get no
      // plate (the "You" header covers the player; an ungrounded name is never
      // invented). Falls back to the single-speaker attribution when absent.
      const npcSpeakers = [
        ...new Set(
          (Array.isArray(entry.dialogueLines) ? entry.dialogueLines : [])
            .filter((l) => l && l.kind === "npc" && l.speakerName)
            .map((l) => l.speakerName)
        )
      ];
      const nameplate = npcSpeakers.length
        ? `<div class="solo-log-speakers">${npcSpeakers
            .map((n) => `<span class="solo-log-speaker">${escapeHtml(n)}</span>`)
            .join("")}</div>`
        : entry.speaker && hasDialogue
          ? `<div class="solo-log-speaker">${escapeHtml(entry.speaker)}</div>`
          : "";
      // #46/#47: each turn is a delineated UNIT — the `has-action` class carries a
      // divider + the action anchor; opening/ambient entries (no header) read as
      // continuous prose without a false turn boundary.
      const unitClass = header ? "solo-log-entry has-action solo-measure" : "solo-log-entry solo-measure";
      return `<article class="${unitClass}">${header}${nameplate}<div class="solo-log-prose">${beatToParas(entry.text)}</div></article>`;
    })
    .join("");
}

// #20: the sole named NPC present in a scene, if exactly one — used to attribute
// ambient dialogue to a speaker. Returns null for 0 or 2+ NPCs (ambiguous:
// dialogue gets color only, no nameplate). Reads the same visibleEntities/cast
// the renderer already has; introduces no new state.
export function soleSceneSpeaker(scene = {}) {
  const cast = Array.isArray(scene.cast) ? scene.cast : [];
  const fromCast = cast
    .map((c) => (c && (c.displayName || c.name)) || null)
    .filter(Boolean);
  if (fromCast.length === 1) {
    return fromCast[0];
  }
  const ents = Array.isArray(scene.visibleEntities) ? scene.visibleEntities : [];
  const npcs = ents.filter((e) => e && e.entityType === "npc" && (e.displayName || e.name));
  return npcs.length === 1 ? npcs[0].displayName || npcs[0].name : null;
}

// Strip the server's "npc:" id prefix (speakerId may arrive raw).
function bareNpcId(id) {
  return String(id || "").replace(/^npc:/i, "").trim();
}

// #20-full: resolve the ACTIVE speaker for a turn even when several NPCs are on
// stage, using CLI 1's authoritative fields in priority order:
//   1. talkResult — the NPC who just spoke THIS turn (speakerName / npcId).
//   2. scene.speakerId — the VN's current active speaker (mapped to a display
//      name through the cast roster).
//   3. soleSceneSpeaker — the single-NPC ambient fallback (0/2+ => null).
// Returns a display name or null. This is what un-blocks nameplates in a
// multi-NPC scene: soleSceneSpeaker alone goes silent the moment a second NPC
// appears; speakerId/talkResult name the one who is actually talking.
export function resolveSceneSpeaker(scene = {}, talkResult = null) {
  const cast = Array.isArray(scene.cast) ? scene.cast : [];
  const nameForId = (id) => {
    const bare = bareNpcId(id);
    if (!bare) {
      return null;
    }
    const hit = cast.find((c) => c && bareNpcId(c.npcId) === bare);
    return (hit && (hit.displayName || hit.name)) || null;
  };
  if (talkResult && typeof talkResult === "object") {
    const spoke = (typeof talkResult.speakerName === "string" && talkResult.speakerName.trim())
      || nameForId(talkResult.npcId);
    if (spoke) {
      return spoke;
    }
  }
  if (scene.speakerId) {
    const active = nameForId(scene.speakerId);
    if (active) {
      return active;
    }
  }
  return soleSceneSpeaker(scene);
}

export function renderMovementPanel(scene = {}) {
  const moves = Array.isArray(scene.availableMoves) ? scene.availableMoves : [];
  return `
    <section class="module-card solo-panel solo-exits-panel">
      <div class="module-header">
        <h3>Exits</h3>
        <span class="small">${moves.length} available</span>
      </div>
      <div class="solo-button-grid">
        ${
          moves.length
            ? moves
                .map(
                  (move) => `
                    <button
                      class="ghost solo-move-button"
                      data-solo-action="move"
                      data-location-id="${escapeHtml(move.locationId || move.toLocationId || "")}"
                      data-direction="${escapeHtml(move.direction || "")}"
                    >
                      <span>${escapeHtml(move.name || move.locationId || "Connected Location")}</span>
                      ${move.direction ? `<small>${escapeHtml(move.direction)}</small>` : ""}
                    </button>
                  `
                )
                .join("")
            : renderEmpty("No connected locations.")
        }
      </div>
    </section>
  `;
}

export function renderEntityCard(entity = {}, selectedEntityId = "") {
  const selected = entity.entityId && entity.entityId === selectedEntityId;
  const inspectable = entity.inspectable !== false;
  // Show an inline Talk button on every visible NPC card so dialogue can be
  // started directly from the Scene tab. We intentionally do NOT gate on
  // actionTypes here: not every NPC payload advertises "talk", and the server
  // resolves talkability (returning a graceful "nothing to say" result when an
  // NPC has no dialogue). Talk also remains available in the Actions tab.
  const canTalk = entity.entityType === "npc";
  return `
    <article
      class="solo-entity-card ${selected ? "selected" : ""} ${inspectable ? "inspectable" : ""}"
      data-entity-id="${escapeHtml(entity.entityId || "")}"
      data-inspectable="${inspectable ? "true" : "false"}"
      tabindex="${inspectable ? "0" : "-1"}"
    >
      <div class="solo-entity-topline">
        <strong>${escapeHtml(entity.displayName || entity.entityId || "Entity")}</strong>
        <span class="tag">${escapeHtml(typeLabel(entity.entityType))}</span>
      </div>
      <p class="small">${escapeHtml(entity.summary || "Inspectable server entity.")}</p>
      <div class="solo-entity-meta">
        <span>${escapeHtml(entity.imageAssetId ? "Image assigned" : "No image assigned")}</span>
        ${entity.relationshipId ? `<span>${escapeHtml(entity.relationshipId)}</span>` : ""}
      </div>
      <button
        class="ghost"
        data-solo-action="inspect"
        data-entity-id="${escapeHtml(entity.entityId || "")}"
        ${inspectable ? "" : "disabled"}
      >
        Inspect
      </button>
      ${
        canTalk
          ? `<button
              class="ghost"
              data-solo-action="talk"
              data-entity-id="${escapeHtml(entity.entityId || "")}"
            >
              Talk
            </button>`
          : ""
      }
    </article>
  `;
}

export function renderEntityPanel(scene = {}, selectedEntityId = "") {
  const entities = Array.isArray(scene.visibleEntities) ? scene.visibleEntities : [];
  return `
    <section class="module-card solo-panel solo-entities-panel">
      <div class="module-header">
        <h3>Visible Entities</h3>
        <span class="small">${entities.length} visible</span>
      </div>
      <div class="solo-entity-grid">
        ${entities.length ? entities.map((entity) => renderEntityCard(entity, selectedEntityId)).join("") : renderEmpty("No visible entities.")}
      </div>
    </section>
  `;
}



export function renderSearchResultPanel(searchResult = null, discoveredDetails = []) {
  const details = Array.isArray(discoveredDetails) ? discoveredDetails : [];
  return `
    <section class="module-card solo-panel solo-search-panel">
      <div class="module-header">
        <h3>Area Search</h3>
        <span class="small">Server result</span>
      </div>
      ${
        searchResult
          ? `
            <div class="solo-search-result ${searchResult.found ? "found" : "empty"}">
              <strong>${escapeHtml(searchResult.found ? "Detail found" : "Nothing new found")}</strong>
              <p>${escapeHtml(searchResult.summary || "You find nothing new right now.")}</p>
              ${
                Array.isArray(searchResult.warningCodes) && searchResult.warningCodes.length
                  ? `<div class="solo-tag-row">${searchResult.warningCodes
                      .map((warning) => `<span class="tag">${escapeHtml(warning)}</span>`)
                      .join("")}</div>`
                  : ""
              }
            </div>
          `
          : renderEmpty("Search this area to reveal pre-authored details.")
      }
      ${
        details.length
          ? `<div class="solo-sheet-section">
              <h5>Discovered Details</h5>
              ${renderCompactList(details, "No discovered details yet.", (detail) => `
                <div class="solo-compact-row">
                  <strong>${escapeHtml(detail.label || detail.detailId || "Detail")}</strong>
                  <span>${escapeHtml(detail.description || "")}</span>
                </div>
              `)}
            </div>`
          : ""
      }
    </section>
  `;
}

function renderCheckResult(checkResult = null) {
  if (!checkResult) {
    return "";
  }
  return `
    <div class="solo-check-result">
      <span class="tag ${checkResult.success ? "success" : "danger"}">
        ${escapeHtml(checkResult.success ? "Check success" : "Check failed")}
      </span>
      <span class="small">
        Total ${escapeHtml(checkResult.total)} vs DC ${escapeHtml(checkResult.dc)}
      </span>
    </div>
  `;
}

// FIX R-UI: feature the dice roll + verdict for the action just taken, in the
// MAIN scene flow — so a resolved attempt reads as "I did X → rolled Y vs DC Z →
// (verdict)" instead of resolving silently in the side Recent Rolls panel. The
// narrated prose outcome renders below in the GM/location panel; this surfaces
// the roll that produced it. Server-authoritative and staleness-proof: shown
// only when the most recent timeline event is an attempt, so a later move/search
// never re-surfaces a stale roll. Returns "" otherwise. Reuses existing classes
// (no new CSS rules) with shared :root accent vars applied inline.
// #33 THREE VISUALLY DISTINCT OUTCOME BANDS. The Ch3 resolution has three bands,
// and a sub-DC "success at a cost" must NEVER read as a clean "Success". Returns
// a band descriptor that is TRIPLE-CODED (distinct key/color, distinct label,
// distinct glyph) so the three are impossible to confuse at a glance. Prefers the
// resolver-stamped band/outcomeLabel (#28); falls back to margin, then boolean.
export function outcomeBandInfo(outcome = {}) {
  const cr = outcome.checkResult || null;
  let band = typeof outcome.band === "string" ? outcome.band : null;
  if (!band) {
    if (cr && cr.total != null && cr.dc != null) {
      const margin = Number(cr.total) - Number(cr.dc);
      band = margin >= 0 ? "success" : margin >= -4 ? "success_at_cost" : "failure";
    } else {
      band = outcome.success === true ? "success" : "failure";
    }
  }
  const MAP = {
    success: { key: "success", label: "Success", glyph: "✓" },
    success_at_cost: { key: "cost", label: "Success at a cost", glyph: "⚑" },
    failure: { key: "failure", label: "Failure", glyph: "✕" }
  };
  const info = MAP[band] || MAP.failure;
  // Honor a resolver-provided label if present, but keep the band key/glyph.
  return typeof outcome.outcomeLabel === "string" && outcome.outcomeLabel.trim()
    ? { ...info, label: outcome.outcomeLabel.trim() }
    : info;
}

export function renderSoloActionOutcome(state = {}) {
  const scene = state.scene || {};
  const timeline = Array.isArray(scene.recentTimeline) ? scene.recentTimeline : [];
  const last = timeline.length ? timeline[timeline.length - 1] : null;
  if (!last || last.type !== "attempt") {
    return "";
  }
  const outcome = scene.latestAttemptResult || state.attemptResult || null;
  if (!outcome) {
    return "";
  }
  const cr = outcome.checkResult || null;
  const b = outcomeBandInfo(outcome);
  const hasTotal = cr && cr.total !== undefined && cr.total !== null;
  const hasDc = cr && cr.dc !== undefined && cr.dc !== null;
  // #5 readability: label the numbers — bare "2/12" was unreadable. Verified
  // semantics: cr.total is the roll total, cr.dc the difficulty (matches the
  // right rail's "vs DC" framing and the resolver's checkResult contract).
  const roll = hasTotal
    ? `<span class="solo-outcome-roll">Rolled ${escapeHtml(cr.total)}${hasDc ? `<span class="solo-outcome-dc"> · DC ${escapeHtml(cr.dc)}</span>` : ""}</span>`
    : "";
  const intent = String(outcome.intent || "").trim();
  // #32: one thin row. Band glyph + label + roll on the left; the attempted
  // intent trails, dimmed. No card chrome, no gold stripe.
  return `
    <div class="solo-action-outcome band-${b.key}" role="status">
      <span class="solo-outcome-badge"><span class="solo-outcome-glyph" aria-hidden="true">${b.glyph}</span>${escapeHtml(b.label)}</span>
      ${roll}
      ${intent ? `<span class="solo-outcome-intent">${escapeHtml(intent)}</span>` : ""}
    </div>
  `;
}

export function renderTalkResultPanel(talkResult = null) {
  return `
    <section class="module-card solo-panel solo-talk-panel">
      <div class="module-header">
        <h3>Dialogue</h3>
        <span class="small">Server result</span>
      </div>
      ${
        talkResult
          ? `
            <div class="solo-talk-result ${talkResult.found ? "found" : "empty"}">
              <strong>${escapeHtml(talkResult.speakerName || "NPC")}</strong>
              <p>${escapeHtml(talkResult.line || "There is not much new to say right now.")}</p>
              <div class="small">${escapeHtml(talkResult.summary || "")}</div>
              ${renderCheckResult(talkResult.checkResult)}
              ${
                Array.isArray(talkResult.warningCodes) && talkResult.warningCodes.length
                  ? `<div class="solo-tag-row">${talkResult.warningCodes
                      .map((warning) => `<span class="tag">${escapeHtml(warning)}</span>`)
                      .join("")}</div>`
                  : ""
              }
            </div>
          `
          : renderEmpty("Talk to a visible NPC to see structured dialogue.")
      }
    </section>
  `;
}




export function renderEntityDetailPanel(detail = null) {
  if (!detail) {
    return `
      <section class="module-card solo-panel solo-detail-sheet">
        <div class="module-header">
          <h3>Entity Sheet</h3>
          <span class="small">Inspectable details</span>
        </div>
        <div class="solo-detail-empty">
          <strong>No entity selected.</strong>
          <p>Click an inspectable entity to open its server-backed detail sheet.</p>
        </div>
      </section>
    `;
  }

  const entity = detail.entity || {};
  const details = detail.details || {};
  const title = details.title || entity.displayName || entity.entityId || "Entity";
  const type = entity.entityType || details.entityType || "entity";
  const description = details.description || entity.summary || "No details available.";
  const stats = details.stats || entity.stats || {};
  const relationships = details.relationships || entity.relationships || [];
  const memories = details.memoryFacts || entity.memoryFacts || [];
  const availableActions = details.availableActions || entity.availableActions || [];
  const imageAssetId = details.imageAssetId || entity.imageAssetId || null;
  const portraitUri = details.portraitUri || entity.portraitUri || null;
  const tags = details.tags || entity.tags || [];

  return `
    <section class="module-card solo-panel solo-detail-sheet">
      <div class="module-header">
        <h3>Entity Sheet</h3>
        <span class="small">Structured payload</span>
      </div>
      <div class="solo-detail-hero">
        <div class="solo-detail-portrait">${
          portraitUri
            ? `<img class="solo-detail-portrait-img" src="${escapeHtml(portraitUri)}" alt="${escapeHtml(title)} portrait" />`
            : escapeHtml(imageAssetId || "No image assigned.")
        }</div>
        <div>
          <div class="solo-section-kicker">${escapeHtml(typeLabel(type))}</div>
          <h4>${escapeHtml(title)}</h4>
          <p>${escapeHtml(description)}</p>
          ${renderTags(tags)}
        </div>
      </div>

      <div class="solo-sheet-section">
        <h5>Stats</h5>
        ${renderStats(stats)}
      </div>

      <div class="solo-sheet-section">
        <h5>Relationships</h5>
        ${renderCompactList(relationships, "No known relationship data yet.", (relationship) => `
          <div class="solo-compact-row">
            <strong>${escapeHtml(relationship.label || relationship.relationshipId || relationship.targetEntityId || "Relationship")}</strong>
            <span>${escapeHtml(relationship.summary || relationship.status || "")}</span>
          </div>
        `)}
      </div>

      <div class="solo-sheet-section">
        <h5>Linked Memories</h5>
        ${renderCompactList(memories, "No linked memories yet.", (fact) => `
          <div class="solo-compact-row">
            <strong>${escapeHtml(fact.type || fact.factId || "Memory")}</strong>
            <span>${escapeHtml(fact.text || fact.summary || "")}</span>
          </div>
        `)}
      </div>

      <div class="solo-sheet-section">
        <h5>Available Actions</h5>
        ${renderCompactList(availableActions, "No sheet actions available yet.", (action) => `
          <div class="solo-compact-row">
            <strong>${escapeHtml(labelForAction(action))}</strong>
            <span>${escapeHtml(action.enabled === false ? action.reason || "Action not implemented yet." : "Available")}</span>
          </div>
        `)}
      </div>
    </section>
  `;
}

// Quest objective panel — pinned to the top of the Journal tab. Shows the active
// quest (the main quest if active, else the first active quest), its one-line
// objective, and a stage indicator past stage 0. Falls back to a neutral empty
// state when nothing is active (e.g. after the main quest is completed).



// ---------------------------------------------------------------------------
// Themed game-screen chrome (skins, fonts, character sidebar, tabs, right rail)
// ---------------------------------------------------------------------------

// Default skin ("Ashen Keep") plus the three premium skins. Each entry is a full
// CSS custom-property set applied to the shell root so the whole screen retints.
export const SOLO_SKINS = {
  // Default skin — "Black grimoire": premium black/oxblood leather-bound tome.
  // Genre-neutral occult-journal base (hosts cyberpunk/cosmic-horror, not just
  // fantasy). Mirrors the :root leather-tome palette so the scene shell matches
  // the home/onboarding surfaces. Texture is a fine gradient cross-hatch (grain)
  // — kept quote-free so it's safe inside the inline style="" attribute.
  // Default skin — "Black grimoire": black leather + SILVER (#21). Mirrors the
  // :root black-leather token map so the scene shell matches home/onboarding
  // surfaces. All accents are silver/steel — no gold, brown, or cobalt.
  ashen: {
    "--bg": "#050506", "--panel": "#0d0d10", "--card": "#101013", "--inset": "#070708",
    "--card-dim": "#0b0b0e", "--tabbar": "#08080a", "--border": "#202024", "--border-faint": "#17171a",
    "--border-strong": "#34343b", "--text": "#d9dbe0", "--text-bright": "#f1f2f5", "--text-2": "#b0b3bb",
    "--text-muted": "#8b8e96", "--text-label": "#83868e", "--text-faint": "#5f626a", "--accent": "#c2c6cf",
    "--accent-2": "#e7e9ee", "--accent-bright": "#e7e9ee", "--accent-grad-a": "#cfd3db", "--accent-grad-b": "#9498a1",
    "--accent-border": "#4c4d54", "--on-accent": "#0a0a0b",
    "--texture": "repeating-linear-gradient(34deg,rgba(214,217,224,.02) 0 1px,transparent 1px 3px),repeating-linear-gradient(-22deg,rgba(0,0,0,.22) 0 1px,transparent 1px 4px)",
    "--texture-size": "auto"
  },
  dragon: {
    "--bg": "#0f1411", "--panel": "#0c100d", "--card": "#121a14", "--inset": "#0c120e",
    "--card-dim": "#0e1410", "--tabbar": "#0a0f0c", "--border": "#243029", "--border-faint": "#1a241e",
    "--border-strong": "#2e3d33", "--text": "#e2e8da", "--text-bright": "#f1f5ec", "--text-2": "#a7b3a0",
    "--text-muted": "#8a978a", "--text-label": "#76837a", "--text-faint": "#5e6b62", "--accent": "#cf5236",
    "--accent-2": "#e6a23a", "--accent-bright": "#e6a23a", "--accent-grad-a": "#d65a3c", "--accent-grad-b": "#9e2a1b",
    "--accent-border": "#5a261a", "--on-accent": "#f6e8d6",
    "--texture": "radial-gradient(circle at 50% 100%,rgba(170,90,60,.10) 0 8px,transparent 9px),radial-gradient(circle at 0 100%,rgba(170,90,60,.10) 0 8px,transparent 9px),radial-gradient(circle at 100% 100%,rgba(170,90,60,.10) 0 8px,transparent 9px)",
    "--texture-size": "20px 14px"
  },
  lava: {
    "--bg": "#16100d", "--panel": "#100b09", "--card": "#1a110d", "--inset": "#0e0907",
    "--card-dim": "#140d0a", "--tabbar": "#0c0807", "--border": "#3a221a", "--border-faint": "#281712",
    "--border-strong": "#4a2a1e", "--text": "#f0e0d2", "--text-bright": "#fff0e2", "--text-2": "#c2a896",
    "--text-muted": "#a08876", "--text-label": "#8a7060", "--text-faint": "#6e5446", "--accent": "#ff6a1f",
    "--accent-2": "#ffb347", "--accent-bright": "#ffb347", "--accent-grad-a": "#ff7a2a", "--accent-grad-b": "#d94512",
    "--accent-border": "#7a2e12", "--on-accent": "#1a0c06",
    "--texture": "linear-gradient(115deg,transparent 47%,rgba(255,90,20,.12) 50%,transparent 53%),linear-gradient(60deg,transparent 47%,rgba(255,120,30,.08) 50%,transparent 53%)",
    "--texture-size": "90px 90px"
  },
  wood: {
    "--bg": "#161310", "--panel": "#11100a", "--card": "#1a1810", "--inset": "#11100a",
    "--card-dim": "#15130d", "--tabbar": "#0f0e09", "--border": "#2c2a1c", "--border-faint": "#201e14",
    "--border-strong": "#3a3724", "--text": "#e6e8d4", "--text-bright": "#f2f4e2", "--text-2": "#aab09a",
    "--text-muted": "#8e9480", "--text-label": "#787e6a", "--text-faint": "#5e6450", "--accent": "#86a544",
    "--accent-2": "#c2b24a", "--accent-bright": "#c2b24a", "--accent-grad-a": "#92b04e", "--accent-grad-b": "#5e7a2c",
    "--accent-border": "#3a4a22", "--on-accent": "#14180a",
    "--texture": "repeating-linear-gradient(92deg,rgba(150,140,90,.05) 0 2px,transparent 2px 8px),repeating-linear-gradient(88deg,rgba(120,110,70,.04) 0 1px,transparent 1px 5px)",
    "--texture-size": "auto"
  }
};

export const SOLO_FONTS = {
  tome: { "--font-display": "'Cinzel',Georgia,serif", "--font-body": "'Spectral',Georgia,serif" },
  court: { "--font-display": "'Marcellus',Georgia,serif", "--font-body": "'EB Garamond',Georgia,serif" },
  iron: { "--font-display": "'Grenze Gotisch',Georgia,serif", "--font-body": "'Spectral',Georgia,serif" }
};

const SOLO_SKIN_SWATCHES = {
  ashen: "linear-gradient(135deg,#e7e9ee,#0d0d10)",
  dragon: "linear-gradient(135deg,#cf5236,#0f1411)",
  lava: "linear-gradient(135deg,#ff6a1f,#16100d)",
  wood: "linear-gradient(135deg,#86a544,#161310)"
};

const SOLO_SKIN_LABELS = { ashen: "Black Grimoire", dragon: "Dragonscale", lava: "Molten Forge", wood: "Wildwood" };
const SOLO_FONT_LABELS = { tome: "Tome", court: "Court", iron: "Iron" };


export function normalizeSkin(skin) {
  return Object.prototype.hasOwnProperty.call(SOLO_SKINS, skin) ? skin : "ashen";
}

export function normalizeFontSet(fontSet) {
  return Object.prototype.hasOwnProperty.call(SOLO_FONTS, fontSet) ? fontSet : "tome";
}


// #48: narration text-size multiplier, clamped to a sane readable band and
// quantized to 0.1 steps. Non-numeric / out-of-range falls back to 1.0.
export const SOLO_LOG_SCALE_MIN = 0.8;
export const SOLO_LOG_SCALE_MAX = 1.6;
export const SOLO_LOG_SCALE_STEP = 0.1;
export function normalizeLogScale(scale) {
  const n = Number(scale);
  if (!Number.isFinite(n)) {
    return 1;
  }
  const clamped = Math.min(SOLO_LOG_SCALE_MAX, Math.max(SOLO_LOG_SCALE_MIN, n));
  return Math.round(clamped * 10) / 10;
}

// Build the inline custom-property string applied to the shell root.
export function soloThemeVarString(skin = "ashen", fontSet = "tome") {
  const vars = { ...SOLO_SKINS[normalizeSkin(skin)], ...SOLO_FONTS[normalizeFontSet(fontSet)] };
  return Object.entries(vars)
    .map(([key, value]) => `${key}:${value}`)
    .join(";");
}

// Static fallback character. The solo scene payload does not currently carry
// player stats, so the sidebar/sheet use this until live data is wired in.
const SOLO_SAMPLE_CHARACTER = {
  name: "Akrij the Spellblade",
  className: "Spellblade",
  level: 1,
  hitPoints: { current: 12, max: 12 },
  armorClass: 13,
  speed: 30,
  abilities: [
    { key: "STR", mod: "+0", score: 10 },
    { key: "DEX", mod: "+1", score: 12 },
    { key: "CON", mod: "+0", score: 11 },
    { key: "INT", mod: "+2", score: 14, accent: true },
    { key: "WIS", mod: "+1", score: 13 },
    { key: "CHA", mod: "+0", score: 10 }
  ],
  passivePerception: 11,
  initiative: "+1",
  proficiency: "+2",
  region: "Ashenmoor",
  saves: [
    { name: "Strength", mod: "+0" },
    { name: "Dexterity", mod: "+1" },
    { name: "Constitution", mod: "+2", proficient: true },
    { name: "Intelligence", mod: "+4", proficient: true },
    { name: "Wisdom", mod: "+1" },
    { name: "Charisma", mod: "+0" }
  ],
  skills: [
    { name: "Arcana", mod: "+4", proficient: true },
    { name: "Investigation", mod: "+4", proficient: true },
    { name: "Perception", mod: "+3", proficient: true },
    { name: "Insight", mod: "+1" },
    { name: "Athletics", mod: "+0" },
    { name: "Persuasion", mod: "+0" }
  ],
  proficiencies: "Light armor · Simple & martial weapons · Arcane focus · Thieves' cant of the Ashen roads"
};

function abilityModifier(score) {
  const n = Number(score);
  return Number.isFinite(n) ? Math.floor((n - 10) / 2) : 0;
}

function formatMod(mod) {
  return `${mod >= 0 ? "+" : ""}${mod}`;
}

// Maps the server scene.player projection into the character sidebar/sheet shape
// (SOLO_SAMPLE_CHARACTER). AC/speed aren't tracked on run.player, so the payload
// sends null and we default here. Returns null when no player is present.
// What each 5e skill DOES — static rules text so the sheet's skill rows are
// inspectable (expand to read) instead of a bare name+modifier. Keys match the
// lowercase names the server emits in player.skills.
const SKILL_INFO = {
  acrobatics: { ability: "DEX", desc: "Stay on your feet: balancing, tumbling, flips, and slipping free of a grapple." },
  "animal handling": { ability: "WIS", desc: "Calm, read, or direct animals — soothe a spooked mount, sense a beast's intent." },
  arcana: { ability: "INT", desc: "Recall lore about spells, magic items, planes, and magical phenomena." },
  athletics: { ability: "STR", desc: "Climb, jump, swim, grapple — raw physical effort under pressure." },
  deception: { ability: "CHA", desc: "Convince someone of a falsehood: lies, disguises, misdirection, bluffs." },
  history: { ability: "INT", desc: "Recall lore about past events, people, kingdoms, wars, and old customs." },
  insight: { ability: "WIS", desc: "Read intentions: detect lies, predict a move, sense what someone really wants." },
  intimidation: { ability: "CHA", desc: "Influence through threats, hostile presence, or the promise of violence." },
  investigation: { ability: "INT", desc: "Deduce from clues: search a room properly, spot a forgery, work out how something happened." },
  medicine: { ability: "WIS", desc: "Stabilize the dying, diagnose illness, and judge what wounded a body." },
  nature: { ability: "INT", desc: "Recall lore about terrain, plants, animals, weather, and natural cycles." },
  perception: { ability: "WIS", desc: "Notice things: hidden foes, faint sounds, small details others miss." },
  performance: { ability: "CHA", desc: "Hold an audience: music, storytelling, acting, and public spectacle." },
  persuasion: { ability: "CHA", desc: "Influence in good faith: tact, negotiation, etiquette, honest appeals." },
  religion: { ability: "INT", desc: "Recall lore about deities, rites, holy symbols, and religious orders." },
  "sleight of hand": { ability: "DEX", desc: "Manual trickery: palm an object, pick a pocket, plant something unseen." },
  stealth: { ability: "DEX", desc: "Go unseen and unheard: sneak past guards, hide, tail someone." },
  survival: { ability: "WIS", desc: "Track, forage, navigate wilds, predict weather, and avoid natural hazards." }
};

export function characterFromScenePlayer(player, world = null) {
  if (!player || typeof player !== "object") {
    return null;
  }
  const ab = player.abilities && typeof player.abilities === "object" ? player.abilities : {};
  const ABILITY_ORDER = [
    ["STR", "strength"],
    ["DEX", "dexterity"],
    ["CON", "constitution"],
    ["INT", "intelligence"],
    ["WIS", "wisdom"],
    ["CHA", "charisma"]
  ];
  const abilities = ABILITY_ORDER.map(([key, full]) => {
    const score = Number.isFinite(Number(ab[full])) ? Number(ab[full]) : 10;
    return { key, score, mod: formatMod(abilityModifier(score)) };
  });
  const dexMod = abilityModifier(Number(ab.dexterity) || 10);
  const wisMod = abilityModifier(Number(ab.wisdom) || 10);
  // State contract: prefer player.resources.{hp,mp}; fall back to the legacy
  // hitPoints gauge so pre-contract runs still render.
  const res = player.resources && typeof player.resources === "object" ? player.resources : {};
  const hp =
    res.hp && typeof res.hp === "object"
      ? res.hp
      : player.hitPoints && typeof player.hitPoints === "object"
        ? player.hitPoints
        : { current: 0, max: 0 };
  const mp = res.mp && typeof res.mp === "object" ? res.mp : { current: 0, max: 0 };
  const skillsObj = player.skills && typeof player.skills === "object" ? player.skills : {};
  const skills = Object.entries(skillsObj).map(([name, value]) => {
    const info = SKILL_INFO[name.toLowerCase()] || null;
    return {
      name: name.charAt(0).toUpperCase() + name.slice(1),
      mod: formatMod(Number(value) || 0),
      ability: info?.ability || "",
      description: info?.desc || ""
    };
  });
  const saves = ABILITY_ORDER.map(([, full]) => ({
    name: full.charAt(0).toUpperCase() + full.slice(1),
    mod: formatMod(abilityModifier(Number(ab[full]) || 10))
  }));
  // BABEL STATUS WINDOW (world-book §2.3): when the run is the Babel world-family
  // (scene.world.variant === "babel"), the sheet is the VOICE's diegetic WINDOW —
  // six relabeled stats (STR/DEX/VIT/Spirit/INT/Luck), a displayed Level + tier, a
  // hunter Rank (or UNASSESSED), the Awakening Origin, and HP. No AC/Speed/Mana/
  // D&D layout. The server owns the truth; this only relabels + reorders it.
  const isBabel = Boolean(world && typeof world === "object" && world.variant === "babel");
  // The Babel stat spine is single-sourced by the SERVER (player.babelStats,
  // built from run.player.abilities via the same lookup the resolver uses — see
  // server/solo/babelStats.js), so the WINDOW displays exactly what the check
  // resolves against. The hardcoded map is only a defensive fallback if an older
  // payload lacks babelStats; it derives from the same abilities the same way.
  const BABEL_STAT_ORDER = [
    ["STR", "strength"], ["DEX", "dexterity"], ["VIT", "constitution"],
    ["Spirit", "wisdom"], ["INT", "intelligence"], ["Luck", "charisma"]
  ];
  const babelStatSource = Array.isArray(player.babelStats) && player.babelStats.length
    ? player.babelStats.map((s) => [s.label, s.ability, s.score])
    : BABEL_STAT_ORDER.map(([key, full]) => [key, full, Number.isFinite(Number(ab[full])) ? Number(ab[full]) : 10]);
  const babel = isBabel
    ? {
        origin: typeof player.origin === "string" ? player.origin : "The Beckoned",
        originFeat: typeof player.originFeat === "string" ? player.originFeat : "",
        rank: typeof player.rank === "string" ? player.rank : "UNASSESSED",
        displayLevel: typeof player.displayLevel === "number" ? player.displayLevel : (typeof player.level === "number" ? player.level : 1),
        milestoneTier: typeof player.milestoneTier === "string" ? player.milestoneTier : "",
        // Ranked-skill surface: count + display records (server-normalized from
        // the SAME player.babelSkills that rank is computed from).
        rankedSkillCount: typeof player.rankedSkillCount === "number" ? player.rankedSkillCount : 0,
        skillDetails: Array.isArray(player.babelSkills) ? player.babelSkills : [],
        stats: babelStatSource.map(([key, , score]) => {
          const n = Number.isFinite(Number(score)) ? Number(score) : 10;
          return { key, score: n, mod: formatMod(abilityModifier(n)) };
        })
      }
    : null;
  return {
    name: player.displayName || "Adventurer",
    className: player.className || "Adventurer",
    level: babel ? babel.displayLevel : (typeof player.level === "number" && Number.isFinite(player.level) ? player.level : 1),
    // Babel STATUS WINDOW data (null for non-Babel worlds → default D&D sheet).
    babel,
    hitPoints: { current: hp.current ?? 0, max: hp.max ?? 0 },
    // State contract: HP/MP gauges, XP, inventory, conditions — surfaced live.
    mana: { current: mp.current ?? 0, max: mp.max ?? 0 },
    xp: typeof player.xp === "number" && Number.isFinite(player.xp) ? player.xp : 0,
    inventory: Array.isArray(player.inventory) ? player.inventory : [],
    conditions: Array.isArray(player.conditions) ? player.conditions : [],
    armorClass: typeof player.armorClass === "number" && Number.isFinite(player.armorClass) ? player.armorClass : 10,
    speed: typeof player.speed === "number" && Number.isFinite(player.speed) ? player.speed : 30,
    abilities,
    passivePerception: 10 + wisMod,
    initiative: formatMod(dexMod),
    proficiency: "+2",
    region: "Ashenmoor",
    saves,
    skills,
    proficiencies: "—",
    portraitUri: typeof player.portraitUri === "string" ? player.portraitUri : ""
  };
}

export function renderSoloThemeSwitcher(skin = "ashen", fontSet = "tome") {
  const activeSkin = normalizeSkin(skin);
  const activeFont = normalizeFontSet(fontSet);
  const chip = (active) =>
    `display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;` +
    (active
      ? "background:var(--accent,#c8922a);border:1px solid var(--accent-2,#e0b352);color:var(--on-accent,#1c1308);"
      : "background:var(--inset,#120c07);border:1px solid var(--border,#2e2420);color:var(--text-2,#b3a48c);");

  const skinButtons = Object.keys(SOLO_SKINS)
    .map(
      (id) =>
        `<button type="button" data-solo-skin="${id}" style="${chip(id === activeSkin)}">` +
        `<span style="display:inline-block;flex:none;width:14px;height:14px;border-radius:4px;background:${SOLO_SKIN_SWATCHES[id]};"></span>` +
        `${escapeHtml(SOLO_SKIN_LABELS[id])}</button>`
    )
    .join("");

  const fontButtons = Object.keys(SOLO_FONTS)
    .map(
      (id) =>
        `<button type="button" data-solo-font="${id}" style="${chip(id === activeFont)}">${escapeHtml(SOLO_FONT_LABELS[id])}</button>`
    )
    .join("");

  return `
    <div class="solo-theme-switcher">
      <div class="solo-theme-group">
        <span class="solo-theme-kicker">Skins</span>
        <span class="solo-theme-premium">Premium</span>
        <div class="solo-theme-buttons">${skinButtons}</div>
      </div>
      <div class="solo-theme-group">
        <span class="solo-theme-kicker">Fonts</span>
        <span class="solo-theme-premium">Premium</span>
        <div class="solo-theme-buttons">${fontButtons}</div>
      </div>
    </div>
  `;
}

// Pct fill for a {current,max} gauge, clamped 0..100 (0 when max is 0).
function gaugePct(gauge) {
  const cur = Number(gauge?.current) || 0;
  const max = Number(gauge?.max) || 0;
  return max > 0 ? Math.max(0, Math.min(100, Math.round((cur / max) * 100))) : 0;
}

// BABEL STATUS WINDOW — the VOICE's diegetic character sheet (world-book §2.3):
// six stats (STR/DEX/VIT/Spirit/INT/Luck), displayed Level + tier band, hunter
// Rank (UNASSESSED until a ranked skill is held), the Awakening Origin, and HP.
// No AC/Speed/Mana/D&D readouts — those are a different world's chassis dressing.
// "THE WINDOW DOES NOT LIE."
export function renderBabelStatusWindow(character = SOLO_SAMPLE_CHARACTER) {
  const b = character.babel || {};
  const hp = character.hitPoints || { current: 0, max: 0 };
  const hpPct = gaugePct(hp);
  const stats = (b.stats || [])
    .map(
      (s) => `
        <div class="solo-ability-cell">
          <div class="solo-ability-key">${escapeHtml(s.key)}</div>
          <div class="solo-ability-mod">${escapeHtml(s.mod)}</div>
          <div class="solo-ability-score">${escapeHtml(s.score)}</div>
        </div>
      `
    )
    .join("");
  const inventory = Array.isArray(character.inventory) ? character.inventory : [];
  // Inventory rows are INTERACTABLE: expand for the item's description, and Use
  // it right here when the server marks it usable (same data-solo-action wire as
  // the Inventory tab, so one delegation handles both surfaces).
  const inventoryHtml = inventory.length
    ? inventory
        .map((item) => {
          const name = typeof item?.name === "string" && item.name ? item.name : item?.id || "Item";
          const qty = Number(item?.qty ?? item?.quantity);
          const qtyTag = Number.isFinite(qty) && qty > 1 ? `<span class="solo-inv-qty">×${qty}</span>` : "";
          const itemId = typeof item?.id === "string" && item.id ? item.id : (typeof item?.itemId === "string" ? item.itemId : "");
          const description = typeof item?.description === "string" && item.description ? item.description : "No further detail — examine it in play.";
          const usable = item?.usable === true;
          return `<li class="solo-inv-item">
            <details class="solo-inv-detail">
              <summary class="solo-inv-summary"><span class="solo-inv-name">${escapeHtml(name)}</span>${qtyTag}</summary>
              <div class="solo-inv-body">
                <p class="solo-inv-desc">${escapeHtml(description)}</p>
                ${itemId && usable ? `<button type="button" class="ghost solo-inv-use" data-solo-action="use_item" data-item-id="${escapeHtml(itemId)}">Use</button>` : ""}
              </div>
            </details>
          </li>`;
        })
        .join("")
    : `<li class="solo-inv-empty">You carry nothing.</li>`;
  const conditions = Array.isArray(character.conditions) ? character.conditions : [];
  const conditionsHtml = conditions.length
    ? conditions
        .map((cond) => {
          const name = typeof cond?.name === "string" && cond.name ? cond.name : cond?.id || "Condition";
          return `<div class="solo-condition"><span class="solo-condition-dot"></span><div><div class="solo-condition-name">${escapeHtml(name)}</div></div></div>`;
        })
        .join("")
    : `<div class="solo-condition-empty">No active conditions.</div>`;
  // Skills shown in the WINDOW are the RANKED skills that define rank (the same
  // source rankForPlayer reads), NOT the 5e 18-row table — so count and RANK
  // never contradict (defect 4). A Beckoned start has none → "none" + UNASSESSED.
  // Each held skill is INSPECTABLE: expand to read its rank/stat/effect —
  // these are the records the RANK amalgamation is computed from.
  const skillDetails = Array.isArray(b.skillDetails) ? b.skillDetails : [];
  const skillCount = typeof b.rankedSkillCount === "number" ? b.rankedSkillCount : 0;
  const skillsHtml = skillDetails.length
    ? `<ul class="solo-skill-list">${skillDetails
        .map((skill) => {
          const name = typeof skill?.name === "string" && skill.name ? skill.name : "Unnamed skill";
          const rank = typeof skill?.rank === "string" && skill.rank ? skill.rank : "—";
          const facts = [
            skill?.stat ? `Keyed to ${String(skill.stat).toUpperCase()}` : "",
            typeof skill?.acquiredAtMilestone === "number" ? `Awakened at milestone ${skill.acquiredAtMilestone}` : "",
            skill?.source ? `Source: ${skill.source}` : ""
          ].filter(Boolean);
          return `<li class="solo-skill-item">
            <details class="solo-skill-detail">
              <summary class="solo-skill-summary"><span class="solo-skill-name">${escapeHtml(name)}</span><span class="solo-skill-rank">[ ${escapeHtml(rank)} ]</span></summary>
              <div class="solo-skill-body">
                ${skill?.effect ? `<p class="solo-skill-effect">${escapeHtml(skill.effect)}</p>` : ""}
                ${facts.length ? `<p class="solo-skill-facts">${escapeHtml(facts.join(" · "))}</p>` : ""}
                ${!skill?.effect && !facts.length ? `<p class="solo-skill-facts">The WINDOW records this skill but offers no further description.</p>` : ""}
              </div>
            </details>
          </li>`;
        })
        .join("")}</ul>`
    : `<div class="solo-skill-empty">none — skills are earned in play, and they define your RANK.</div>`;
  return `
    <aside class="solo-game-sidebar solo-babel-window" data-window="babel">
      <div class="solo-portrait" data-portrait-for="player" data-portrait-img-class="solo-portrait-img">${character.portraitUri ? `<img class="solo-portrait-img" src="${escapeHtml(character.portraitUri)}" alt="${escapeHtml(character.name || "Character")} portrait" />` : `<div class="solo-portrait-pending"><span class="solo-portrait-spinner" aria-hidden="true"></span><small>Crafting your portrait… (~20s)</small></div>`}</div>
      <div class="solo-sidebar-identity">
        <div class="solo-stat-kicker">◄ STATUS ►</div>
        <div class="solo-char-name">${escapeHtml(character.name)}</div>
        <div class="solo-char-sub">Level ${escapeHtml(b.displayLevel)} · ${escapeHtml(b.milestoneTier || "")}</div>
      </div>
      <div class="solo-sidebar-block">
        <div class="solo-passive-row"><span>RANK</span><span data-textfit>${escapeHtml(b.rank || "UNASSESSED")}</span></div>
        <div class="solo-passive-row"><span>ORIGIN</span><span data-textfit>${escapeHtml(b.origin || "The Beckoned")}</span></div>
      </div>
      <div class="solo-sidebar-block">
        <div class="solo-gauge-row">
          <span class="solo-stat-kicker">Vitality</span>
          <span class="solo-hp-value">${escapeHtml(hp.current)} <span>/ ${escapeHtml(hp.max)}</span></span>
        </div>
        <div class="solo-gauge-track"><div class="solo-gauge-fill solo-hp-fill" style="width:${hpPct}%;"></div></div>
      </div>
      <div class="solo-sidebar-block">
        <div class="solo-stat-kicker">Attributes</div>
        <div class="solo-ability-grid">${stats}</div>
      </div>
      <div class="solo-sidebar-block">
        <div class="solo-passive-row"><span>Skills</span><span>${skillCount > 0 ? escapeHtml(skillCount) : "none"}</span></div>
        ${skillsHtml}
      </div>
      <div class="solo-sidebar-block solo-inventory-block">
        <div class="solo-stat-kicker">Inventory</div>
        <ul class="solo-inv-list">${inventoryHtml}</ul>
      </div>
      <div class="solo-sidebar-block solo-conditions-block">
        <div class="solo-stat-kicker">Conditions</div>
        ${conditionsHtml}
      </div>
      <div class="solo-sidebar-block solo-window-motto">[ THE WINDOW DOES NOT LIE. ]</div>
    </aside>
  `;
}

export function renderSoloCharacterSidebar(character = SOLO_SAMPLE_CHARACTER) {
  // BABEL: the diegetic STATUS WINDOW replaces the D&D sheet entirely (§2.3).
  if (character && character.babel) {
    return renderBabelStatusWindow(character);
  }
  const hp = character.hitPoints || { current: 0, max: 0 };
  const mp = character.mana || { current: 0, max: 0 };
  const hpPct = gaugePct(hp);
  const mpPct = gaugePct(mp);
  const hasMana = (Number(mp.max) || 0) > 0;
  const xp = Number.isFinite(Number(character.xp)) ? Number(character.xp) : 0;
  const abilities = (character.abilities || [])
    .map(
      (ability) => `
        <div class="solo-ability-cell">
          <div class="solo-ability-key">${escapeHtml(ability.key)}</div>
          <div class="solo-ability-mod ${ability.accent ? "accent" : ""}">${escapeHtml(ability.mod)}</div>
          <div class="solo-ability-score">${escapeHtml(ability.score)}</div>
        </div>
      `
    )
    .join("");

  // State contract: player.inventory[] (each {id,name,qty}). Always shown so the
  // player can see what they carry; resolvers append to it as actions land.
  // Interactable (same treatment as the Babel WINDOW): expand for the item's
  // description, Use in place when the server marks it usable.
  const inventory = Array.isArray(character.inventory) ? character.inventory : [];
  const inventoryHtml = inventory.length
    ? inventory
        .map((item) => {
          const name = typeof item?.name === "string" && item.name ? item.name : item?.id || "Item";
          const qty = Number(item?.qty ?? item?.quantity);
          const qtyTag = Number.isFinite(qty) && qty > 1 ? `<span class="solo-inv-qty">×${qty}</span>` : "";
          const itemId = typeof item?.id === "string" && item.id ? item.id : (typeof item?.itemId === "string" ? item.itemId : "");
          const description = typeof item?.description === "string" && item.description ? item.description : "No further detail — examine it in play.";
          const usable = item?.usable === true;
          return `<li class="solo-inv-item">
            <details class="solo-inv-detail">
              <summary class="solo-inv-summary"><span class="solo-inv-name">${escapeHtml(name)}</span>${qtyTag}</summary>
              <div class="solo-inv-body">
                <p class="solo-inv-desc">${escapeHtml(description)}</p>
                ${itemId && usable ? `<button type="button" class="ghost solo-inv-use" data-solo-action="use_item" data-item-id="${escapeHtml(itemId)}">Use</button>` : ""}
              </div>
            </details>
          </li>`;
        })
        .join("")
    : `<li class="solo-inv-empty">Your pack is empty.</li>`;

  // State contract: player.conditions[] (each {id,name}). Replaces the old
  // hard-coded sample condition — empty state when the player carries none.
  const conditions = Array.isArray(character.conditions) ? character.conditions : [];
  const conditionsHtml = conditions.length
    ? conditions
        .map((cond) => {
          const name = typeof cond?.name === "string" && cond.name ? cond.name : cond?.id || "Condition";
          const note = typeof cond?.note === "string" && cond.note ? `<div class="solo-condition-note">${escapeHtml(cond.note)}</div>` : "";
          return `<div class="solo-condition"><span class="solo-condition-dot"></span><div><div class="solo-condition-name">${escapeHtml(name)}</div>${note}</div></div>`;
        })
        .join("")
    : `<div class="solo-condition-empty">No active conditions.</div>`;

  return `
    <aside class="solo-game-sidebar">
      <div class="solo-portrait" data-portrait-for="player" data-portrait-img-class="solo-portrait-img">${character.portraitUri ? `<img class="solo-portrait-img" src="${escapeHtml(character.portraitUri)}" alt="${escapeHtml(character.name || "Character")} portrait" />` : `<div class="solo-portrait-pending"><span class="solo-portrait-spinner" aria-hidden="true"></span><small>Crafting your portrait… (~20s)</small></div>`}</div>
      <div class="solo-sidebar-identity">
        <div class="solo-char-name">${escapeHtml(character.name)}</div>
        <div class="solo-char-sub">${escapeHtml(character.className)} · Level ${escapeHtml(character.level)}</div>
        <div class="solo-xp-row"><span class="solo-stat-kicker">XP</span><span class="solo-xp-value">${escapeHtml(xp)}</span></div>
      </div>
      <div class="solo-sidebar-block">
        <div class="solo-gauge-row">
          <span class="solo-stat-kicker">Hit Points</span>
          <span class="solo-hp-value">${escapeHtml(hp.current)} <span>/ ${escapeHtml(hp.max)}</span></span>
        </div>
        <div class="solo-gauge-track"><div class="solo-gauge-fill solo-hp-fill" style="width:${hpPct}%;"></div></div>
        <div class="solo-gauge-row solo-mp-row${hasMana ? "" : " is-muted"}">
          <span class="solo-stat-kicker">${hasMana ? "Mana" : "Mana — none"}</span>
          <span class="solo-hp-value">${escapeHtml(mp.current)} <span>/ ${escapeHtml(mp.max)}</span></span>
        </div>
        <div class="solo-gauge-track"><div class="solo-gauge-fill solo-mp-fill" style="width:${mpPct}%;"></div></div>
        <div class="solo-mini-stats">
          <div class="solo-mini-stat"><div class="solo-mini-val">${escapeHtml(character.armorClass)}</div><div class="solo-mini-label">Armor</div></div>
          <div class="solo-mini-stat"><div class="solo-mini-val">${escapeHtml(character.speed)}</div><div class="solo-mini-label">Speed</div></div>
        </div>
      </div>
      <div class="solo-sidebar-block">
        <div class="solo-stat-kicker">Abilities</div>
        <div class="solo-ability-grid">${abilities}</div>
      </div>
      <div class="solo-sidebar-block solo-inventory-block">
        <div class="solo-stat-kicker">Inventory</div>
        <ul class="solo-inv-list">${inventoryHtml}</ul>
      </div>
      <div class="solo-sidebar-block solo-passive-block">
        <div class="solo-passive-row"><span>Passive Perception</span><span>${escapeHtml(character.passivePerception)}</span></div>
        <div class="solo-passive-row"><span>Initiative</span><span>${escapeHtml(character.initiative)}</span></div>
        <div class="solo-passive-row"><span>Proficiency</span><span>${escapeHtml(character.proficiency)}</span></div>
      </div>
      <div class="solo-sidebar-block solo-conditions-block">
        <div class="solo-stat-kicker">Conditions</div>
        ${conditionsHtml}
      </div>
    </aside>
  `;
}


// #15: the "GM is thinking / Loading scene" strip, extracted so the turn
// fast-path can repaint just this node (inside data-solo-thinking) in place.
// ---------------------------------------------------------------------------
// CONDITIONS HUD (#26 made player-visible). The server commits conditions with
// durations and sheds them on expiry — but nothing rendered them (the live
// palm-mark example: committed, invisible). One chip per active condition,
// read from the scene payload the client already polls:
//   scene.player.conditions[] = { id, name, effect, remainingMinutes|null,
//                                 permanent } (conditionStatusPayload)
// DATA GAP (flagged, not invented): the payload has NO buff/debuff type field.
// Hue is a client-side PRESENTATION heuristic over name+effect words; unknown
// stays neutral. Colors reuse the existing fixed band semantics (success green /
// failure red) so they read identically across all four skins.
// ---------------------------------------------------------------------------
const CONDITION_BUFF_RE = /\b(bless|blessed|haste|hasted|inspir|ward|warded|protect|shield|regen|fortif|strengthen|suppress|resist|guid|heal)/i;
const CONDITION_DEBUFF_RE = /\b(exhaust|poison|grappl|stun|burn|frozen|blind|curse|disease|paralyz|prone|bleed|weaken|slow|frighten|fear|wound)/i;

export function classifyConditionHue(condition = {}) {
  const blob = `${condition.name || ""} ${condition.effect || ""}`;
  if (CONDITION_DEBUFF_RE.test(blob)) return "debuff";
  if (CONDITION_BUFF_RE.test(blob)) return "buff";
  return "neutral";
}

// World-clock minutes → a short human duration ("45m", "≈2h", "≈3d").
export function formatConditionDuration(remainingMinutes) {
  if (remainingMinutes == null) return ""; // Number(null)===0 — never "1m" a permanent
  const m = Number(remainingMinutes);
  if (!Number.isFinite(m)) return "";
  if (m < 60) return `${Math.max(1, Math.round(m))}m`;
  if (m < 1440) return `≈${Math.round(m / 60)}h`;
  return `≈${Math.round(m / 1440)}d`;
}

export function renderSoloConditionsHud(scene = {}) {
  const conditions = (Array.isArray(scene.player?.conditions) ? scene.player.conditions : Array.isArray(scene.conditions) ? scene.conditions : [])
    .filter((c) => c && (c.name || c.id));
  if (!conditions.length) {
    return ""; // empty state: nothing visible, no placeholder text
  }
  const chips = conditions
    .map((c) => {
      const hue = classifyConditionHue(c);
      const name = String(c.name || c.id);
      const duration = c.permanent ? "" : formatConditionDuration(c.remainingMinutes);
      const remainText = c.permanent
        ? "Lasts until cleared."
        : duration
          ? `Time remaining: ${duration}.`
          : "";
      const tipBody = [String(c.effect || "").trim(), remainText].filter(Boolean).join(" ");
      return `
        <span class="solo-cond-chip cond-${hue}" tabindex="0" data-cond-id="${escapeHtml(c.id || name)}" aria-label="${escapeHtml(`${name}. ${tipBody}`)}">
          <span class="solo-cond-dot" aria-hidden="true"></span>
          <span class="solo-cond-name">${escapeHtml(name)}</span>
          ${duration ? `<span class="solo-cond-time">${escapeHtml(duration)}</span>` : ""}
          <span class="solo-cond-tip" role="tooltip">
            <strong>${escapeHtml(name)}</strong>${tipBody ? `<span>${escapeHtml(tipBody)}</span>` : ""}
          </span>
        </span>`;
    })
    .join("");
  return `<div class="solo-conditions solo-measure" role="group" aria-label="Active conditions">${chips}</div>`;
}

export function renderSoloThinkingIndicator(state = {}) {
  if (!state.gmThinking && !state.sceneReloading) {
    return "";
  }
  const label = state.gmThinking ? "The GM is thinking…" : "Loading scene…";
  return `<div class="solo-thinking" role="status">${label}</div>`;
}

export function renderSoloSceneInputBar(state = {}) {
  const confirmation = typeof state.npcCreatorConfirmation === "string" ? state.npcCreatorConfirmation : "";

  // While any action is in flight, disable the input + submit (prevents
  // double-submit) and surface the wait in the button label.
  const busy = Boolean(state.busy);

  // #16: the top "Suggested" AI-hook chips and the bottom verb row are gone.
  // #22: the orphaned "+ Bring someone in" tool (a multiplayer stub) is removed
  // from the solo build. The free-text input is the whole interface: type what
  // you do. The NPC-creator confirmation line still renders if one is pending.
  // #37/#38/#39: a thin meta row under the field shows the live-classified mode
  // (Action / Speech / OOC) and the char counter. Both are updated in place as
  // the player types (no re-render — see bindSoloSceneShell), so the chip below
  // reflects only the initial draft state.
  const draft = String(state.attemptDraft || "");
  const cls = classifyInput(draft);
  const meta = SOLO_INPUT_MODE_META[cls.mode] || SOLO_INPUT_MODE_META.action;
  const count = draft.length;
  const over = count > SOLO_INPUT_MAXLEN;
  return `
    <div class="solo-scene-input solo-measure">
      <div class="solo-scene-input-row">
        <input type="text" class="solo-scene-field" data-solo-attempt-input placeholder="What do you do?  (&quot;quote&quot; to speak · /ooc to ask the GM)" value="${escapeHtml(draft)}" maxlength="${SOLO_INPUT_MAXLEN}" ${busy ? "disabled" : ""} />
        <button type="button" class="solo-attempt-submit" data-solo-attempt-submit ${busy ? "disabled" : ""}>${busy ? "Thinking…" : "Attempt"}</button>
      </div>
      <div class="solo-scene-input-meta">
        <span class="solo-input-mode solo-input-mode--${cls.mode}" data-solo-input-mode title="${escapeHtml(meta.hint)}">${escapeHtml(meta.label)}</span>
        <span class="solo-input-count${over ? " is-over" : ""}" data-solo-charcount>${count}/${SOLO_INPUT_MAXLEN}</span>
        <!-- #48: narration text-size control. Scales the log prose (and player
             action intent) via --solo-log-scale without touching the bounded
             scroll / pinned stage. Persisted; delegated via data-solo-logfont. -->
        <span class="solo-log-fontsize" role="group" aria-label="Narration text size">
          <button type="button" class="solo-fontsize-btn" data-solo-logfont="down" title="Smaller narration text" aria-label="Smaller narration text">A−</button>
          <button type="button" class="solo-fontsize-btn" data-solo-logfont="up" title="Larger narration text" aria-label="Larger narration text">A+</button>
        </span>
      </div>
      ${confirmation ? `<div class="solo-npc-confirm" role="status">${escapeHtml(confirmation)}</div>` : ""}
    </div>
  `;
}

// Inner HTML for the scene-art banner when an image exists: the image plus the
// Redo/Save controls (hidden once the image is locked). Shared by the initial
// render and the poll's in-place swap so both stay consistent.
export function sceneArtInnerHtml(uri, { locked = false } = {}) {
  const controls = locked
    ? ""
    : `
      <div class="solo-scene-art-controls">
        <button type="button" class="solo-scene-art-btn" data-scene-redo title="Generate a new image for this location">↻ Redo</button>
        <button type="button" class="solo-scene-art-btn solo-scene-art-btn--save" data-scene-save title="Keep this image for this location">✓ Save</button>
      </div>`;
  return `<img class="solo-scene-art-img" src="${escapeHtml(uri)}" alt="Location background" />${controls}`;
}

export function renderSoloSceneArt(locationImageUri = null, { locked = false } = {}) {
  const uri = typeof locationImageUri === "string" ? locationImageUri.trim() : "";
  if (uri) {
    // Generated location background fills the banner area (object-fit: cover),
    // with Redo/Save controls overlaid bottom-right until the image is locked.
    return `
      <div class="solo-scene-art" data-scene-art>
        ${sceneArtInnerHtml(uri, { locked })}
      </div>
    `;
  }
  // No image yet: decorative firelit vignette + a subtle generating label,
  // mirroring the portrait-placeholder pattern.
  return `
    <div class="solo-scene-art" data-scene-art>
      <div class="solo-scene-art-glow"></div>
      <div class="solo-scene-art-window"></div>
      <div class="solo-scene-art-hearth"></div>
      <div class="solo-scene-art-floor"></div>
      <div class="solo-scene-art-pending">Painting the scene… (~20s)</div>
    </div>
  `;
}


// ---------------------------------------------------------------------------
// Solo battle map — Phase 1 (Tickets: solo battle map).
// Net-new, solo-only (does NOT touch the multiplayer VTT). Phase 1 scope:
// spawn the player + visible NPCs as tokens on a 5ft grid, linked to real run
// entities. No movement/fog yet (Phase 2/3). Positions are derived
// deterministically from the scene; nothing is persisted server-side.

// Image-completion poll cadence. Portraits + location art generate async (one
// shared worker queue, no WebSocket), so the scene loads with placeholders and
// we poll until every URI is ready. Real providers (Pollinations) routinely
// take far longer than the old 15s budget — base portrait, each NPC base, and
// the location background all generate sequentially — so the window must cover
// realistic latency, not just a couple of ticks. Still bounded: the poll stops
// early as soon as nothing is pending, and at the cap otherwise.
const SOLO_ART_POLL_INTERVAL_MS = 5000;
const SOLO_ART_POLL_MAX_ATTEMPTS = 24; // ~2 minutes at 5s

function soloMapClamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function soloTokenInitials(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "?";
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}





// Procedural LOCAL-AREA map: the ruins (home base) + forest + discovered POIs in
// their remembered positions. Undiscovered places stay fogged (the payload only
// carries discovered POIs + a count of the rest). Read-only — markers, not
// tactics. Built to ZOOM OUT later: scale:"local" today; a world layer can nest
// regions around the same home anchor. Pure render from scene.areaMap.
const AREA_POI_GLYPH = { home: "⌂", ruins: "▲", forest: "♣", settlement: "⌂", water: "≈", site: "◆" };

// Resolves a token's display name from the scene (player → displayName; npc →
// cast/visibleEntities; else the raw id). Pure.
function presenceTokenName(entityId, kind, scene) {
  const id = String(entityId || "");
  if (kind === "player" || id.startsWith("player:")) {
    return (scene.player && scene.player.displayName) || "You";
  }
  const raw = id.includes(":") ? id.split(":").slice(1).join(":") : id;
  const cast = Array.isArray(scene.cast) ? scene.cast : [];
  const fromCast = cast.find((m) => m && (m.npcId === raw || m.entityId === id));
  if (fromCast && fromCast.displayName) {
    return fromCast.displayName;
  }
  const visible = Array.isArray(scene.visibleEntities) ? scene.visibleEntities : [];
  const fromVisible = visible.find((e) => e && e.entityId === id);
  if (fromVisible && fromVisible.displayName) {
    return fromVisible.displayName;
  }
  return raw || "?";
}

// Deterministic 0..1 hash from a string (FNV-1a, normalized). Pure — used to give
// the presence map a stable, location-specific mottle so the same place always
// renders the same ground (no flicker across re-renders).
function soloHash01(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 1000) / 1000;
}

// Picks a terrain skin (a CSS class) for the presence/battle ground from the
// location's tags + name, so the floor reads as appropriate to the place
// (forest, ruins/stone, water, sand) instead of a black void. Defaults to the
// neutral stone-floor when nothing matches.
function presenceTerrainClass(scene = {}) {
  const loc = scene && typeof scene.location === "object" && scene.location ? scene.location : {};
  const hay = [
    ...(Array.isArray(loc.tags) ? loc.tags : []),
    ...(Array.isArray(loc.contentTags) ? loc.contentTags : []),
    typeof loc.name === "string" ? loc.name : ""
  ]
    .join(" ")
    .toLowerCase();
  if (/forest|wood|grove|wild|jungle|thicket/.test(hay)) return "terrain-forest";
  if (/water|river|port|sea|lake|coast|dock|marsh|swamp/.test(hay)) return "terrain-water";
  if (/sand|desert|dune|waste/.test(hay)) return "terrain-sand";
  if (/ruin|crypt|dungeon|temple|stone|tomb|hall/.test(hay)) return "terrain-ruins";
  return "terrain-stone";
}

// Always-on presence map (light): renders the per-scene battleMap tokens (player
// + co-located NPCs) from the state contract so the player always has a sense of
// being SOMEWHERE. Read-only — tactical movement / range / line-of-sight is a
// deferred resolver track, NOT here. Reuses the .solo-token-<kind> colour classes;
// CSS grid places each token at its (x,y). A terrain+grid layer is rendered
// BENEATH the tokens (explicitly-placed background cells) so the tokens sit on a
// readable ground, not in a void.
// Glyphs for state-placed area features on the presence map. Legible at the small
// tactical scale; kind-keyed so the server can label exits/landmarks/structure.
const PRESENCE_FEATURE_GLYPH = {
  exit: "⤳",
  door: "▢",
  landmark: "◆",
  poi: "◆",
  site: "◆",
  ruins: "▲",
  structure: "⌂",
  building: "⌂",
  shrine: "✦",
  hazard: "⚠",
  water: "≈",
  cover: "▮",
  loot: "✚"
};
export function renderSoloPresenceMap(scene = {}) {
  const bm = scene && typeof scene.battleMap === "object" && scene.battleMap ? scene.battleMap : {};
  const tokens = Array.isArray(bm.tokens) ? bm.tokens : [];
  const locationName = scene.location && typeof scene.location.name === "string" && scene.location.name ? scene.location.name : "Here";
  const head = `<div class="solo-presence-head"><span class="solo-stat-kicker">Where you are</span><span class="solo-presence-loc" data-textfit>${escapeHtml(locationName)}</span></div>`;
  if (!tokens.length) {
    return `<div class="solo-presence">${head}<div class="solo-presence-empty">The ground beneath you hasn't taken shape yet.</div></div>`;
  }
  const width = Number.isFinite(bm.width) && bm.width > 0 ? Math.min(24, Math.trunc(bm.width)) : 12;
  const height = Number.isFinite(bm.height) && bm.height > 0 ? Math.min(24, Math.trunc(bm.height)) : 12;
  const clampTo = (n, max) => Math.max(0, Math.min(max - 1, Math.trunc(Number(n) || 0)));
  const terrainClass = presenceTerrainClass(scene);

  // Terrain layer: one background cell per grid coordinate (explicitly placed so
  // it never collides with the explicitly-placed tokens). Each cell carries a
  // deterministic per-cell brightness so the ground looks mottled/natural — the
  // grid lines come from the cell borders in CSS.
  const ground = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const shade = 0.85 + soloHash01(`${locationName}:${x}:${y}`) * 0.3;
      ground.push(
        `<span class="solo-presence-cell" style="grid-column:${x + 1};grid-row:${y + 1};filter:brightness(${shade.toFixed(2)});"></span>`
      );
    }
  }

  // Area-feature layer (POIs / landmarks / exits / the ruins structure) — drawn
  // BENEATH the tokens so the player/NPCs stay on top. PURELY state-driven: read
  // from scene.battleMap.features (positioned { kind, x, y, name }, the same grid
  // as tokens). Honest to state — when the server places none, nothing is drawn
  // (no invented markers). Track A/backend populates this field; this is the
  // render side, built generically so placed features appear without more UI work.
  const features = Array.isArray(bm.features) ? bm.features : [];
  const featureCells = features
    .filter((f) => f && typeof f === "object" && Number.isFinite(Number(f.x)) && Number.isFinite(Number(f.y)))
    .map((feature) => {
      const kind = typeof feature.kind === "string" && feature.kind ? feature.kind : "site";
      const glyph = PRESENCE_FEATURE_GLYPH[kind] || PRESENCE_FEATURE_GLYPH.site;
      const x = clampTo(feature.x, width);
      const y = clampTo(feature.y, height);
      const name = typeof feature.name === "string" && feature.name ? feature.name : kind;
      return `<span class="solo-presence-feature solo-feature-${escapeHtml(kind)}" style="grid-column:${x + 1};grid-row:${y + 1};" title="${escapeHtml(name)}" aria-label="${escapeHtml(name)}"><span class="solo-feature-glyph">${glyph}</span></span>`;
    })
    .join("");

  // Legend so each glyph is legible (the bare ◆ diamond had no meaning on hover
  // or otherwise). Honest to state: only features actually placed are listed,
  // deduped by name — nothing invented. Renders only when features exist.
  const seenFeatureNames = new Set();
  const featureLegend = features
    .filter((f) => f && typeof f === "object" && Number.isFinite(Number(f.x)) && Number.isFinite(Number(f.y)))
    .map((feature) => {
      const kind = typeof feature.kind === "string" && feature.kind ? feature.kind : "site";
      return {
        kind,
        glyph: PRESENCE_FEATURE_GLYPH[kind] || PRESENCE_FEATURE_GLYPH.site,
        name: typeof feature.name === "string" && feature.name ? feature.name : kind
      };
    })
    .filter((f) => (seenFeatureNames.has(f.name) ? false : (seenFeatureNames.add(f.name), true)))
    .map(
      (f) =>
        `<span class="solo-presence-legend-item"><span class="solo-feature-glyph solo-feature-${escapeHtml(f.kind)}">${f.glyph}</span>${escapeHtml(f.name)}</span>`
    )
    .join("");
  const legendBlock = featureLegend ? `<div class="solo-presence-legend">${featureLegend}</div>` : "";

  const cells = tokens
    .map((token) => {
      const kind = token && (token.kind === "player" || token.kind === "npc" || token.kind === "item") ? token.kind : "npc";
      const x = clampTo(token.x, width);
      const y = clampTo(token.y, height);
      const name = presenceTokenName(token.entityId, kind, scene);
      const initial = String(name).trim().slice(0, 1).toUpperCase() || "?";
      return `<span class="solo-presence-token solo-token-${escapeHtml(kind)}" style="grid-column:${x + 1};grid-row:${y + 1};" title="${escapeHtml(name)}" aria-label="${escapeHtml(name)}">${escapeHtml(initial)}</span>`;
    })
    .join("");
  return `<div class="solo-presence">${head}<div class="solo-presence-grid ${terrainClass}" style="grid-template-columns:repeat(${width},1fr);grid-template-rows:repeat(${height},1fr);" role="img" aria-label="Presence map of ${escapeHtml(locationName)}">${ground.join("")}${featureCells}${cells}</div>${legendBlock}</div>`;
}

// #40 — surface the committed world clock (#14). The server derives
// scene.player.worldTime { day, clock:"HH:MM", phase, isNight, isDark } from the
// one committed truth; the client only READS it (never recomputes). A Caves-of-
// Qud-style sun/moon icon + time + phase/day, styled per phase in CSS.
const CLOCK_PHASE_META = {
  dawn: { label: "Dawn", cls: "solo-clock-dawn" },
  day: { label: "Day", cls: "solo-clock-day" },
  dusk: { label: "Dusk", cls: "solo-clock-dusk" },
  night: { label: "Night", cls: "solo-clock-night" }
};

// Sun for dawn/day/dusk (tinted per phase in CSS), crescent moon for night.
function clockPhaseIcon(phase) {
  if (phase === "night") {
    return `<svg class="solo-clock-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 14.5A8 8 0 0 1 9.5 4a0.5 0.5 0 0 0-0.7-0.6 9 9 0 1 0 11.8 11.8 0.5 0.5 0 0 0-0.6-0.7z"/></svg>`;
  }
  const rays = [
    [12, 1, 12, 4], [12, 20, 12, 23], [1, 12, 4, 12], [20, 12, 23, 12],
    [4.2, 4.2, 6.3, 6.3], [17.7, 17.7, 19.8, 19.8], [4.2, 19.8, 6.3, 17.7], [17.7, 6.3, 19.8, 4.2]
  ]
    .map(([x1, y1, x2, y2]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`)
    .join("");
  return `<svg class="solo-clock-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4.5"/><g class="solo-clock-rays">${rays}</g></svg>`;
}

export function renderSoloClock(scene = {}) {
  const wt = (scene.player && typeof scene.player.worldTime === "object" && scene.player.worldTime)
    || (typeof scene.worldTime === "object" && scene.worldTime)
    || null;
  if (!wt) {
    return "";
  }
  const phase = typeof wt.phase === "string" && CLOCK_PHASE_META[wt.phase] ? wt.phase : "day";
  const meta = CLOCK_PHASE_META[phase];
  const clock = typeof wt.clock === "string" && wt.clock ? wt.clock : "—";
  const day = Number.isFinite(wt.day) ? wt.day : null;
  const dayPart = day ? ` · Day ${escapeHtml(day)}` : "";
  const aria = `Time ${clock}, ${meta.label}${day ? `, day ${day}` : ""}`;
  return `
    <div class="solo-clock ${meta.cls}" role="group" aria-label="${escapeHtml(aria)}" data-solo-clock>
      ${clockPhaseIcon(phase)}
      <div class="solo-clock-text">
        <span class="solo-clock-time">${escapeHtml(clock)}</span>
        <span class="solo-clock-phase">${escapeHtml(meta.label)}${dayPart}</span>
      </div>
    </div>`;
}

export function renderSoloRightRail(state = {}) {
  const scene = state.scene || {};
  // Prefer the full server-side cast roster (all run.npcs with portrait URIs);
  // fall back to current-location NPCs for older payloads without `cast`.
  const roster =
    Array.isArray(scene.cast) && scene.cast.length
      ? scene.cast
      : (Array.isArray(scene.visibleEntities) ? scene.visibleEntities : [])
          .filter((entity) => entity?.entityType === "npc")
          .map((entity) => ({
            npcId: String(entity.entityId || "").split(":").slice(1).join(":") || entity.entityId,
            entityId: entity.entityId,
            displayName: entity.displayName,
            role: entity.summary,
            portraitUri: "",
            present: true
          }));

  const cast = roster.length
    ? roster
        .map((member) => {
          const name = member.displayName || "Unknown";
          const role = member.role || "—";
          const entityId = member.entityId || (member.npcId ? `npc:${member.npcId}` : "");
          const portraitUri = typeof member.portraitUri === "string" ? member.portraitUri : "";
          const initial = String(name).trim().slice(0, 1).toUpperCase() || "?";
          const present = member.present !== false;
          const thumb = portraitUri
            ? `<img src="${escapeHtml(portraitUri)}" alt="${escapeHtml(name)}" />`
            : `<span class="solo-cast-thumb-pending" title="Crafting your portrait… (~20s)">${escapeHtml(initial)}</span>`;
          const away = member.present === false ? ` <span class="solo-cast-away">away</span>` : "";
          // Present NPCs carry Talk/Inspect — the affordances the now-removed
          // "Visible Entities" panel held, so entities live in ONE place. Reuses
          // the existing data-solo-action delegation (no handler change) and the
          // .solo-cast-bringback button styling (no new CSS). Bring back stays for
          // everyone.
          return `
            <div class="solo-cast-card">
              <div class="solo-cast-thumb" data-portrait-for="${escapeHtml(entityId)}">${thumb}</div>
              <div class="solo-cast-meta">
                <div class="solo-cast-name" data-textfit>${escapeHtml(name)}${away}</div>
                <div class="solo-cast-role">${escapeHtml(role)}</div>
              </div>
              <div class="solo-cast-actions" style="display:flex;flex-direction:column;gap:4px;">
                ${
                  present
                    ? `<button type="button" class="solo-cast-bringback" data-solo-action="talk" data-entity-id="${escapeHtml(entityId)}">Talk</button>
                       <button type="button" class="solo-cast-bringback" data-solo-action="inspect" data-entity-id="${escapeHtml(entityId)}">Inspect</button>`
                    : ""
                }
                <button type="button" class="solo-cast-bringback" data-solo-npc-bringback data-entity-id="${escapeHtml(entityId)}">Bring back</button>
              </div>
            </div>`;
        })
        .join("")
    : `<div class="solo-empty-state">No one is here yet. Use “Bring someone in” to add a character.</div>`;

  const rollEntries = (Array.isArray(scene.attemptHistory) ? scene.attemptHistory : [])
    .filter((entry) => entry && entry.checkResult)
    .slice(-3)
    .reverse();
  const recentRolls = rollEntries.length
    ? rollEntries
        .map((entry) => {
          const cr = entry.checkResult || {};
          const intent = String(entry.intent || "Check");
          const label = intent.length > 26 ? `${intent.slice(0, 26)}…` : intent;
          const total = cr.total ?? "—";
          const dc = cr.dc ?? "—";
          const cls = cr.success ? "good" : "accent";
          return `<div class="solo-roll"><div><div class="solo-roll-name">${escapeHtml(label)}</div><div class="solo-roll-detail">vs DC ${escapeHtml(dc)}</div></div><span class="solo-roll-total ${cls}" data-textfit>${escapeHtml(total)}</span></div>`;
        })
        .join("")
    : `<div class="solo-empty-state">No rolls yet.</div>`;

  return `
    <aside class="solo-game-rail solo-scene-side">
      ${(() => {
        const clock = renderSoloClock(scene);
        return clock ? `<div class="solo-rail-block solo-rail-clock">${clock}</div>` : "";
      })()}
      <div class="solo-rail-block solo-rail-presence">
        ${renderSoloPresenceMap(scene)}
      </div>
      <div class="solo-rail-block">
        <div class="solo-stat-kicker">Recent Rolls</div>
        ${recentRolls}
      </div>
      <div class="solo-rail-block">
        <div class="solo-stat-kicker">Cast</div>
        <div class="solo-cast-list">${cast}</div>
      </div>
      <div class="solo-rail-block">
        ${renderMovementPanel(scene)}
      </div>
      <div class="solo-rail-block">
        ${renderSearchResultPanel(state.searchResult, scene.discoveredDetails)}
      </div>
      <div class="solo-rail-block">
        ${renderTalkResultPanel(state.talkResult)}
      </div>
      <div class="solo-rail-block">
        ${renderEntityDetailPanel(state.detail)}
      </div>
    </aside>
  `;
}

// ---------------------------------------------------------------------------
// Visual-novel dialogue overlay
// ---------------------------------------------------------------------------
// Rendered only while `state.dialogueActive` is true (opened by a talk action),
// so the existing right-rail talk panel and all string-render tests are
// untouched. The portrait pulls from talkResult.expressionVariants[expression]
// when the server has generated it (Part 1), otherwise an atmospheric
// placeholder stands in until the image worker finishes. The typewriter reveal
// itself runs in bindSoloSceneShell against live DOM, not in this string.
export function renderSoloDialogueOverlay(state = {}) {
  if (!state.dialogueActive || !state.talkResult) {
    return "";
  }
  const talk = state.talkResult;
  const scene = state.scene || {};
  const expression = typeof talk.expression === "string" && talk.expression ? talk.expression : "neutral";
  const variants = talk.expressionVariants && typeof talk.expressionVariants === "object" ? talk.expressionVariants : {};
  // Fallback chain: requested expression variant -> the NPC's base portrait
  // (from the cast roster) -> atmospheric placeholder. Never a broken image.
  const castMember = (Array.isArray(scene.cast) ? scene.cast : []).find(
    (member) => member && member.npcId === talk.npcId
  ) || null;
  const baseUri = castMember && typeof castMember.portraitUri === "string" ? castMember.portraitUri : "";
  const variantUri = typeof variants[expression] === "string" && variants[expression] ? variants[expression] : "";
  const portraitUri = variantUri || baseUri;
  const speaker = talk.speakerName || "NPC";
  const line = talk.line || "There is not much new to say right now.";
  const typed = state.dialogueTyped === true;
  const initial = String(speaker).trim().slice(0, 1).toUpperCase() || "?";
  // The reply TEXT INPUT is intentionally never disabled — the player must always
  // be able to type. The global busy flag is held by the outer action that opens
  // this overlay (the freeform "speak to X" attempt), so gating the input on it
  // made the box paint dead on arrival. Only the submit BUTTON reflects busy (for
  // feedback); double-submit is prevented by runAction's re-entry guard, and busy
  // always clears in runAction's finally (even on a hung call, via the client
  // request timeout) so submit can never wedge permanently.
  const busy = Boolean(state.busy);
  const replyDraft = typeof state.dialogueReplyDraft === "string" ? state.dialogueReplyDraft : "";

  const portraitInner = portraitUri
    ? `<img class="solo-vn-portrait-img" src="${escapeHtml(portraitUri)}" alt="${escapeHtml(speaker)} portrait" />`
    : `<div class="solo-vn-portrait-placeholder">
        <span>${escapeHtml(initial)}</span>
        <small>Portrait incoming…</small>
      </div>`;

  // The conversation scrollback now lives in the persistent narration log (each
  // beat is a logged turn with speaker attribution), so the in-stage textbox shows
  // only the CURRENT line — no duplicate history panel inside the VN box.

  // #49: the VN presentation lives IN the pinned stage — NOT a floating modal that
  // dims the narration. The NPC renders as a sprite anchored to one side of the
  // stage; the line + reply sit in a classic VN textbox banded across the stage
  // bottom, over the location art. The narration log stays fully visible behind
  // it (no backdrop). `data-portrait-key` forces a fresh <img> (replays the fade)
  // when the expression changes; the data-solo-dialogue-* hooks are unchanged so
  // the typewriter / reply / end bindings in bindSoloSceneShell keep working.
  return `
    <div class="solo-vn-sprite" data-expression="${escapeHtml(expression)}" data-portrait-key="${escapeHtml(portraitUri || expression)}" aria-hidden="true">
      ${portraitInner}
    </div>
    <div class="solo-vn-box" data-solo-dialogue-panel role="group" aria-label="Dialogue with ${escapeHtml(speaker)}">
      <div class="solo-vn-box-head">
        <span class="solo-vn-box-speaker" data-textfit>${escapeHtml(speaker)}</span>
        <button type="button" class="solo-vn-box-end" data-solo-dialogue-end aria-label="End conversation" title="End conversation">End ✕</button>
      </div>
      <div
        class="solo-vn-box-text ${typed ? "is-complete" : ""}"
        data-solo-dialogue-text
        data-typed="${typed ? "true" : "false"}"
        data-fulltext="${escapeHtml(line)}"
      >${typed ? escapeHtml(line) : ""}</div>
      <div class="solo-vn-box-reply">
        <input
          type="text"
          class="solo-vn-box-reply-input"
          data-solo-dialogue-reply-input
          placeholder="Say something — or describe what you do…"
          value="${escapeHtml(replyDraft)}"
        />
        <button type="button" class="solo-vn-box-reply-submit" data-solo-dialogue-reply-submit ${busy ? "disabled" : ""}>${busy ? "…" : "Reply ›"}</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// In-scene NPC creator modal
// ---------------------------------------------------------------------------
// Lightweight 3-field modal (portrait / who / how-they-enter), rendered only
// while state.npcCreator.open is true. Field values + the selected File live in
// state so they survive the shell's full-innerHTML re-renders.
export function renderNpcCreatorModal(state = {}) {
  const creator = state.npcCreator || {};
  if (!creator.open) {
    return "";
  }
  const mode = creator.mode === "imagine" ? "imagine" : "upload";
  const loading = creator.loading === true;
  const previewUrl = typeof creator.previewUrl === "string" ? creator.previewUrl : "";
  const error = typeof creator.error === "string" ? creator.error : "";
  const thumbInner = previewUrl
    ? `<img src="${escapeHtml(previewUrl)}" alt="Portrait preview" />`
    : `<span>${mode === "imagine" ? "GM" : "?"}</span>`;

  return `
    <div class="solo-npc-modal-overlay" data-solo-npc-overlay role="dialog" aria-modal="true" aria-label="Bring in a character">
      <div class="solo-npc-modal-backdrop" data-solo-npc-close></div>
      <div class="solo-npc-modal" data-solo-npc-modal>
        <div class="solo-npc-modal-head">
          <h3>Bring someone in</h3>
          <button type="button" class="solo-npc-modal-x" data-solo-npc-close aria-label="Close">×</button>
        </div>

        <div class="solo-npc-field">
          <label class="solo-npc-label">Portrait</label>
          <div class="solo-npc-portrait-row">
            <div class="solo-npc-thumb">${thumbInner}</div>
            <div class="solo-npc-portrait-controls">
              <label class="solo-npc-upload ${mode === "imagine" ? "is-disabled" : ""}">
                <input type="file" accept="image/png,image/jpeg,image/webp" data-solo-npc-file ${mode === "imagine" ? "disabled" : ""} />
                <span>Upload a portrait</span>
              </label>
              <label class="solo-npc-checkbox">
                <input type="checkbox" data-solo-npc-imagine ${mode === "imagine" ? "checked" : ""} />
                <span>Let the GM imagine them</span>
              </label>
              <small class="solo-npc-hint">JPG, PNG, or WEBP · up to 10MB</small>
            </div>
          </div>
        </div>

        <div class="solo-npc-field">
          <label class="solo-npc-label">Who they are</label>
          <input type="text" class="solo-npc-input" data-solo-npc-name placeholder="Name (optional — the GM can name them)" value="${escapeHtml(creator.name || "")}" />
          <input type="text" class="solo-npc-input" data-solo-npc-desc placeholder="a scarred mercenary with a secret" value="${escapeHtml(creator.description || "")}" />
        </div>

        <div class="solo-npc-field">
          <label class="solo-npc-label">How they enter</label>
          <textarea class="solo-npc-textarea" data-solo-npc-intro rows="2" placeholder="My old mentor walks in, looking for me...">${escapeHtml(creator.introInstructions || "")}</textarea>
        </div>

        ${error ? `<div class="solo-npc-error" role="alert">${escapeHtml(error)}</div>` : ""}
        ${loading ? `<div class="solo-npc-loading">The GM is preparing to introduce them…</div>` : ""}

        <div class="solo-npc-actions">
          <button type="button" class="ghost" data-solo-npc-close ${loading ? "disabled" : ""}>Cancel</button>
          <button type="button" class="solo-npc-submit" data-solo-npc-submit ${loading ? "disabled" : ""}>Bring them in</button>
        </div>
      </div>
    </div>
  `;
}

// Formats a run duration (ms) as a compact "Xh Ym" / "Xm Ys" / "Xs" string.
export function formatRunDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}

export function renderSoloSceneShell(state = {}) {
  if (state.loading) {
    return `
      <section class="solo-scene-shell solo-scene-shell-loading">
        <div class="solo-scene-loading">Loading solo scene...</div>
      </section>
    `;
  }

  if (state.error) {
    return `
      <section class="solo-scene-shell solo-scene-shell-error">
        <div class="solo-scene-error">
          <h2>Solo Scene Unavailable</h2>
          <p>${escapeHtml(state.error)}</p>
          <div class="solo-scene-error-actions">
            <button class="ghost" data-solo-action="reload-scene">Retry</button>
            <button class="ghost" data-solo-home>Return to your adventures</button>
          </div>
        </div>
      </section>
    `;
  }

  // Victory screen: the main quest was completed (run concluded as a win).
  // Mirrors the death-screen layout with a gold scheme and triumphant copy.
  if (state.victoryScreen) {
    const summary = state.runSummary || {};
    const name = summary.playerName || state.character?.name || "Your adventurer";
    const where = summary.location || state.scene?.location?.name || "the world";
    const played = formatRunDuration(summary.timePlayedMs);
    const questTitle = state.scene?.quests?.mainQuest?.title || "your quest";
    const narration = typeof state.victoryNarration === "string" ? state.victoryNarration : "";
    const narrationTyped = state.victoryTyped === true;
    return `
      <section class="solo-scene-shell solo-victory-screen" data-solo-victory>
        <div class="solo-victory-card">
          <div class="solo-victory-kicker">Victory</div>
          <h2 class="solo-victory-title">${escapeHtml(name)} prevails.</h2>
          ${
            narration
              ? `<p
                   class="solo-victory-narration ${narrationTyped ? "is-complete" : ""}"
                   data-solo-victory-text
                   data-typed="${narrationTyped ? "true" : "false"}"
                   data-fulltext="${escapeHtml(narration)}"
                 >${narrationTyped ? escapeHtml(narration) : ""}</p>`
              : ""
          }
          <p class="solo-victory-sub">You completed <strong>${escapeHtml(questTitle)}</strong>. This chapter is won.</p>
          <dl class="solo-victory-summary">
            <div><dt>Adventurer</dt><dd>${escapeHtml(name)}</dd></div>
            <div><dt>Quest</dt><dd>${escapeHtml(questTitle)}</dd></div>
            <div><dt>Last seen</dt><dd>${escapeHtml(where)}</dd></div>
            <div><dt>Time played</dt><dd>${escapeHtml(played)}</dd></div>
            <div><dt>Outcome</dt><dd>${escapeHtml(summary.outcome || "victory")}</dd></div>
          </dl>
          <button class="solo-victory-home" data-solo-home>Return to your adventures</button>
        </div>
      </section>
    `;
  }

  // Death screen: the run has been concluded as a death; replace the shell with
  // a summary before the player returns to the solo home.
  if (state.deathScreen) {
    const summary = state.runSummary || {};
    const name = summary.playerName || state.character?.name || "Your adventurer";
    const where = summary.location || state.scene?.location?.name || "the wilds";
    const played = formatRunDuration(summary.timePlayedMs);
    return `
      <section class="solo-scene-shell solo-death-screen" data-solo-death>
        <div class="solo-death-card">
          <div class="solo-death-kicker">You Died</div>
          <h2 class="solo-death-title">${escapeHtml(name)} has fallen.</h2>
          <p class="solo-death-sub">Cut down in ${escapeHtml(where)}. This story ends here.</p>
          <dl class="solo-death-summary">
            <div><dt>Adventurer</dt><dd>${escapeHtml(name)}</dd></div>
            <div><dt>Last seen</dt><dd>${escapeHtml(where)}</dd></div>
            <div><dt>Time played</dt><dd>${escapeHtml(played)}</dd></div>
            <div><dt>Outcome</dt><dd>${escapeHtml(summary.outcome || "died")}</dd></div>
          </dl>
          <button class="solo-death-home" data-solo-home>Return to your adventures</button>
        </div>
      </section>
    `;
  }

  const scene = state.scene || {};
  const location = scene.location || {};
  const selectedGmMode = state.gmMode || "placeholder";
  // GM provider/fallback status panel is debug-only (hidden from beta players).
  const debug = state.debug === true;
  const character = state.character || SOLO_SAMPLE_CHARACTER;
  const skin = normalizeSkin(state.skin);
  const fontSet = normalizeFontSet(state.fontSet);
  const logScale = normalizeLogScale(state.logScale);

  return `
    <section
      class="solo-scene-shell solo-scene-shell-polished solo-game-shell${state.busy ? " is-busy" : ""}"
      data-run-id="${escapeHtml(scene.runId || state.runId || "")}"
      data-solo-busy="${state.busy ? "true" : ""}"
      data-solo-skin="${skin}"
      data-solo-font="${fontSet}"
      style="${soloThemeVarString(skin, fontSet)};--solo-log-scale:${logScale};"
    >
      <div class="solo-settings ${state.menuOpen ? "open" : ""}">
        <button type="button" class="solo-settings-btn" data-solo-menu-toggle aria-haspopup="true" aria-expanded="${state.menuOpen ? "true" : "false"}" aria-label="Menu" title="Menu">⚙</button>
        ${state.menuOpen ? `
          <div class="solo-settings-menu solo-cog-menu" role="menu">
            ${state.isGuest ? `<button type="button" class="solo-cog-item" data-solo-guest-save role="menuitem">Save your adventure</button>` : ""}
            <button type="button" class="solo-cog-item" data-solo-exit role="menuitem">Leave Adventure</button>
          </div>
        ` : ""}
      </div>
      ${
        state.isGuest
          ? `<div class="solo-guest-banner">
              <span>Playing as guest — your progress lives in this browser until you save it.</span>
              <button type="button" class="solo-guest-banner-save" data-solo-guest-save>Save your adventure</button>
            </div>`
          : ""
      }
      <div class="solo-game-layout">
      <div class="solo-game-frame solo-scene-grid">
        ${renderSoloCharacterSidebar(character)}
        <main class="solo-game-main solo-scene-main">
          <!-- Fable: all non-functional chrome above the scene (breadcrumb, title,
               objective, and the entire tab bar + its placeholder panels) removed.
               The scene renders full-bleed to the top of the viewport. -->
          <div class="solo-game-content">
            ${
              state.banner
                ? `<div class="solo-banner${state.bannerKind === "info" ? " solo-banner-info" : ""}" role="${state.bannerKind === "info" ? "status" : "alert"}">
                    <span class="solo-banner-msg">${escapeHtml(state.banner)}</span>
                    <button type="button" class="solo-banner-dismiss" data-solo-banner-dismiss aria-label="Dismiss">×</button>
                  </div>`
                : ""
            }
            <!-- SCENE — the only view. Three-zone layout (#25/#34): pinned stage
                 (art + outcome + #49 VN layer), scrollable narration log, input
                 dock. No tab wrapper — the non-SCENE tabs and their panels are gone. -->
            <div class="solo-scene-layout" style="grid-template-columns: minmax(0, 1fr);">
              <div class="solo-scene-center solo-scene-zones">
                <!-- ZONE 1 — PINNED STAGE -->
                <div class="solo-stage${state.dialogueActive && state.talkResult ? " vn-active" : ""}" data-solo-stage>
                  ${renderSoloUpgradePrompt(scene)}
                  ${renderSoloSceneArt(scene.locationImageUri, { locked: scene.locationImageLocked })}
                  <div data-solo-outcome>${renderSoloActionOutcome(state)}</div>
                  ${renderSoloDialogueOverlay(state)}
                </div>
                <!-- ZONE 2 — SCROLLABLE NARRATION LOG -->
                <div class="solo-narration-log" data-solo-log>
                  ${
                    (typeof scene.openingNarration === "string" && scene.openingNarration.trim()) || (Array.isArray(scene.openingBeats) && scene.openingBeats.length)
                      ? renderSoloSceneOpening(scene.openingNarration, scene.openingBeats)
                      : Array.isArray(state.narrationLog) && state.narrationLog.length
                        ? renderNarrationLog(state.narrationLog)
                        : renderLocationPanel(location, scene.gmNarration, scene.gmStatus, selectedGmMode, debug, {})
                  }
                </div>
                <!-- ZONE 3 — INPUT DOCK -->
                <div class="solo-input-dock">
                  <!-- CONDITIONS HUD (#26 made visible): committed buffs/debuffs as
                       chips adjacent to the input — in view while choosing the next
                       action. Stable wrapper so the fast-path patches it in place. -->
                  <div data-solo-conditions>${renderSoloConditionsHud(scene)}</div>
                  <div data-solo-dock-status>${renderSoloThinkingIndicator(state)}</div>
                  ${renderSoloSceneInputBar(state)}
                </div>
              </div>
            </div>
          </div>
        </main>
        ${renderSoloRightRail(state)}
      </div>
      </div>
      <!-- #49: the VN dialogue layer moved INTO the pinned stage (above); it is no
           longer a full-screen modal appended here. -->
      ${renderNpcCreatorModal(state)}
    </section>
  `;
}

// #15-full event delegation. One click / keydown dispatcher, walked from the
// event target via closest(). PURE and exported so it's unit-testable without a
// DOM, and — crucially — bound ONCE on the stable root (which is never replaced,
// only its innerHTML), so every action handler survives an in-place turn patch
// of the stage OR the rail with no rebind. Order matters: the most-specific
// action (a Talk/Inspect button inside an inspectable card) is matched BEFORE the
// card, reproducing the old per-button stopPropagation.
export function dispatchSoloClick(target, handlers = {}) {
  const closest = (sel) => (target && typeof target.closest === "function" ? target.closest(sel) : null);
  let el;
  if ((el = closest("[data-solo-action='move']"))) {
    handlers.onMove?.({ locationId: el.getAttribute("data-location-id"), direction: el.getAttribute("data-direction") || null });
    return true;
  }
  if ((el = closest("[data-solo-action='inspect']"))) { handlers.onInspect?.({ entityId: el.getAttribute("data-entity-id") }); return true; }
  if ((el = closest("[data-solo-action='talk']"))) {
    handlers.onTalk?.({ entityId: el.getAttribute("data-entity-id"), targetEntityId: el.getAttribute("data-entity-id") });
    return true;
  }
  if ((el = closest("[data-solo-action='use_item']"))) { handlers.onUseItem?.({ itemId: el.getAttribute("data-item-id") }); return true; }
  if ((el = closest("[data-solo-gm-mode]"))) { handlers.onGmMode?.({ mode: el.getAttribute("data-solo-gm-mode") }); return true; }
  if ((el = closest("[data-solo-npc-bringback]"))) { handlers.onBringBack?.({ entityId: el.getAttribute("data-entity-id") }); return true; }
  // Inspectable card AFTER the action buttons it may contain.
  if ((el = closest(".solo-entity-card.inspectable"))) { handlers.onInspect?.({ entityId: el.getAttribute("data-entity-id") }); return true; }
  // NOTE: the ROOT <section> also carries data-solo-skin / data-solo-font as
  // theme-state markers, so these MUST be scoped to the actual picker BUTTONS —
  // a bare [data-solo-skin] closest() walks up to the section and swallows every
  // later handler (the exit-button regression, db4149c). Match buttons only.
  if ((el = closest("button[data-solo-skin]"))) { handlers.onSkin?.({ skin: el.getAttribute("data-solo-skin") }); return true; }
  if ((el = closest("button[data-solo-font]"))) { handlers.onFont?.({ fontSet: el.getAttribute("data-solo-font") }); return true; }
  if ((el = closest("[data-solo-logfont]"))) { handlers.onLogFontScale?.({ dir: el.getAttribute("data-solo-logfont") }); return true; }
  if ((el = closest("[data-solo-dialogue-end]"))) { handlers.onDialogueEnd?.(); return true; }
  if ((el = closest("[data-solo-dialogue-reply-submit]"))) { handlers.onDialogueReply?.(); return true; }
  if ((el = closest("[data-solo-dialogue-close]"))) { handlers.onDialogueClose?.(); return true; }
  if ((el = closest("[data-scene-redo]"))) { handlers.onSceneRedo?.(); return true; }
  if ((el = closest("[data-scene-save]"))) { handlers.onSceneSave?.(); return true; }
  if ((el = closest("[data-solo-npc-close]"))) { handlers.onNpcClose?.(); return true; }
  if ((el = closest("[data-solo-npc-submit]"))) { handlers.onNpcSubmit?.(); return true; }
  if ((el = closest("[data-solo-action='reload-scene']"))) { handlers.onReload?.(); return true; }
  if ((el = closest("[data-solo-banner-dismiss]"))) { handlers.onDismissBanner?.(); return true; }
  if ((el = closest("[data-solo-home]"))) { handlers.onReturnHome?.(); return true; }
  if ((el = closest("[data-solo-exit]"))) { handlers.onExit?.(); return true; }
  if ((el = closest("[data-solo-guest-save]"))) { handlers.onGuestSave?.(); return true; }
  if ((el = closest("[data-solo-menu-toggle]"))) { handlers.onMenuToggle?.(); return true; }
  return false;
}

// Delegated keydown: Enter/Space activates an inspectable entity card (a11y).
export function dispatchSoloKeydown(event, handlers = {}) {
  const key = event?.key;
  if (key !== "Enter" && key !== " ") {
    return false;
  }
  const target = event?.target;
  const card = target && typeof target.closest === "function" ? target.closest(".solo-entity-card.inspectable") : null;
  if (card) {
    event.preventDefault?.();
    handlers.onInspect?.({ entityId: card.getAttribute("data-entity-id") });
    return true;
  }
  return false;
}

export function bindSoloSceneShell(root, handlers = {}) {
  // Always publish the latest handlers so the once-bound delegated listener
  // dispatches through the current closure set.
  root.__soloHandlers = handlers;
  // Bind the delegated click/keydown listeners exactly ONCE per root. The root
  // element itself is never torn down (fullRender only replaces its innerHTML),
  // so a single delegated listener survives every render AND every in-place
  // patch — this is what lets a turn repaint the stage/rail without rebinding.
  if (!root.__soloDelegated && typeof root.addEventListener === "function") {
    root.__soloDelegated = true;
    root.addEventListener("click", (event) => dispatchSoloClick(event?.target, root.__soloHandlers || {}));
    root.addEventListener("keydown", (event) => dispatchSoloKeydown(event, root.__soloHandlers || {}));
    // CONDITIONS HUD tooltip edge-clamp: on hover/focus of a chip, flip the
    // tooltip to right-anchored when its default left-anchored box would clip
    // the viewport's right edge. Delegated once; chips are re-rendered freely.
    const clampConditionTip = (event) => {
      const chip = event?.target && typeof event.target.closest === "function" ? event.target.closest(".solo-cond-chip") : null;
      if (!chip || typeof chip.getBoundingClientRect !== "function" || typeof window === "undefined") {
        return;
      }
      const rect = chip.getBoundingClientRect();
      const TIP_WIDTH = 320; // matches .solo-cond-tip max-width
      chip.classList.toggle("tip-right", rect.left + TIP_WIDTH > window.innerWidth - 8);
    };
    root.addEventListener("mouseover", clampConditionTip);
    root.addEventListener("focusin", clampConditionTip);
  }

  // ---- Visual-novel typewriter (shared: dialogue box + victory card) ----
  // THROTTLE-IMMUNE by design: the reveal position derives from a WALL-CLOCK
  // delta sampled on an animation-frame loop — never from raw setInterval tick
  // counts. A backgrounded tab throttles/freezes timers and rAF, which used to
  // strand the reveal mid-sentence (reading as TRUNCATED text); with the clock
  // delta, the elapsed time keeps counting while hidden and the owed characters
  // appear the moment the tab is visible again. Any click/tap on the textbox
  // completes the reveal instantly (standard VN convention).
  const VN_CHAR_MS = 30;
  function bindTypewriter(el, { onDone } = {}) {
    const fullText = el.getAttribute("data-fulltext") || "";
    const alreadyTyped = el.getAttribute("data-typed") === "true";
    let done = alreadyTyped;
    let raf = null;
    let fallbackTimer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (raf !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
      if (fallbackTimer && typeof clearInterval === "function") clearInterval(fallbackTimer);
      raf = null;
      fallbackTimer = null;
      el.textContent = fullText;
      el.classList?.add("is-complete");
      onDone?.();
    };
    if (!alreadyTyped && fullText) {
      el.textContent = "";
      const t0 = Date.now();
      const step = () => {
        if (done) return;
        const chars = Math.min(fullText.length, Math.floor((Date.now() - t0) / VN_CHAR_MS) + 1);
        el.textContent = fullText.slice(0, chars);
        if (chars >= fullText.length) {
          finish();
          return;
        }
        if (typeof requestAnimationFrame === "function") raf = requestAnimationFrame(step);
      };
      if (typeof requestAnimationFrame === "function") {
        raf = requestAnimationFrame(step);
      } else if (typeof setInterval === "function") {
        // No rAF (test mocks / odd embeds): same wall-clock math on an interval.
        fallbackTimer = setInterval(step, VN_CHAR_MS);
      } else {
        finish();
      }
      // Tap-to-complete directly on the textbox — works even if the surrounding
      // panel's delegated click is intercepted by other chrome.
      if (typeof el.addEventListener === "function") {
        el.addEventListener("click", finish);
      }
    }
    return { finish, isDone: () => done };
  }

  // Only querySelectorAll is used (test mocks expose no querySelector); unknown
  // selectors return [] in the browser and in the lightweight mount test mocks.
  const dialogueTextEl = root.querySelectorAll("[data-solo-dialogue-text]")[0] || null;
  if (dialogueTextEl && typeof dialogueTextEl.getAttribute === "function") {
    const tw = bindTypewriter(dialogueTextEl, { onDone: () => handlers.onDialogueTyped?.() });
    // Click anywhere on the panel also completes the reveal — except the reply
    // controls (input / submit / end), which have their own behavior.
    root.querySelectorAll("[data-solo-dialogue-panel]").forEach((panel) => {
      panel.addEventListener("click", (event) => {
        const target = event?.target;
        if (
          target &&
          typeof target.closest === "function" &&
          target.closest("[data-solo-dialogue-reply-input], [data-solo-dialogue-reply-submit], [data-solo-dialogue-end]")
        ) {
          return;
        }
        if (!tw.isDone()) {
          tw.finish();
        }
      });
    });
  }
  // Dialogue close / end / reply-submit CLICKS are handled by the delegated
  // dispatcher (dispatchSoloClick). Only the element-lifecycle bits stay here:
  // the reply <input> (draft + Enter-to-send), which needs the live element.
  const dialogueReplyInput = root.querySelectorAll("[data-solo-dialogue-reply-input]")[0] || null;
  const submitDialogueReply = () => handlers.onDialogueReply?.();
  if (dialogueReplyInput && typeof dialogueReplyInput.addEventListener === "function") {
    dialogueReplyInput.addEventListener("input", () => {
      handlers.onDialogueReplyDraft?.({ value: dialogueReplyInput.value });
    });
    dialogueReplyInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitDialogueReply();
      }
    });
  }

  // ---- Victory-screen narration typewriter (same shared treatment) ----
  const victoryTextEl = root.querySelectorAll("[data-solo-victory-text]")[0] || null;
  if (victoryTextEl && typeof victoryTextEl.getAttribute === "function") {
    const tw = bindTypewriter(victoryTextEl, { onDone: () => handlers.onVictoryTyped?.() });
    // Click the card (except the home button) completes the reveal.
    root.querySelectorAll("[data-solo-victory]").forEach((card) => {
      card.addEventListener("click", (event) => {
        const target = event?.target;
        if (target && typeof target.closest === "function" && target.closest("[data-solo-home]")) {
          return;
        }
        if (!tw.isDone()) {
          tw.finish();
        }
      });
    });
  }

  // ---- In-scene NPC creator modal + cast roster ----
  // #22: the "+ Bring someone in" entry point (data-solo-npc-create) was removed
  // from the solo build; its binding is gone too (it matched nothing — inert).
  // Scene redo/save + NPC modal close/submit CLICKS are delegated
  // (dispatchSoloClick). The NPC modal's <input>/<select>/<file> fields below
  // stay element-lifecycle — they read live element values on change/input.
  const npcFileInput = root.querySelectorAll("[data-solo-npc-file]")[0] || null;
  if (npcFileInput && typeof npcFileInput.addEventListener === "function") {
    npcFileInput.addEventListener("change", (event) => {
      handlers.onNpcFile?.({ file: event?.target?.files?.[0] || null });
    });
  }
  const npcImagineInput = root.querySelectorAll("[data-solo-npc-imagine]")[0] || null;
  if (npcImagineInput && typeof npcImagineInput.addEventListener === "function") {
    npcImagineInput.addEventListener("change", (event) => {
      handlers.onNpcMode?.({ imagine: Boolean(event?.target?.checked) });
    });
  }
  for (const [selector, field] of [
    ["[data-solo-npc-name]", "name"],
    ["[data-solo-npc-desc]", "description"],
    ["[data-solo-npc-intro]", "introInstructions"]
  ]) {
    const el = root.querySelectorAll(selector)[0] || null;
    if (el && typeof el.addEventListener === "function") {
      el.addEventListener("input", () => handlers.onNpcField?.({ field, value: el.value }));
    }
  }
  // NPC "bring back" click is delegated (dispatchSoloClick).

  const attemptInput = root.querySelectorAll("[data-solo-attempt-input]")[0] || null;
  const submitAttempt = () => {
    // #37/#38: classify at submit so the mode travels with the turn. Speech keeps
    // its quotes; /ooc is stripped to its note. Empty (e.g. a bare "/ooc") no-ops.
    const cls = classifyInput(attemptInput?.value || "");
    if (!cls.intent) {
      return;
    }
    handlers.onAttempt?.({ intent: cls.intent, mode: cls.mode });
  };
  // #37/#38/#39: keep the mode chip + char counter in sync as the player types,
  // patching just those two nodes in place (no re-render — the whole point of the
  // stage-DOM-stability work, and it keeps caret/focus intact while typing).
  const syncInputMeta = () => {
    const val = attemptInput ? attemptInput.value || "" : "";
    const c = classifyInput(val);
    const m = SOLO_INPUT_MODE_META[c.mode] || SOLO_INPUT_MODE_META.action;
    const modeEl = typeof root.querySelector === "function" ? root.querySelector("[data-solo-input-mode]") : null;
    if (modeEl) {
      modeEl.textContent = m.label;
      modeEl.className = `solo-input-mode solo-input-mode--${c.mode}`;
      modeEl.setAttribute("title", m.hint);
    }
    const countEl = typeof root.querySelector === "function" ? root.querySelector("[data-solo-charcount]") : null;
    if (countEl) {
      const n = val.length;
      countEl.textContent = `${n}/${SOLO_INPUT_MAXLEN}`;
      if (typeof countEl.classList?.toggle === "function") {
        countEl.classList.toggle("is-over", n > SOLO_INPUT_MAXLEN);
      }
    }
  };
  root.querySelectorAll("[data-solo-attempt-submit]").forEach((button) => {
    button.addEventListener("click", submitAttempt);
  });
  // A suggested action is a CHOICE, not a text template: clicking a suggestion
  // executes that action immediately (same path as typing it + Attempt), in one
  // click. No pre-fill, no second click. The free-text input + Attempt button is
  // unchanged for custom actions.
  root.querySelectorAll("[data-solo-suggestion]").forEach((button) => {
    button.addEventListener("click", () => {
      const intent = String(button.getAttribute("data-solo-suggestion") || "").trim();
      if (!intent) {
        return;
      }
      handlers.onAttempt?.({ intent });
    });
  });
  if (attemptInput && typeof attemptInput.addEventListener === "function") {
    attemptInput.addEventListener("input", () => {
      handlers.onAttemptDraft?.({ value: attemptInput.value });
      syncInputMeta();
    });
    attemptInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitAttempt();
      }
    });
  }
}

export const SOLO_SKIN_STORAGE_KEY = "notdnd.solo.skin";
export const SOLO_FONT_STORAGE_KEY = "notdnd.solo.fontSet";
export const SOLO_LOG_SCALE_STORAGE_KEY = "notdnd.solo.logScale";

export function readSoloThemePref(key, fallback) {
  try {
    if (typeof localStorage === "undefined") {
      return fallback;
    }
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

// #48 SELF-HEAL: read the persisted narration text-size, normalize it (clamped
// 0.8-1.6, 0.1 steps), and WRITE THE HEALED VALUE BACK when the stored raw is
// stale/invalid ("9", "NaN", garbage) — so one bad write can never wedge the
// sizer across reloads. Returns the sane multiplier.
// Turn-scroll policy (owner fix 2026-07-10). Given the live-turn anchor state,
// decide what the post-render scroll does:
//   "anchor-newest" — the completion entry exists: land on ITS top (the player
//                     action header + fresh narration, read from the start)
//   "pin-bottom"    — the submit render: keep the newest content in view ONCE
//   "restore"       — passive/interim renders: preserve the player's position
export function resolveTurnScrollMode({ pending = false, freshEntry = false, submitScrolled = false } = {}) {
  if (!pending) {
    return "restore";
  }
  if (freshEntry) {
    return "anchor-newest";
  }
  return submitScrolled ? "restore" : "pin-bottom";
}

export function readHealedLogScale(storage) {
  const store = storage !== undefined ? storage : (typeof localStorage !== "undefined" ? localStorage : null);
  let raw = null;
  try {
    raw = store ? store.getItem(SOLO_LOG_SCALE_STORAGE_KEY) : null;
  } catch {
    raw = null;
  }
  const value = normalizeLogScale(raw == null ? 1 : raw);
  if (raw != null && String(value) !== String(raw).trim()) {
    try {
      store?.setItem(SOLO_LOG_SCALE_STORAGE_KEY, String(value));
    } catch {
      // best-effort heal; the in-memory value is already sane
    }
  }
  return value;
}

// Shrink-to-fit for BOUNDED single-line UI text ([data-textfit]: VN speaker
// name, cast-rail names, status-window values, roll chips, location label).
// widthOnly (no fixed height required); prose NEVER gets fit-scaling — it has
// the .solo-measure column rule instead. Best-effort: silently skips in
// non-browser environments (unit tests use mock roots) and on detached nodes.
function applySoloTextFit(root) {
  if (typeof document === "undefined" || !root || typeof root.querySelectorAll !== "function") {
    return;
  }
  let nodes;
  try {
    nodes = root.querySelectorAll("[data-textfit]");
  } catch {
    return;
  }
  for (const el of nodes) {
    try {
      if (!el || !el.offsetWidth || !String(el.textContent || "").trim()) continue;
      textFit(el, { widthOnly: true, reProcess: true, minFontSize: 8, maxFontSize: 22 });
    } catch {
      // fitting is cosmetic — never let it break a render
    }
  }
}

// Player-hidden debug surfaces (e.g. the GM provider/fallback status panel) are
// shown only when localStorage notdnd_debug === "true". Off for beta players —
// the "Fallback"/"Placeholder" tags read as "broken" to a real player.
function isDebugEnabled() {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("notdnd_debug") === "true";
  } catch {
    return false;
  }
}

export function writeSoloThemePref(key, value) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, value);
    }
  } catch {
    // Persisting the theme is best-effort; ignore storage failures.
  }
}

function freshNpcCreatorState() {
  return {
    open: false,
    mode: "upload",
    file: null,
    previewUrl: "",
    name: "",
    description: "",
    introInstructions: "",
    loading: false,
    error: ""
  };
}

export function mountSoloSceneShell(root, { apiClient, runId }) {
  const state = {
    runId,
    loading: true,
    error: "",
    scene: null,
    character: null,
    detail: null,
    searchResult: null,
    talkResult: null,
    restResult: null,
    useItemResult: null,
    attemptResult: null,
    // #20-full: per-line speaker attribution from the LAST action response
    // ([{ text, speakerId, speakerName, kind }], server-grounded). Consumed by
    // logNarration into the log entry, then cleared with the other per-turn
    // results. Empty for ambient / no-dialogue turns.
    dialogueLines: [],
    // #25 APPEND-ONLY NARRATION LOG. Every turn's prose accumulates here as
    // readable history the player can scroll back through, instead of being
    // discarded when state.scene is replaced each turn. Entries:
    // { id, intent, checkResult, text, speaker }. Client-owned; survives the
    // per-turn scene refresh (the scene payload only carries the CURRENT turn).
    narrationLog: [],
    attemptDraft: "",
    busy: null,
    banner: "",
    // "info" => amber/gold one-time wait notice; anything else => the default
    // (reddish, alert-styled) error banner.
    bannerKind: "",
    // GM provider/fallback status panel: shown only with localStorage
    // notdnd_debug === "true" (hidden from beta players by default).
    debug: isDebugEnabled(),
    gmThinking: false,
    // Run conclusion (death / abandon / victory). runConcluded guards against
    // double-close; death/victory screens swap the shell for a summary; runSummary
    // holds it. pendingVictory is set from an action response's runWon flag and
    // flushed into the victory screen once the action settles.
    runConcluded: false,
    deathScreen: false,
    victoryScreen: false,
    pendingVictory: false,
    // GM-written closing narration for a won run (typewritered on the victory
    // screen before the summary). victoryTyped marks the reveal complete.
    victoryNarration: null,
    victoryTyped: false,
    runSummary: null,
    menuOpen: false,
    dialogueActive: false,
    dialogueTyped: false,
    dialogueHistory: [],
    dialogueReplyDraft: "",
    dialogueTargetEntityId: null,
    gmMode: "placeholder",
    npcCreator: freshNpcCreatorState(),
    npcCreatorConfirmation: "",
    // Guards re-entry while a Redo/Save location-image request is in flight.
    sceneArtBusy: null,
    skin: normalizeSkin(readSoloThemePref(SOLO_SKIN_STORAGE_KEY, "ashen")),
    fontSet: normalizeFontSet(readSoloThemePref(SOLO_FONT_STORAGE_KEY, "tome")),
    // #48: persisted narration text-size multiplier (see normalizeLogScale).
    // #48: self-healing read — a stale/invalid persisted multiplier is clamped
    // AND written back, so a bad value can never wedge the sizer across reloads.
    logScale: readHealedLogScale(),
    // Guest play: when the player has no real account, the shell offers a
    // persistent "save your adventure" affordance. Registering upgrades the
    // guest identity in place server-side, so the run is never lost.
    isGuest: false
  };

  // External/timer-triggered renders are deferred while a text field is focused
  // (see externalRender + the focusout flush below). Any render — user or
  // external — clears it, so a deferred flush never double-renders.
  let pendingExternalRender = false;

  // While an action is in flight (submit -> "GM is thinking" -> result), renders
  // should ANCHOR the view on the live turn (the latest outcome + the thinking
  // banner + the input), not just preserve the prior scroll. Set across the whole
  // runAction lifecycle and cleared after its final render; passive poll renders
  // (anchor off) still preserve scroll position.
  let anchorLiveTurnPending = false;
  // Turn-scroll phase state: the log length at submit (a LONGER log later means
  // the completion entry landed) and whether the one-shot submit bottom-pin ran.
  let anchorLogCountAtSubmit = 0;
  let anchorSubmitScrolled = false;

  // #15: the stage baseline recorded by the last FULL render — the fast-path
  // compares against it to decide whether the turn can be patched in place
  // (stage + existing log entries preserved) or needs a full rebuild.
  let stageBaseline = null;

  // A signature of every scene-tab-VISIBLE region the fast-path does NOT patch
  // (sidebar, right rail, upgrade prompt, dialogue overlay, NPC modal, scene art,
  // banners, structural flags). If this is byte-identical to the last full
  // render, the only things that could have changed are the log / outcome strip /
  // thinking indicator / input — exactly what the fast-path repaints — so
  // patching is provably safe. Hidden tab panels are intentionally excluded: they
  // aren't visible on the scene tab and are rebuilt on tab switch (a full render).
  function stageSignature() {
    const scene = state.scene || {};
    const character = state.character || SOLO_SAMPLE_CHARACTER;
    try {
      return JSON.stringify({
        skin: normalizeSkin(state.skin),
        font: normalizeFontSet(state.fontSet),
        menu: Boolean(state.menuOpen),
        guest: Boolean(state.isGuest),
        banner: state.banner || "",
        bannerKind: state.bannerKind || "",
        death: Boolean(state.deathScreen),
        victory: Boolean(state.victoryScreen),
        concluded: Boolean(state.runConcluded),
        loading: Boolean(state.loading),
        error: state.error || "",
        reloading: Boolean(state.sceneReloading),
        dlg: Boolean(state.dialogueActive),
        npc: Boolean(state.npcCreator && state.npcCreator.open),
        art: [scene.locationImageUri || null, Boolean(scene.locationImageLocked)],
        sidebar: renderSoloCharacterSidebar(character),
        // #15-full: the rail (rolls / clock / cast / exits) is NO LONGER a
        // full-render trigger — the turn fast-path repaints it in place (its
        // handlers are delegated on root), so a within-location turn never
        // rebuilds the stage DOM. A cross-location move still forces a full
        // render via the `art` key above (the scene image changes).
        upgrade: renderSoloUpgradePrompt(scene),
        overlay: renderSoloDialogueOverlay(state),
        modal: renderNpcCreatorModal(state)
      });
    } catch {
      return null;
    }
  }

  function recordStageBaseline() {
    const scene = state.scene || {};
    const hasOpening =
      (typeof scene.openingNarration === "string" && scene.openingNarration.trim()) ||
      (Array.isArray(scene.openingBeats) && scene.openingBeats.length);
    stageBaseline = {
      sig: stageSignature(),
      logCount: Array.isArray(state.narrationLog) ? state.narrationLog.length : 0,
      // The log container shows the append-only narration log only when there's no
      // opening set-piece to play AND we have accumulated entries.
      showedNarrationLog: !hasOpening && Array.isArray(state.narrationLog) && state.narrationLog.length > 0
    };
  }

  // #15: the turn fast-path. When only the log / outcome / thinking / input have
  // changed since the last full render (everything else byte-identical), repaint
  // just those in place — the scene art, the existing log entries, and the live
  // <input> node are NEVER torn down. Returns false (→ full render) whenever any
  // guard fails, so it can only ever be a safe optimization, never a regression.
  function tryStagePatch() {
    if (!stageBaseline || !stageBaseline.showedNarrationLog) {
      return false;
    }
    if (typeof root.querySelector !== "function") {
      return false;
    }
    if (state.loading || state.error || state.deathScreen || state.victoryScreen || state.runConcluded) {
      return false;
    }
    const logEl = root.querySelector("[data-solo-log]");
    const outcomeEl = root.querySelector("[data-solo-outcome]");
    const thinkingEl = root.querySelector("[data-solo-dock-status]");
    const inputField = root.querySelector("[data-solo-attempt-input]");
    const submitBtn = root.querySelector("[data-solo-attempt-submit]");
    if (!logEl || !outcomeEl || !thinkingEl || !inputField || !submitBtn) {
      return false;
    }
    const sig = stageSignature();
    if (sig == null || sig !== stageBaseline.sig) {
      return false;
    }
    const entries = Array.isArray(state.narrationLog) ? state.narrationLog : [];
    if (entries.length < stageBaseline.logCount) {
      return false; // the log reset/shrank — let a full render re-seed it
    }

    // --- provably safe to patch in place from here ---
    const scrollSnapshot = captureSoloScroll();
    if (entries.length > stageBaseline.logCount) {
      const fresh = entries.slice(stageBaseline.logCount);
      if (typeof logEl.insertAdjacentHTML === "function") {
        // Append ONLY the new entries — existing entry DOM is never rebuilt.
        logEl.insertAdjacentHTML("beforeend", renderNarrationLog(fresh));
      } else {
        logEl.innerHTML = renderNarrationLog(entries);
      }
      stageBaseline.logCount = entries.length;
    }
    outcomeEl.innerHTML = renderSoloActionOutcome(state);
    thinkingEl.innerHTML = renderSoloThinkingIndicator(state);

    // CONDITIONS HUD: chips appear on commit and vanish on shed via BOTH render
    // paths (one policy — the scroll-fix precedent). Tolerates absence in the
    // lightweight test mocks.
    const conditionsEl = root.querySelector("[data-solo-conditions]");
    if (conditionsEl && "innerHTML" in conditionsEl) {
      conditionsEl.innerHTML = renderSoloConditionsHud(state.scene || {});
    }

    // #15-full: repaint the right rail in place (rolls / clock / cast / exits).
    // Because it's no longer in stageSignature, patch it unconditionally on every
    // fast-path turn. Its action handlers are delegated on the stable root, so
    // replacing the rail node needs NO rebind. Guarded so the lightweight test
    // mocks (no querySelector / outerHTML) simply skip it.
    const railEl = typeof root.querySelector === "function" ? root.querySelector(".solo-game-rail") : null;
    if (railEl && typeof railEl === "object" && "outerHTML" in railEl) {
      railEl.outerHTML = renderSoloRightRail(state);
    }

    const busy = Boolean(state.busy);
    if (busy) {
      inputField.setAttribute("disabled", "");
      submitBtn.setAttribute("disabled", "");
    } else {
      inputField.removeAttribute("disabled");
      submitBtn.removeAttribute("disabled");
    }
    if (typeof submitBtn.textContent === "string" || submitBtn.textContent === undefined) {
      submitBtn.textContent = busy ? "Thinking…" : "Attempt";
    }
    // Only push the draft into the field when the player isn't typing in it, so a
    // background render (e.g. a settled turn clearing the draft) never clobbers a
    // live caret. Resync the mode chip + counter to the value we set.
    const active = typeof document !== "undefined" ? document.activeElement : null;
    if (active !== inputField) {
      const val = String(state.attemptDraft || "");
      inputField.value = val;
      const c = classifyInput(val);
      const m = SOLO_INPUT_MODE_META[c.mode] || SOLO_INPUT_MODE_META.action;
      const modeEl = root.querySelector("[data-solo-input-mode]");
      if (modeEl) {
        modeEl.textContent = m.label;
        modeEl.className = `solo-input-mode solo-input-mode--${c.mode}`;
      }
      const countEl = root.querySelector("[data-solo-charcount]");
      if (countEl) {
        countEl.textContent = `${val.length}/${SOLO_INPUT_MAXLEN}`;
      }
    }

    applyPostRenderScroll(scrollSnapshot);
    // The in-place rail repaint recreates cast names / roll chips — re-fit them.
    applySoloTextFit(root);
    return true;
  }

  // Dispatcher: try the in-place turn patch first (stage DOM survives); fall back
  // to the full rebuild for structural changes, tab switches, and first mount.
  function render() {
    if (tryStagePatch()) {
      pendingExternalRender = false;
      return;
    }
    fullRender();
  }

  function fullRender() {
    pendingExternalRender = false;
    // Keep the live text input alive across the innerHTML rebuild. The deferral
    // guard (externalRender) only covers TIMER renders; direct render() calls —
    // runAction's start/finally, loadScene, click handlers — would otherwise
    // destroy the focused <input> out from under the player and drop focus/caret.
    // Real symptom: send a VN reply / action, click back to type the next one, and
    // ~1s later the GM call's finally{render()} recreates the box → it "freezes".
    // Capture which field was focused + its caret, restore both after the rebuild.
    const focusSnapshot = captureSoloFocus();
    const scrollSnapshot = captureSoloScroll();
    root.innerHTML = renderSoloSceneShell(state);
    bindSoloSceneShell(root, {
      onReload: loadScene,
      onExit: handleExit,
      onReturnHome: handleReturnHome,
      onGuestSave: handleGuestSave,
      onDismissBanner: handleDismissBanner,
      onMenuToggle: handleMenuToggle,
      onMove: handleMove,
      onInspect: handleInspect,
      onTalk: handleTalk,
      onUseItem: handleUseItem,
      onGmMode: handleGmMode,
      onSkin: handleSkin,
      onFont: handleFont,
      onLogFontScale: handleLogFontScale,
      onAttempt: handleAttempt,
      onAttemptDraft: handleAttemptDraft,
      onDialogueClose: handleDialogueClose,
      onDialogueTyped: handleDialogueTyped,
      onDialogueReply: handleDialogueReply,
      onDialogueReplyDraft: handleDialogueReplyDraft,
      onDialogueEnd: handleDialogueEnd,
      onVictoryTyped: handleVictoryTyped,
      onOpenNpcCreator: handleOpenNpcCreator,
      onSceneRedo: handleSceneRedo,
      onSceneSave: handleSceneSave,
      onNpcClose: handleNpcClose,
      onNpcMode: handleNpcMode,
      onNpcFile: handleNpcFile,
      onNpcField: handleNpcField,
      onNpcSubmit: handleNpcSubmit,
      onBringBack: handleBringBack
    });
    restoreSoloFocus(focusSnapshot);
    // Action render -> phase-aware turn scroll (submit pins bottom once, interim
    // renders preserve position, completion anchors the new entry's top);
    // passive render -> preserve where they were.
    applyPostRenderScroll(scrollSnapshot);
    // #15: snapshot the stage so the NEXT render can decide whether it's a
    // patchable turn (only the log/outcome/input changed) or a full rebuild.
    recordStageBaseline();
    // Shrink-to-fit the bounded UI text (VN speaker, cast names, status values,
    // roll chips, location label). Never applied to prose.
    applySoloTextFit(root);
  }

  // Preserve/restore the scroll position of the in-scene scrolling container
  // across a render(). The innerHTML rebuild recreates the scroll container
  // (.solo-game-content, overflow-y: auto) and resets its scrollTop to 0, so
  // after every resolved action the view snaps to the top — forcing the player
  // to scroll back down to the result + input each turn. We capture scrollTop
  // before the rebuild and restore it after binding, alongside the focus/caret
  // guard. Covers every render path (runAction, loadScene, click handlers).
  // #34: the narration log is the single internal scroller now (styles.css), so
  // scroll capture/restore MUST target it — targeting the old .solo-game-content
  // (which no longer scrolls on the scene tab) is why passive renders reset the
  // player's scroll position. Fall back to .solo-game-content for the other tabs.
  // Prefer the narration log (the scene tab's internal scroller); on the other
  // tabs the log is absent, so fall back to .solo-game-content. Two ordered
  // lookups — a comma selector would return the ancestor .solo-game-content by
  // document order, defeating the whole point.
  function getSoloScroller() {
    if (typeof root.querySelector !== "function") {
      return null;
    }
    return root.querySelector(".solo-narration-log") || root.querySelector(".solo-game-content");
  }
  function captureSoloScroll() {
    const el = getSoloScroller();
    if (!el || typeof el.scrollTop !== "number") {
      return null;
    }
    return { top: el.scrollTop };
  }
  function restoreSoloScroll(snapshot) {
    if (!snapshot) {
      return;
    }
    const el = getSoloScroller();
    if (!el) {
      return;
    }
    try {
      el.scrollTop = snapshot.top;
    } catch {
      // Non-fatal — restoring scroll is best-effort.
    }
  }

  // TURN-SCROLL PHASES (owner fix 2026-07-10: "GM thinking resets scroll to the
  // top"). anchorLiveTurnPending is set at SUBMIT, but the new log entry only
  // exists at COMPLETION — anchoring `.solo-log-entry:last-child` during the
  // thinking phase targeted the PREVIOUS entry's top, which on a young run is
  // the top of the whole text. Phase-aware behavior instead:
  //   submit render      -> pin the log to the BOTTOM once (the newest content /
  //                         the player's just-sent action context stays in view)
  //   interim thinking   -> preserve the player's scroll (they may be re-reading)
  //   completion render  -> anchor the NEW entry's top (the player-action header
  //                         + fresh narration read from the beginning)
  // Pure decision fn, exported for tests.
  const resolveTurnScrollModeLocal = (pending, freshEntry, submitScrolled) =>
    resolveTurnScrollMode({ pending, freshEntry, submitScrolled });

  function scrollLogToBottom() {
    const container = getSoloScroller();
    if (!container) {
      return;
    }
    try {
      if (typeof container.scrollHeight === "number") {
        container.scrollTop = container.scrollHeight;
      }
    } catch {
      // best-effort
    }
  }

  // One post-render scroll policy for BOTH render paths (full + patch).
  function applyPostRenderScroll(scrollSnapshot) {
    const freshEntry = Array.isArray(state.narrationLog) && state.narrationLog.length > anchorLogCountAtSubmit;
    const mode = resolveTurnScrollModeLocal(anchorLiveTurnPending, freshEntry, anchorSubmitScrolled);
    if (mode === "anchor-newest") {
      scrollLiveTurnIntoView();
    } else if (mode === "pin-bottom") {
      anchorSubmitScrolled = true;
      scrollLogToBottom();
    } else {
      restoreSoloScroll(scrollSnapshot);
    }
  }

  // Scroll the in-scene container so the LIVE TURN is visible after an action: the
  // freshest anchor wins — the "GM is thinking…" banner while the call is pending,
  // else the latest action outcome, else the input bar (always at the foot of the
  // scene). The player lands on "your action went through, the GM is working,"
  // never yanked to the top, and the thinking banner stays in view while pending.
  // Reflow-safe: the scene art <img> usually loads AFTER this render and grows the
  // container, so we re-anchor once it loads (one-shot) to avoid being stranded.
  // #34 step 4: on a new turn, land the view on the NEWEST narration entry (the
  // last .solo-log-entry), NOT the sticky input dock. Anchoring the input dock is
  // what made the view appear to jump to the top / hide the fresh text behind the
  // dock. Prefer the last log entry; fall back to the thinking indicator while a
  // turn is in flight, then the input as a last resort.
  const SOLO_LIVE_TURN_ANCHORS = [".solo-log-entry:last-child", ".solo-thinking", ".solo-scene-input"];
  function scrollLiveTurnIntoView() {
    if (typeof root.querySelector !== "function") {
      return;
    }
    const container = getSoloScroller();
    if (!container) {
      return;
    }
    const pickAnchor = () => {
      for (const sel of SOLO_LIVE_TURN_ANCHORS) {
        const el = root.querySelector(sel);
        if (el) {
          return el;
        }
      }
      return null;
    };
    const apply = () => {
      const anchor = pickAnchor();
      try {
        if (anchor && typeof anchor.scrollIntoView === "function") {
          // #34 step 4: land the newest narration entry at the TOP of the log so
          // the player reads the fresh turn from its beginning (block:"start").
          // This only fires on a live turn (anchorLiveTurnPending); passive poll
          // renders restore the player's scroll position instead, so scrolling
          // back through history is never yanked.
          anchor.scrollIntoView({ block: "start" });
        } else if (typeof container.scrollHeight === "number") {
          container.scrollTop = container.scrollHeight;
        }
      } catch {
        // Best-effort — never let an auto-scroll throw into the render path.
      }
    };
    apply();
    // Re-anchor after the scene image reflows the container (load OR error).
    const img = typeof container.querySelector === "function" ? container.querySelector(".solo-scene-art img") : null;
    if (img && img.complete !== true && typeof img.addEventListener === "function") {
      img.addEventListener("load", apply, { once: true });
      img.addEventListener("error", apply, { once: true });
    }
  }

  // Capture/restore the focused text field across a render(). Identified by a
  // STABLE data-* attribute (the action box and the VN reply box each have a
  // unique one) so the post-rebuild element is the same field. Returns null when
  // nothing relevant is focused — so a render triggered by clicking elsewhere
  // never yanks focus back. The value itself is already restored from state
  // (attemptDraft / dialogueReplyDraft); we only recover focus + caret.
  const SOLO_FOCUS_ATTRS = ["data-solo-attempt-input", "data-solo-dialogue-reply-input"];
  function captureSoloFocus() {
    if (typeof document === "undefined") {
      return null;
    }
    const el = document.activeElement;
    if (!el || (typeof root.contains === "function" && !root.contains(el))) {
      return null;
    }
    const attr = typeof el.hasAttribute === "function" ? SOLO_FOCUS_ATTRS.find((a) => el.hasAttribute(a)) : null;
    if (!attr) {
      return null;
    }
    let start = null;
    let end = null;
    try {
      start = el.selectionStart;
      end = el.selectionEnd;
    } catch {
      // Some input types disallow selection access — focus alone is enough.
    }
    return { attr, start, end };
  }
  function restoreSoloFocus(snapshot) {
    if (!snapshot || typeof root.querySelector !== "function") {
      return;
    }
    const el = root.querySelector(`[${snapshot.attr}]`);
    if (!el || typeof el.focus !== "function" || el.disabled) {
      return;
    }
    el.focus();
    if (snapshot.start !== null && typeof el.setSelectionRange === "function") {
      try {
        el.setSelectionRange(snapshot.start, snapshot.end);
      } catch {
        // Non-fatal — focus is restored even if caret placement isn't supported.
      }
    }
  }

  // True while the user is actively typing in a text input/textarea inside the
  // shell — used to suppress external/timer renders that would clear focus/caret
  // mid-keystroke. Mirrors main.js's isEditingTextField guard. Defensive about
  // headless test roots (no document / no root.contains).
  function isSoloEditingTextField() {
    if (typeof document === "undefined") {
      return false;
    }
    const el = document.activeElement;
    if (!el || el === document.body || (typeof root.contains === "function" && !root.contains(el))) {
      return false;
    }
    if (el.tagName === "TEXTAREA") {
      return true;
    }
    if (el.tagName === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      return ["text", "search", "email", "password", "number", "url", "tel", ""].includes(type);
    }
    return false;
  }

  // Render driven by an external/timer event (NOT a user click / tab switch). If
  // a text field is focused, skip the innerHTML rebuild and remember to re-run it
  // once focus leaves — a mid-keystroke rebuild would drop focus/caret. User
  // actions call render() directly and are never deferred.
  function externalRender() {
    if (isSoloEditingTextField()) {
      pendingExternalRender = true;
      return;
    }
    render();
  }

  // One-time: when focus leaves a text field, flush any render that was deferred
  // while the user was typing. Listens on `root` (which persists across innerHTML
  // rebuilds); focusout bubbles up to it. The 0ms defer lets activeElement settle
  // so hopping between two text fields doesn't trigger a premature flush.
  if (typeof root.addEventListener === "function") {
    root.addEventListener("focusout", () => {
      if (!pendingExternalRender) {
        return;
      }
      const flush = () => {
        if (pendingExternalRender && !isSoloEditingTextField()) {
          render();
        }
      };
      if (typeof setTimeout === "function") {
        setTimeout(flush, 0);
      } else {
        flush();
      }
    });
  }

  function revokePreview() {
    const url = state.npcCreator?.previewUrl;
    if (url && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // best-effort cleanup
      }
    }
  }

  function handleOpenNpcCreator() {
    state.npcCreatorConfirmation = "";
    revokePreview();
    state.npcCreator = { ...freshNpcCreatorState(), open: true };
    render();
  }

  function handleNpcClose() {
    revokePreview();
    state.npcCreator = freshNpcCreatorState();
    render();
  }

  function handleNpcMode({ imagine }) {
    const creator = state.npcCreator;
    creator.mode = imagine ? "imagine" : "upload";
    if (imagine) {
      revokePreview();
      creator.file = null;
      creator.previewUrl = "";
    }
    render();
  }

  function handleNpcFile({ file }) {
    const creator = state.npcCreator;
    revokePreview();
    creator.file = file || null;
    creator.mode = "upload";
    creator.previewUrl =
      file && typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
        ? URL.createObjectURL(file)
        : "";
    render();
  }

  function handleNpcField({ field, value }) {
    // No re-render: keep the live DOM (and caret) intact while typing; state is
    // synced so a later render repopulates from these values.
    const creator = state.npcCreator;
    if (field === "name") {
      creator.name = String(value || "");
    } else if (field === "description") {
      creator.description = String(value || "");
    } else if (field === "introInstructions") {
      creator.introInstructions = String(value || "");
    }
  }

  async function handleNpcSubmit() {
    const creator = state.npcCreator;
    if (!creator || creator.loading) {
      return;
    }
    creator.loading = true;
    creator.error = "";
    render();
    try {
      // Portrait uploaded -> "user"; otherwise AI-portrait "hybrid".
      const origin = creator.file ? "user" : "hybrid";
      const created = await apiClient.createNpc(runId, {
        name: creator.name,
        description: creator.description,
        introInstructions: creator.introInstructions,
        origin
      });
      const npc = created?.npc || null;
      if (creator.file && npc?.npcId) {
        await apiClient.uploadNpcPortrait(runId, npc.npcId, creator.file);
      }
      const name = npc?.generatedName || npc?.displayName || "A new figure";
      revokePreview();
      state.npcCreator = freshNpcCreatorState();
      await loadScene();
      state.npcCreatorConfirmation = `${name} is entering the story…`;
      render();
    } catch (error) {
      creator.loading = false;
      creator.error = String(error?.message || error || "Could not bring them in.");
      render();
    }
  }

  function handleBringBack(entity) {
    // For an NPC already at the current location, "bring back" focuses them via
    // the talk flow (re-engaging any intro/dialogue).
    return handleTalk(entity);
  }

  function handleMenuToggle() {
    state.menuOpen = !state.menuOpen;
    render();
  }

  function handleDismissBanner() {
    state.banner = "";
    state.bannerKind = "";
    render();
  }

  // One-time-per-session amber notice on first scene entry, explaining that
  // images stream in so the early placeholders read as intentional, not broken.
  // sessionStorage-gated (shows once per tab session); skipped entirely where
  // sessionStorage is unavailable (tests / SSR), so it never alters test output.
  const IMAGE_WAIT_BANNER_KEY = "notdnd_image_wait_banner_seen";
  function maybeShowImageWaitBanner() {
    const ss = typeof window !== "undefined" ? window.sessionStorage : null;
    if (!ss) {
      return;
    }
    let seen = false;
    try {
      seen = ss.getItem(IMAGE_WAIT_BANNER_KEY) === "true";
    } catch {
      return;
    }
    if (seen) {
      return;
    }
    state.banner =
      "Your world is being illustrated. Portraits and scenes appear as they're ready — usually within 30 seconds.";
    state.bannerKind = "info";
    try {
      ss.setItem(IMAGE_WAIT_BANNER_KEY, "true");
    } catch {
      // best-effort; the banner still shows this load if the write fails.
    }
  }

  // ---- Async feedback wrapper ----------------------------------------------
  // Wraps every network action so it can never fail silently or wait
  // invisibly: it sets a busy flag (disables the input + dims action buttons,
  // guarding against double-submit), arms a 2s "GM is thinking…" lag indicator,
  // surfaces any thrown error as a dismissible in-panel banner, and always
  // clears the busy/lag state when the action settles.
  let lagTimer = null;

  function clearLag() {
    if (lagTimer) {
      clearTimeout(lagTimer);
      lagTimer = null;
    }
    state.gmThinking = false;
  }

  async function runAction(label, fn) {
    if (state.busy) {
      return; // an action is already in flight — ignore re-entry
    }
    state.busy = label;
    state.banner = "";
    clearLag();
    // Anchor this action's lifecycle on the live turn, phase-aware (owner fix
    // 2026-07-10): the submit render pins the log BOTTOM once (newest content /
    // the just-sent action stays in view — never yanked to the top), interim
    // thinking renders preserve the player's scroll, and the completion render
    // anchors the NEW entry's top (see resolveTurnScrollMode).
    anchorLiveTurnPending = true;
    anchorLogCountAtSubmit = Array.isArray(state.narrationLog) ? state.narrationLog.length : 0;
    anchorSubmitScrolled = false;
    if (typeof setTimeout === "function") {
      // Timer-triggered: the "GM is thinking" lag indicator must not rebuild the
      // DOM (and drop focus) if the player is mid-keystroke in a text field.
      lagTimer = setTimeout(() => {
        state.gmThinking = true;
        externalRender();
      }, 2000);
      if (lagTimer && typeof lagTimer.unref === "function") {
        lagTimer.unref();
      }
    }
    render();
    try {
      await fn();
    } catch (error) {
      // SELF-HEAL: a slow-but-working GM turn can outrun even the raised client
      // timeout (or a transient network blip can drop the response) AFTER the
      // server already COMMITTED the turn. Without recovery the view froze on the
      // stale pre-action scene and the player appeared "thrown back" to an earlier
      // turn (the #A blocker). Re-sync to the server's true current state so the
      // display can never diverge from committed reality. Best-effort: if the
      // reload also fails, fall back to the raw error and let the next poll retry.
      let resynced = false;
      try {
        await loadScene();
        resynced = true;
      } catch {
        // reconcile failed too — keep the hard error below
      }
      state.banner = resynced
        ? "That turn took a while — caught up to the latest."
        : String(error?.message || error || "Something went wrong. Try again.");
      state.bannerKind = resynced ? "info" : "error";
    } finally {
      state.busy = null;
      clearLag();
      // If this action won the run (main quest completed), swap to the victory
      // screen before the final render.
      await maybeConcludeVictory();
      render();
      // The result render has anchored on the live turn; subsequent passive poll
      // renders resume preserving the player's scroll position.
      anchorLiveTurnPending = false;
    }
  }





  // Concludes the run server-side exactly once and caches its summary.
  // Best-effort: a failed close must never block the death screen or navigation.
  async function concludeRun(outcome) {
    if (state.runConcluded) {
      return state.runSummary;
    }
    state.runConcluded = true;
    const response = await completeSoloRun(apiClient, runId, outcome);
    state.runSummary = response?.summary || null;
    return state.runSummary;
  }

  // Posts a solo action and flags a pending victory when the server reports the
  // main quest was just completed (response.runWon). The flag is flushed by
  // maybeConcludeVictory once the action settles.
  async function postAction(action) {
    const response = await postSoloAction(apiClient, runId, action);
    if (response && response.runWon) {
      state.pendingVictory = true;
      state.victoryNarration = typeof response.victoryNarration === "string" ? response.victoryNarration : null;
    }
    return response;
  }

  // Concludes the run as a win when it was just won — either via the action
  // response (pendingVictory) or a main quest already flipped to "completed" in
  // the scene (covers reload / re-entry into a won run). Idempotent and mutually
  // exclusive with the death screen. The server already concluded the run as
  // "victory"; concludeRun just fetches the summary (idempotent server-side).
  async function maybeConcludeVictory() {
    if (state.runConcluded || state.deathScreen || state.victoryScreen) {
      return false;
    }
    const wonByQuest = state.scene?.quests?.mainQuest?.status === "completed";
    if (!state.pendingVictory && !wonByQuest) {
      return false;
    }
    state.pendingVictory = false;
    await concludeRun("victory");
    state.victoryScreen = true;
    return true;
  }

  // Navigates to the solo home, flagging the exit so bootstrap() does not
  // auto-resume this (now concluded) run — otherwise "/" would redirect straight
  // back into it (re-entry loop).
  function returnHome() {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.sessionStorage?.setItem("notdnd_exited_run", "true");
    } catch {
      // sessionStorage may be unavailable; navigation still proceeds.
    }
    // "/" renders the minimal solo home (Continue card + Start a New Adventure +
    // past runs), not the legacy 7-tab GM shell.
    window.location.href = "/";
  }

  async function handleExit() {
    // Voluntary exit ("Leave Adventure"): confirm, close the run as "abandoned"
    // so it is properly concluded (not left active forever), then navigate home.
    if (typeof window === "undefined") {
      return;
    }
    if (typeof window.confirm === "function" && !window.confirm("Leave this adventure? Your progress is saved and the run will be closed.")) {
      return;
    }
    await concludeRun("abandoned");
    returnHome();
  }

  // Returns home from the death screen (run already concluded as "died").
  function handleReturnHome() {
    returnHome();
  }

  function handleGuestSave() {
    if (typeof window === "undefined") {
      return;
    }
    // ?save=1 tells the home screen to open the register panel ("Save your
    // adventure"). Deliberately NOT marked as an exited run — the adventure
    // continues right after saving.
    window.location.href = "/?save=1";
  }

  function handleDialogueClose() {
    // Close the dialogue overlay without reloading the scene. The talk result
    // remains in state so the right-rail summary stays visible.
    state.dialogueActive = false;
    render();
  }

  function handleDialogueTyped() {
    // Typewriter finished (or was skipped); mark complete so a re-render shows
    // the full line immediately instead of restarting the reveal.
    state.dialogueTyped = true;
  }

  function handleVictoryTyped() {
    // Victory narration typewriter finished/skipped; mark complete so any later
    // re-render shows the full closing line rather than restarting the reveal.
    state.victoryTyped = true;
  }

  function handleSkin({ skin }) {
    state.skin = normalizeSkin(skin);
    writeSoloThemePref(SOLO_SKIN_STORAGE_KEY, state.skin);
    render();
  }

  function handleFont({ fontSet }) {
    state.fontSet = normalizeFontSet(fontSet);
    writeSoloThemePref(SOLO_FONT_STORAGE_KEY, state.fontSet);
    render();
  }

  // #48: step the narration text size. Persist, and set --solo-log-scale directly
  // on the shell section (the closest ancestor that carries the var, so it beats
  // the section's own inline value) for INSTANT resize — no re-render, so the
  // bounded scroll position and the pinned stage are untouched.
  function handleLogFontScale({ dir } = {}) {
    const step = dir === "down" ? -SOLO_LOG_SCALE_STEP : SOLO_LOG_SCALE_STEP;
    state.logScale = normalizeLogScale((state.logScale || 1) + step);
    writeSoloThemePref(SOLO_LOG_SCALE_STORAGE_KEY, String(state.logScale));
    const shell = typeof root.querySelector === "function" ? root.querySelector(".solo-scene-shell") : null;
    const target = shell && shell.style ? shell : root;
    target.style?.setProperty?.("--solo-log-scale", String(state.logScale));
  }

  function handleAttemptDraft({ value }) {
    state.attemptDraft = String(value || "");
  }

  // Bug A (#37/#38): render the GM's out-of-character reply as a distinct log
  // note. NOT a story beat — no YOU header, no roll, no turn cost. A failed/empty
  // reply shows an explicit retry prompt: silence is never an acceptable outcome.
  function appendOocNote({ reply } = {}) {
    const body = String(reply || "").trim() || "The GM couldn't answer that — try again.";
    state.narrationLog.push({ id: `ooc${state.narrationLog.length + 1}`, kind: "ooc", text: body });
    if (state.narrationLog.length > 200) {
      state.narrationLog.splice(0, state.narrationLog.length - 200);
    }
    render();
  }

  function handleAttempt({ intent, mode }) {
    if (!state.scene) {
      return;
    }
    // Bug B (provenance): remember the player's VERBATIM submitted text so the YOU
    // header renders exactly what they typed — never a GM-generated beat title,
    // regardless of how the resolver commits the turn (attempt / move / search…).
    const submittedText = String(intent || "").trim();
    return runAction("attempt", async () => {
      let response;
      try {
        response = await postAction(createAttemptAction({ intent, mode }));
      } catch (error) {
        // OOC must never fail silently (Bug A): a thrown OOC request still gets a
        // visible failure note rather than a generic banner + resync.
        if (mode === "ooc") {
          appendOocNote({ reply: "" });
          state.attemptDraft = "";
          return;
        }
        throw error;
      }
      // Bug A — OOC (#37/#38): the server committed NO state (run echoed unchanged)
      // and answered AS GM. Render that reply as a distinct note and STOP: no turn
      // cost, no clock tick, no scene reload, no story entry, no auditor pass.
      if (response && response.ooc) {
        appendOocNote({ reply: response.oocReply });
        state.attemptDraft = "";
        return;
      }
      state.pendingPlayerAction = submittedText;
      state.attemptResult = response.attemptResult || response.latestAttemptResult || null;
      // #20-full: capture the server's per-line speaker attribution for this turn
      // so logNarration can nameplate each grounded NPC line (cross-wire to #20).
      state.dialogueLines = Array.isArray(response.dialogueLines) ? response.dialogueLines : [];
      state.attemptDraft = "";
      state.searchResult = null;
      state.talkResult = null;
      state.dialogueActive = false;
      state.restResult = null;
      state.useItemResult = null;
      await loadScene();
    });
  }

  // ---- Location-image controls (Redo / Save) ----
  // Redo: ask the server to regenerate the current location image (fresh seed),
  // clear it locally so the "Painting the scene…" placeholder shows, then let
  // the art poll swap the new image in. Save: lock the current image so it is
  // final (Redo/Save controls disappear, never regenerates on revisit).
  function handleSceneRedo() {
    const scene = state.scene;
    if (!scene || !scene.location || scene.locationImageLocked || state.sceneArtBusy) {
      return;
    }
    state.sceneArtBusy = "redo";
    (async () => {
      try {
        await redoLocationImage(apiClient, runId);
        if (state.scene) {
          // Hide the stale image so the placeholder shows and the poll re-arms.
          state.scene = { ...state.scene, locationImageUri: null, locationImageLocked: false };
        }
      } catch (error) {
        state.banner = String(error?.message || error || "Could not redo the scene image.");
        state.bannerKind = "error";
      } finally {
        state.sceneArtBusy = null;
        render();
        scheduleCastPoll();
      }
    })();
  }

  function handleSceneSave() {
    const scene = state.scene;
    if (!scene || !scene.location || scene.locationImageLocked || !scene.locationImageUri || state.sceneArtBusy) {
      return;
    }
    state.sceneArtBusy = "save";
    (async () => {
      try {
        await saveLocationImage(apiClient, runId);
        if (state.scene) {
          state.scene = { ...state.scene, locationImageLocked: true };
        }
      } catch (error) {
        state.banner = String(error?.message || error || "Could not save the scene image.");
        state.bannerKind = "error";
      } finally {
        state.sceneArtBusy = null;
        render();
      }
    })();
  }

  let castPollTimer = null;
  let castPollAttempts = 0;

  function castHasMissingPortraits() {
    // Player portrait still pending?
    const player = state.scene?.player;
    if (player && player.character && !player.portraitUri) {
      return true;
    }
    const cast = state.scene?.cast;
    if (!Array.isArray(cast) || cast.length === 0) {
      return false;
    }
    return cast.some(
      (member) => member && (member.portraitUri === null || member.portraitUri === undefined || member.portraitUri === "")
    );
  }

  // Location background image still pending? (generated async like portraits)
  function locationImageMissing() {
    const scene = state.scene;
    return Boolean(scene && scene.location) && !(typeof scene.locationImageUri === "string" && scene.locationImageUri);
  }

  // Anything in the scene still waiting on async art (portraits or background)?
  function sceneArtPending() {
    return castHasMissingPortraits() || locationImageMissing();
  }

  function stopCastPoll() {
    if (castPollTimer) {
      clearTimeout(castPollTimer);
      castPollTimer = null;
    }
  }

  // Portraits generate ~10-15s after a scene loads (async, no WebSocket), so the
  // first render shows placeholders. Poll the scene a few times until every cast
  // member has a portrait, then stop. Only runs while portraits are missing.
  // Swaps newly-generated portraits into the existing DOM in place — no full
  // re-render — so open menus and in-flight interactions survive the poll.
  // Portrait slots carry data-portrait-for="<player|npc:ID>".
  function applyPortraitUpdates(rootEl, scene) {
    if (!rootEl || !scene || typeof rootEl.querySelectorAll !== "function") {
      return;
    }
    const uris = {};
    if (scene.player) {
      uris.player = typeof scene.player.portraitUri === "string" ? scene.player.portraitUri : "";
    }
    for (const npc of Array.isArray(scene.cast) ? scene.cast : []) {
      if (npc && typeof npc.npcId === "string") {
        uris[`npc:${npc.npcId}`] = typeof npc.portraitUri === "string" ? npc.portraitUri : "";
      }
    }
    rootEl.querySelectorAll("[data-portrait-for]").forEach((slot) => {
      const key = slot.getAttribute("data-portrait-for");
      const uri = uris[key];
      if (!uri) {
        return;
      }
      const img = typeof slot.querySelector === "function" ? slot.querySelector("img") : null;
      if (img) {
        if (img.getAttribute("src") !== uri) {
          img.setAttribute("src", uri);
        }
      } else {
        // Placeholder -> real portrait: replace just this small slot's contents.
        const cls = slot.getAttribute("data-portrait-img-class") || "";
        slot.innerHTML = `<img class="${cls}" src="${escapeHtml(uri)}" alt="" />`;
      }
    });
  }

  // Targeted update: swap a newly-generated location background into the scene
  // banner in place (mirrors applyPortraitUpdates — no full re-render).
  function applySceneArtUpdate(rootEl, scene) {
    const uri = typeof scene?.locationImageUri === "string" ? scene.locationImageUri.trim() : "";
    if (!uri || !rootEl || typeof rootEl.querySelector !== "function") {
      return;
    }
    const art = rootEl.querySelector("[data-scene-art]");
    if (!art) {
      return;
    }
    const locked = Boolean(scene?.locationImageLocked);
    const img = typeof art.querySelector === "function" ? art.querySelector("img.solo-scene-art-img") : null;
    const hasControls = Boolean(art.querySelector("[data-scene-redo]"));
    // Already showing this image with the correct control state — nothing to do.
    if (img && img.getAttribute("src") === uri && hasControls === !locked) {
      return;
    }
    // Rebuild the banner contents (image + Redo/Save unless locked) and re-bind
    // the controls, since replacing innerHTML drops their listeners.
    art.innerHTML = sceneArtInnerHtml(uri, { locked });
    const redoBtn = art.querySelector("[data-scene-redo]");
    if (redoBtn) {
      redoBtn.addEventListener("click", () => handleSceneRedo());
    }
    const saveBtn = art.querySelector("[data-scene-save]");
    if (saveBtn) {
      saveBtn.addEventListener("click", () => handleSceneSave());
    }
  }

  function scheduleCastPoll() {
    stopCastPoll();
    castPollAttempts = 0;
    if (!sceneArtPending() || typeof setTimeout !== "function") {
      return;
    }
    const arm = () => {
      castPollTimer = setTimeout(tick, SOLO_ART_POLL_INTERVAL_MS);
      if (castPollTimer && typeof castPollTimer.unref === "function") {
        castPollTimer.unref();
      }
    };
    const tick = async () => {
      castPollTimer = null;
      castPollAttempts += 1;
      // Never tear down the DOM while the cog menu is open — a full re-render
      // would destroy the open menu and eat in-flight clicks.
      if (state.menuOpen) {
        if (sceneArtPending() && castPollAttempts < SOLO_ART_POLL_MAX_ATTEMPTS) {
          arm();
        }
        return;
      }
      try {
        const refreshed = await fetchSoloScene(apiClient, runId);
        state.scene = {
          ...refreshed,
          gmNarration: state.scene?.gmNarration || null,
          gmStatus: state.scene?.gmStatus || null
        };
        if (refreshed?.player) {
          state.character = characterFromScenePlayer(refreshed.player, refreshed.world || state.scene?.world);
        }
        // Targeted update: only swap newly-available portraits + the location
        // background in place rather than rebuilding the whole shell (which
        // flickers and drops clicks).
        applyPortraitUpdates(root, state.scene);
        applySceneArtUpdate(root, state.scene);
      } catch {
        // best-effort; keep trying until the attempt budget is spent
      }
      if (sceneArtPending() && castPollAttempts < SOLO_ART_POLL_MAX_ATTEMPTS) {
        arm();
      }
    };
    arm();
  }

  // #25: fold the just-loaded turn's prose into the append-only narration log so
  // history accumulates instead of being discarded when state.scene is replaced.
  // Called once per completed loadScene. Deduped against the previous entry so an
  // unchanged ambient description does not spam the log; a roll/intent is attached
  // ONLY when this turn was an attempt (guards against a stale prior roll leaking
  // onto a move/search turn), mirroring renderSoloActionOutcome's staleness guard.
  function logNarration() {
    const scene = state.scene || {};
    const gmBody = String(scene.gmNarration?.narration?.body || "").trim();
    const opening =
      typeof scene.openingNarration === "string" && scene.openingNarration.trim()
        ? scene.openingNarration.trim()
        : Array.isArray(scene.openingBeats)
          ? scene.openingBeats.filter(Boolean).join("\n\n")
          : "";
    const isFirst = state.narrationLog.length === 0;
    const text = gmBody || (isFirst ? opening : "") || String(scene.location?.description || "").trim();
    if (!text) {
      return;
    }
    const last = state.narrationLog[state.narrationLog.length - 1];
    if (last && last.text === text) {
      return;
    }
    const timeline = Array.isArray(scene.recentTimeline) ? scene.recentTimeline : [];
    const lastEv = timeline.length ? timeline[timeline.length - 1] : null;
    const ar = lastEv && lastEv.type === "attempt" ? scene.latestAttemptResult || state.attemptResult : null;
    // Bug B (provenance): the YOU header is the player's OWN words. Prefer the
    // verbatim text just submitted this turn, then the raw intent the resolver /
    // server preserved — a GM-generated beat title is NEVER used. Consume the
    // pending submitted text immediately so it can never leak onto a later
    // (e.g. ambient poll) turn. #45/#46: click-driven affordance turns with no
    // typed words fall back to a deterministic action label (inside the helper).
    const submitted = state.pendingPlayerAction;
    state.pendingPlayerAction = null;
    const turnIntent = resolveTurnHeaderIntent({ submitted, attemptResult: ar, lastEvent: lastEv, isFirst });
    state.narrationLog.push({
      id: `n${state.narrationLog.length + 1}`,
      intent: turnIntent,
      checkResult: ar && ar.checkResult ? ar.checkResult : null,
      success: ar ? ar.success : undefined,
      // #33: carry the resolver band/label so the log roll tag is band-coded too.
      band: ar && typeof ar.band === "string" ? ar.band : null,
      outcomeLabel: ar && typeof ar.outcomeLabel === "string" ? ar.outcomeLabel : null,
      text,
      // #20-full: attribute the line to whoever is actually speaking this turn
      // (talkResult / VN speakerId), not just the lone-NPC ambient case.
      speaker: resolveSceneSpeaker(scene, state.talkResult) || null,
      // #20-full: the server's per-line attribution (grounded NPC speakers), so a
      // multi-NPC beat nameplates each line — falls back to `speaker` when empty.
      dialogueLines: Array.isArray(state.dialogueLines) ? state.dialogueLines : []
    });
    // Cap DOM growth on a very long session.
    if (state.narrationLog.length > 200) {
      state.narrationLog.splice(0, state.narrationLog.length - 200);
    }
  }

  async function loadScene() {
    // First load (no scene yet) takes over the shell with the full-screen
    // loader/error. A reload after an action keeps the current scene on screen
    // and shows a brief inline "Loading scene…" strip instead of a blank flash.
    const initial = !state.scene;
    if (initial) {
      state.loading = true;
      state.error = "";
    } else {
      state.sceneReloading = true;
    }
    state.npcCreatorConfirmation = "";
    render();
    try {
      state.scene = await fetchSoloScene(apiClient, runId);
      if (state.scene && state.scene.player) {
        // Surface the player's real character (falls back to the sample only
        // when the payload genuinely lacks a player).
        state.character = characterFromScenePlayer(state.scene.player, state.scene.world);
      }
      if (initial) {
        // First entry this session: explain that images stream in.
        maybeShowImageWaitBanner();
      }
      // Terminal-run detection from the server's STATE CONTRACT (runStatus /
      // isDead / resumable / player.status). A concluded run — most importantly a
      // DEAD run re-opened from saved campaigns — is routed to an outcome screen
      // below; it must NOT mount the live playable shell. "downed" is the
      // transient mid-combat death; "dead" is the terminal, persisted status.
      const sc = state.scene || {};
      const runIsDead =
        sc.isDead === true ||
        sc.runStatus === "dead" ||
        sc.player?.status === "dead" ||
        sc.player?.status === "downed";
      const runIsWon = sc.runStatus === "completed" || sc.quests?.mainQuest?.status === "completed";
      const runIsTerminal = runIsDead || runIsWon || sc.runStatus === "abandoned" || sc.resumable === false;
      // GM ambient narration is only meaningful for a LIVE scene. Skip it for a
      // concluded run: there's nothing to narrate, and on a degraded GM (e.g. the
      // local fallback when cloud credits are exhausted) the call can block up to
      // the request timeout — which is exactly the "stuck on Loading solo scene…"
      // hang reported for re-opened dead runs. The outcome screen needs no GM.
      if (!runIsTerminal) {
        try {
          const gmScene = await fetchSoloGmScene(apiClient, runId, { mode: state.gmMode });
          if (gmScene?.gmNarration) {
            state.scene = {
              ...state.scene,
              gmNarration: gmScene.gmNarration,
              gmStatus: gmScene.gmStatus || null
            };
          }
        } catch {
          // Placeholder GM narration is optional and must not block scene rendering.
        }
      }
      // Route a concluded run straight to its outcome screen instead of the
      // playable shell. concludeRun is idempotent server-side for an
      // already-concluded run (it just re-fetches the summary); for a fresh
      // mid-combat death (transient "downed") it concludes the run as "died".
      if (runIsDead && !state.runConcluded && !state.deathScreen) {
        await concludeRun("died");
        state.deathScreen = true;
      } else if (runIsWon && !state.runConcluded && !state.victoryScreen && !state.deathScreen) {
        await concludeRun("victory");
        state.victoryScreen = true;
      }
      // Main quest completed via a live action (reload / re-entry into a won run):
      // conclude as a victory. No-op when already concluded, dead, or won above.
      await maybeConcludeVictory();
      // Accumulate this turn's prose into the append-only log BEFORE the
      // per-turn result panels are cleared (talkResult speaker is read here).
      logNarration();
      state.detail = null;
      state.searchResult = null;
      state.talkResult = null;
      state.dialogueLines = [];
      state.dialogueActive = false;
      state.restResult = null;
      state.useItemResult = null;
      // VN auto-trigger: the GM/classifier flagged direct dialogue with a named
      // speaker (the freeform "speak to X" path sets scene.vnMode + speakerId
      // server-side). Open the dialogue overlay for that speaker via the talk
      // pipeline. This runs AFTER the resets above so it overrides the default
      // dialogueActive=false when — and only when — vnMode is active. Ambient
      // (vnMode=false) leaves the overlay closed; the manual Talk button is
      // unaffected (it opens via handleTalk + refreshSceneAfterAction, not here).
      if (state.scene && state.scene.vnMode === true && typeof state.scene.speakerId === "string" && state.scene.speakerId.trim()) {
        await openVnDialogueForSpeaker(state.scene.speakerId);
      }
    } catch (error) {
      const message = String(error?.message || error || "Failed to load solo scene.");
      if (initial) {
        // No scene to fall back to — show the full-screen retry surface.
        state.error = message;
      } else {
        // Keep the existing scene visible; surface the failure as a banner.
        state.banner = message;
        state.bannerKind = "error";
      }
    } finally {
      state.loading = false;
      state.sceneReloading = false;
      render();
      scheduleCastPoll();
    }
  }

  function handleMove(move) {
    if (!state.scene) {
      return;
    }
    return runAction("move", async () => {
      await postAction(createMoveAction(state.scene, move));
      await loadScene();
    });
  }

  function handleInspect(entity) {
    return runAction("inspect", async () => {
      state.detail = await postAction(createInspectAction(entity));
    });
  }

  // Several actions share the same epilogue: clear the other result panels and
  // re-fetch the scene, preserving any GM narration already in state.
  async function refreshSceneAfterAction() {
    const refreshed = await fetchSoloScene(apiClient, runId);
    state.scene = {
      ...refreshed,
      gmNarration: state.scene?.gmNarration || null,
      gmStatus: state.scene?.gmStatus || null
    };
  }

  function handleTalk(entity) {
    return runAction("talk", async () => {
      const response = await postAction(createTalkAction(entity));
      state.talkResult = response.talkResult || null;
      // Open the visual-novel dialogue overlay and restart the typewriter.
      state.dialogueActive = Boolean(state.talkResult);
      state.dialogueTyped = false;
      // Start a fresh conversation: remember who we're talking to (so replies
      // re-target them through the same talk pipeline) and seed the history with
      // the NPC's opening line.
      state.dialogueTargetEntityId =
        entity.entityId || entity.targetEntityId || (state.talkResult ? `npc:${state.talkResult.npcId}` : null);
      state.dialogueReplyDraft = "";
      state.dialogueHistory =
        state.talkResult && state.talkResult.line
          ? [{ role: "npc", speaker: state.talkResult.speakerName || "NPC", text: state.talkResult.line }]
          : [];
      state.searchResult = null;
      state.restResult = null;
      state.useItemResult = null;
      await refreshSceneAfterAction();
    });
  }

  // Auto-open the VN dialogue overlay from the server's vnMode signal — the
  // freeform "speak to X" path. The classifier set scene.vnMode=true + speakerId
  // server-side, but no dialogue content rides the scene payload, so we pull the
  // speaker's beat through the SAME talk pipeline the manual Talk button uses and
  // converge on the same overlay + dialogue state. postAction directly (NOT
  // runAction): loadScene may already be running inside an action's runAction,
  // whose busy guard would block a nested runAction. Best-effort — on any failure
  // we leave the scene ambient rather than open an empty overlay.
  async function openVnDialogueForSpeaker(speakerId) {
    const target = String(speakerId || "").trim();
    if (!target) {
      return;
    }
    // scene.speakerId arrives as the RAW npcId (the freeform "speak to X" trigger)
    // or, from the GM-driven classifier, an already-"npc:"-prefixed id. The talk
    // pipeline validates targetEntityId against the visible ENTITY id, which is
    // always prefixed — so normalize to "npc:<rawId>" before resolving the beat.
    // Passing the raw id was the bug: validateTalkAction rejected it, no talkResult
    // came back, and the overlay fell through to GM scene narration under a generic
    // "NPC". With the prefix, resolveTalkAction returns the NPC's own beat + name.
    const rawId = target.includes(":") ? target.split(":").slice(1).join(":") : target;
    const entityId = `npc:${rawId}`;
    let talk = null;
    try {
      const resp = await postAction(createTalkAction({ targetEntityId: entityId }));
      talk = resp && resp.talkResult ? resp.talkResult : null;
    } catch {
      talk = null;
    }
    // The dialogue content must be the NPC's OWN line — never the GM scene
    // narration. resolveTalkAction always returns a line for a valid, present NPC
    // (a real unrevealed beat, or an in-character "nothing new yet" placeholder),
    // so a missing line/talkResult means the NPC isn't talkable here: stay ambient
    // rather than open an overlay echoing scene prose under the wrong speaker.
    const line = talk && typeof talk.line === "string" && talk.line.trim() ? talk.line.trim() : "";
    if (!talk || !line) {
      return;
    }
    // Always show the NPC's actual NAME. resolveTalkAction sets speakerName to the
    // NPC's displayName; fall back to the cast roster (keyed by raw npcId) so a
    // known NPC is never labeled the generic "NPC".
    const castName = (Array.isArray(state.scene?.cast) ? state.scene.cast : [])
      .find((member) => member && member.npcId === rawId)?.displayName || null;
    const speakerName = typeof talk.speakerName === "string" && talk.speakerName.trim()
      ? talk.speakerName
      : castName;
    state.talkResult = speakerName && speakerName !== talk.speakerName ? { ...talk, speakerName } : talk;
    state.dialogueActive = true;
    state.dialogueTyped = false;
    state.dialogueTargetEntityId = entityId;
    state.dialogueReplyDraft = "";
    state.dialogueHistory = [{ role: "npc", speaker: speakerName || "NPC", text: line }];
  }

  function handleDialogueReplyDraft({ value }) {
    state.dialogueReplyDraft = String(value || "");
  }

  function handleDialogueReply() {
    if (!state.dialogueActive || !state.talkResult) {
      return undefined;
    }
    const reply = String(state.dialogueReplyDraft || "").trim();
    const target = state.dialogueTargetEntityId || `npc:${state.talkResult.npcId}`;
    // Snapshot the transcript BEFORE appending the new line, so message + history
    // aren't duplicated: `message` carries the new line, `history` the prior turns.
    const priorHistory = Array.isArray(state.dialogueHistory) ? state.dialogueHistory.slice() : [];
    return runAction("talk", async () => {
      // The player's line goes into the visible history AND is sent to the server
      // (message + history) so the GM voices an in-character reply to what was
      // actually said — not a re-run of the intro beat.
      if (reply) {
        state.dialogueHistory = [...priorHistory, { role: "player", speaker: "You", text: reply }];
      }
      state.dialogueReplyDraft = "";
      const response = await postAction(createTalkAction({ entityId: target, message: reply, history: priorHistory }));
      const next = response.talkResult || null;
      if (next && next.found !== false && next.line) {
        state.talkResult = next;
        state.dialogueTyped = false;
        state.dialogueHistory = [
          ...(state.dialogueHistory || []),
          { role: "npc", speaker: next.speakerName || "NPC", text: next.line }
        ];
      } else {
        // The NPC has nothing more to add — note it but keep the overlay open so
        // the exit stays explicit (the player clicks "End conversation").
        state.dialogueHistory = [
          ...(state.dialogueHistory || []),
          { role: "system", speaker: "", text: "The conversation winds down. Nothing more to say for now." }
        ];
      }
      state.searchResult = null;
      state.restResult = null;
      state.useItemResult = null;
      await refreshSceneAfterAction();
    });
  }

  function handleDialogueEnd() {
    // Explicit exit: leave the VN overlay back to the ambient scene. The server's
    // vnMode returns to ambient on the player's next (non-talk) action; the
    // overlay closes immediately so the player is back in the scene.
    state.dialogueActive = false;
    state.dialogueReplyDraft = "";
    state.dialogueHistory = [];
    state.dialogueTargetEntityId = null;
    render();
  }

  function handleUseItem(item) {
    return runAction("use_item", async () => {
      const response = await postAction(createUseItemAction(item));
      state.useItemResult = response.useItemResult || null;
      state.searchResult = null;
      state.talkResult = null;
      state.dialogueActive = false;
      state.restResult = null;
      await refreshSceneAfterAction();
    });
  }

  function handleGmMode({ mode }) {
    state.gmMode = mode === "provider" ? "provider" : "placeholder";
    return runAction("gm-mode", async () => {
      await loadScene();
    });
  }

  render();
  loadScene();
  // Guest probe (fire-and-forget): learn whether this player is a guest so the
  // shell can offer "save your adventure". Failure means no banner — never a
  // blocked scene.
  Promise.resolve()
    .then(() => apiClient.me())
    .then((me) => {
      if (me?.user?.isGuest === true) {
        state.isGuest = true;
        externalRender();
      }
    })
    .catch(() => {});
  return {
    reload: loadScene
  };
}
