// PUBLIC ROADMAP — full page. A pure string builder (no DOM, no fetch) so it is
// unit-testable exactly like homeZones.js. It renders the WHOLE sealed roadmap
// from data/roadmap-public.json (served static, loaded into uiState.roadmapFull),
// never from hardcoded copy. Every section row is CLICKABLE and expands a detail
// blurb, driven by an `expanded` map { id: true } the caller keeps in uiState.
//
// STANDING LAW (mirrored in the data file): statuses are exactly one of
// building | next | planned | long-term. No dates, no percentages, no em-dash in
// player-facing strings. This module only formats what the data file provides, so
// keeping the data file clean keeps the page clean.

function escapeText(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const ROADMAP_STATUS_LABEL = {
  building: "Building now",
  next: "Up next",
  planned: "Planned",
  "long-term": "Long term"
};

// Only these four statuses are legal on the full page (adds "long-term" over the
// teaser's three). Anything else falls through to no pill rather than inventing a
// label.
function statusKey(raw) {
  const key = String(raw || "").toLowerCase();
  return Object.prototype.hasOwnProperty.call(ROADMAP_STATUS_LABEL, key) ? key : "";
}

function renderMilestones(milestones) {
  const rows = Array.isArray(milestones)
    ? milestones.filter((m) => m && (m.label || m.value))
    : [];
  if (rows.length === 0) {
    return "";
  }
  const cards = rows
    .map(
      (m) => `
        <li class="roadmap-milestone">
          <span class="roadmap-milestone-value">${escapeText(m.value)}</span>
          <span class="roadmap-milestone-label">${escapeText(m.label)}</span>
        </li>
      `
    )
    .join("");
  return `<ul class="roadmap-milestones" aria-label="Milestones">${cards}</ul>`;
}

function renderRow(section, expanded) {
  const id = String(section.id || "");
  const key = statusKey(section.status);
  const label = ROADMAP_STATUS_LABEL[key] || "";
  const isOpen = Boolean(expanded && id && expanded[id]);
  const statusPill = label
    ? `<span class="roadmap-row-status roadmap-row-status--${key}">${escapeText(label)}</span>`
    : "";
  const summary = section.summary
    ? `<span class="roadmap-row-summary">${escapeText(section.summary)}</span>`
    : "";
  // The detail blurb is only emitted when the row is open. String-based tests key
  // off exactly this: collapsed → blurb ABSENT, open → blurb PRESENT.
  const detail =
    isOpen && section.detail
      ? `<div class="roadmap-row-detail" id="roadmap-detail-${escapeText(id)}"><p>${escapeText(
          section.detail
        )}</p></div>`
      : "";
  return `
    <li class="roadmap-row roadmap-row--${key || "none"}${isOpen ? " is-open" : ""}">
      <button type="button" class="roadmap-row-head" data-action="toggle-roadmap-row" data-roadmap-id="${escapeText(
        id
      )}" aria-expanded="${isOpen ? "true" : "false"}"${
        isOpen ? ` aria-controls="roadmap-detail-${escapeText(id)}"` : ""
      }>
        <span class="roadmap-row-heading">
          <span class="roadmap-row-title">${escapeText(section.title)}</span>
          ${statusPill}
        </span>
        ${summary}
        <span class="roadmap-row-chevron" aria-hidden="true">${isOpen ? "▾" : "▸"}</span>
      </button>
      ${detail}
    </li>
  `;
}

/**
 * Render the full public roadmap page from the loaded data file.
 * @param {{title?:string,intro?:string,milestones?:Array,sections?:Array}|null} data
 *   Parsed data/roadmap-public.json (null/undefined while it is still loading).
 * @param {Record<string, boolean>} [expanded] Map of section id -> open.
 * @returns {string} HTML for the page body.
 */
export function renderRoadmapPage(data, expanded = {}) {
  const sections = Array.isArray(data?.sections)
    ? data.sections.filter((s) => s && s.title)
    : [];
  const title = escapeText(data?.title || "The Road Ahead");
  const intro = data?.intro ? `<p class="roadmap-intro">${escapeText(data.intro)}</p>` : "";

  // Null data (still loading) or an empty/absent file → an honest, non-broken page
  // rather than a blank surface. The Back control is always present so the view is
  // never a dead end.
  const body =
    sections.length === 0
      ? `<p class="roadmap-empty">The roadmap is being written. Check back soon.</p>`
      : `<ol class="roadmap-list">${sections
          .map((section) => renderRow(section, expanded))
          .join("")}</ol>`;

  return `
    <main class="panel main roadmap-page" aria-labelledby="roadmap-heading">
      <div class="roadmap-page-inner">
        <div class="roadmap-page-top">
          <button type="button" class="ghost roadmap-back" data-action="close-roadmap">Back</button>
          <span class="roadmap-kicker">Roadmap</span>
        </div>
        <h1 id="roadmap-heading" class="roadmap-title">${title}</h1>
        ${intro}
        ${renderMilestones(data?.milestones)}
        ${body}
      </div>
    </main>
  `;
}
