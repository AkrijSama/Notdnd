import { completeSoloRun, fetchSoloGmScene, fetchSoloScene, postSoloAction, redoLocationImage, saveLocationImage } from "./soloSceneApi.js";
import textFit from "../vendor/textFit.js";
import { renderConditionChip, renderConditionChipRow } from "./conditionChips.js";
import { renderBrand } from "./brand.js";
import { HOME_NAV_CONFIRM } from "./homeNav.js";

// ── BETA THUMB (owner-feedback calibration) ──────────────────────────────────
// A small, low-opacity, ALWAYS-VISIBLE (not hover — mobile has no hover) thumbs
// up/down overlaid on every generated-image surface. Gated by scene.betaThumb, which
// the server sets from NOTDND_BETA_THUMB. Off ⇒ every widget renders empty, the whole
// control gone in one move. Reason chips (down only) let the owner say WHY. The
// widget is absolutely positioned inside a position:relative image wrapper so it never
// shifts layout or covers the art. DEATH DATE + rationale: server/art/ownerFeedback.js.
let _betaThumb = false;
const ART_REASON_CHIPS = ["wrong subject", "bad crop", "wrong camera", "wrong style", "just ugly"];
export function renderArtThumb(uri, kind, corner = "br") {
  if (!_betaThumb || !uri || typeof uri !== "string" || !uri.trim()) return "";
  return `<div class="art-thumb art-thumb--${corner}" data-art-thumb data-art-uri="${escapeHtml(uri)}" data-art-kind="${escapeHtml(kind || "")}">`
    + `<button type="button" class="art-thumb-btn art-thumb-up" data-art-vote="up" aria-label="Good image" title="Good image">▲</button>`
    + `<button type="button" class="art-thumb-btn art-thumb-down" data-art-vote="down" aria-label="Bad image" title="Bad image">▼</button>`
    + `<div class="art-thumb-reasons" data-art-reasons hidden>`
    + ART_REASON_CHIPS.map((r) => `<button type="button" class="art-thumb-chip" data-art-reason="${escapeHtml(r)}">${escapeHtml(r)}</button>`).join("")
    + `</div></div>`;
}

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
      ${renderBrand()}
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

// Split the authored opening beats at the committed speaker-from index (from the
// scenario's beatsSpeakerFrom, carried on the payload). Beats before it are scene-
// setting narration; beats from it are the committed speaker's (the VOICE) SPOKEN lines,
// which must render in the real VN box — never as narration-log prose. Index-based, not
// bracket-based: a VOICE beat can be multi-block or have an unclosed bracket.
export function splitOpeningBeats(openingBeats = null, speakerFrom = 0) {
  const beats = Array.isArray(openingBeats) ? openingBeats : [];
  const from = Number.isInteger(speakerFrom) && speakerFrom >= 0 && speakerFrom <= beats.length ? speakerFrom : 0;
  return { narration: beats.slice(0, from), spoken: beats.slice(from) };
}

