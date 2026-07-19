// THE CUSTOM WORLD CREATOR — the Babel interview, productized (client).
//
// The UX law (owner): world creation is a CONVERSATION, not a spreadsheet. The user
// answers questions and curates drafts; they never see a schema, never fill a stat, and
// are never blocked from playing. Complexity lives behind defaults + drawers.
//
// Five steps: SPARK → INTERVIEW (one question at a time, skippable, "just build it") →
// DRAFT REVIEW (keep / twist / kill cards) → DEFAULTS DRAWER (collapsed) → STEP IN.
//
// String-based render + two bind hooks (data-wc-input for text, data-wc-action for
// buttons), matching the onboardingFlow convention. The interview reducers mirror the
// server (server/campaign/worldInterview.js) EXACTLY — a parity test guards the copy so
// the two never drift. Player-facing copy says "world", never "template" (Worlds law).

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// The question set — mirrors server INTERVIEW_QUESTIONS (parity-tested). The prompts ARE
// the UX; this is the client copy the owner reviews.
export const CREATOR_QUESTIONS = Object.freeze([
  { id: "landmark", prompt: "Every world has one thing everyone's heard of. What's the landmark of yours — the thing people point to on the horizon?", help: "A tower that shouldn't exist, a wound in the sky, a drowned city, a mountain that hums…", placeholder: "e.g. a hundred-floor tower at the south pole, leaking something into the green", skipLabel: "Let the world decide" },
  { id: "remnant", prompt: "Something came before. What did the old world leave behind that people still live with?", help: "Ruins, a broken law, a debt, a machine still running, a promise nobody kept…", placeholder: "e.g. the licences — you can make money off the corruption, you just can't cure it", skipLabel: "Let the world decide" },
  { id: "temptation", prompt: "People with sense stay home. What's the temptation that makes your adventurers risk it anyway?", help: "Money, a cure, a person, an answer, a way back…", placeholder: "e.g. salvage rights worth a fortune, if you're licensed and fast", skipLabel: "Let the world decide" },
  { id: "threats", prompt: "What's out there, weakest to worst? Give me a few rungs of the danger ladder.", help: "Four to six rungs is plenty — from the everyday nuisance up to the thing nobody walks away from.", placeholder: "e.g. stray wildlife → desperate salvagers → chaos-touched things → the demons", skipLabel: "Let the world decide" },
  { id: "signature", prompt: "What's the one danger this world is known for — its signature, the thing players will tell stories about?", help: "The trademark. In Babel it's getting turned around in woods that rearrange themselves.", placeholder: "e.g. the Green Static — the corruption that eats your sense of direction", skipLabel: "Let the world decide" },
  { id: "powers", prompt: "Who holds power here? Name three or four factions pulling the strings.", help: "Guilds, gangs, churches, corporations, crowns, cults — whoever people owe or fear.", placeholder: "e.g. the Charter, the Root Shrine keepers, the Hollow Congregation", skipLabel: "Let the world decide" },
  { id: "region", prompt: "Last thing — what's this first region called? Or I can name it for you.", help: "Just the corner of the world you'll start in. You can leave it to me.", placeholder: "e.g. the Verdance", skipLabel: "Name it for me" }
]);

const QUESTION_IDS = CREATOR_QUESTIONS.map((q) => q.id);
const QUESTION_BY_ID = new Map(CREATOR_QUESTIONS.map((q) => [q.id, q]));

// ── client interview reducers (mirror the server state shape) ────────────────

export function creatorStartInterview(spark = "") {
  return { version: 1, spark: String(spark || "").trim(), order: [...QUESTION_IDS], answers: {}, cursor: 0, status: "asking" };
}
function advance(iv) {
  let cursor = iv.cursor;
  while (cursor < iv.order.length && iv.answers[iv.order[cursor]]) cursor += 1;
  return { ...iv, cursor, status: cursor >= iv.order.length ? "ready" : iv.status };
}
export function creatorCurrentQuestion(iv) {
  if (!iv || iv.status === "ready") return null;
  return QUESTION_BY_ID.get(iv.order?.[iv.cursor]) || null;
}
export function creatorAnswer(iv, value) {
  const q = creatorCurrentQuestion(iv);
  if (!q) return iv;
  const v = String(value || "").trim();
  if (!v) return creatorSkip(iv);
  return advance({ ...iv, answers: { ...iv.answers, [q.id]: { value: v } } });
}
export function creatorSkip(iv) {
  const q = creatorCurrentQuestion(iv);
  if (!q) return iv;
  return advance({ ...iv, answers: { ...iv.answers, [q.id]: { skipped: true } } });
}
export function creatorJustBuild(iv) {
  const answers = { ...iv.answers };
  for (const id of iv.order) if (!answers[id]) answers[id] = { skipped: true, deferred: true };
  return { ...iv, answers, cursor: iv.order.length, status: "ready" };
}
export function creatorProgress(iv) {
  const total = iv?.order?.length || QUESTION_IDS.length;
  const resolved = iv?.order?.filter((id) => Boolean(iv?.answers?.[id])).length || 0;
  const answered = iv?.order?.filter((id) => iv?.answers?.[id] && !iv.answers[id].skipped).length || 0;
  return { total, resolved, answered, index: Math.min((iv?.cursor || 0) + 1, total) };
}

