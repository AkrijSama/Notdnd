// GUEST → SIGN-IN PATH (2026-07-18 login dead-end fix). A guest could only ever
// register ("Save your adventure"); the working sign-in form was unreachable
// without signing out first. renderGuestAuthPanel now serves both modes and
// resolveAuthAction no longer forces register for a guest.
import assert from "node:assert/strict";
import test from "node:test";
import { renderGuestAuthPanel, resolveAuthAction } from "../src/components/authPanel.js";

test("resolveAuthAction: login mode logs in (the wasGuest force is gone)", () => {
  assert.equal(resolveAuthAction("login"), "login");
  assert.equal(resolveAuthAction("register"), "register");
  assert.equal(resolveAuthAction(""), "register", "default is register (save-your-adventure)");
});

test("guest register panel: reachable sign-in toggle WITHOUT signing out", () => {
  const html = renderGuestAuthPanel("register");
  assert.match(html, /Save your adventure/);
  assert.match(html, /data-action="auth-mode-login"/, "an in-panel toggle reaches login");
  assert.match(html, /Already have an account\? Sign in/);
  assert.match(html, /Save my adventure/, "register form/CTA still present (path unchanged)");
});

test("guest login panel: sign-in form + warning that links back to save-your-adventure", () => {
  const html = renderGuestAuthPanel("login");
  assert.match(html, /Sign in to your account/);
  assert.match(html, /solo-auth-warning/, "the warning renders");
  assert.match(html, /leaves this guest adventure behind/, "warns the guest run is left behind");
  assert.match(html, /data-action="auth-mode-register"/, "warning links back to save-your-adventure");
  assert.match(html, /<button type="submit">Sign in<\/button>/);
  assert.doesNotMatch(html, /Save my adventure/, "login mode is not the register form");
});
