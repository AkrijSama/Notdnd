// Header brand lockup: the mark (src/assets/logo.svg) left of the title. Extracted
// from main.js so both header states (guest + logged-in) share ONE brand and it's
// unit-testable. The mark is a fixed-size <i> painted via a CSS mask, so it recolors
// with `currentColor` (theme-inverts: paper-light on the dark header, ink-dark on
// light surfaces) and reserves its box → no layout shift. It is an <i> (not a
// <span>) so the `.brand span` text styling never touches it. The wordmark stays the
// accessible name; the mark is decorative (aria-hidden).
//
// T1: the whole lockup is a LINK back to the landing/home (role=link, keyboard-
// reachable, data-action="go-home"; cursor + hover via .brand--home). The go-home
// handler confirms first when there is in-progress work (see homeNav.shouldConfirmHomeNav).
// `interactive:false` renders the plain (non-clickable) lockup for any static context.
export function renderBrand({ interactive = true } = {}) {
  const inner = `
      <i class="brand-logo" aria-hidden="true"></i>
      <div class="brand-text">
        <h1>Inkborne</h1>
        <span>AI RPG</span>
      </div>`;
  if (!interactive) {
    return `
    <div class="brand">${inner}
    </div>
  `;
  }
  return `
    <div class="brand brand--home" data-action="go-home" role="link" tabindex="0" aria-label="Go to the home screen">${inner}
    </div>
  `;
}