// ── review reducers (keep / twist / kill) ────────────────────────────────────

const REVIEW_SECTIONS = ["pois", "factions", "threatLadder"];
export function creatorCreateReview(draft = {}) {
  const wrap = (l) => (Array.isArray(l) ? l : []).map((c) => ({ ...c, status: "keep" }));
  return { identity: draft.identity || {}, cosmology: draft.cosmology || "", signatureDanger: draft.signatureDanger || {}, pois: wrap(draft.pois), factions: wrap(draft.factions), threatLadder: wrap(draft.threatLadder) };
}
function mapCard(review, section, id, fn) {
  if (!REVIEW_SECTIONS.includes(section)) return review;
  return { ...review, [section]: review[section].map((c) => (c.id === id ? fn(c) : c)) };
}
export function creatorKeep(review, section, id) { return mapCard(review, section, id, (c) => ({ ...c, status: "keep" })); }
export function creatorKill(review, section, id) { return mapCard(review, section, id, (c) => ({ ...c, status: "killed" })); }
export function creatorReplace(review, section, id, next) { return mapCard(review, section, id, (c) => ({ ...next, id: c.id, status: "keep" })); }

// ── RENDER ───────────────────────────────────────────────────────────────────

/** The default client state for the creator (held at onboarding.worldCreator). */
export function defaultWorldCreatorState() {
  return { substep: "spark", spark: "", interview: null, answerDraft: "", draft: null, review: null, overrides: {}, defaultsOpen: false, twistOpen: null, busy: false, error: "" };
}

export function renderWorldCreator(wc = {}) {
  const substep = wc.substep || "spark";
  const shell = (body) => `
    <section class="onboarding-shell onb-wc" data-wc-root>
      <header class="onboarding-header">
        <div class="tag">Custom World</div>
        ${renderWcSteps(substep)}
      </header>
      ${wc.error ? `<div class="onboarding-error" data-wc-error>${esc(wc.error)}</div>` : ""}
      ${body}
    </section>`;
  if (substep === "spark") return shell(renderSpark(wc));
  if (substep === "drafting") return shell(renderDrafting(wc));
  if (substep === "review") return shell(renderReview(wc));
  return shell(renderInterview(wc));
}

function renderWcSteps(substep) {
  const order = ["spark", "interview", "review"];
  const at = substep === "drafting" ? 1 : order.indexOf(substep);
  const labels = { spark: "Spark", interview: "Interview", review: "Review" };
  return `<div class="onb-wc-steps" aria-hidden="true">${order.map((s, i) =>
    `<span class="onb-wc-step ${i <= at ? "is-done" : ""} ${i === at ? "is-current" : ""}">${labels[s]}</span>`
  ).join("<span class=\"onb-wc-step-sep\">·</span>")}</div>`;
}

function renderSpark(wc) {
  return `
    <div class="onb-wc-spark">
      <h2>Describe your world</h2>
      <p class="onb-wc-lede">A sentence, a vibe, a genre — whatever's in your head. I'll ask a few questions and draft the rest. You can change anything.</p>
      <textarea class="onb-wc-spark-input" data-wc-input="spark" rows="3" maxlength="400"
        placeholder="neon cyberpunk city, corporate gods, rain that never stops">${esc(wc.spark || "")}</textarea>
      <div class="onb-wc-actions">
        <button type="button" class="onb-primary" data-wc-action="begin" ${wc.busy ? "disabled" : ""}>Begin →</button>
        <button type="button" class="onb-ghost" data-wc-action="just-build-from-spark" ${wc.busy ? "disabled" : ""}>Just build it for me</button>
      </div>
    </div>`;
}

