// Header brand lockup: the mark (src/assets/logo.svg) left of the title. Extracted
// from main.js so both header states (guest + logged-in) share ONE brand and it's
// unit-testable. The mark is a fixed-size <i> painted via a CSS mask, so it recolors
// with `currentColor` (theme-inverts: paper-light on the dark header, ink-dark on
// light surfaces) and reserves its box → no layout shift. It is an <i> (not a
// <span>) so the `.brand span` text styling never touches it. The wordmark stays the
// accessible name; the mark is decorative (aria-hidden).
export function renderBrand() {
  return `
    <div class="brand">
      <i class="brand-logo" aria-hidden="true"></i>
      <div class="brand-text">
        <h1>Inkborne</h1>
        <span>AI RPG</span>
      </div>
    </div>
  `;
}
