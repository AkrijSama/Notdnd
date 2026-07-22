// Guest auth panel — the register ("Save your adventure", upgrade-in-place) AND
// the sign-in-to-an-existing-account paths for a player currently in a guest
// session. Extracted from main.js so the guest→login flow (the 2026-07-18
// dead-end fix) is unit-testable without a DOM. Pure string/logic builders only.

/**
 * The submit action follows the panel MODE only. Previously a guest was forced to
 * "register" regardless of mode (the `wasGuest` force in handleAuthSubmit), which
 * made the sign-in path unreachable for anyone already in a guest session. Now a
 * guest in login mode actually logs in; register stays the default (so the
 * "Save your adventure" upgrade-in-place path is unchanged).
 * @param {string} authMode
 * @returns {"login"|"register"}
 */
export function resolveAuthAction(authMode) {
  return authMode === "login" ? "login" : "register";
}

/**
 * Renders the guest auth panel for the given mode. In "login" mode it shows a
 * sign-in form with a prominent warning (signing into a different account leaves
 * the current guest run behind) that links back to the save-your-adventure flow.
 * In register mode it shows the save-your-adventure form plus a toggle to reach
 * sign-in without having to sign out first.
 * @param {string} authMode
 * @returns {string} HTML
 */
export function renderGuestAuthPanel(authMode) {
  if (resolveAuthAction(authMode) === "login") {
    return `
      <section class="module-card solo-guest-save-card">
        <div class="module-header">
          <h3>Sign in to your account</h3>
          <span class="tag">Playing as guest</span>
        </div>
        <p class="small solo-auth-warning" role="alert" data-testid="guest-login-warning">
          Signing in to a different account leaves this guest adventure behind. To keep
          <em>this</em> run instead,
          <button type="button" class="ghost linklike" data-action="auth-mode-register">save your adventure</button>.
        </p>
        <form id="auth-form" class="field">
          <input name="email" type="email" autocomplete="username" placeholder="email" required />
          <input name="password" type="password" autocomplete="current-password" placeholder="password" required />
          <button type="submit">Sign in</button>
        </form>
        <div class="inline">
          <button class="ghost" data-action="dismiss-auth">Keep playing as guest</button>
        </div>
      </section>
    `;
  }
  return `
    <section class="module-card solo-guest-save-card">
      <div class="module-header">
        <h3>Save your adventure</h3>
        <span class="tag">Playing as guest</span>
      </div>
      <p class="small">Create a free account to keep this adventure. Your progress stays exactly where it is.</p>
      <form id="auth-form" class="field">
        <input name="displayName" autocomplete="name" placeholder="Display Name" />
        <input name="email" type="email" autocomplete="username" placeholder="email" required />
        <input name="password" type="password" autocomplete="new-password" placeholder="password (min 8 chars)" required />
        <button type="submit">Save my adventure</button>
      </form>
      <div class="inline">
        <button class="ghost" data-action="auth-mode-login">Already have an account? Sign in</button>
        <button class="ghost" data-action="dismiss-auth">Keep playing as guest</button>
      </div>
    </section>
  `;
}