function renderInterview(wc) {
  const iv = wc.interview || creatorStartInterview(wc.spark || "");
  const q = creatorCurrentQuestion(iv);
  if (!q) return renderDrafting(wc); // resolved but not yet drafted
  const p = creatorProgress(iv);
  return `
    <div class="onb-wc-interview">
      <div class="onb-wc-progress">Question ${p.index} of ${p.total}</div>
      <h2 class="onb-wc-question">${esc(q.prompt)}</h2>
      ${q.help ? `<p class="onb-wc-help">${esc(q.help)}</p>` : ""}
      <textarea class="onb-wc-answer" data-wc-input="answerDraft" rows="2" maxlength="400"
        placeholder="${esc(q.placeholder || "")}">${esc(wc.answerDraft || "")}</textarea>
      <div class="onb-wc-actions">
        <button type="button" class="onb-primary" data-wc-action="answer" ${wc.busy ? "disabled" : ""}>Next →</button>
        <button type="button" class="onb-ghost" data-wc-action="skip" ${wc.busy ? "disabled" : ""}>${esc(q.skipLabel || "Skip")}</button>
      </div>
      <button type="button" class="onb-wc-justbuild" data-wc-action="just-build" ${wc.busy ? "disabled" : ""}>Just build it from here →</button>
    </div>`;
}

function renderDrafting(wc) {
  return `
    <div class="onb-wc-drafting" data-wc-drafting>
      <h2>Building your world…</h2>
      <p class="onb-wc-lede">Drawing the map, seating the powers, stocking the danger. One moment.</p>
      <div class="onboarding-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="60">
        <div class="onboarding-progress-bar" style="width:60%;"></div>
      </div>
    </div>`;
}

function renderReview(wc) {
  const review = wc.review || {};
  const name = esc(review.identity?.name || "Your world");
  return `
    <div class="onb-wc-review">
      <h2>${name}</h2>
      <p class="onb-wc-lede">Here's the first draft. Keep what you like, twist what's close, cut what isn't yours. Nothing here is final — a young world fills in as you play.</p>

      ${renderCardSection("Places", "pois", review.pois, wc, renderPoiCard)}
      ${renderCardSection("Powers", "factions", review.factions, wc, renderFactionCard)}
      ${renderCardSection("The danger ladder", "threatLadder", review.threatLadder, wc, renderThreatCard)}

      ${renderDefaultsDrawer(wc)}

      <div class="onb-wc-actions onb-wc-stepin">
        <button type="button" class="onb-primary" data-wc-action="step-in" ${wc.busy ? "disabled" : ""}>Step into ${name} →</button>
        <span class="onb-wc-stepin-note">You'll make your character next.</span>
      </div>
    </div>`;
}

function renderCardSection(title, section, cards, wc, cardFn) {
  const list = Array.isArray(cards) ? cards : [];
  const live = list.filter((c) => c.status !== "killed").length;
  return `
    <div class="onb-wc-section" data-wc-section-name="${section}">
      <h3>${esc(title)} <span class="onb-wc-count">${live}</span></h3>
      <div class="onb-wc-cards">
        ${list.map((c) => cardFn(c, section, wc)).join("")}
      </div>
    </div>`;
}

function cardControls(section, card, wc) {
  const killed = card.status === "killed";
  const twisting = wc.twistOpen && wc.twistOpen.section === section && wc.twistOpen.id === card.id;
  if (killed) {
    return `<div class="onb-wc-card-controls"><button type="button" class="onb-ghost" data-wc-action="keep" data-wc-section="${section}" data-wc-id="${esc(card.id)}">Undo</button></div>`;
  }
  return `
    <div class="onb-wc-card-controls">
      <button type="button" class="onb-chip" data-wc-action="twist-open" data-wc-section="${section}" data-wc-id="${esc(card.id)}" aria-expanded="${twisting ? "true" : "false"}">Twist</button>
      <button type="button" class="onb-chip is-kill" data-wc-action="kill" data-wc-section="${section}" data-wc-id="${esc(card.id)}">Kill</button>
    </div>
    ${twisting ? `
      <div class="onb-wc-twist">
        <input type="text" class="onb-wc-twist-input" data-wc-input="twistText" maxlength="160" placeholder="one line: make it darker, rename it, move it underground…" value="${esc(wc.twistText || "")}" />
        <button type="button" class="onb-primary" data-wc-action="twist-submit" data-wc-section="${section}" data-wc-id="${esc(card.id)}" ${wc.busy ? "disabled" : ""}>Regenerate</button>
      </div>` : ""}`;
}

