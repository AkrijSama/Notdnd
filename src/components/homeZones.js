// Home dashboard reserved zones (right rail + shelf). Extracted from main.js so
// the MODULES taxonomy and the data-driven ROADMAP are unit-testable. Pure string
// builders — no DOM, no fetch.

function escapeText(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// WORLD/MODULE taxonomy (docs/design/world-module-law.md): a WORLD is a sealed
// universe (characters never cross between worlds); a MODULE is authored,
// world-scoped content (premises / one-shots / adventures) WITHIN a world.
// Player-facing copy never says "story templates" / "template".
//
// HIDE-WHEN-EMPTY (landing makeover 2026-07-21): the shelf no longer renders a
// standing "Coming soon" placeholder — an empty section HIDES (same law the roadmap
// zone already follows). It renders only when real modules exist for the world.
// @param {Array<{title?:string,description?:string}>} modules
// @returns {string} HTML ("" when there is nothing to show)
export function renderModulesZone(modules) {
  const rows = Array.isArray(modules) ? modules.filter((m) => m && m.title) : [];
  if (rows.length === 0) return "";
  const list = rows
    .map(
      (m) => `
        <span class="solo-home-module">
          <span class="solo-home-module-title">${escapeText(m.title)}</span>
          ${m.description ? `<span class="solo-home-module-desc">${escapeText(m.description)}</span>` : ""}
        </span>`
    )
    .join("");
  return `
    <div class="solo-home-zone solo-home-zone-shelf" aria-label="Modules">
      <span class="solo-home-zone-kicker">Modules</span>
      <span class="solo-home-zone-note">Ready-made adventures within this world.</span>
      ${list}
    </div>
  `;
}

const ROADMAP_STATUS_LABEL = { building: "Building", next: "Next", planned: "Planned" };

/**
 * Data-driven roadmap (docs/roadmap-public.json → /api/roadmap → uiState.roadmap).
 * Each item: { title, description, status: "building"|"next"|"planned" }. When the
 * data file is absent/empty the list is empty and this returns "" so the zone
 * HIDES CLEANLY (no release-notes machinery until public).
 * @param {Array<{title?:string,description?:string,status?:string}>} items
 * @returns {string} HTML ("" when there is nothing to show)
 */
export function renderRoadmapZone(items) {
  const rows = Array.isArray(items) ? items.filter((row) => row && row.title) : [];
  if (rows.length === 0) {
    return "";
  }
  const list = rows
    .map((row) => {
      const status = String(row.status || "").toLowerCase();
      const label = ROADMAP_STATUS_LABEL[status] || "";
      return `
        <li class="solo-roadmap-item">
          <span class="solo-roadmap-title">${escapeText(row.title)}</span>
          ${row.description ? `<span class="solo-roadmap-desc">${escapeText(row.description)}</span>` : ""}
          ${label ? `<span class="solo-roadmap-status solo-roadmap-status--${status}">${escapeText(label)}</span>` : ""}
        </li>
      `;
    })
    .join("");
  // TEASER: the right-rail zone shows a short cut of the roadmap and links out to
  // the full data-driven page (renderRoadmapPage). The link opens the in-app view
  // via uiState.showRoadmap (data-action="open-roadmap", wired in main.js).
  return `
    <aside class="solo-home-zone solo-home-zone-rail solo-home-zone-right solo-roadmap" aria-label="Roadmap">
      <span class="solo-home-zone-kicker">Roadmap</span>
      <ul class="solo-roadmap-list">${list}</ul>
      <button type="button" class="solo-roadmap-more" data-action="open-roadmap">See the full roadmap</button>
    </aside>
  `;
}
