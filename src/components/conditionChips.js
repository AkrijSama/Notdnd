// SHARED CONDITION-CHIP COMPONENT (owner ruling 2026-07-19). The condition-chip
// idiom — a solid dark contrast pill (glyph + optional count + tooltip), warn accent
// for debuffs / ok for buffs, 4px inset, cap + "+N" overflow — is used on the
// portrait dock AND will be reused by CLI 2's battle surface. It lives here as a
// SHARED component (markup + the `.solo-cond-chip cond-<kind>` CSS class contract in
// styles.css), not portrait-only styling, so both surfaces render one identical chip.
//
// Pure string builders. `kindMeta(kind)` and `formatDuration(min)` are injected by
// the caller (the portrait dock passes soloSceneShell's; the battle surface passes
// its own), so this module has NO dependency back on any specific surface.

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * One condition chip. `cond` = { id, name, kind, effect, stacks, permanent,
 * remainingMinutes }. opts.kindMeta(kind) → { glyph, word, order }; opts.knownKind
 * (kind) → boolean (else falls to "neutral"); opts.formatDuration(min) → string.
 */
export function renderConditionChip(cond, { compact = false, kindMeta, knownKind, formatDuration } = {}) {
  const rawKind = String(cond?.kind || "").toLowerCase();
  const kind = typeof knownKind === "function" && knownKind(rawKind) ? rawKind : "neutral";
  const meta = typeof kindMeta === "function" ? kindMeta(cond?.kind) : { glyph: "•", word: "" };
  const name = String(cond?.name || cond?.id || "");
  const duration = cond?.permanent ? "" : (typeof formatDuration === "function" ? formatDuration(cond?.remainingMinutes) : "");
  const remainText = cond?.permanent ? "Lasts until cleared." : duration ? `Time remaining: ${duration}.` : "";
  const tipBody = [String(cond?.effect || "").trim(), remainText].filter(Boolean).join(" ");
  return `
        <span class="solo-cond-chip cond-${kind}${compact ? " is-compact" : ""}" tabindex="0" data-cond-id="${esc(cond?.id || name)}" aria-label="${esc(`${name}. ${meta.word}. ${tipBody}`)}">
          <span class="solo-cond-glyph" aria-hidden="true">${meta.glyph}</span>
          ${Number(cond?.stacks) > 1 ? `<span class="solo-cond-count" aria-hidden="true">${esc(cond.stacks)}</span>` : ""}
          ${compact ? "" : `<span class="solo-cond-name">${esc(name)}</span>`}
          ${!compact && duration ? `<span class="solo-cond-time">${esc(duration)}</span>` : ""}
          <span class="solo-cond-tip" role="tooltip">
            <strong>${esc(name)} · ${meta.word}</strong>${tipBody ? `<span>${esc(tipBody)}</span>` : ""}
          </span>
        </span>`;
}

/**
 * A chip ROW: grouped by kind order, compact caps at `cap` visible with a "+N"
 * overflow pill (opts.overflowAction = the data-action attribute the pill carries).
 * Returns "" when there are no conditions (empty-state law). Returns { html } string.
 */
export function renderConditionChipRow(conditions, { compact = false, cap = 4, kindMeta, knownKind, formatDuration, overflowAttr = "data-solo-char-tab", wrapClass = "" } = {}) {
  const list = (Array.isArray(conditions) ? conditions : []).filter((c) => c && (c.name || c.id));
  if (!list.length) return "";
  const ordered = list
    .map((c, i) => ({ c, i, meta: typeof kindMeta === "function" ? kindMeta(c.kind) : { order: 0 } }))
    .sort((a, b) => (a.meta.order ?? 0) - (b.meta.order ?? 0) || a.i - b.i);
  const visible = compact ? ordered.slice(0, cap) : ordered;
  const overflow = compact ? ordered.length - visible.length : 0;
  const chips = visible.map(({ c }) => renderConditionChip(c, { compact, kindMeta, knownKind, formatDuration })).join("");
  const overflowChip = overflow > 0
    ? `<button type="button" class="solo-cond-chip is-compact solo-cond-overflow" ${overflowAttr} aria-label="${esc(`${overflow} more condition${overflow === 1 ? "" : "s"} — open character sheet`)}" title="${esc(`${overflow} more — open sheet`)}">+${overflow}</button>`
    : "";
  const cls = `solo-conditions${compact ? " solo-conditions-portrait" : wrapClass ? ` ${wrapClass}` : ""}`;
  return `<div class="${cls}" role="group" aria-label="Active conditions">${chips}${overflowChip}</div>`;
}