function renderPoiCard(card, section, wc) {
  const killed = card.status === "killed";
  return `
    <article class="onb-wc-card ${killed ? "is-killed" : ""}" data-wc-card="${esc(card.id)}">
      <div class="onb-wc-card-head"><span class="onb-wc-card-title">${esc(card.name)}</span><span class="onb-wc-card-tag">${esc(card.poiClass || "place")}${Number(card.dangerLevel) ? ` · danger ${esc(card.dangerLevel)}` : ""}</span></div>
      <p class="onb-wc-card-body">${esc(card.description || "")}</p>
      ${cardControls(section, card, wc)}
    </article>`;
}
function renderFactionCard(card, section, wc) {
  const killed = card.status === "killed";
  return `
    <article class="onb-wc-card ${killed ? "is-killed" : ""}" data-wc-card="${esc(card.id)}">
      <div class="onb-wc-card-head"><span class="onb-wc-card-title">${esc(card.name)}</span><span class="onb-wc-card-tag">${esc(card.disposition || "neutral")}</span></div>
      <p class="onb-wc-card-body">${esc(card.wants || "")}</p>
      ${cardControls(section, card, wc)}
    </article>`;
}
function renderThreatCard(card, section, wc) {
  const killed = card.status === "killed";
  return `
    <article class="onb-wc-card onb-wc-card-threat ${killed ? "is-killed" : ""}" data-wc-card="${esc(card.id)}">
      <div class="onb-wc-card-head"><span class="onb-wc-card-title">${esc(card.rung)}</span><span class="onb-wc-card-tag">${esc(card.rarity || "uncommon")}</span></div>
      ${cardControls(section, card, wc)}
    </article>`;
}

function renderDefaultsDrawer(wc) {
  const open = Boolean(wc.defaultsOpen);
  const o = wc.overrides || {};
  return `
    <div class="onb-wc-defaults ${open ? "is-open" : ""}">
      <button type="button" class="onb-wc-drawer-toggle" data-wc-action="toggle-defaults" aria-expanded="${open ? "true" : "false"}">
        ${open ? "▾" : "▸"} Defaults <span class="onb-wc-drawer-hint">era · tone · art · death — all optional</span>
      </button>
      ${open ? `
        <div class="onb-wc-defaults-body">
          <label class="onb-wc-field"><span>Era</span><input type="text" data-wc-input="override:era" maxlength="120" placeholder="e.g. late-corporate, post-collapse" value="${esc(o.era || "")}" /></label>
          <label class="onb-wc-field"><span>Tone</span><input type="text" data-wc-input="override:tone" maxlength="80" placeholder="e.g. neon-noir, cozy, grim" value="${esc(o.tone || "")}" /></label>
          <label class="onb-wc-field"><span>Art style</span>
            <select data-wc-input="override:artStyle">
              ${["illustrated", "anime", "cinematic"].map((s) => `<option value="${s}" ${o.artStyle === s ? "selected" : ""}>${s}</option>`).join("")}
            </select>
          </label>
          <p class="onb-wc-death">Death: a free death ends the run with an epilogue; continuing past it is a premium touch. (You can't lock yourself out of the story.)</p>
          <div class="onb-wc-advanced">Custom skill trees, per-world creatures &amp; modules — <em>coming soon.</em></div>
        </div>` : ""}
    </div>`;
}

// ── BIND (per-element, matches onboardingFlow) ───────────────────────────────

export function bindWorldCreator(root, handlers = {}) {
  if (!root || typeof root.querySelector !== "function" || !root.querySelector("[data-wc-root]")) return;
  root.querySelectorAll("[data-wc-input]").forEach((field) => {
    if (typeof field.addEventListener === "function") {
      field.addEventListener("input", () => handlers.onWcInput?.(field.getAttribute("data-wc-input"), field.value));
      field.addEventListener("change", () => handlers.onWcInput?.(field.getAttribute("data-wc-input"), field.value));
    }
  });
  root.querySelectorAll("[data-wc-action]").forEach((btn) => {
    if (typeof btn.addEventListener === "function") {
      btn.addEventListener("click", () => handlers.onWcAction?.(btn.getAttribute("data-wc-action"), {
        section: btn.getAttribute("data-wc-section") || null,
        id: btn.getAttribute("data-wc-id") || null
      }));
    }
  });
}

// Pure click router (test seam, mirrors dispatchSoloClick). Returns true if handled.
export function dispatchWorldCreatorClick(target, handlers = {}) {
  const el = target && typeof target.closest === "function" ? target.closest("[data-wc-action]") : null;
  if (!el) return false;
  handlers.onWcAction?.(el.getAttribute("data-wc-action"), { section: el.getAttribute("data-wc-section") || null, id: el.getAttribute("data-wc-id") || null });
  return true;
}