export function renderSoloSceneOpening(openingNarration = "", openingBeats = null, speaker = null) {
  // PACED set-piece: when the opening is an authored BEAT SEQUENCE (openingBeats),
  // reveal the beats one at a time in a staggered cascade instead of dumping the
  // whole VOICE monologue as one scroll-wall — so it lands. Each beat is its own
  // framed block, fading in after the previous; reduced-motion users get them all
  // at once (no animation). Falls back to the single-string rendering otherwise.
  //
  // W1: the VOICE is a COMMITTED cast member — when the opening carries her speaker
  // (npcId + name + portraitUri), the set-piece renders as HER VN SPEAKER SURFACE (a
  // named avatar frame with her ball-of-light portrait), not anonymous narration.
  const beats = Array.isArray(openingBeats)
    ? openingBeats.map((b) => String(b || "").trim()).filter(Boolean)
    : null;
  if (beats && beats.length) {
    const blocks = beats
      .map((beat, i) => `<div class="solo-opening-beat" style="animation-delay:${(i * 1.1).toFixed(2)}s">${beatToParas(beat)}</div>`)
      .join("");
    const pacedStyle = `
        <style>
          .solo-opening-paced .solo-opening-beat { opacity: 0; animation: soloBeatIn 0.9s ease forwards; }
          .solo-opening-paced .solo-opening-beat + .solo-opening-beat { margin-top: 0.9rem; padding-top: 0.9rem; border-top: 1px solid rgba(255,255,255,0.08); }
          @keyframes soloBeatIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
          @media (prefers-reduced-motion: reduce) { .solo-opening-paced .solo-opening-beat { opacity: 1; animation: none; } }
        </style>`;
    // WALK-3 V4: with a committed speaker, the SPOKEN beats now render in the real VN box
    // (loadScene routes them there), so this renderer receives ONLY the scene-setting
    // narration beats with speaker=null — render them as GM narration, NOT a "VOICE speaks"
    // look-alike frame. (A speaker IS still honored when passed directly, e.g. in unit tests
    // of the frame itself, but the live opening path no longer narrates the VOICE's words.)
    if (!speaker || typeof speaker.npcId !== "string" || !speaker.npcId) {
      return `
      <section class="solo-scene-opening solo-opening-paced solo-measure" role="note" aria-label="Opening narration">
        ${pacedStyle}
        <span class="solo-scene-opening-kicker">The GM sets the scene</span>
        ${blocks}
      </section>
    `;
    }
    const speakerName = typeof speaker.displayName === "string" ? speaker.displayName : "The VOICE";
    const speakerNpcId = speaker.npcId;
    const avatar = typeof speaker.portraitUri === "string" && speaker.portraitUri
      ? `<img class="solo-opening-speaker-avatar" src="${escapeHtml(speaker.portraitUri)}" alt="${escapeHtml(speakerName)}" />`
      : "";
    return `
      <section class="solo-scene-opening solo-opening-paced solo-measure solo-opening-vn" role="note" aria-label="${escapeHtml(speakerName)} speaks" data-solo-speaker="${escapeHtml(speakerNpcId)}">
        ${pacedStyle}
        <div class="solo-opening-speaker">${avatar}<span class="solo-scene-opening-kicker">${escapeHtml(speakerName)} speaks</span></div>
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
      : `Only ${remaining} free image${remaining === 1 ? "" : "s"} left today. Upgrade to Adventurer for unlimited portraits and scenes.`;
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
      // VN TRANSCRIPT ENTRY (vn-dialogue-hardening, table stakes): a spoken VN
      // line preserved VERBATIM in the backlog — speaker plate + the quoted line,
      // compact, so a finished conversation is replayable from the log. Pushed as
      // each line lands (chronological with the turn's non-dialogue remainder).
      if (entry.kind === "vn") {
        const plate = entry.role === "player" ? "You" : String(entry.speaker || "NPC");
        return `<article class="solo-log-entry solo-measure solo-log-vn"><div class="solo-log-speaker">${escapeHtml(plate)}</div><div class="solo-log-prose solo-log-vn-line">“${escapeHtml(String(entry.text || ""))}”</div></article>`;
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
      // R2: the committed cost of this turn, from state (never narration).
      const costLine = consequenceCostLine(entry);
      const costTag = costLine ? `<span class="solo-log-cost">${escapeHtml(costLine)}</span>` : "";
      const header = intent
        ? `<header class="solo-log-action"><span class="solo-log-you">You</span><span class="solo-log-intent" title="${escapeHtml(intent)}">${escapeHtml(intentDisplay)}</span>${rollTag}${costTag}</header>`
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

// ---------------------------------------------------------------------------
// VN QUOTE SPLIT (owner ruling, absolute): the VN overlay shows QUOTED DIALOGUE
// from the ADDRESSED speaker ONLY. Every other character — scene beats, gestures,
// other NPCs' lines, atmosphere — goes to the narration log below. No "minimal
// speaker action" exception. If the addressed speaker has zero quoted speech, the
// VN shows nothing new and the whole response goes to the log.
//
// CONSERVATION: the split partitions the source into ordered segments; every
// character lands in exactly one segment, so segments.join("") === source. No
// character is dropped or duplicated (this is what kills the "Ilse's scarred"
// data-loss class dead). Attribution mirrors the server's grounded rule
// (attributeSceneDialogue): a quote is the addressed speaker's iff a speech tag
// names them, or they are the SOLE present NPC and no other name is tagged;
// anything ambiguous or tagged to another character goes to the log — the VN
// never guesses.
const VN_SPLIT_SPEECH_VERBS = "says?|said|asks?|asked|repl(?:y|ies|ied)|answers?|answered|whispers?|whispered|mutters?|muttered|growls?|growled|calls?|called|adds?|added|shouts?|shouted|murmurs?|murmured|snaps?|snapped|continues?|continued|offers?|offered|warns?|warned|hisses|barks?|declares?|declared";
const VN_SPLIT_QUOTED_SPAN_RE = /["“][^"“”]+["”]/g;
const VN_SPLIT_NAME_CAP = "([A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?)";

function vnSplitFirstName(name) {
  return String(name || "").trim().toLowerCase().split(/\s+/)[0] || "";
}

const VN_SPLIT_PRONOUNS = new Set(["she", "he", "they", "her", "him", "them"]);

// Which character does this quoted span belong to? Returns "addressed" (VN),
// "other" (a different named present character or the player), or "unknown".
// The speech tag must sit IMMEDIATELY against the quote — a distant earlier tag
// ("Garrick warns … " sentences back) must never attach to a later quote.
function vnSplitAttributeSpan(text, index, span, ctx) {
  const before = text.slice(Math.max(0, index - 40), index);
  const after = text.slice(index + span.length, index + span.length + 40);
  const V = VN_SPLIT_SPEECH_VERBS;
  // Priority: the post-quote tag is the most reliable and immediate
  //   ," she says   |   ," Ilse adds   |   ," said Ilse
  const tagged =
    (new RegExp(`^[\\s,]*([A-Za-z]+)\\s+(?:${V})\\b`).exec(after) || [])[1] ||
    (new RegExp(`^[\\s,]*(?:${V})\\s+([A-Z][a-z]+)`).exec(after) || [])[1] ||
    // Pre-quote tag, bound to the quote: "Ilse said," / "she whispered,"
    (new RegExp(`([A-Za-z]+)\\s+(?:${V})[\\s,:]*$`).exec(before) || [])[1] ||
    null;
  if (tagged) {
    const first = vnSplitFirstName(tagged);
    // A PRONOUN speech tag ("she says", "he warns") in an active VN attributes to
    // the conversation partner — the addressed speaker. (Another NPC speaking is
    // name-tagged, as in "Garrick warns"; those route to the log below.)
    if (VN_SPLIT_PRONOUNS.has(first)) {
      return ctx.addressedFirst ? "addressed" : "unknown";
    }
    if (first && first === ctx.addressedFirst) return "addressed";
    if (ctx.otherFirsts.has(first) || first === ctx.playerFirst) return "other";
    return "unknown"; // a name that isn't a known present character — don't guess
  }
  // No tag: attribute to the addressed speaker ONLY when they are the sole present
  // NPC (the 1:1 conversation). With other NPCs on stage, an untagged line is
  // ambiguous — log it.
  return ctx.soleAddressed ? "addressed" : "unknown";
}

// Pure. Splits GM narration into the addressed speaker's quotes (VN) and
// everything else (log), conserving every character.
// @returns {{ vnText: string, logText: string, segments: Array<{part:'vn'|'log',text:string}>, hasVnDialogue: boolean }}
export function splitVnDialogue(fullText, options = {}) {
  const text = typeof fullText === "string" ? fullText : "";
  const addressedName = typeof options.addressedSpeakerName === "string" ? options.addressedSpeakerName : "";
  const otherNames = Array.isArray(options.otherPresentNames) ? options.otherPresentNames : [];
  const playerName = typeof options.playerName === "string" ? options.playerName : "";
  const ctx = {
    addressedFirst: vnSplitFirstName(addressedName),
    otherFirsts: new Set(otherNames.map(vnSplitFirstName).filter(Boolean)),
    playerFirst: vnSplitFirstName(playerName),
    soleAddressed: otherNames.filter(Boolean).length === 0 && Boolean(addressedName)
  };
  const segments = [];
  if (!text) {
    return { vnText: "", logText: "", segments, hasVnDialogue: false };
  }
  let cursor = 0;
  let m;
  VN_SPLIT_QUOTED_SPAN_RE.lastIndex = 0;
  while ((m = VN_SPLIT_QUOTED_SPAN_RE.exec(text)) !== null) {
    const span = m[0];
    const start = m.index;
    if (start > cursor) {
      segments.push({ part: "log", text: text.slice(cursor, start) });
    }
    const spoken = span.replace(/^["“]|["”]$/g, "").trim();
    const verdict = spoken ? vnSplitAttributeSpan(text, start, span, ctx) : "other";
    segments.push({ part: verdict === "addressed" ? "vn" : "log", text: span });
    cursor = start + span.length;
  }
  if (cursor < text.length) {
    segments.push({ part: "log", text: text.slice(cursor) });
  }
  const vnParts = segments.filter((s) => s.part === "vn").map((s) => s.text);
  const logText = segments.filter((s) => s.part === "log").map((s) => s.text).join("");
  return {
    vnText: vnParts.join(" ").replace(/\s+/g, " ").trim(),
    logText,
    segments,
    hasVnDialogue: vnParts.length > 0
  };
}

// Convenience: derive the split for a talk turn from scene + the addressed
// speaker, pulling the "other present names" from the cast roster so other NPCs'
// quotes route to the log.
export function splitVnDialogueForScene(fullText, scene = {}, addressedSpeakerName = "", playerName = "") {
  const cast = Array.isArray(scene.cast) ? scene.cast : [];
  const addressedFirst = vnSplitFirstName(addressedSpeakerName);
  const otherPresentNames = cast
    .map((c) => (c && (c.displayName || c.name)) || "")
    .filter((n) => n && vnSplitFirstName(n) !== addressedFirst);
  return splitVnDialogue(fullText, { addressedSpeakerName, otherPresentNames, playerName });
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

// R2 — VISIBLE COSTS (walk-2, sharpened by F2's HP mystery). A failed check's committed
// cost is stated in the roll banner, derived from the COMMITTED consequence/damage record
// (never from narration): "cost: −2 vitality". No committed cost may be invisible.
export function consequenceCostLine(entry = {}) {
  const c = entry && entry.consequence ? entry.consequence : null;
  const dmg = entry && entry.damage ? entry.damage : (c && c.type === "damage" ? c : null);
  if (dmg && Number.isFinite(dmg.hpBefore) && Number.isFinite(dmg.hpAfter) && dmg.hpAfter < dmg.hpBefore) {
    return `cost: −${dmg.hpBefore - dmg.hpAfter} vitality`;
  }
  if (dmg && Number.isFinite(dmg.amount) && dmg.amount > 0) return `cost: −${dmg.amount} vitality`;
  if (c && c.type === "condition" && (c.condition || c.kind)) return `cost: now ${String(c.condition || c.kind)}`;
  if (c && c.type === "resource" && c.resource) return `cost: −${Number(c.amount) || 1} ${c.resource}`;
  if (c && c.applied && typeof c.summary === "string" && c.summary.trim()) return `cost: ${c.summary.trim()}`;
  return "";
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
  const hasTotal = cr && cr.total !== undefined && cr.total !== null;
  const hasDc = cr && cr.dc !== undefined && cr.dc !== null;
  // resolution-tier (item 3/6): a roll-less outcome is AUTOMATIC — it must show
  // NO band badge and NEVER a numberless FAILURE. The log-entry render already
  // gates its roll tag on hasRoll (#33); THIS strip missed that guard and stamped
  // a bare "Failure ✕" whenever the resolver produced no checkResult (the owner's
  // "FAILURE badge, no visible roll" symptom). No roll total => no strip. This is
  // the client half; the resolver's automatic tier (server/solo, CLI 1) is what
  // stops stamping a band on safe move/talk/observe in the first place.
  if (!hasTotal) {
    return "";
  }
  const b = outcomeBandInfo(outcome);
  // #5 readability: label the numbers — bare "2/12" was unreadable. Verified
  // semantics: cr.total is the roll total, cr.dc the difficulty (matches the
  // right rail's "vs DC" framing and the resolver's checkResult contract).
  const roll = `<span class="solo-outcome-roll">Rolled ${escapeHtml(cr.total)}${hasDc ? `<span class="solo-outcome-dc"> · DC ${escapeHtml(cr.dc)}</span>` : ""}</span>`;
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
            ? `<img class="solo-detail-portrait-img" src="${escapeHtml(portraitUri)}" alt="${escapeHtml(title)} portrait" />` + renderArtThumb(portraitUri, "portrait", "br")
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
  // POLISHED default skin (owner pick 2026-07-22 — Obsidian was seen live and rejected).
  // The scene shell applies THIS skin's tokens as inline style on .app-shell, overriding
  // :root — so the RUN's polished surface must be set HERE too, not only in :root (a run
  // once rendered the old variant while the lobby was updated). Cool blue-black volcanic
  // glass (B>R), silver accents, a DEEPER base + a STRONGER specular sheen baked into the
  // texture so run panels catch light like the lobby's Polished. Grain retained. Mirrors
  // :root (Polished default). The rejected softer Obsidian is :root[data-leather="obsidian"]
  // in styles.css — swap these values back to carry it into runs.
  // DRIFT-LOCK: tests/obsidian-surface-unified.test.js asserts every color token below
  // equals the styles.css :root Polished value (the --accent-2 overload aside), so the
  // RUN surface can never silently drift off the lobby's Polished again.
  ashen: {
    "--bg": "#05060b", "--panel": "#0a0c12", "--card": "#0c0e15", "--inset": "#050609",
    "--card-dim": "#08090f", "--tabbar": "#06070c", "--border": "#1b1d27", "--border-faint": "#141620",
    "--border-strong": "#31343f", "--text": "#d9dbe0", "--text-bright": "#f1f2f5", "--text-2": "#b0b3bb",
    "--text-muted": "#8b8e96", "--text-label": "#83868e", "--text-faint": "#5f626a", "--accent": "#c2c6cf",
    "--accent-2": "#e7e9ee", "--accent-bright": "#e7e9ee", "--accent-grad-a": "#cfd3db", "--accent-grad-b": "#9498a1",
    "--accent-border": "#474b59", "--on-accent": "#0a0a0b",
    "--texture": "linear-gradient(133deg,rgba(226,232,240,.09) 0%,rgba(226,232,240,.03) 15%,transparent 46%),repeating-linear-gradient(34deg,rgba(214,217,224,.02) 0 1px,transparent 1px 3px),repeating-linear-gradient(-22deg,rgba(0,0,0,.22) 0 1px,transparent 1px 4px)",
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


// VN TEXT SPEED (vn-dialogue-hardening, table stakes): the per-character reveal
// rate of the VN typewriter, player-tunable like the narration text size (#48
// pattern: normalize + localStorage persist + one delegated control). "instant"
// skips the reveal entirely.
export const VN_TEXT_SPEEDS = Object.freeze({ slow: 45, normal: 30, fast: 15, instant: 0 });
export const VN_TEXT_SPEED_ORDER = Object.freeze(["slow", "normal", "fast", "instant"]);
export function normalizeTextSpeed(value) {
  return Object.prototype.hasOwnProperty.call(VN_TEXT_SPEEDS, value) ? value : "normal";
}

// #48: narration text-size multiplier, clamped to a sane readable band and
// quantized to 0.1 steps. Non-numeric / out-of-range falls back to 1.0.
// U5 (walk-2): floor extended 2 steps smaller (0.8 -> 0.6) for denser readers.
export const SOLO_LOG_SCALE_MIN = 0.6;
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
  "animal handling": { ability: "WIS", desc: "Calm, read, or direct animals: soothe a spooked mount, sense a beast's intent." },
  arcana: { ability: "INT", desc: "Recall lore about spells, magic items, planes, and magical phenomena." },
  athletics: { ability: "STR", desc: "Climb, jump, swim, grapple: raw physical effort under pressure." },
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
    proficiencies: "·",
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
export function renderBabelStatusWindow(character = SOLO_SAMPLE_CHARACTER, { open = false, scene = {} } = {}) {
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
          const description = typeof item?.description === "string" && item.description ? item.description : "No further detail. Examine it in play.";
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
          const rank = typeof skill?.rank === "string" && skill.rank ? skill.rank : "·";
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
    : `<div class="solo-skill-empty">none yet. Skills are earned in play, and they define your RANK.</div>`;
  return `
    <aside class="solo-game-sidebar solo-babel-window solo-portrait-dock-aside" data-window="babel">
      ${portraitDockHtml(character, scene)}
      ${/* JOB 2: the ◄ STATUS ► / name / Level·Tier block moved OUT of the always-on
           dock (where it overlaid the reading column) and INTO the player tab. */""}
      ${characterTabHtml(open, `
        <div class="solo-sidebar-identity solo-dock-identity">
          <div class="solo-stat-kicker">◄ STATUS ►</div>
          <div class="solo-char-name" data-textfit>${escapeHtml(character.name)}</div>
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
        <div class="solo-sidebar-block solo-sight-block">
          <div class="solo-stat-kicker">Essence-sight</div>
          <div data-solo-sight>${renderSoloSightBlockInner(scene)}</div>
        </div>
        <div class="solo-sidebar-block solo-window-motto">[ THE WINDOW DOES NOT LIE. ]</div>
      `)}
    </aside>
  `;
}

export function renderSoloCharacterSidebar(character = SOLO_SAMPLE_CHARACTER, { open = false, scene = {} } = {}) {
  // BABEL: the diegetic STATUS WINDOW replaces the D&D sheet entirely (§2.3).
  if (character && character.babel) {
    return renderBabelStatusWindow(character, { open, scene });
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
          const description = typeof item?.description === "string" && item.description ? item.description : "No further detail. Examine it in play.";
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
    <aside class="solo-game-sidebar solo-portrait-dock-aside">
      ${portraitDockHtml(character, scene)}
      ${/* JOB 2: identity block relocated from the always-on dock into the player tab. */""}
      ${characterTabHtml(open, `
        <div class="solo-sidebar-identity solo-dock-identity">
          <div class="solo-char-name" data-textfit>${escapeHtml(character.name)}</div>
          <div class="solo-char-sub">${escapeHtml(character.className)} · Level ${escapeHtml(character.level)}</div>
        </div>
        <div class="solo-sidebar-block">
          <div class="solo-xp-row"><span class="solo-stat-kicker">XP</span><span class="solo-xp-value">${escapeHtml(xp)}</span></div>
        </div>
        <div class="solo-sidebar-block">
          <div class="solo-gauge-row">
            <span class="solo-stat-kicker">Hit Points</span>
            <span class="solo-hp-value">${escapeHtml(hp.current)} <span>/ ${escapeHtml(hp.max)}</span></span>
          </div>
          <div class="solo-gauge-track"><div class="solo-gauge-fill solo-hp-fill" style="width:${hpPct}%;"></div></div>
          <div class="solo-gauge-row solo-mp-row${hasMana ? "" : " is-muted"}">
            <span class="solo-stat-kicker">${hasMana ? "Mana" : "Mana: none"}</span>
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
      `)}
    </aside>
  `;
}

// The CHARACTER TAB drawer (ui restructure): wraps the full sheet body so it
// overlays out of the compact portrait dock. Hidden unless `open`; a backdrop +
// close button dismiss it. Shared by the D&D sidebar and the Babel window.
function characterTabHtml(open, bodyHtml) {
  return `
    <div class="solo-char-tab${open ? " is-open" : ""}" data-solo-char-tab-panel role="dialog" aria-label="Character sheet" aria-hidden="${open ? "false" : "true"}">
      <div class="solo-char-tab-head">
        <span class="solo-stat-kicker">Character</span>
        <button type="button" class="solo-char-tab-close" data-solo-char-tab-close aria-label="Close character sheet">×</button>
      </div>
      <div class="solo-char-tab-body">${bodyHtml}</div>
    </div>
    ${open ? `<div class="solo-char-tab-backdrop" data-solo-char-tab-close aria-hidden="true"></div>` : ""}`;
}


// #15: the "GM is thinking / Loading scene" strip, extracted so the turn
// fast-path can repaint just this node (inside data-solo-thinking) in place.
// ---------------------------------------------------------------------------
// CONDITIONS HUD v2 (#26 + item 1). One chip per active condition from the scene
// payload: scene.player.conditions[] = { id, name, effect, kind, remaining
// Minutes|null, permanent } (conditionStatusPayload). `kind` is SERVER-MINTED
// ("buff"|"debuff"|"mark"|"control"|"neutral") — the client word-guessing
// classifier is DELETED. Colorblind-safe multi-channel encoding: color alone is
// banned, so every kind also carries a mandatory shape glyph (color-independent)
// and the kind word in the screen-reader label + tooltip. Chips are GROUPED by
// kind (buffs → marks → neutral → control → debuffs), never interleaved.
// ---------------------------------------------------------------------------
export const CONDITION_KIND_META = Object.freeze({
  buff: { glyph: "▲", word: "Buff", order: 0 },
  mark: { glyph: "◆", word: "Mark", order: 1 },
  neutral: { glyph: "●", word: "Effect", order: 2 },
  control: { glyph: "🔒", word: "Control", order: 3 },
  debuff: { glyph: "▼", word: "Debuff", order: 4 }
});

function conditionKindMeta(kind) {
  return CONDITION_KIND_META[String(kind || "").toLowerCase()] || CONDITION_KIND_META.neutral;
}

// ---------------------------------------------------------------------------
// ESSENCE-SIGHT trace chips (verdance-region-v1 §law-5) — the SIGHT layer in the
// STATUS WINDOW idiom. Same multi-channel encoding as the conditions HUD: a kind
// GLYPH + a band WORD + the direction, never colour alone (colorblind-safe). Fed
// by scene.sight (a player-only surface no NPC/OOC payload carries). Only the MC
// perceives essence, so this reads as the champion's unique organ.
// ---------------------------------------------------------------------------
export const TRACE_CHIP_META = Object.freeze({
  trail: { glyph: "≈", word: "Trail" },
  residue: { glyph: "◈", word: "Residue" },
  mark: { glyph: "✶", word: "Mark" }
});
export const TRACE_BAND_WORD = Object.freeze({ bright: "Bright", clear: "Clear", faint: "Faint", cold: "Cold" });

// DIEGETIC SIGHT PHRASES — CLIENT MIRROR of server/solo/essence.js SIGHT_PHRASES
// (parity-tested: tests/sight-phrase-parity.test.js). The chip reads as the champion's
// PERCEPTION, never the raw kind/band field names; the mechanical band rides the tooltip.
export const SIGHT_PHRASES = Object.freeze({
  trail: Object.freeze({ bright: "The trail burns fresh", clear: "The scent holds", faint: "A fading trace", cold: "Cold remnants linger" }),
  mark: Object.freeze({ bright: "A mark, freshly cut", clear: "A mark holds its edge", faint: "A mark worn thin", cold: "An old mark, all but gone" }),
  residue: Object.freeze({ bright: "Raw residue still clings", clear: "Residue lingers close", faint: "Residue thinning away", cold: "The faintest cold residue" })
});
function sightPhraseClient(kind, band) {
  const k = SIGHT_PHRASES[kind] ? kind : "trail";
  const b = SIGHT_PHRASES[k][band] ? band : "clear";
  return SIGHT_PHRASES[k][b];
}

function traceChipMeta(kind) {
  return TRACE_CHIP_META[String(kind || "").toLowerCase()] || TRACE_CHIP_META.trail;
}

export function renderSoloTraceChips(scene = {}) {
  const traces = Array.isArray(scene?.sight?.traces) ? scene.sight.traces : [];
  if (!traces.length) {
    return ""; // empty state supplied by the block wrapper (see renderSoloSightBlockInner)
  }
  const chips = traces
    .map((t) => {
      const kind = TRACE_CHIP_META[String(t.kind || "").toLowerCase()] ? String(t.kind).toLowerCase() : "trail";
      const meta = traceChipMeta(kind);
      const band = String(t.band || "cold").toLowerCase();
      const bandWord = TRACE_BAND_WORD[band] || "Cold";
      const phrase = sightPhraseClient(kind, band); // the champion's perception (diegetic)
      const dir = t.followable ? (t.direction ? `toward ${t.direction}` : "leading onward") : "";
      const scent = t.meta && typeof t.meta.handlerScent === "string" ? t.meta.handlerScent : "";
      const tipBody = [dir, scent].filter(Boolean).join(" · ");
      return `
        <span class="solo-trace-chip trace-${band}" tabindex="0" data-trace-id="${escapeHtml(t.id || kind)}" aria-label="${escapeHtml(`${phrase}. ${meta.word}, ${bandWord}. ${tipBody}`)}">
          <span class="solo-trace-glyph" aria-hidden="true">${meta.glyph}</span>
          <span class="solo-trace-name">${escapeHtml(phrase)}</span>
          ${dir ? `<span class="solo-trace-dir">${escapeHtml(dir)}</span>` : ""}
          <span class="solo-trace-tip" role="tooltip"><strong>${escapeHtml(`${meta.word} · ${bandWord}`)}</strong>${tipBody ? `<span>${escapeHtml(tipBody)}</span>` : ""}</span>
        </span>`;
    })
    .join("");
  return `<div class="solo-traces solo-measure" role="group" aria-label="Essence-sight traces">${chips}</div>`;
}

// The STATUS WINDOW's essence-sight block body: the chips, or a quiet empty state
// (the WINDOW always reads out the sight — a quiet sight is still a fact).
export function renderSoloSightBlockInner(scene = {}) {
  return renderSoloTraceChips(scene) || `<div class="solo-trace-empty">The sight is quiet here.</div>`;
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

// `compact` (buffs/debuffs-on-portrait law): drops the full-bleed measure column
// and the inline name/time, leaving glyph-only chips sized to sit on the portrait
// edge — the name/effect/duration stay in the tooltip + aria label (unchanged
// detail on hover/focus). Default false keeps the legacy HUD shape for callers.
export function renderSoloConditionsHud(scene = {}, { compact = false } = {}) {
  // Delegates to the SHARED condition-chip component (conditionChips.js) — the same
  // idiom CLI 2's battle surface reuses. The portrait dock passes THIS surface's kind
  // meta + duration formatter; grouping/cap/overflow/markup all live in the shared
  // component. Compact caps at 4 with a "+N" pill into the character sheet.
  const conditions = Array.isArray(scene.player?.conditions) ? scene.player.conditions : Array.isArray(scene.conditions) ? scene.conditions : [];
  return renderConditionChipRow(conditions, {
    compact,
    cap: 4,
    kindMeta: conditionKindMeta,
    knownKind: (k) => Boolean(CONDITION_KIND_META[String(k || "").toLowerCase()]),
    formatDuration: formatConditionDuration,
    overflowAttr: "data-solo-char-tab",
    wrapClass: "solo-measure"
  });
}

// Shared compact PORTRAIT DOCK (ui restructure): the portrait stays visible and
// compact; a badge ON it opens the character tab; committed conditions render as
// glyph chips overlaid on the portrait edge (tooltip carries the detail). Reused
// by both the D&D sidebar and the Babel status window. `data-solo-conditions` is
// the fast-path patch target, so the turn fast-path repaints these chips in place.
function portraitDockHtml(character = {}, scene = {}) {
  const img = character.portraitUri
    ? `<img class="solo-portrait-img" src="${escapeHtml(character.portraitUri)}" alt="${escapeHtml(character.name || "Character")} portrait" />`
    : `<div class="solo-portrait-pending"><span class="solo-portrait-spinner" aria-hidden="true"></span><small>Cooking your portrait…</small></div>`;
  return `
    <div class="solo-portrait" data-portrait-for="player" data-portrait-img-class="solo-portrait-img">
      ${img}
      <button type="button" class="solo-portrait-badge" data-solo-char-tab aria-haspopup="dialog" aria-label="Open character sheet" title="Character sheet">☰</button>
      <div class="solo-portrait-conds" data-solo-conditions>${renderSoloConditionsHud(scene, { compact: true })}</div>
      ${character.portraitUri ? renderArtThumb(character.portraitUri, "portrait", "bl") : ""}
    </div>`;
}

// Past this elapsed time a pending turn shows a live seconds counter instead of a
// static "thinking" label, so a latency spike reads as alive, not dead.
export const SOLO_STALL_ELAPSED_THRESHOLD_MS = 6000;

export function renderSoloThinkingIndicator(state = {}, now = null) {
  if (!state.gmThinking && !state.sceneReloading) {
    return "";
  }
  let label = state.gmThinking ? "The GM is thinking…" : "Loading scene…";
  // STALL VISIBILITY (input integrity clause 5): once a processing turn passes the
  // stall threshold, surface elapsed time ("Still working — 18s"). Tie-in: the
  // pending turn's startedAt (set at submit) + the shell's stall re-render timer.
  const started = state.pendingTurn && state.pendingTurn.status === "processing"
    ? Number(state.pendingTurn.startedAt)
    : NaN;
  const nowT = Number.isFinite(now) ? Number(now) : (typeof Date !== "undefined" ? Date.now() : 0);
  if (state.gmThinking && Number.isFinite(started) && nowT - started >= SOLO_STALL_ELAPSED_THRESHOLD_MS) {
    const el = stallElapsedLabel(started, nowT);
    if (el) {
      label = `Still working — ${el}`;
    }
  }
  return `<div class="solo-thinking" role="status">${label}</div>`;
}

// U4 — the classified WHY a turn submission failed (mirrors classifyImageFailure). A
// message the player can act on, not a bare "failed". Retry is always offered alongside.
export function classifyTurnFailure(error) {
  const m = String(error?.message || error || "").toLowerCase();
  const status = Number(error?.status || error?.statusCode) || 0;
  if (/timeout|timed out|deadline|aborted/.test(m)) return "The game master took too long to answer. Retry when ready.";
  if (/failed to fetch|network|econnrefused|unreachable|offline|load failed/.test(m)) return "The connection to the server dropped. Check your connection and retry.";
  if (status === 429 || /rate|too many/.test(m)) return "The server is busy right now. Give it a moment, then retry.";
  if (status >= 500 || /server error|internal/.test(m)) return "The server hit an error on this turn. Your text is kept; retry.";
  return "The turn didn't reach the server. Your text is kept; retry.";
}

// INPUT INTEGRITY surface — the failed-turn recovery banner and the one-deep queued
// chip. A failed turn is NEVER silently dropped: the player sees exactly which
// action is at risk and chooses Retry (idempotent resubmit) or Discard.
export function renderSoloTurnLifecycle(state = {}) {
  const parts = [];
  const pending = state.pendingTurn;
  if (pending && pending.status === "failed") {
    const label = firstWordsLabel(pending.text) || "your last action";
    // U4: carry the classified WHY (timeout / provider / network), never a bare failure.
    const why = typeof pending.reason === "string" && pending.reason.trim() ? ` ${pending.reason.trim()}` : "";
    parts.push(
      `<div class="solo-turn-failed" role="alert" data-solo-turn-failed>` +
        `<span class="solo-turn-failed-msg">Your action “${escapeHtml(label)}” wasn't processed.${escapeHtml(why)}</span>` +
        `<span class="solo-turn-failed-actions">` +
        `<button type="button" class="solo-turn-retry" data-solo-turn-retry>Retry</button>` +
        `<button type="button" class="solo-turn-discard" data-solo-turn-discard>Discard</button>` +
        `</span>` +
      `</div>`
    );
  }
  const queued = state.queuedTurn;
  if (queued && queued.text) {
    const label = firstWordsLabel(queued.text) || "next action";
    parts.push(
      `<div class="solo-turn-queued" role="status" data-solo-turn-queued>Queued: “${escapeHtml(label)}” — sends when this turn finishes.</div>`
    );
  }
  return parts.join("");
}

// COMMITTED AFFORDANCES chip row (affordances-map-law Part A). Renders
// scene.affordances (server-derived from committed state) as a quiet capped row
// ABOVE the input box — suggest, never limit. Cap 7 visible + a "more" overflow
// chip (state.affordancesExpanded shows all). Gated chips render distinct with
// the reason in title/aria; a tap on a gated chip shows the reason and does NOT
// submit. An OK chip carries data-solo-affordance=<intent> and routes through the
// same turn path as typing (delegated dispatch → onAttempt). "" when none.
export const SOLO_AFFORDANCE_CAP = 7;
export function renderSoloAffordances(state = {}) {
  const scene = state.scene || {};
  const all = Array.isArray(scene.affordances) ? scene.affordances.filter((a) => a && typeof a.label === "string" && typeof a.intent === "string") : [];
  if (!all.length) {
    return "";
  }
  const expanded = state.affordancesExpanded === true;
  const overflow = all.length > SOLO_AFFORDANCE_CAP;
  const visible = expanded || !overflow ? all : all.slice(0, SOLO_AFFORDANCE_CAP);
  const chips = visible
    .map((a) => {
      const gated = a.feasibility === "gated";
      const reason = typeof a.gateReason === "string" ? a.gateReason : "";
      if (gated) {
        return `<button type="button" class="solo-affordance is-gated" data-solo-affordance-gated="${escapeHtml(reason)}" aria-disabled="true" title="${escapeHtml(reason)}" aria-label="${escapeHtml(`${a.label}. Not possible: ${reason}`)}">${escapeHtml(a.label)}</button>`;
      }
      return `<button type="button" class="solo-affordance" data-solo-affordance="${escapeHtml(a.intent)}" data-source="${escapeHtml(String(a.source || ""))}" title="${escapeHtml(a.intent)}">${escapeHtml(a.label)}</button>`;
    })
    .join("");
  const more = overflow
    ? `<button type="button" class="solo-affordance solo-affordance-more" data-solo-affordances-more aria-expanded="${expanded ? "true" : "false"}">${expanded ? "less" : `more (${all.length - SOLO_AFFORDANCE_CAP})`}</button>`
    : "";
  const gateNote = typeof state.affordanceGateNote === "string" && state.affordanceGateNote
    ? `<div class="solo-affordance-gatenote" role="status">${escapeHtml(state.affordanceGateNote)}</div>`
    : "";
  return `<div class="solo-affordances solo-measure" role="group" aria-label="Suggested actions">${chips}${more}</div>${gateNote}`;
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
        <input type="text" class="solo-scene-field" data-solo-attempt-input placeholder="What do you do?  (&quot;quote&quot; to speak · /ooc to ask the GM)" value="${escapeHtml(draft)}" maxlength="${SOLO_INPUT_MAXLEN}" />
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
        <!-- VN text speed (table stakes): cycles slow → normal → fast → instant;
             persisted like the sizer; the typewriter reads it on every bind. -->
        <span class="solo-log-fontsize solo-textspeed" role="group" aria-label="Dialogue text speed">
          <button type="button" class="solo-fontsize-btn" data-solo-textspeed title="Dialogue text speed (click to cycle)" aria-label="Dialogue text speed: ${escapeHtml(normalizeTextSpeed(state.textSpeed))}">Aa·${escapeHtml(normalizeTextSpeed(state.textSpeed))}</button>
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

export function renderSoloSceneArt(locationImageUri = null, { locked = false, status = "" } = {}) {
  const uri = typeof locationImageUri === "string" ? locationImageUri.trim() : "";
  if (uri) {
    // Generated location background fills the banner area (object-fit: cover),
    // with Redo/Save controls overlaid bottom-right until the image is locked.
    return `
      <div class="solo-scene-art" data-scene-art>
        ${sceneArtInnerHtml(uri, { locked })}
        ${renderArtThumb(uri, "scene", "bl")}
      </div>
    `;
  }
  // No image yet. The pending overlay lives ON the art slot (JOB 3): it carries the
  // "appears as it's ready" message the old page-level banner used to, and it resolves to
  // a real end-state — a FAILED overlay with a retry when the cook fails, so a pending
  // promise never hangs forever. It clears automatically when the image arrives (the uri
  // branch above renders instead), tying its lifetime to the asset's ready state, not a timer.
  const overlay =
    status === "failed"
      ? `<div class="solo-scene-art-pending solo-scene-art-failed" role="status">
           <span>Scene art didn't finish.</span>
           <button type="button" class="solo-scene-art-btn" data-scene-redo>↻ Try again</button>
         </div>`
      : `<div class="solo-scene-art-pending" role="status" aria-live="polite">
           <span class="solo-scene-art-spinner" aria-hidden="true"></span>
           <span class="solo-scene-art-pending-msg">Painting the scene…<small>appears here as it's ready, usually a minute or two</small></span>
         </div>`;
  return `
    <div class="solo-scene-art" data-scene-art>
      <div class="solo-scene-art-glow"></div>
      <div class="solo-scene-art-window"></div>
      <div class="solo-scene-art-hearth"></div>
      <div class="solo-scene-art-floor"></div>
      ${overlay}
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
// Map-layout law: glyphs for COMMITTED terrain/structure cells (the server-
// minted location layout riding scene.battleMap.terrain). Distinct from the
// marker glyphs above: terrain is the ground truth of the place itself.
const PRESENCE_TERRAIN_GLYPH = {
  tree: "♣",
  rock: "▲",
  rubble: "▒",
  wall: "█",
  gate: "∩",
  door: "▢",
  road: "·",
  water: "≈",
  building: "⌂",
  exit: "⤳"
};
// Committed ground kind -> terrain skin class. When the server mints a layout
// its `ground` field wins over the legacy name/tag regex guess.
const PRESENCE_GROUND_CLASS = {
  forest: "terrain-forest",
  grass: "terrain-forest",
  water: "terrain-water",
  sand: "terrain-sand",
  ruins: "terrain-ruins",
  stone: "terrain-stone"
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
  const terrainClass =
    (typeof bm.ground === "string" && PRESENCE_GROUND_CLASS[bm.ground]) || presenceTerrainClass(scene);

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

  // COMMITTED LAYOUT layer (map-layout law): the server-minted location layout —
  // terrain and structures (trees, walls, the gate, roads, water) riding
  // scene.battleMap.terrain. Drawn between the ground and the marker/token
  // layers. Honest to state: when the server commits no layout, nothing draws.
  const terrain = Array.isArray(bm.terrain) ? bm.terrain : [];
  const terrainCells = terrain
    .filter((c) => c && typeof c === "object" && Number.isFinite(Number(c.x)) && Number.isFinite(Number(c.y)))
    .map((cell) => {
      const kind = typeof cell.kind === "string" && cell.kind ? cell.kind : "rock";
      const glyph = PRESENCE_TERRAIN_GLYPH[kind] || "▲";
      const x = clampTo(cell.x, width);
      const y = clampTo(cell.y, height);
      const label =
        typeof cell.name === "string" && cell.name
          ? ` title="${escapeHtml(cell.name)}" aria-label="${escapeHtml(cell.name)}"`
          : "";
      return `<span class="solo-presence-terrainfeat solo-terrainfeat-${escapeHtml(kind)}" style="grid-column:${x + 1};grid-row:${y + 1};"${label}>${glyph}</span>`;
    })
    .join("");

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
  const namedTerrainLegend = terrain
    .filter((c) => c && typeof c === "object" && typeof c.name === "string" && c.name)
    .map((cell) => {
      const kind = typeof cell.kind === "string" && cell.kind ? cell.kind : "rock";
      return { kind: `terrain-${kind}`, glyph: PRESENCE_TERRAIN_GLYPH[kind] || "▲", name: cell.name };
    });
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
    .concat(namedTerrainLegend)
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
  return `<div class="solo-presence">${head}<div class="solo-presence-grid ${terrainClass}" style="grid-template-columns:repeat(${width},1fr);grid-template-rows:repeat(${height},1fr);" role="img" aria-label="Presence map of ${escapeHtml(locationName)}">${ground.join("")}${terrainCells}${featureCells}${cells}</div>${legendBlock}</div>`;
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

// DERIVED WEATHER glyph (owner checklist item 1) — sits beside the phase icon.
// "clear" renders NO extra glyph (the sun/moon phase icon already says clear
// sky); every other committed weather adds a small inline SVG in the phase-icon
// idiom. The value is the server's derived read (sky hazard overlaying the
// persistent world.weather) — the client never derives weather itself.
const CLOCK_WEATHER_META = {
  cloudy: { label: "Cloudy" },
  rain: { label: "Rain" },
  storm: { label: "Storm" },
  snow: { label: "Snow" },
  fog: { label: "Fog" }
};
// One shared cloud path; rain/storm/snow decorate under it, fog is layered lines.
const WX_CLOUD = `<path d="M7 17a4 4 0 1 1 .6-7.96A5.5 5.5 0 0 1 18 10.5 3.5 3.5 0 0 1 17.5 17z"/>`;
function clockWeatherIcon(weather) {
  const w = CLOCK_WEATHER_META[weather] ? weather : null;
  if (!w) {
    return "";
  }
  let art = WX_CLOUD;
  if (w === "rain") {
    art += `<line x1="9" y1="19" x2="8" y2="22"/><line x1="13" y1="19" x2="12" y2="22"/><line x1="17" y1="19" x2="16" y2="22"/>`;
  } else if (w === "storm") {
    art += `<path d="M12 18l-2.5 4h3l-1.5 3 4-5h-3l1.8-2z"/>`;
  } else if (w === "snow") {
    art += `<circle cx="9" cy="20.5" r="0.9"/><circle cx="13" cy="22" r="0.9"/><circle cx="16.5" cy="20" r="0.9"/>`;
  } else if (w === "fog") {
    art = `<line x1="3" y1="9" x2="21" y2="9"/><line x1="5" y1="13" x2="19" y2="13"/><line x1="3" y1="17" x2="21" y2="17"/>`;
  }
  return `<svg class="solo-clock-icon solo-clock-wx solo-clock-wx-${w}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-solo-weather="${w}">${art}</svg>`;
}

// PLAYER GOALS status surface (player-goals-law, honor machinery 4). Draws the
// committed goals from scene.goals: active goals with a scale tag (Projects show
// pips), then recent achievements struck through. "" when the run has no goals,
// so a legacy run's rail is unchanged.
const GOAL_SCALE_LABEL = { task: "Task", project: "Project", ambition: "Ambition" };
function goalPips(progress) {
  if (!progress || !Number.isFinite(progress.target) || progress.target <= 0) {
    return "";
  }
  const target = Math.min(12, Math.max(0, Math.floor(progress.target)));
  const filled = Math.min(target, Math.max(0, Math.floor(progress.current)));
  let pips = "";
  for (let i = 0; i < target; i += 1) {
    pips += `<span class="solo-goal-pip${i < filled ? " is-filled" : ""}" aria-hidden="true"></span>`;
  }
  return `<span class="solo-goal-pips" role="img" aria-label="${filled} of ${target}">${pips}</span>`;
}
export function renderSoloGoals(scene = {}) {
  const goals = Array.isArray(scene.goals) ? scene.goals.filter((g) => g && typeof g.summary === "string") : [];
  if (!goals.length) {
    return "";
  }
  const rows = goals
    .map((g) => {
      const achieved = g.state === "achieved";
      const scale = GOAL_SCALE_LABEL[g.scale] || "Goal";
      const pips = !achieved && g.scale === "project" ? goalPips(g.progress) : "";
      return `<li class="solo-goal${achieved ? " is-achieved" : ""}">
        <span class="solo-goal-scale">${escapeHtml(scale)}</span>
        <span class="solo-goal-summary">${escapeHtml(g.summary)}</span>
        ${achieved ? `<span class="solo-goal-check" aria-label="achieved">✓</span>` : pips}
      </li>`;
    })
    .join("");
  return `
    <div class="solo-goals" data-solo-goals>
      <div class="solo-stat-kicker">Goals</div>
      <ul class="solo-goal-list">${rows}</ul>
    </div>`;
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
  const clock = typeof wt.clock === "string" && wt.clock ? wt.clock : "·";
  const day = Number.isFinite(wt.day) ? wt.day : null;
  const dayPart = day ? ` · Day ${escapeHtml(day)}` : "";
  // Server-derived weather; "clear" (or absent on a legacy payload) adds nothing.
  const weather = typeof wt.weather === "string" && CLOCK_WEATHER_META[wt.weather] ? wt.weather : null;
  const weatherAria = weather ? `, ${CLOCK_WEATHER_META[weather].label.toLowerCase()}` : "";
  const aria = `Time ${clock}, ${meta.label}${weatherAria}${day ? `, day ${day}` : ""}`;
  return `
    <div class="solo-clock ${meta.cls}${weather ? ` solo-clock-has-wx` : ""}" role="group" aria-label="${escapeHtml(aria)}" data-solo-clock>
      ${clockPhaseIcon(phase)}${weather ? clockWeatherIcon(weather) : ""}
      <div class="solo-clock-text">
        <span class="solo-clock-time">${escapeHtml(clock)}</span>
        <span class="solo-clock-phase">${escapeHtml(meta.label)}${weather ? ` · ${escapeHtml(CLOCK_WEATHER_META[weather].label)}` : ""}${dayPart}</span>
      </div>
    </div>`;
}

// Roll entries (most-recent-first) from the scene's attempt history — the shared
// source for the compact roll BANNER and the roll HISTORY drawer.
function rollEntriesFromScene(scene = {}) {
  return (Array.isArray(scene.attemptHistory) ? scene.attemptHistory : [])
    .filter((entry) => entry && entry.checkResult)
    .slice()
    .reverse();
}

// ROLL BANNER (ui restructure): the recent-rolls RAIL panel is gone; the latest
// roll surfaces as one compact inline line, with a magnifying-glass that opens
// the roll HISTORY drawer. "" when no roll has happened yet.
export function renderSoloRollBanner(scene = {}) {
  const entries = rollEntriesFromScene(scene);
  if (!entries.length) {
    return "";
  }
  const entry = entries[0];
  const cr = entry.checkResult || {};
  const intent = String(entry.intent || "Check");
  const label = intent.length > 32 ? `${intent.slice(0, 32)}…` : intent;
  const total = cr.total ?? "·";
  const dc = cr.dc ?? "·";
  const cls = cr.success ? "good" : "accent";
  const outcome = cr.success ? "✓" : "✕";
  return `
    <div class="solo-roll-banner" role="status" aria-label="Most recent roll: ${escapeHtml(label)}, rolled ${escapeHtml(total)} versus DC ${escapeHtml(dc)}, ${cr.success ? "success" : "failure"}">
      <span class="solo-roll-banner-outcome ${cls}" aria-hidden="true">${outcome}</span>
      <span class="solo-roll-banner-label" data-textfit>${escapeHtml(label)}</span>
      <span class="solo-roll-banner-total ${cls}" data-textfit>${escapeHtml(total)}<span class="solo-roll-banner-dc"> / DC ${escapeHtml(dc)}</span></span>
      <button type="button" class="solo-roll-history-btn" data-solo-roll-history aria-haspopup="dialog" aria-label="Open roll history" title="Roll history">🔍</button>
    </div>`;
}

// ROLL HISTORY drawer (ui restructure): the full recent-roll list, in the log
// drawer idiom. Rendered at shell level; hidden unless `open`.
export function renderSoloRollHistory(scene = {}, open = false) {
  const entries = rollEntriesFromScene(scene);
  const rows = entries.length
    ? entries
        .map((entry) => {
          const cr = entry.checkResult || {};
          const intent = String(entry.intent || "Check");
          const total = cr.total ?? "·";
          const dc = cr.dc ?? "·";
          const cls = cr.success ? "good" : "accent";
          return `<li class="solo-roll-hist-row"><span class="solo-roll-hist-intent">${escapeHtml(intent)}</span><span class="solo-roll-hist-detail">vs DC ${escapeHtml(dc)}</span><span class="solo-roll-total ${cls}" data-textfit>${escapeHtml(total)}</span></li>`;
        })
        .join("")
    : `<li class="solo-empty-state">No rolls yet.</li>`;
  return `
    <div class="solo-roll-history-layer${open ? " is-open" : ""}" data-solo-roll-history-layer aria-hidden="${open ? "false" : "true"}">
      ${open ? `<div class="solo-roll-history-backdrop" data-solo-roll-history-close aria-hidden="true"></div>` : ""}
      <div class="solo-roll-history-drawer" role="dialog" aria-label="Roll history">
        <div class="solo-roll-history-head">
          <span class="solo-stat-kicker">Roll History</span>
          <button type="button" class="solo-roll-history-close" data-solo-roll-history-close aria-label="Close roll history">×</button>
        </div>
        <ul class="solo-roll-hist-list">${rows}</ul>
      </div>
    </div>`;
}

// AFFORDANCES-MAP LAW (Part B) — region-graph render. Type glyphs per node (never
// a generic circle); reuses the layout type set. Positions are a deterministic
// client layout (BFS layers from current) — topology is committed, pixels are not.
const REGION_TYPE_GLYPH = {
  forest: "♣",
  clearing: "⌇",
  road: "⌁",
  "town-approach": "∩",
  "town-street": "⌂",
  interior: "▢",
  ruin: "▲",
  cave: "◗"
};

// Deterministic BFS-layered positions (normalized 0..1) for the region nodes.
function layoutRegionNodes(nodes, edges, current) {
  const adj = {};
  for (const n of nodes) {
    adj[n.id] = [];
  }
  for (const e of edges) {
    if (adj[e.a]) adj[e.a].push(e.b);
    if (adj[e.b]) adj[e.b].push(e.a);
  }
  const level = {};
  const queue = [];
  if (current && adj[current]) {
    level[current] = 0;
    queue.push(current);
  }
  while (queue.length) {
    const id = queue.shift();
    for (const nb of adj[id] || []) {
      if (level[nb] === undefined) {
        level[nb] = level[id] + 1;
        queue.push(nb);
      }
    }
  }
  let maxLevel = 0;
  for (const v of Object.values(level)) {
    maxLevel = Math.max(maxLevel, v);
  }
  // Nodes disconnected from current (revealed by map, not adjacent) trail after.
  for (const n of nodes) {
    if (level[n.id] === undefined) {
      maxLevel += 1;
      level[n.id] = maxLevel;
    }
  }
  const byLevel = {};
  for (const n of nodes) {
    (byLevel[level[n.id]] = byLevel[level[n.id]] || []).push(n.id);
  }
  const cols = Math.max(1, maxLevel + 1);
  const pos = {};
  for (const [lvl, group] of Object.entries(byLevel)) {
    group.sort();
    const L = Number(lvl);
    const x = cols === 1 ? 0.5 : L / (cols - 1);
    group.forEach((id, i) => {
      const y = group.length === 1 ? 0.5 : i / (group.length - 1);
      pos[id] = { x, y };
    });
  }
  return pos;
}

export function renderSoloRegionMap(scene = {}) {
  const rm = scene && typeof scene.regionMap === "object" && scene.regionMap ? scene.regionMap : null;
  const head = `<div class="solo-presence-head"><span class="solo-stat-kicker">The region</span><span class="solo-presence-loc" data-textfit>Known map</span></div>`;
  const nodes = rm && Array.isArray(rm.nodes) ? rm.nodes : [];
  if (!nodes.length) {
    return `<div class="solo-region"><div class="solo-region-empty">No mapped ground yet — travel, or find a map, to chart the region.</div></div>`;
  }
  const edges = Array.isArray(rm.edges) ? rm.edges : [];
  const goalByLoc = {};
  for (const g of Array.isArray(rm.goalPins) ? rm.goalPins : []) {
    if (g && g.locationId) {
      (goalByLoc[g.locationId] = goalByLoc[g.locationId] || []).push(g);
    }
  }
  const pos = layoutRegionNodes(nodes, edges, rm.current);
  const W = 300;
  const H = Math.max(150, Math.min(320, 70 + nodes.length * 26));
  const M = 34;
  const px = (nx) => M + nx * (W - 2 * M);
  const py = (ny) => M + ny * (H - 2 * M);

  const edgeSvg = edges
    .map((e) => {
      const pa = pos[e.a];
      const pb = pos[e.b];
      if (!pa || !pb) {
        return "";
      }
      const x1 = px(pa.x);
      const y1 = py(pa.y);
      const x2 = px(pb.x);
      const y2 = py(pb.y);
      // ESSENCE-SIGHT edge glow: an edge carrying a followable trail draws bright
      // and dashed, banded by strength — the trail the champion is reading.
      const cls = e.blocked
        ? "solo-region-edge is-blocked"
        : e.trail
          ? `solo-region-edge is-followed trail-${escapeHtml(String(e.trail))}`
          : "solo-region-edge";
      const line = `<line class="${cls}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" />`;
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const label = Number.isFinite(Number(e.travelTime))
        ? `<text class="solo-region-edge-label" x="${mx.toFixed(1)}" y="${(my - 3).toFixed(1)}" text-anchor="middle">${escapeHtml(String(e.travelTime))}m</text>`
        : "";
      const block = e.blocked
        ? `<text class="solo-region-edge-block" x="${mx.toFixed(1)}" y="${(my + 4).toFixed(1)}" text-anchor="middle" aria-label="blocked">✕</text>`
        : "";
      return line + label + block;
    })
    .join("");

  const nodeSvg = nodes
    .map((n) => {
      const p = pos[n.id];
      if (!p) {
        return "";
      }
      const cx = px(p.x);
      const cy = py(p.y);
      // ESSENCE-SIGHT silhouette: a sight-revealed next node — dimmed + dashed, no
      // place-name (fog-safe: heard-of-by-sight, distinct from a map-item reveal).
      // Tappable to FOLLOW the trail (a normal committed move to that node).
      if (n.sightReveal) {
        const band = escapeHtml(String(n.sightReveal));
        const scls = ["solo-region-node", "is-silhouette", `sight-${band}`];
        if (n.reachable) scls.push("is-reachable");
        const sg =
          `<text class="solo-region-glyph" x="${cx.toFixed(1)}" y="${(cy + 5).toFixed(1)}" text-anchor="middle">≈</text>` +
          `<text class="solo-region-name solo-region-silname" x="${cx.toFixed(1)}" y="${(cy + 22).toFixed(1)}" text-anchor="middle">trail</text>`;
        if (n.reachable) {
          return `<g class="${scls.join(" ")}" role="button" tabindex="0" data-solo-action="move" data-location-id="${escapeHtml(n.id)}" aria-label="Follow the ${band} essence trail">${sg}</g>`;
        }
        return `<g class="${scls.join(" ")}" aria-label="A ${band} essence trail leads here">${sg}</g>`;
      }
      const glyph = REGION_TYPE_GLYPH[n.type] || "◆";
      const classes = ["solo-region-node", `solo-region-type-${escapeHtml(n.type)}`];
      if (n.isCurrent) classes.push("is-current");
      if (n.reachable) classes.push("is-reachable");
      if (n.hazard) classes.push("is-hazard");
      const goals = goalByLoc[n.id] || [];
      const goalPin = goals.length
        ? `<text class="solo-region-goalpin" x="${(cx + 11).toFixed(1)}" y="${(cy - 9).toFixed(1)}" text-anchor="middle" title="${escapeHtml(goals.map((g) => g.summary).join("; "))}">◎</text>`
        : "";
      const marker = n.isCurrent
        ? `<circle class="solo-region-here" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="14" />`
        : "";
      const frayed = n.unexploredExits > 0
        ? `<text class="solo-region-frayed" x="${(cx - 11).toFixed(1)}" y="${(cy + 12).toFixed(1)}" text-anchor="middle" aria-label="${n.unexploredExits} unexplored">⋯</text>`
        : "";
      const name = `<text class="solo-region-name" x="${cx.toFixed(1)}" y="${(cy + 22).toFixed(1)}" text-anchor="middle">${escapeHtml(n.name)}</text>`;
      const g = `${marker}<text class="solo-region-glyph" x="${cx.toFixed(1)}" y="${(cy + 5).toFixed(1)}" text-anchor="middle">${glyph}</text>${goalPin}${frayed}${name}`;
      // Tap a REACHABLE node = a travel intent through the normal move pipeline
      // (exits-equivalent). Revealed-but-distant nodes are shown, not tappable.
      if (n.reachable) {
        return `<g class="${classes.join(" ")}" role="button" tabindex="0" data-solo-action="move" data-location-id="${escapeHtml(n.id)}" aria-label="Travel to ${escapeHtml(n.name)}">${g}</g>`;
      }
      return `<g class="${classes.join(" ")}" aria-label="${escapeHtml(n.name)}">${g}</g>`;
    })
    .join("");

  return `<div class="solo-region">${head}<svg class="solo-region-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Region map of known locations" preserveAspectRatio="xMidYMid meet">${edgeSvg}${nodeSvg}</svg></div>`;
}

// The zoom toggle (owner ruling: default LOCAL, region behind the toggle).
export function renderSoloMapToggle(mapView = "local") {
  const region = mapView === "region";
  return `<div class="solo-map-toggle" role="group" aria-label="Map zoom">
      <button type="button" class="solo-map-toggle-btn${region ? "" : " active"}" data-solo-map-view="local" aria-pressed="${region ? "false" : "true"}">Local</button>
      <button type="button" class="solo-map-toggle-btn${region ? " active" : ""}" data-solo-map-view="region" aria-pressed="${region ? "true" : "false"}">Region</button>
    </div>`;
}

// The map surface: toggle + the active view. Default local (Part A floor plan);
// region graph (Part B) behind the toggle.
export function renderSoloMapSurface(scene = {}, mapView = "local") {
  const view = mapView === "region" ? "region" : "local";
  const body = view === "region" ? renderSoloRegionMap(scene) : renderSoloPresenceMap(scene);
  return `${renderSoloMapToggle(view)}${body}`;
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
          const role = member.role || "·";
          const entityId = member.entityId || (member.npcId ? `npc:${member.npcId}` : "");
          const portraitUri = typeof member.portraitUri === "string" ? member.portraitUri : "";
          const initial = String(name).trim().slice(0, 1).toUpperCase() || "?";
          const present = member.present !== false;
          const thumb = portraitUri
            ? `<img src="${escapeHtml(portraitUri)}" alt="${escapeHtml(name)}" />`
            : `<span class="solo-cast-thumb-pending" title="Cooking your portrait…">${escapeHtml(initial)}</span>`;
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

  // NO RIGHT COLUMN (owner ruling 2026-07-19): the reading area spans edge to edge.
  // What was the rail is now an on-demand INFO DRAWER (Cast · Exits + the reactive
  // search/talk/entity panels), opened from the stage-HUD toggle. Map + clock float
  // over the banner instead (renderSoloStageHud / renderSoloMapDrawer). Rolls stay
  // in the input dock banner + the roll-history drawer.
  const open = Boolean(state.sceneInfoOpen);
  return `
    <div class="solo-scene-drawer solo-info-drawer${open ? " is-open" : ""}" data-solo-scene-info-panel role="dialog" aria-label="Cast and exits" aria-hidden="${open ? "false" : "true"}">
      ${open ? `<div class="solo-scene-drawer-backdrop" data-solo-scene-info-close aria-hidden="true"></div>` : ""}
      <div class="solo-scene-drawer-panel">
        <div class="solo-scene-drawer-head"><span>Cast · Exits</span><button type="button" class="solo-scene-drawer-close" data-solo-scene-info-close aria-label="Close">×</button></div>
        ${(() => {
          const goals = renderSoloGoals(scene);
          return goals ? `<div class="solo-rail-block solo-rail-goals">${goals}</div>` : "";
        })()}
        <div class="solo-rail-block">
          <div class="solo-stat-kicker">Cast</div>
          <div class="solo-cast-list">${cast}</div>
        </div>
        <div class="solo-rail-block">${renderMovementPanel(scene)}</div>
        <div class="solo-rail-block">${renderSearchResultPanel(state.searchResult, scene.discoveredDetails)}</div>
        <div class="solo-rail-block">${renderTalkResultPanel(state.talkResult)}</div>
        <div class="solo-rail-block">${renderEntityDetailPanel(state.detail)}</div>
      </div>
    </div>
  `;
}

// STAGE HUD (owner ruling 2026-07-19): floating overlays on the scene banner,
// drawer-tier z — a compact MAP widget top-right (local/region toggle intact,
// click to expand into the map drawer), a TIME/WEATHER chip beside it (phase +
// weather glyph from the committed weather law), and a slim Cast · Exits toggle
// that opens the info drawer. Empty-state law: a chip with nothing to show hides
// (the clock is absent on a legacy payload; the info toggle always has exits).
// U6 — PERSISTENT MINI-MAP WIDGET. Always on the scene (LOCAL by default), toggled
// local/regional IN PLACE via the same data-solo-map-view control the HUD carries; the
// full-view drawer stays. Docked bottom-RIGHT (walk-3 re-anchor: off the left column, no
// longer under the top-left portrait dock), vertically clear of the top-right HUD row and
// horizontally clear of the portrait dock (pairwise-overlap net, pre-mortem c). Honest
// to known-map state — the map renderers fog unknown nodes. No map data → nothing docked
// (empty-state law). Hides when any drawer opens (mirrors the HUD row) so it never overlaps.
export function renderSoloMiniMap(scene = {}, state = {}) {
  const region = state.mapView === "region";
  const body = region ? renderSoloRegionMap(scene) : renderSoloPresenceMap(scene);
  if (!body || !String(body).trim()) return "";
  return `
    <aside class="solo-minimap" data-solo-minimap aria-label="${region ? "Region" : "Local"} map (mini)">
      <div class="solo-minimap-body">${body}</div>
    </aside>
  `;
}

export function renderSoloStageHud(scene = {}, state = {}) {
  const clock = renderSoloClock(scene);
  const present = Array.isArray(scene.cast) ? scene.cast.filter((c) => c && c.present !== false).length : 0;
  const region = state.mapView === "region";
  const menuOpen = Boolean(state.menuOpen);
  // OVERLAY ROW (owner 2026-07-19, append): ONE flush-top row of peer chips, anchored
  // top:8/right:8 to mirror the portrait dock's top-left 8px corner. Order
  // [Local|Region toggle] [Map] [time/weather] [Cast·Exits] [⚙ settings gear]. The
  // gear now DOCKS INTO the row as its rightmost element (was a separate box floating
  // above) so there is no orphan gear and no corner where it overlaps a drawer's close
  // ✕ — when any drawer opens the whole row hides (:has rule in styles.css). Uniform
  // 28px chip height across every item (the tighter of the two — the time chip shrinks
  // to it). The clock chip is omitted when absent (empty-state law); order + gaps hold.
  return `
    <div class="solo-stage-hud" data-solo-stage-hud>
      <div class="solo-map-toggle" role="group" aria-label="Map zoom">
        <button type="button" class="solo-map-toggle-btn${region ? "" : " active"}" data-solo-map-view="local" aria-pressed="${region ? "false" : "true"}">Local</button>
        <button type="button" class="solo-map-toggle-btn${region ? " active" : ""}" data-solo-map-view="region" aria-pressed="${region ? "true" : "false"}">Region</button>
      </div>
      <button type="button" class="solo-hud-map-open" data-solo-scene-map aria-haspopup="dialog" aria-label="Open map" title="Open map">⤢ Map</button>
      ${clock ? `<div class="solo-hud-time">${clock}</div>` : ""}
      <button type="button" class="solo-hud-info" data-solo-scene-info aria-haspopup="dialog" aria-label="Cast and exits" title="Cast · Exits">☰ Cast${present ? ` ${present}` : ""} · Exits</button>
      <div class="solo-settings${menuOpen ? " open" : ""}">
        <button type="button" class="solo-settings-btn" data-solo-menu-toggle aria-haspopup="true" aria-expanded="${menuOpen ? "true" : "false"}" aria-label="Menu" title="Menu">⚙</button>
        ${menuOpen ? `
          <div class="solo-settings-menu solo-cog-menu" role="menu">
            ${state.isGuest ? `<button type="button" class="solo-cog-item" data-solo-guest-save role="menuitem">Save your adventure</button>` : ""}
            <button type="button" class="solo-cog-item" data-solo-exit role="menuitem">Leave Adventure</button>
          </div>
        ` : ""}
      </div>
    </div>`;
}

// THE VN BATTLE SURFACE (D.4 item 8). During a fight, overlays the pinned stage: a
// FORECAST RAIL of order chips (turn order, never ticks), enemy CARD(s) with the
// telegraphed intent + a wound-band bar + status chips + the essence-sight read + the
// enemy fullbody (empty-state silhouette while the art cooks — never blocks the turn).
// The player side stays the existing top-left portrait dock (with its status chips).
// Full-bleed + overlay idiom; empty when there is no live fight (no dead box).
export function renderSoloBattleSurface(scene = {}) {
  const combat = scene.combat;
  if (!combat || combat.status !== "active") return "";
  const forecast = Array.isArray(combat.forecast) ? combat.forecast : [];
  const enemies = Array.isArray(combat.enemies) ? combat.enemies : [];

  const rail = forecast.length
    ? `<div class="solo-battle-forecast" role="list" aria-label="Turn order">
        ${forecast.map((s, i) => `<span class="solo-battle-slot${i === 0 ? " is-next" : ""}${s.isPlayer ? " is-you" : ""}" role="listitem" title="${escapeHtml(s.displayName || (s.isPlayer ? "You" : "Enemy"))}">${escapeHtml(s.isPlayer ? "You" : (s.displayName || "?").split(/\s+/).slice(-1)[0])}</span>`).join('<span class="solo-battle-arrow" aria-hidden="true">›</span>')}
      </div>`
    : "";

  const cards = enemies.map((e) => {
    const band = e.hpBand || "steady";
    const bandPct = band === "down" ? 0 : band === "bloodied" ? 33 : 100;
    const intent = e.intent && e.intent.telegraph ? e.intent.telegraph : (e.intent && e.intent.hidden ? "coils, unreadable" : null);
    const reads = Array.isArray(e.reads) ? e.reads : [];
    const bodyUri = typeof e.bodyUri === "string" && e.bodyUri.trim() ? e.bodyUri.trim() : null;
    const initial = String(e.name || "?").trim().slice(0, 1).toUpperCase() || "?";
    const art = bodyUri
      ? `<img class="solo-battle-enemy-img" data-portrait-key="${escapeHtml(bodyUri)}" src="${escapeHtml(bodyUri)}" alt="${escapeHtml(e.name || "Enemy")}" />`
      : `<div class="solo-battle-enemy-pending" title="Reading its shape…"><span aria-hidden="true">${escapeHtml(initial)}</span></div>`;
    return `
      <div class="solo-battle-enemy-card" data-combatant-id="${escapeHtml(e.id || "")}">
        <div class="solo-battle-enemy-art">${art}${bodyUri ? renderArtThumb(bodyUri, "fullbody", "br") : ""}</div>
        <div class="solo-battle-enemy-meta">
          <div class="solo-battle-enemy-name" data-textfit>${escapeHtml(e.name || "Enemy")}</div>
          <div class="solo-battle-hpband solo-battle-hpband--${band}" role="img" aria-label="${escapeHtml(band)}"><span style="width:${bandPct}%"></span></div>
          ${intent ? `<div class="solo-battle-intent" title="${escapeHtml(intent)}">${escapeHtml(intent)}</div>` : ""}
          ${reads.length ? `<div class="solo-battle-read">You read: ${escapeHtml(reads.join("; "))}</div>` : ""}
          <div class="solo-battle-enemy-conds">${renderSoloConditionsHud({ conditions: Array.isArray(e.conditions) ? e.conditions : [] }, { compact: true })}</div>
        </div>
      </div>`;
  }).join("");

  return `
    <div class="solo-battle" data-solo-battle>
      ${rail}
      <div class="solo-battle-enemies">${cards}</div>
    </div>`;
}

// The MAP DRAWER — the full region/local map, opened from the HUD map widget.
export function renderSoloMapDrawer(scene = {}, state = {}) {
  const mapOpen = Boolean(state.sceneMapOpen);
  return `
    <div class="solo-scene-drawer solo-map-drawer${mapOpen ? " is-open" : ""}" data-solo-scene-map-panel role="dialog" aria-label="Map" aria-hidden="${mapOpen ? "false" : "true"}">
      ${mapOpen ? `<div class="solo-scene-drawer-backdrop" data-solo-scene-map-close aria-hidden="true"></div>` : ""}
      <div class="solo-scene-drawer-panel">
        <div class="solo-scene-drawer-head"><span>Map</span><button type="button" class="solo-scene-drawer-close" data-solo-scene-map-close aria-label="Close map">×</button></div>
        ${renderSoloMapSurface(scene, state.mapView)}
      </div>
    </div>`;
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
// VISIBLE CONSEQUENCE (vn-dialogue-hardening, law 3): a one-line diegetic cue
// derived from the COMMITTED disposition delta the server returned for this turn
// (attemptResult.dispositionChange — meter, delta, suspicionDelta, targetName).
// Pure text mapping over committed data; the narrator never writes this line.
// Returns "" when the change carries no name or no visible movement.
const DISPOSITION_CUE_PHRASES = Object.freeze({
  trust: ["seems to trust you a little more", "seems to trust you less"],
  affection: ["seems to warm to you", "seems cooler toward you"],
  fear: ["seems warier of you", "seems less afraid of you"],
  suspicion: ["eyes you with fresh suspicion", "seems to relax their guard"],
  debt: ["seems to feel they owe you", "seems to feel the debt is settled"],
  loyalty: ["seems firmer at your side", "seems less bound to you"],
  rivalry: ["seems to bristle at you", "seems less set against you"]
});
// Display order of the server's ROMANCE_TIERS (reputation.js) — used ONLY to pick
// the promotion-vs-demotion phrasing direction; the tier VALUES themselves are
// server truth carried on the commit payload, never recomputed here.
const ROMANCE_TIER_ORDER = ["stranger", "friendly", "close", "courting", "partner"];

export function dispositionCueText(change) {
  if (!change || typeof change !== "object") {
    return "";
  }
  const name = typeof change.targetName === "string" && change.targetName.trim() ? change.targetName.trim() : "";
  if (!name) {
    return "";
  }
  // ROMANCE TIER CROSSING (vn tier-cue): when this turn's commit moved the
  // committed romanceTier across a threshold, the crossing cue SUPERSEDES the
  // generic warmth line for the turn. Generic two-line vocabulary (SFW,
  // neutral-warm) — per-tier phrasing is spec-pending, owner rules later.
  const tierBefore = typeof change.romanceTierBefore === "string" ? change.romanceTierBefore : null;
  const tierAfter = typeof change.romanceTier === "string" ? change.romanceTier : null;
  if (tierBefore && tierAfter && tierBefore !== tierAfter) {
    const up = ROMANCE_TIER_ORDER.indexOf(tierAfter) > ROMANCE_TIER_ORDER.indexOf(tierBefore);
    // TWO-TRACK cue register (R1): friendship tiers (stranger/friendly/close) are
    // PLATONIC always — no romance-coded language below the switch. Only courting/
    // partner (reachable past the switch + gate) get the romantic register.
    const PLATONIC = tierAfter === "stranger" || tierAfter === "friendly" || tierAfter === "close";
    if (!PLATONIC) {
      return up
        ? `Something has deepened between you and ${name}.`
        : `Something has cooled between you and ${name}.`;
    }
    if (up) {
      return tierAfter === "close"
        ? `${name} counts you a real friend now.`
        : `${name} is warming to you.`;
    }
    return `${name} feels more distant.`;
  }
  const meter = typeof change.meter === "string" ? change.meter : "";
  const delta = Number(change.delta) || 0;
  const suspicionDelta = Number(change.suspicionDelta) || 0;
  const phrases = DISPOSITION_CUE_PHRASES[meter];
  if (phrases && delta !== 0) {
    return `${name} ${delta > 0 ? phrases[0] : phrases[1]}.`;
  }
  // No primary movement but suspicion rose (the at-cost / failure shapes).
  if (suspicionDelta > 0) {
    return `${name} ${DISPOSITION_CUE_PHRASES.suspicion[0]}.`;
  }
  return "";
}

export function renderSoloDialogueOverlay(state = {}) {
  if (!state.dialogueActive || !state.talkResult) {
    return "";
  }
  const talk = state.talkResult;
  const scene = state.scene || {};
  const expression = typeof talk.expression === "string" && talk.expression ? talk.expression : "neutral";
  const variants = talk.expressionVariants && typeof talk.expressionVariants === "object" ? talk.expressionVariants : {};
  // SPRITE IDENTITY IS COMMITTED-STATE-DRIVEN (vn-live law A.2): while the server
  // says VN is active, the sprite belongs to scene.speakerId — the COMMITTED
  // active speaker (run.vn.speakerId) — never a stale client-side talk target.
  // Outside VN mode (manual Talk overlay before the scene refresh) talk.npcId is
  // itself the server's resolved talk target, so it remains the fallback.
  const committedSpeakerId =
    scene.vnMode === true && typeof scene.speakerId === "string" && scene.speakerId.trim()
      ? bareNpcId(scene.speakerId)
      : null;
  const spriteNpcId = committedSpeakerId || talk.npcId;
  // Fallback chain: requested expression variant -> the NPC's base portrait
  // (from the cast roster) -> atmospheric placeholder. Never a broken image.
  const castMember = (Array.isArray(scene.cast) ? scene.cast : []).find(
    (member) => member && bareNpcId(member.npcId) === String(spriteNpcId || "")
  ) || null;
  const baseUri = castMember && typeof castMember.portraitUri === "string" ? castMember.portraitUri : "";
  const variantUri = typeof variants[expression] === "string" && variants[expression] ? variants[expression] : "";
  const portraitUri = variantUri || baseUri;
  const speaker = talk.speakerName || "NPC";
  // VN QUOTE SPLIT (owner rule 3): the addressed speaker's quotes ARE the VN line.
  // When this turn carried none (the whole beat went to the log), the VN shows
  // NOTHING NEW — an empty text area with the reply prompt still live — rather
  // than fabricating a "nothing to say" line the NPC never spoke.
  const line = typeof talk.line === "string" ? talk.line : "";
  const typed = state.dialogueTyped === true;
  // VN SPRITE SOURCE: prefer the committed full-body sprite (scene.vnBodyUri — the
  // 832x1216 2:3 fullbody keyed to this speaker, null until the art pipeline mints
  // it). Fall back to the bust portrait (also 2:3, so object-fit:contain fits
  // either). When BOTH are absent — the case today for every NPC — the slot renders
  // NOTHING (no glyph, no placeholder): an empty sprite surface shows nothing.
  const spriteUri = (typeof scene.vnBodyUri === "string" && scene.vnBodyUri.trim())
    ? scene.vnBodyUri.trim()
    : portraitUri;
  // The reply TEXT INPUT is intentionally never disabled — the player must always
  // be able to type. The global busy flag is held by the outer action that opens
  // this overlay (the freeform "speak to X" attempt), so gating the input on it
  // made the box paint dead on arrival. Only the submit BUTTON reflects busy (for
  // feedback); double-submit is prevented by runAction's re-entry guard, and busy
  // always clears in runAction's finally (even on a hung call, via the client
  // request timeout) so submit can never wedge permanently.
  const busy = Boolean(state.busy);
  const replyDraft = typeof state.dialogueReplyDraft === "string" ? state.dialogueReplyDraft : "";
  // VISIBLE CONSEQUENCE (law 3): the committed-delta cue for THIS speaker, set by
  // the submit path from attemptResult.dispositionChange and cleared with the
  // other per-turn results. Never rendered for a different NPC than the sprite.
  const cue =
    state.dispositionCue &&
    typeof state.dispositionCue.text === "string" &&
    state.dispositionCue.text &&
    String(state.dispositionCue.npcId || "") === String(spriteNpcId || "")
      ? state.dispositionCue.text
      : "";

  // The sprite surface renders ONLY when there is an image. Empty state = the whole
  // container is omitted (truly nothing on screen), not an empty box. The
  // data-solo-vn-sprite hook lets bindSoloSceneShell fade the sprite in on load and
  // fall back to the empty state on a failed load (never a broken-image icon).
  const spriteBlock = spriteUri
    ? `<div class="solo-vn-sprite" data-portrait-key="${escapeHtml(spriteUri)}"><img class="solo-vn-sprite-img solo-vn-sprite-breathe" data-solo-vn-sprite src="${escapeHtml(spriteUri)}" alt="${escapeHtml(speaker)}" aria-hidden="true" />${renderArtThumb(spriteUri, "fullbody", "br")}</div>`
    : "";

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
    ${spriteBlock}
    <div class="solo-vn-box" data-solo-dialogue-panel role="group" aria-label="Dialogue with ${escapeHtml(speaker)}">
      <div class="solo-vn-box-head">
        <span class="solo-vn-box-speaker" data-textfit>${escapeHtml(speaker)}</span>
        <div class="solo-vn-box-head-actions">
          ${/* JOB 3: VN dialogue sizer — lives IN the VN box (only present during a beat),
               NOT in the top-right chrome. Independent of the narration A−/A+. */""}
          <span class="solo-vn-sizer" role="group" aria-label="Dialogue text size">
            <button type="button" class="solo-fontsize-btn" data-solo-vnfont="down" title="Smaller dialogue text" aria-label="Smaller dialogue text">A−</button>
            <button type="button" class="solo-fontsize-btn" data-solo-vnfont="up" title="Larger dialogue text" aria-label="Larger dialogue text">A+</button>
          </span>
          <button type="button" class="solo-vn-box-end" data-solo-dialogue-end aria-label="End conversation" title="End conversation">End ✕</button>
        </div>
      </div>
      <div
        class="solo-vn-box-text ${typed ? "is-complete" : ""}"
        data-solo-dialogue-text
        data-typed="${typed ? "true" : "false"}"
        data-fulltext="${escapeHtml(line)}"
      >${typed ? escapeHtml(line) : ""}</div>
      ${cue ? `<div class="solo-vn-cue" data-solo-vn-cue role="status">${escapeHtml(cue)}</div>` : ""}
      <div class="solo-vn-box-reply">
        <input
          type="text"
          class="solo-vn-box-reply-input"
          data-solo-dialogue-reply-input
          placeholder="Say something, or describe what you do…"
          value="${escapeHtml(replyDraft)}"
        />
        <button type="button" class="solo-vn-box-reply-submit" data-solo-dialogue-reply-submit ${busy ? "disabled" : ""}>${busy ? "…" : "Reply ›"}</button>
      </div>
    </div>
  `;
}

// Wire a VN sprite <img> (data-solo-vn-sprite): fade it in once it loads, and on a
// FAILED load remove it so the slot degrades to the empty state — never a broken-
// image icon. Idempotent per element (guarded by a flag). Exported for the binding
// and directly unit-testable with a minimal mock element.
export function wireVnSpriteImage(img) {
  if (!img || typeof img.addEventListener !== "function" || img.dataset?.vnWired === "1") {
    return;
  }
  if (img.dataset) img.dataset.vnWired = "1";
  const reveal = () => {
    if (img.classList && typeof img.classList.add === "function") img.classList.add("is-loaded");
  };
  img.addEventListener("load", reveal);
  img.addEventListener("error", () => {
    // Failed load → empty state: drop the whole sprite container (no broken icon).
    const host = typeof img.closest === "function" ? img.closest(".solo-vn-sprite") : null;
    if (host && typeof host.remove === "function") host.remove();
    else if (typeof img.remove === "function") img.remove();
  });
  // A cached image may already be complete before listeners attach — reveal now.
  if (img.complete && (img.naturalWidth === undefined || img.naturalWidth > 0)) reveal();
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
          <input type="text" class="solo-npc-input" data-solo-npc-name placeholder="Name (optional, the GM can name them)" value="${escapeHtml(creator.name || "")}" />
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
    return "·";
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

// C4 — PER-WORLD DEATH LAW epilogue. The game-over screen closes with the world's own
// death-law (Babel: the soul-law, v1-thin — the coma an ocean away is not death). Keyed on
// the run's scenario; a generic close for a worldgen/custom run. Death is TERMINAL (the
// run is already marked unresumable server-side — this is the epilogue, not the gate).
export const DEATH_LAW_EPILOGUE = Object.freeze({
  babel: "The Green Static releases its hold. An ocean away, a coma that was never death stirs, and the Tower keeps its hundred floors. It will call another."
});
export function deathEpilogue(state = {}, summary = {}) {
  // Prefer the AUTHORED per-world epilogue served on the scene payload
  // (world.deathLaw.epilogue — steel/furniture: the slot is now data, not a hardcoded
  // dict). The dict below stays a resume-safety fallback for a payload that predates
  // the slot; the generic close is the final floor.
  const authored = state.scene?.world?.deathLaw?.epilogue;
  if (typeof authored === "string" && authored.trim()) return authored;
  const world = String(
    summary.scenarioId || state.scene?.world?.variant || state.scene?.scenarioId || state.worldDef?.scenarioId || ""
  ).toLowerCase();
  return DEATH_LAW_EPILOGUE[world] || "The world closes over the place where you fell, and goes on without you.";
}

export function renderSoloSceneShell(state = {}) {
  _betaThumb = !!(state && state.scene && state.scene.betaThumb);
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
          <p class="solo-death-epilogue">${escapeHtml(deathEpilogue(state, summary))}</p>
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
  // JOB 3: VN dialogue multiplier, stamped alongside --solo-log-scale so the VN box
  // sizes independently of the narration log.
  const vnScale = normalizeLogScale(state.vnScale);

  return `
    <section
      class="solo-scene-shell solo-scene-shell-polished solo-game-shell${state.busy ? " is-busy" : ""}"
      data-run-id="${escapeHtml(scene.runId || state.runId || "")}"
      data-solo-busy="${state.busy ? "true" : ""}"
      data-solo-skin="${skin}"
      data-solo-font="${fontSet}"
      style="${soloThemeVarString(skin, fontSet)};--solo-log-scale:${logScale};--solo-vn-scale:${vnScale};"
    >
      ${/* settings gear moved INTO the stage-HUD overlay row (owner 2026-07-19 append):
           it is now that row's rightmost chip, not a separate box floating above. */""}
      ${
        state.isGuest
          ? `<div class="solo-guest-banner">
              <span>Playing as guest. Your progress lives in this browser until you save it.</span>
              <button type="button" class="solo-guest-banner-save" data-solo-guest-save>Save your adventure</button>
            </div>`
          : ""
      }
      <div class="solo-game-layout">
      <div class="solo-game-frame solo-scene-grid">
        ${renderSoloCharacterSidebar(character, { open: state.characterTabOpen, scene })}
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
                  ${renderSoloSceneArt(scene.locationImageUri, { locked: scene.locationImageLocked, status: scene.locationImageStatus })}
                  <!-- Floating HUD: portrait dock (top-left, in the frame), MAP
                       widget + TIME/WEATHER chip + Cast·Exits toggle (top-right). -->
                  <div data-solo-stage-hud-slot>${renderSoloStageHud(scene, state)}</div>
                  <div data-solo-minimap-slot>${renderSoloMiniMap(scene, state)}</div>
                  <div data-solo-battle-slot>${renderSoloBattleSurface(scene)}</div>
                  <div data-solo-outcome>${renderSoloActionOutcome(state)}</div>
                  ${renderSoloDialogueOverlay(state)}
                </div>
                <!-- ZONE 2 — SCROLLABLE NARRATION LOG -->
                <div class="solo-narration-log" data-solo-log>
                  ${
                    (typeof scene.openingNarration === "string" && scene.openingNarration.trim()) || (Array.isArray(scene.openingBeats) && scene.openingBeats.length)
                      // WALK-3 V4: when the opening commits a VN speaker (the VOICE), her SPOKEN
                      // beats render in the real VN box (loadScene routes them), so this log gets
                      // ONLY the narration beats with speaker=null — never her words as prose.
                      ? (scene.vnMode === true && scene.openingSpeaker
                          ? renderSoloSceneOpening(scene.openingNarration, splitOpeningBeats(scene.openingBeats, scene.openingBeatsSpeakerFrom).narration, null)
                          : renderSoloSceneOpening(scene.openingNarration, scene.openingBeats, scene.openingSpeaker))
                      : Array.isArray(state.narrationLog) && state.narrationLog.length
                        ? renderNarrationLog(state.narrationLog)
                        : renderLocationPanel(location, scene.gmNarration, scene.gmStatus, selectedGmMode, debug, {})
                  }
                </div>
                <!-- ZONE 3 — INPUT DOCK -->
                <div class="solo-input-dock">
                  <!-- ROLL BANNER (ui restructure): the latest roll surfaces here
                       as one compact line; the magnifier opens the roll-history
                       drawer. Conditions moved ONTO the portrait (buffs/debuffs
                       law), so the old conditions bar above the input is gone. -->
                  <div data-solo-roll-banner>${renderSoloRollBanner(scene)}</div>
                  <div data-solo-dock-status>${renderSoloThinkingIndicator(state)}</div>
                  <div data-solo-turn-lifecycle>${renderSoloTurnLifecycle(state)}</div>
                  <!-- COMMITTED AFFORDANCES (affordances-map-law Part A): a quiet
                       chip row directly ABOVE the input; suggest, never limit —
                       the text box stays primary. A tap submits the intent through
                       the normal turn path; gated chips show a reason, never submit. -->
                  <div data-solo-affordances>${renderSoloAffordances(state)}</div>
                  ${renderSoloSceneInputBar(state)}
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
      </div>
      <!-- NO RIGHT COLUMN (owner ruling 2026-07-19): the rail is gone; its content
           is the on-demand INFO DRAWER + the floating MAP DRAWER, opened from the
           stage HUD. The VN dialogue layer lives in the pinned stage (above). -->
      ${renderSoloRightRail(state)}
      ${renderSoloMapDrawer(scene, state)}
      ${renderSoloRollHistory(scene, state.rollHistoryOpen)}
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
  if ((el = closest("[data-solo-vnfont]"))) { handlers.onVnFontScale?.({ dir: el.getAttribute("data-solo-vnfont") }); return true; }
  if ((el = closest("[data-solo-textspeed]"))) { handlers.onTextSpeed?.(); return true; }
  if ((el = closest("[data-solo-dialogue-end]"))) { handlers.onDialogueEnd?.(); return true; }
  if ((el = closest("[data-solo-dialogue-reply-submit]"))) { handlers.onDialogueReply?.(); return true; }
  if ((el = closest("[data-solo-dialogue-close]"))) { handlers.onDialogueClose?.(); return true; }
  if ((el = closest("[data-scene-redo]"))) { handlers.onSceneRedo?.(); return true; }
  if ((el = closest("[data-scene-save]"))) { handlers.onSceneSave?.(); return true; }
  // BETA THUMB: a reason chip (down-detail) is checked before the up/down button so a
  // tap on a chip does not re-fire the vote. Both read the asset off the wrapper.
  if ((el = closest("[data-art-reason]"))) {
    const box = el.closest("[data-art-thumb]");
    if (box) handlers.onArtReason?.({ uri: box.getAttribute("data-art-uri"), kind: box.getAttribute("data-art-kind"), reason: el.getAttribute("data-art-reason"), chipEl: el, boxEl: box });
    return true;
  }
  if ((el = closest("[data-art-vote]"))) {
    const box = el.closest("[data-art-thumb]");
    if (box) handlers.onArtThumb?.({ uri: box.getAttribute("data-art-uri"), kind: box.getAttribute("data-art-kind"), vote: el.getAttribute("data-art-vote"), boxEl: box });
    return true;
  }
  if ((el = closest("[data-solo-npc-close]"))) { handlers.onNpcClose?.(); return true; }
  if ((el = closest("[data-solo-npc-submit]"))) { handlers.onNpcSubmit?.(); return true; }
  if ((el = closest("[data-solo-action='reload-scene']"))) { handlers.onReload?.(); return true; }
  if ((el = closest("[data-solo-turn-retry]"))) { handlers.onTurnRetry?.(); return true; }
  if ((el = closest("[data-solo-turn-discard]"))) { handlers.onTurnDiscard?.(); return true; }
  if ((el = closest("[data-solo-map-view]"))) { handlers.onMapView?.({ view: el.getAttribute("data-solo-map-view") }); return true; }
  // Stage-HUD drawers (owner ruling 2026-07-19): map widget → map drawer;
  // Cast·Exits toggle → info drawer. Close routes checked before the open toggles.
  if ((el = closest("[data-solo-scene-map-close]"))) { handlers.onSceneMapClose?.(); return true; }
  if ((el = closest("[data-solo-scene-map]"))) { handlers.onSceneMap?.(); return true; }
  if ((el = closest("[data-solo-scene-info-close]"))) { handlers.onSceneInfoClose?.(); return true; }
  if ((el = closest("[data-solo-scene-info]"))) { handlers.onSceneInfo?.(); return true; }
  if ((el = closest("[data-solo-banner-dismiss]"))) { handlers.onDismissBanner?.(); return true; }
  // T1: the header brand is a home link IN-RUN too — always confirm (an unsent turn
  // must never be silently abandoned). Checked before other chrome.
  if ((el = closest("[data-action='go-home']"))) { handlers.onGoHome?.(); return true; }
  if ((el = closest("[data-solo-home]"))) { handlers.onReturnHome?.(); return true; }
  if ((el = closest("[data-solo-exit]"))) { handlers.onExit?.(); return true; }
  if ((el = closest("[data-solo-guest-save]"))) { handlers.onGuestSave?.(); return true; }
  if ((el = closest("[data-solo-menu-toggle]"))) { handlers.onMenuToggle?.(); return true; }
  if ((el = closest("[data-solo-char-tab-close]"))) { handlers.onCharTabClose?.(); return true; }
  if ((el = closest("[data-solo-char-tab]"))) { handlers.onCharTab?.(); return true; }
  if ((el = closest("[data-solo-roll-history-close]"))) { handlers.onRollHistoryClose?.(); return true; }
  if ((el = closest("[data-solo-roll-history]"))) { handlers.onRollHistory?.(); return true; }
  // COMMITTED AFFORDANCES: an OK chip submits its pre-typed intent through the
  // SAME turn path as typing (onAttempt); a gated chip surfaces its reason and
  // never submits; "more" toggles the overflow. Delegated on the stable root so
  // fast-path-patched chips stay live. Gated is matched BEFORE the OK chip.
  if ((el = closest("[data-solo-affordances-more]"))) { handlers.onAffordancesMore?.(); return true; }
  if ((el = closest("[data-solo-affordance-gated]"))) { handlers.onAffordanceGate?.({ reason: el.getAttribute("data-solo-affordance-gated") || "" }); return true; }
  if ((el = closest("[data-solo-affordance]"))) {
    const intent = String(el.getAttribute("data-solo-affordance") || "").trim();
    if (intent) { handlers.onAttempt?.({ intent }); }
    return true;
  }
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
  // Per-character reveal rate — player-tunable (vn-dialogue-hardening, table
  // stakes): reads the persisted text-speed setting each bind, so a changed
  // setting applies from the very next line. 0 (instant) skips the reveal.
  const vnCharMs = () => VN_TEXT_SPEEDS[normalizeTextSpeed(readSoloThemePref(SOLO_TEXT_SPEED_STORAGE_KEY, "normal"))];
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
    const charMs = vnCharMs();
    if (!alreadyTyped && fullText && charMs <= 0) {
      // Instant: no reveal loop at all — the full line lands immediately.
      finish();
    } else if (!alreadyTyped && fullText) {
      el.textContent = "";
      const t0 = Date.now();
      const step = () => {
        if (done) return;
        const chars = Math.min(fullText.length, Math.floor((Date.now() - t0) / charMs) + 1);
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
        fallbackTimer = setInterval(step, charMs);
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
  // VN sprite: fade in on load; a failed load degrades to the empty state.
  root.querySelectorAll("[data-solo-vn-sprite]").forEach(wireVnSpriteImage);
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
// JOB 3: the VN dialogue box carries its OWN size multiplier, independent of the
// narration log's --solo-log-scale. Same range/step/heal as the narration sizer
// (normalizeLogScale is reused), persisted the same way (writeSoloThemePref).
export const SOLO_VN_SCALE_STORAGE_KEY = "notdnd.solo.vnScale";
export const SOLO_TEXT_SPEED_STORAGE_KEY = "notdnd.solo.textSpeed";
// DRAFT SURVIVAL (input integrity): the composer draft is persisted per-run so a
// page refresh / disconnect never eats typed-but-unsent text. Namespaced like the
// other solo prefs; follows the textSpeed read/write pattern (readSoloThemePref /
// writeSoloThemePref), no new dependency.
export const SOLO_COMPOSER_DRAFT_STORAGE_KEY_PREFIX = "notdnd.solo.draft.";
export function soloComposerDraftKey(runId) {
  return `${SOLO_COMPOSER_DRAFT_STORAGE_KEY_PREFIX}${String(runId || "")}`;
}

// A client-stamped turn id for input integrity. Unique per logical turn; a resync
// RESUBMIT reuses the same id so the server replays it idempotently (no re-roll,
// no double-commit). crypto.randomUUID when available; a time+counter fallback
// otherwise (uniqueness only needs to hold within a run's resync window).
let soloTurnIdCounter = 0;
export function newSoloTurnId(runId) {
  soloTurnIdCounter += 1;
  let rnd;
  try {
    rnd = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  } catch {
    rnd = Math.random().toString(36).slice(2, 10);
  }
  const t = typeof Date !== "undefined" ? Date.now() : 0;
  return `turn_${String(runId || "r").slice(0, 12)}_${t}_${soloTurnIdCounter}_${rnd}`;
}

// The "first six words…" label the failed-turn surface shows, so a stranger sees
// exactly which of their actions is at risk. Bounded + ellipsized.
export function firstWordsLabel(text, n = 6) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "";
  }
  const head = words.slice(0, n).join(" ");
  return words.length > n ? `${head}…` : head;
}

// Elapsed-seconds phrasing for the stall indicator ("Still working — 18s"). Past
// the lag threshold a slow turn reads as ALIVE, not dead.
export function stallElapsedLabel(startedAtMs, nowMs) {
  const started = Number(startedAtMs);
  const now = Number(nowMs);
  if (!Number.isFinite(started) || !Number.isFinite(now) || now < started) {
    return "";
  }
  return `${Math.floor((now - started) / 1000)}s`;
}

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

// JOB 3: the VN dialogue sizer's self-healing read — mirrors readHealedLogScale
// exactly (same clamp/heal), keyed to the independent VN multiplier so a stale
// value can never wedge the VN sizer across reloads.
export function readHealedVnScale(storage) {
  const store = storage !== undefined ? storage : (typeof localStorage !== "undefined" ? localStorage : null);
  let raw = null;
  try {
    raw = store ? store.getItem(SOLO_VN_SCALE_STORAGE_KEY) : null;
  } catch {
    raw = null;
  }
  const value = normalizeLogScale(raw == null ? 1 : raw);
  if (raw != null && String(value) !== String(raw).trim()) {
    try {
      store?.setItem(SOLO_VN_SCALE_STORAGE_KEY, String(value));
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
    // DRAFT SURVIVAL: restore any composer text persisted for this run (page
    // refresh / disconnect must never eat typed-but-unsent input).
    attemptDraft: readSoloThemePref(soloComposerDraftKey(runId), ""),
    // INPUT INTEGRITY — turn lifecycle. `pendingTurn` is the single in-flight (or
    // failed) typed turn: { turnId, text, mode, status: "processing"|"failed",
    // startedAt }. `queuedTurn` is the one-deep queue for a turn typed while another
    // is processing: { text, mode }. Both null when idle.
    pendingTurn: null,
    queuedTurn: null,
    busy: null,
    // Map zoom (affordances-map-law Part B): default LOCAL floor plan; the region
    // graph is behind the toggle. In-memory per session (owner ruling).
    mapView: "local",
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
    // UI restructure: the character-sheet tab (opened from the portrait badge)
    // and the roll-history drawer (opened from the roll banner's magnifier).
    characterTabOpen: false,
    rollHistoryOpen: false,
    // Affordance chip row (affordances-map-law Part A): overflow toggle + the
    // transient in-fiction reason shown when a gated chip is tapped.
    affordancesExpanded: false,
    affordanceGateNote: "",
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
    // JOB 3: persisted VN dialogue text-size multiplier — INDEPENDENT of logScale.
    vnScale: readHealedVnScale(),
    // VN text speed (table stakes): persisted reveal rate for the typewriter.
    textSpeed: normalizeTextSpeed(readSoloThemePref(SOLO_TEXT_SPEED_STORAGE_KEY, "normal")),
    // VISIBLE CONSEQUENCE (law 3): { npcId, text } derived from THIS turn's
    // committed dispositionChange; cleared with the other per-turn results.
    dispositionCue: null,
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
        // The drawer toggles (character tab / roll history) are full-render
        // triggers so opening/closing them repaints, never a stage fast-path.
        charTab: Boolean(state.characterTabOpen),
        rollHist: Boolean(state.rollHistoryOpen),
        sidebar: renderSoloCharacterSidebar(character, { open: state.characterTabOpen, scene }),
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

    // INPUT INTEGRITY: keep the failed-turn/queued surface current on the fast path
    // (a settled/failed turn must show its recovery affordance without a full render).
    const lifecycleEl = root.querySelector("[data-solo-turn-lifecycle]");
    if (lifecycleEl && "innerHTML" in lifecycleEl) {
      lifecycleEl.innerHTML = renderSoloTurnLifecycle(state);
    }

    // CONDITIONS chips (now overlaid ON the portrait, ui restructure): appear on
    // commit and vanish on shed via BOTH render paths (one policy — the scroll-fix
    // precedent). Compact form to match the portrait-edge overlay. Tolerates
    // absence in the lightweight test mocks.
    const conditionsEl = root.querySelector("[data-solo-conditions]");
    if (conditionsEl && "innerHTML" in conditionsEl) {
      conditionsEl.innerHTML = renderSoloConditionsHud(state.scene || {}, { compact: true });
    }
    // ESSENCE-SIGHT chips in the STATUS WINDOW: the sight readout shifts with the
    // committed traces at the scene (a followed trail, a fresh spawn), so repaint
    // it in place on the fast path too. Tolerates absence in lightweight mocks.
    const sightEl = root.querySelector("[data-solo-sight]");
    if (sightEl && "innerHTML" in sightEl) {
      sightEl.innerHTML = renderSoloSightBlockInner(state.scene || {});
    }
    // ROLL BANNER: the latest roll updates in place on the fast path too.
    const rollBannerEl = root.querySelector("[data-solo-roll-banner]");
    if (rollBannerEl && "innerHTML" in rollBannerEl) {
      rollBannerEl.innerHTML = renderSoloRollBanner(state.scene || {});
    }
    // AFFORDANCES: re-derive the chip row in place — committed state (present
    // cast, exits, goals, objects) shifts every turn, so a within-location turn
    // must repaint the chips. Taps are delegated on the stable root, so patching
    // innerHTML never orphans a handler.
    const affordEl = root.querySelector("[data-solo-affordances]");
    if (affordEl && "innerHTML" in affordEl) {
      affordEl.innerHTML = renderSoloAffordances(state);
    }

    // No right rail (owner ruling 2026-07-19). The stage HUD (map widget + time/
    // weather chip + Cast·Exits count) and the on-demand INFO/MAP drawers carry what
    // the rail did; all change per turn (weather/time/exits/cast/search/talk), so
    // repaint them in place. Handlers are delegated on the stable root — no rebind.
    const hudEl = typeof root.querySelector === "function" ? root.querySelector("[data-solo-stage-hud-slot]") : null;
    if (hudEl && "innerHTML" in hudEl) {
      hudEl.innerHTML = renderSoloStageHud(state.scene || {}, state);
    }
    // U6 — repaint the persistent mini-map in place (known nodes/present-location shift
    // every move; the local/region toggle also re-enters here). Delegated taps on the
    // stable root, so an innerHTML patch never orphans a handler.
    const miniMapEl = typeof root.querySelector === "function" ? root.querySelector("[data-solo-minimap-slot]") : null;
    if (miniMapEl && "innerHTML" in miniMapEl) {
      miniMapEl.innerHTML = renderSoloMiniMap(state.scene || {}, state);
    }
    // The VN battle surface repaints per turn (forecast/intent/HP-band/status shift
    // every turn); handlers are delegated on the stable root, so innerHTML is safe.
    const battleEl = typeof root.querySelector === "function" ? root.querySelector("[data-solo-battle-slot]") : null;
    if (battleEl && "innerHTML" in battleEl) {
      battleEl.innerHTML = renderSoloBattleSurface(state.scene || {});
    }
    const infoEl = typeof root.querySelector === "function" ? root.querySelector("[data-solo-scene-info-panel]") : null;
    if (infoEl && typeof infoEl === "object" && "outerHTML" in infoEl) {
      infoEl.outerHTML = renderSoloRightRail(state);
    }
    const mapDrawerEl = typeof root.querySelector === "function" ? root.querySelector("[data-solo-scene-map-panel]") : null;
    if (mapDrawerEl && typeof mapDrawerEl === "object" && "outerHTML" in mapDrawerEl) {
      mapDrawerEl.outerHTML = renderSoloMapDrawer(state.scene || {}, state);
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
    applyArtVotes(root);
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
      onGoHome: handleGoHome,
      onGuestSave: handleGuestSave,
      onDismissBanner: handleDismissBanner,
      onMapView: handleMapView,
      onMenuToggle: handleMenuToggle,
      onCharTab: handleCharTabToggle,
      onCharTabClose: handleCharTabClose,
      onRollHistory: handleRollHistoryToggle,
      onRollHistoryClose: handleRollHistoryClose,
      onSceneMap: handleSceneMapToggle,
      onSceneMapClose: handleSceneMapClose,
      onSceneInfo: handleSceneInfoToggle,
      onSceneInfoClose: handleSceneInfoClose,
      onAffordancesMore: handleAffordancesMore,
      onAffordanceGate: handleAffordanceGate,
      onMove: handleMove,
      onInspect: handleInspect,
      onTalk: handleTalk,
      onUseItem: handleUseItem,
      onGmMode: handleGmMode,
      onSkin: handleSkin,
      onFont: handleFont,
      onLogFontScale: handleLogFontScale,
      onVnFontScale: handleVnFontScale,
      onTextSpeed: handleTextSpeed,
      onAttempt: handleAttempt,
      onAttemptDraft: handleAttemptDraft,
      onTurnRetry: retryPendingTurn,
      onTurnDiscard: discardPendingTurn,
      onDialogueClose: handleDialogueClose,
      onDialogueTyped: handleDialogueTyped,
      onDialogueReply: handleDialogueReply,
      onDialogueReplyDraft: handleDialogueReplyDraft,
      onDialogueEnd: handleDialogueEnd,
      onVictoryTyped: handleVictoryTyped,
      onOpenNpcCreator: handleOpenNpcCreator,
      onSceneRedo: handleSceneRedo,
      onSceneSave: handleSceneSave,
      onArtThumb: handleArtThumb,
      onArtReason: handleArtReason,
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
    applyArtVotes(root);
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

  // Map zoom toggle (affordances-map-law Part B): flip the map surface between the
  // LOCAL floor plan and the REGION graph. Map-surface only — no input-dock touch.
  function handleMapView({ view } = {}) {
    const next = view === "region" ? "region" : "local";
    if (state.mapView === next) {
      return;
    }
    state.mapView = next;
    render();
  }

  // Character-sheet tab (portrait badge) + roll-history drawer (banner magnifier).
  // Each is a single-open drawer: opening one closes the other so they never stack.
  function handleCharTabToggle() {
    state.characterTabOpen = !state.characterTabOpen;
    if (state.characterTabOpen) state.rollHistoryOpen = false;
    render();
  }
  function handleCharTabClose() {
    state.characterTabOpen = false;
    render();
  }
  function handleRollHistoryToggle() {
    state.rollHistoryOpen = !state.rollHistoryOpen;
    if (state.rollHistoryOpen) state.characterTabOpen = false;
    render();
  }
  function handleRollHistoryClose() {
    state.rollHistoryOpen = false;
    render();
  }

  // Stage-HUD drawers (owner ruling 2026-07-19): the floated map widget opens the
  // MAP drawer; the Cast·Exits toggle opens the INFO drawer. Single-open per family
  // (opening one closes the sibling scene drawer) so they never stack.
  function handleSceneMapToggle() {
    state.sceneMapOpen = !state.sceneMapOpen;
    if (state.sceneMapOpen) state.sceneInfoOpen = false;
    render();
  }
  function handleSceneMapClose() {
    state.sceneMapOpen = false;
    render();
  }
  function handleSceneInfoToggle() {
    state.sceneInfoOpen = !state.sceneInfoOpen;
    if (state.sceneInfoOpen) state.sceneMapOpen = false;
    render();
  }
  function handleSceneInfoClose() {
    state.sceneInfoOpen = false;
    render();
  }

  // Affordance chip row: overflow toggle + a gated-chip's in-fiction reason.
  function handleAffordancesMore() {
    state.affordancesExpanded = !state.affordancesExpanded;
    render();
  }
  function handleAffordanceGate({ reason } = {}) {
    // A gated affordance never submits — it surfaces its committed-state reason.
    state.affordanceGateNote = typeof reason === "string" ? reason : "";
    render();
  }

  function handleDismissBanner() {
    state.banner = "";
    state.bannerKind = "";
    render();
  }


  // ---- Async feedback wrapper ----------------------------------------------
  // Wraps every network action so it can never fail silently or wait
  // invisibly: it sets a busy flag (disables the input + dims action buttons,
  // guarding against double-submit), arms a 2s "GM is thinking…" lag indicator,
  // surfaces any thrown error as a dismissible in-panel banner, and always
  // clears the busy/lag state when the action settles.
  let lagTimer = null;
  let stallTimer = null;

  // STALL VISIBILITY: a focus-safe repaint of ONLY the thinking-indicator leaf, so
  // the elapsed-seconds counter ("Still working — 18s") ticks even while the player
  // is typing their next action (the input element is never touched).
  function repaintDockStatus() {
    if (!root || typeof root.querySelector !== "function") {
      return;
    }
    const el = root.querySelector("[data-solo-dock-status]");
    if (el && "innerHTML" in el) {
      el.innerHTML = renderSoloThinkingIndicator(state);
    }
  }

  function clearLag() {
    if (lagTimer) {
      clearTimeout(lagTimer);
      lagTimer = null;
    }
    if (stallTimer) {
      clearInterval(stallTimer);
      stallTimer = null;
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
    // STALL VISIBILITY: once thinking, tick the elapsed counter every second via a
    // leaf-only repaint (focus-safe — never rebuilds the composer mid-keystroke).
    if (typeof setInterval === "function") {
      stallTimer = setInterval(() => {
        if (state.gmThinking) {
          repaintDockStatus();
        }
      }, 1000);
      if (stallTimer && typeof stallTimer.unref === "function") {
        stallTimer.unref();
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
        ? "That turn took a while. Caught up to the latest."
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
  async function postAction(action, turnId = null) {
    const response = await postSoloAction(apiClient, runId, action, turnId);
    if (response && response.runWon) {
      state.pendingVictory = true;
      state.victoryNarration = typeof response.victoryNarration === "string" ? response.victoryNarration : null;
    }
    return response;
  }

  // DRAFT SURVIVAL: persist / clear the composer draft for this run (mirrors the
  // textSpeed pref pattern). Called on every keystroke and on a settled submit.
  function persistDraft(text) {
    writeSoloThemePref(soloComposerDraftKey(runId), String(text || ""));
  }
  function clearComposerDraft() {
    state.attemptDraft = "";
    persistDraft("");
  }
  function nowMs() {
    return typeof Date !== "undefined" && typeof Date.now === "function" ? Date.now() : 0;
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

  // T1: the header brand → landing/home from inside a live run. ALWAYS confirm — an
  // unsent turn or in-flight action must not be silently abandoned. Home = strip the
  // ?soloRunId param (pathname only) and land on the world-select.
  function handleGoHome() {
    if (typeof window === "undefined") {
      return;
    }
    if (window.confirm(HOME_NAV_CONFIRM)) {
      window.location.href = window.location.pathname;
    }
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

  // JOB 3: step the VN dialogue text size — the exact narration-sizer pattern, but
  // scoped to --solo-vn-scale so it NEVER touches the narration log (and A−/A+ never
  // touches the VN box). Instant resize via a direct var set on the shell, persisted.
  function handleVnFontScale({ dir } = {}) {
    const step = dir === "down" ? -SOLO_LOG_SCALE_STEP : SOLO_LOG_SCALE_STEP;
    state.vnScale = normalizeLogScale((state.vnScale || 1) + step);
    writeSoloThemePref(SOLO_VN_SCALE_STORAGE_KEY, String(state.vnScale));
    const shell = typeof root.querySelector === "function" ? root.querySelector(".solo-scene-shell") : null;
    const target = shell && shell.style ? shell : root;
    target.style?.setProperty?.("--solo-vn-scale", String(state.vnScale));
  }

  // VN text speed (table stakes): cycle slow → normal → fast → instant, persist
  // (font-sizer pattern), re-render so the control label updates; the typewriter
  // reads the persisted value on its next bind.
  function handleTextSpeed() {
    const order = VN_TEXT_SPEED_ORDER;
    const current = normalizeTextSpeed(state.textSpeed);
    state.textSpeed = order[(order.indexOf(current) + 1) % order.length];
    writeSoloThemePref(SOLO_TEXT_SPEED_STORAGE_KEY, state.textSpeed);
    render();
  }

  function handleAttemptDraft({ value }) {
    state.attemptDraft = String(value || "");
    // DRAFT SURVIVAL: persist per keystroke so a refresh/disconnect keeps the text.
    persistDraft(state.attemptDraft);
  }

  // Bug A (#37/#38): render the GM's out-of-character reply as a distinct log
  // note. NOT a story beat — no YOU header, no roll, no turn cost. A failed/empty
  // reply shows an explicit retry prompt: silence is never an acceptable outcome.
  function appendOocNote({ reply } = {}) {
    const body = String(reply || "").trim() || "The GM couldn't answer that. Try again.";
    state.narrationLog.push({ id: `ooc${state.narrationLog.length + 1}`, kind: "ooc", text: body });
    if (state.narrationLog.length > 200) {
      state.narrationLog.splice(0, state.narrationLog.length - 200);
    }
    render();
  }

  // Applies a committed turn's response to state (provenance, attempt result,
  // dialogue cue, dialogue lines) then resyncs the scene. Shared by a first-try
  // success and an idempotent retry so both render identically.
  async function applyTurnSuccess(response, submittedText) {
    state.pendingPlayerAction = submittedText;
    state.attemptResult = response.attemptResult || response.latestAttemptResult || null;
    // VISIBLE CONSEQUENCE (law 3): derive the diegetic cue from the COMMITTED
    // disposition delta this turn returned (never narrator text). Turn-scoped.
    {
      const dc = state.attemptResult?.dispositionChange || state.attemptResult?.giftChange || null;
      const cueText = dc ? dispositionCueText(dc) : "";
      state.dispositionCue = cueText ? { npcId: dc.targetNpcId, text: cueText } : null;
    }
    // #20-full: per-line speaker attribution so logNarration nameplates NPC lines.
    state.dialogueLines = Array.isArray(response.dialogueLines) ? response.dialogueLines : [];
    clearComposerDraft();
    state.searchResult = null;
    state.talkResult = null;
    state.dialogueActive = false;
    state.restResult = null;
    state.useItemResult = null;
    await loadScene();
  }

  // INPUT INTEGRITY — the resync-safe submit. Posts a typed turn stamped with a
  // stable turnId; on a thrown/lost request it RESUBMITS the SAME turnId once (the
  // server replays idempotently if the turn already committed, or processes it if
  // it did not — never a re-roll, never a double-commit). If both attempts fail to
  // reach the server, the turn is SURFACED (pendingTurn.status = "failed") with
  // Retry/Discard — never silently dropped. `caughtErrors` collects both throws so
  // the second failure carries the real message.
  async function submitTurn({ intent, mode, turnId, submittedText }) {
    state.pendingTurn = { turnId, text: submittedText, mode, status: "processing", startedAt: nowMs() };
    let response = null;
    let firstError = null;
    try {
      response = await postAction(createAttemptAction({ intent, mode }), turnId);
    } catch (error) {
      firstError = error;
      // OOC never fails silently (Bug A): a thrown OOC request gets a visible note.
      if (mode === "ooc") {
        appendOocNote({ reply: "" });
        state.pendingTurn = null;
        clearComposerDraft();
        return;
      }
      // Resync-safe retry — SAME turnId, so a committed-but-timed-out turn replays
      // idempotently rather than re-rolling.
      try {
        response = await postAction(createAttemptAction({ intent, mode }), turnId);
      } catch (secondError) {
        // Both attempts failed: SURFACE (contract clause 1c), never drop. Keep the
        // player's text so Retry/Discard/edit are all possible. U4: carry the classified
        // WHY (timeout / unreachable / server) so the banner explains, not just alarms.
        state.pendingTurn = { turnId, text: submittedText, mode, status: "failed", reason: classifyTurnFailure(firstError || secondError), startedAt: state.pendingTurn?.startedAt || nowMs() };
        state.attemptDraft = submittedText;
        persistDraft(submittedText);
        state.banner = "";
        return; // runAction's finally clears busy; the failed-turn surface renders
      }
    }
    void firstError;
    // The original of this turnId is still processing server-side (a resubmit raced
    // it). Don't double-process — resync to catch its commit; the pending surface
    // clears once the committed scene is shown.
    if (response && response.processing) {
      state.pendingTurn = null;
      await loadScene();
      return;
    }
    // OOC (#37/#38): server committed NO state, answered AS GM. Render + stop.
    if (response && response.ooc) {
      appendOocNote({ reply: response.oocReply });
      state.pendingTurn = null;
      clearComposerDraft();
      return;
    }
    // Idempotent replay: the turn was ALREADY committed (a prior attempt landed).
    // Its outcome is already in the run/scene — just resync, never re-append.
    if (response && (response.idempotentReplay || response.alreadyProcessed)) {
      state.pendingTurn = null;
      clearComposerDraft();
      await loadScene();
      return;
    }
    // Normal first-time success.
    state.pendingTurn = null;
    await applyTurnSuccess(response, submittedText);
  }

  // QUEUE, DON'T SWALLOW (contract clause 2): a turn typed while another is
  // processing is captured one-deep and flushed when the current turn settles —
  // no keystroke path throws input away.
  function flushQueuedTurn() {
    const queued = state.queuedTurn;
    if (!queued) {
      return;
    }
    state.queuedTurn = null;
    handleAttempt({ intent: queued.text, mode: queued.mode });
  }

  // Runs after an attempt's runAction fully settles (busy cleared). Flushes any turn
  // the player queued mid-flight — must be here, NOT inside submitTurn, or the flush
  // would re-see busy=true and re-queue instead of sending.
  function afterTurnSettled() {
    if (!state.busy && state.queuedTurn && (!state.pendingTurn || state.pendingTurn.status !== "failed")) {
      flushQueuedTurn();
    }
  }

  function handleAttempt({ intent, mode }) {
    if (!state.scene) {
      return;
    }
    // Bug B (provenance): the player's VERBATIM submitted text drives the YOU header.
    const submittedText = String(intent || "").trim();
    if (!submittedText) {
      return;
    }
    // A real submission clears any lingering gated-affordance reason.
    state.affordanceGateNote = "";
    // A turn is already processing: QUEUE this one (one deep) with a visible chip,
    // clear the box so the composer is ready, and flush when the current turn
    // settles. Replacing an existing queued turn keeps only the newest (one deep).
    if (state.busy) {
      state.queuedTurn = { text: submittedText, mode };
      clearComposerDraft();
      render();
      return;
    }
    const turnId = newSoloTurnId(runId);
    return runAction("attempt", () => submitTurn({ intent: submittedText, mode, turnId, submittedText })).then(afterTurnSettled);
  }

  // Retry the surfaced failed turn — reuses its turnId (idempotent) so a turn that
  // actually committed on the prior attempt is not double-committed.
  function retryPendingTurn() {
    const pending = state.pendingTurn;
    if (!pending || pending.status !== "failed" || state.busy) {
      return;
    }
    const { turnId, text, mode } = pending;
    return runAction("attempt", () => submitTurn({ intent: text, mode, turnId, submittedText: text })).then(afterTurnSettled);
  }

  // Discard is a PLAYER choice only (contract clause 1c) — the sole path that drops
  // a typed turn, and only on explicit intent.
  function discardPendingTurn() {
    if (!state.pendingTurn || state.pendingTurn.status !== "failed") {
      return;
    }
    state.pendingTurn = null;
    clearComposerDraft();
    state.banner = "";
    render();
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

  // ── BETA THUMB handlers (owner-feedback calibration) ───────────────────────
  // Optimistic + reversible. Session-scoped state.artVotes drives the toggle look
  // across re-renders (server sidecar + data/owner-verdicts.jsonl are the durable
  // record). A down reveals reason chips; tapping the same vote again clears it.
  function handleArtThumb({ uri, kind, vote, boxEl }) {
    if (!uri || !vote) return;
    state.artVotes = state.artVotes || {};
    const current = state.artVotes[uri] || null;
    const next = current === vote ? null : vote; // tap-again toggles off (mis-taps reversible)
    state.artVotes[uri] = next;
    if (boxEl) {
      boxEl.setAttribute("data-art-state", next || "");
      const reasons = boxEl.querySelector("[data-art-reasons]");
      if (reasons) {
        reasons.hidden = next !== "down";
        if (next !== "down") reasons.querySelectorAll(".is-on").forEach((c) => c.classList.remove("is-on"));
      }
    }
    (async () => {
      try { await apiClient.artThumb({ uri, kind, world: state.scene?.world, verdict: next || "clear", reasons: [] }); }
      catch { /* beta tool: keep the optimistic state; the record is best-effort */ }
    })();
  }
  function handleArtReason({ uri, kind, reason, chipEl, boxEl }) {
    if (!uri || !reason || !chipEl || !boxEl) return;
    chipEl.classList.toggle("is-on");
    const reasons = Array.from(boxEl.querySelectorAll(".art-thumb-chip.is-on")).map((c) => c.getAttribute("data-art-reason"));
    state.artVotes = state.artVotes || {};
    state.artVotes[uri] = "down";
    boxEl.setAttribute("data-art-state", "down");
    (async () => {
      try { await apiClient.artThumb({ uri, kind, world: state.scene?.world, verdict: "down", reasons }); }
      catch { /* best-effort */ }
    })();
  }
  // Restore the toggle look after any (full or stage-patch) re-render.
  function applyArtVotes(rootEl) {
    if (!rootEl || typeof rootEl.querySelectorAll !== "function") return;
    const votes = state.artVotes || {};
    rootEl.querySelectorAll("[data-art-thumb]").forEach((box) => {
      const uri = box.getAttribute("data-art-uri");
      const st = votes[uri] || "";
      box.setAttribute("data-art-state", st);
      const reasons = box.querySelector("[data-art-reasons]");
      if (reasons) reasons.hidden = st !== "down";
    });
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
      // Never tear down the DOM while the cog menu OR a drawer (character tab /
      // roll history) is open — a full re-render would destroy the open overlay
      // and eat in-flight clicks.
      if (state.menuOpen || state.characterTabOpen || state.rollHistoryOpen) {
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
    // JOB 3.1 (owner law: dialogue lives ONLY in the VN box, never the narration log).
    // On a VN opening the committed speaker's SPOKEN beats ride openingBeats and are
    // diverted to the real VN box by loadScene (the beatsSpeakerFrom split). Folding ALL
    // beats into the log here re-filed her spoken words as narration — the exact rule
    // violation. Log only the SCENE-SETTING narration beats (beats[0..speakerFrom)); the
    // spoken beats go to the VN box alone. The split mirrors loadScene's synthesize path
    // EXACTLY (same splitOpeningBeats call), so conservation is total: narration→log,
    // spoken→VN, never both, never dropped. A non-VN opening (no speaker) keeps ALL beats
    // as narration, unchanged.
    const openingIsVnSpeaker = scene.vnMode === true && typeof scene.speakerId === "string" && scene.speakerId.trim();
    const opening =
      typeof scene.openingNarration === "string" && scene.openingNarration.trim()
        ? scene.openingNarration.trim()
        : Array.isArray(scene.openingBeats)
          ? (openingIsVnSpeaker
              ? splitOpeningBeats(scene.openingBeats, scene.openingBeatsSpeakerFrom).narration
              : scene.openingBeats
            ).filter(Boolean).join("\n\n")
          : "";
    const isFirst = state.narrationLog.length === 0;
    let text = gmBody || (isFirst ? opening : "") || String(scene.location?.description || "").trim();
    // VN QUOTE SPLIT (owner ruling): on a VN turn, the addressed speaker's quoted
    // lines belong to the OVERLAY, not the log — the log gets everything else, in
    // original order. Stash the VN quotes for openVnDialogueForSpeaker to consume
    // (one narration, one split — never a second GM generation). Conservation is
    // total: split.logText + the stashed VN quotes reconstruct gmBody.
    state.vnDialogueSplit = null;
    if (gmBody && text === gmBody && scene.vnMode === true && typeof scene.speakerId === "string" && scene.speakerId.trim()) {
      const speakerName = resolveSceneSpeaker(scene, null) || "";
      const split = splitVnDialogueForScene(gmBody, scene, speakerName, scene.player?.displayName || "");
      state.vnDialogueSplit = { speakerId: scene.speakerId, speakerName, ...split };
      // The log entry is the non-dialogue remainder (may be empty for a pure-
      // dialogue beat, which then logs nothing and lives entirely in the VN).
      text = split.logText.trim();
    }
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

  // VN TRANSCRIPT (vn-dialogue-hardening, table stakes): every spoken VN line is
  // ALSO preserved verbatim in the persistent narration log as a compact
  // speaker-attributed entry (kind:"vn"), so a finished conversation replays
  // from the backlog — the VN box remains the live presentation surface, the log
  // the durable one. Consecutive-duplicate guard mirrors logNarration's.
  function pushVnLogEntry({ role, speaker, text }) {
    const line = String(text || "").trim();
    if (!line) {
      return;
    }
    const last = state.narrationLog[state.narrationLog.length - 1];
    if (last && last.kind === "vn" && last.text === line && last.speaker === (speaker || null)) {
      return;
    }
    state.narrationLog.push({
      id: `n${state.narrationLog.length + 1}`,
      kind: "vn",
      role: role === "player" ? "player" : "npc",
      intent: "",
      checkResult: null,
      success: undefined,
      band: null,
      outcomeLabel: null,
      text: line,
      speaker: speaker || null,
      dialogueLines: []
    });
    if (state.narrationLog.length > 200) {
      state.narrationLog.splice(0, state.narrationLog.length - 200);
    }
  }

  // VN QUOTE SPLIT for the talk-button / reply paths (which reload via
  // refreshSceneAfterAction, bypassing logNarration). Splits the NPC's full turn
  // narration: returns the addressed speaker's quoted lines for the VN box and
  // pushes the non-dialogue remainder to the narration log (owner ruling — every
  // unquoted word goes to the log). Conservation holds via splitVnDialogue.
  // Returns the VN line (quotes only; "" when the turn carried no quoted speech).
  function splitTalkNarrationToLog(fullNarration, speakerName, intentText) {
    const scene = state.scene || {};
    const split = splitVnDialogueForScene(String(fullNarration || ""), scene, speakerName || "", scene.player?.displayName || "");
    const remainder = split.logText.trim();
    if (remainder) {
      const last = state.narrationLog[state.narrationLog.length - 1];
      if (!last || last.text !== remainder) {
        state.narrationLog.push({
          id: `n${state.narrationLog.length + 1}`,
          intent: typeof intentText === "string" ? intentText : "",
          checkResult: null,
          success: undefined,
          band: null,
          outcomeLabel: null,
          text: remainder,
          speaker: speakerName || null,
          dialogueLines: []
        });
        if (state.narrationLog.length > 200) {
          state.narrationLog.splice(0, state.narrationLog.length - 200);
        }
      }
    }
    return split.vnText;
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
      // (removed) the page-level "Your world is being illustrated…" banner. It was pinned
      // at the top, disconnected from the art it described, dismiss-only, and outlived the
      // cook. That message now lives ON the pending art slot as an overlay (renderSoloSceneArt),
      // tied to the asset's ready state: it clears when the image arrives and becomes a
      // FAILED state if the cook fails — never a promise that hangs forever (JOB 3).
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
        // WALK-3 V4 — THE OPENING VN BRIDGE (the VOICE bug, escaped 4×). On the authored
        // opening the speaker's SPEECH rides scene.openingBeats, NOT gmNarration.body, so
        // logNarration's split never populated vnDialogueSplit → the VN box opened EMPTY
        // while the words fell to the yellow prose renderer. Synthesize the split from the
        // committed speaker's beats (beats[from..]) so her first line lands in the real VN
        // box exactly like a live talk beat. Only when the normal split didn't already set it.
        // Fire UNLESS a NON-EMPTY split already exists for this speaker. logNarration
        // runs its own split off gmBody FIRST and, at the opening, produces a split with
        // the right speakerId but EMPTY vnText (the VOICE's words live in openingBeats,
        // not gmBody) — an empty split must NOT block the opening bridge (the bug in the
        // first cut of this fix: it saw the matching-but-empty split and skipped).
        const existingVnText =
          state.vnDialogueSplit && state.vnDialogueSplit.speakerId === state.scene.speakerId
            ? String(state.vnDialogueSplit.vnText || "").trim()
            : "";
        if (!existingVnText && Array.isArray(state.scene.openingBeats) && state.scene.openingBeats.length) {
          const { spoken } = splitOpeningBeats(state.scene.openingBeats, state.scene.openingBeatsSpeakerFrom);
          if (spoken.length) {
            state.vnDialogueSplit = {
              speakerId: state.scene.speakerId,
              speakerName: (state.scene.openingSpeaker && state.scene.openingSpeaker.displayName) || "The VOICE",
              vnText: spoken.join("\n\n")
            };
          }
        }
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
      const talk = response.talkResult || null;
      // VN QUOTE SPLIT (owner ruling): when the GM narrated (talkResult.line is a
      // full scene block, not a scripted one-liner), keep only the addressed
      // speaker's quotes in the VN and send the rest to the log. A quote-free
      // scripted beat is shown as-is (no split changes it → the beat stays in VN).
      let vnLine = talk && typeof talk.line === "string" ? talk.line : "";
      if (talk && /["“][^"”]+["”]/.test(vnLine)) {
        vnLine = splitTalkNarrationToLog(vnLine, talk.speakerName || "NPC", `Speak with ${talk.speakerName || "NPC"}`);
      }
      state.talkResult = talk ? { ...talk, line: vnLine, fullNarration: talk.line } : null;
      // Open the visual-novel dialogue overlay and restart the typewriter.
      state.dialogueActive = Boolean(state.talkResult);
      state.dialogueTyped = false;
      // A manual Talk opens a fresh exchange — a prior turn's cue never carries over.
      state.dispositionCue = null;
      // Table stakes: the spoken line lands verbatim in the backlog too.
      if (state.talkResult && vnLine) {
        pushVnLogEntry({ role: "npc", speaker: state.talkResult.speakerName || "NPC", text: vnLine });
      }
      // Start a fresh conversation: remember who we're talking to (so replies
      // re-target them through the same talk pipeline) and seed the history with
      // the NPC's opening line.
      state.dialogueTargetEntityId =
        entity.entityId || entity.targetEntityId || (state.talkResult ? `npc:${state.talkResult.npcId}` : null);
      state.dialogueReplyDraft = "";
      state.dialogueHistory =
        state.talkResult && vnLine
          ? [{ role: "npc", speaker: state.talkResult.speakerName || "NPC", text: vnLine }]
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
  function openVnDialogueForSpeaker(speakerId) {
    const target = String(speakerId || "").trim();
    if (!target) {
      return;
    }
    // scene.speakerId arrives as the RAW npcId (the freeform "speak to X" trigger)
    // or, from the GM-driven classifier, an already-"npc:"-prefixed id. Normalize
    // to "npc:<rawId>" so replies re-target the same visible entity.
    const rawId = target.includes(":") ? target.split(":").slice(1).join(":") : target;
    const entityId = `npc:${rawId}`;
    // NO SECOND GENERATION (owner ruling / seam fix): the dialogue content is the
    // addressed speaker's QUOTED lines already carried by THIS turn's narration —
    // split out in logNarration and stashed on state.vnDialogueSplit. Firing a
    // fresh talk postAction here was the root of the "VN says one thing, log says
    // another" seam (two independent GM generations) AND doubled per-turn latency.
    const split = state.vnDialogueSplit && state.vnDialogueSplit.speakerId === speakerId
      ? state.vnDialogueSplit
      : null;
    const castName = (Array.isArray(state.scene?.cast) ? state.scene.cast : [])
      .find((member) => member && member.npcId === rawId)?.displayName || null;
    const speakerName = (split && split.speakerName) || castName || "NPC";
    // The VN line is the addressed speaker's quotes only. When this turn's
    // narration carried zero quotes from them, the VN shows nothing new (empty
    // line) and the whole response is already in the log — the session stays open
    // awaiting the player's reply (owner rule 3).
    const vnLine = split && typeof split.vnText === "string" ? split.vnText : "";
    state.talkResult = { npcId: rawId, speakerName, line: vnLine, found: true };
    state.dialogueActive = true;
    state.dialogueTyped = false;
    state.dialogueTargetEntityId = entityId;
    state.dialogueReplyDraft = "";
    state.dialogueHistory = vnLine ? [{ role: "npc", speaker: speakerName, text: vnLine }] : [];
    // Table stakes: the spoken line lands verbatim in the backlog too.
    if (vnLine) {
      pushVnLogEntry({ role: "npc", speaker: speakerName, text: vnLine });
    }
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
        // Table stakes: the player's spoken line is part of the replayable transcript.
        pushVnLogEntry({ role: "player", speaker: "You", text: reply });
      }
      // A new exchange supersedes the previous turn's committed-delta cue.
      state.dispositionCue = null;
      state.dialogueReplyDraft = "";
      const response = await postAction(createTalkAction({ entityId: target, message: reply, history: priorHistory }));
      const next = response.talkResult || null;
      if (next && next.found !== false && next.line) {
        // VN QUOTE SPLIT (owner ruling): the reply narration is one block — the
        // addressed speaker's quotes stay in the VN, every other word (scene beats,
        // other NPCs, atmosphere) goes to the log. A pure-action reply with zero
        // quoted speech leaves vnLine empty → the VN shows nothing new, the whole
        // beat is logged, and the session stays open (rule 3).
        const vnLine = splitTalkNarrationToLog(next.line, next.speakerName || "NPC", reply || "");
        state.talkResult = { ...next, line: vnLine, fullNarration: next.line };
        state.dialogueTyped = false;
        state.dialogueHistory = vnLine
          ? [...(state.dialogueHistory || []), { role: "npc", speaker: next.speakerName || "NPC", text: vnLine }]
          : (state.dialogueHistory || []);
        // Table stakes: the NPC's reply lands verbatim in the backlog too.
        if (vnLine) {
          pushVnLogEntry({ role: "npc", speaker: next.speakerName || "NPC", text: vnLine });
        }
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
    // overlay closes immediately so the player is back in the scene. The spoken
    // lines survive in the narration log (vn transcript entries) — replayable.
    state.dialogueActive = false;
    state.dialogueReplyDraft = "";
    state.dialogueHistory = [];
    state.dialogueTargetEntityId = null;
    state.dispositionCue = null;
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
