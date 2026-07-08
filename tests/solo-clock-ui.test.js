import assert from "node:assert/strict";
import test from "node:test";

const { renderSoloClock, renderSoloRightRail } = await import("../src/components/soloSceneShell.js");

// #40 — the world clock (#14) is committed server-side and surfaced read-only in
// the right rail. The client never recomputes; it reads scene.player.worldTime.

test("renders committed time, phase and day from scene.player.worldTime", () => {
  const html = renderSoloClock({ player: { worldTime: { day: 2, clock: "14:30", phase: "day", isNight: false, isDark: false } } });
  assert.match(html, /14:30/, "shows the committed clock");
  assert.match(html, /Day/, "shows the phase label");
  assert.match(html, /Day 2/, "shows the day number");
  assert.match(html, /solo-clock-day/, "applies the day phase class");
  assert.match(html, /<circle/, "day uses the sun icon");
});

test("night renders the moon icon and night class", () => {
  const html = renderSoloClock({ player: { worldTime: { day: 1, clock: "23:10", phase: "night", isNight: true, isDark: true } } });
  assert.match(html, /solo-clock-night/);
  assert.match(html, /<path/, "night uses the crescent-moon path");
  assert.doesNotMatch(html, /<circle/, "night is not the sun");
  assert.match(html, /23:10/);
});

test("dawn and dusk get their own tint classes", () => {
  assert.match(renderSoloClock({ player: { worldTime: { day: 1, clock: "05:40", phase: "dawn" } } }), /solo-clock-dawn/);
  assert.match(renderSoloClock({ player: { worldTime: { day: 1, clock: "19:20", phase: "dusk" } } }), /solo-clock-dusk/);
});

test("falls back to scene.worldTime when player payload absent", () => {
  const html = renderSoloClock({ worldTime: { day: 1, clock: "08:00", phase: "day" } });
  assert.match(html, /08:00/);
});

test("renders nothing when no worldTime is present (older payloads)", () => {
  assert.equal(renderSoloClock({ player: {} }), "");
  assert.equal(renderSoloClock({}), "");
});

test("unknown phase degrades to day rather than breaking", () => {
  const html = renderSoloClock({ player: { worldTime: { day: 1, clock: "12:00", phase: "eclipse" } } });
  assert.match(html, /solo-clock-day/);
});

test("the right rail includes the clock block when worldTime is present", () => {
  const html = renderSoloRightRail({ scene: { player: { worldTime: { day: 1, clock: "07:00", phase: "dawn" } }, cast: [] } });
  assert.match(html, /solo-rail-clock/, "clock block is in the rail");
  assert.match(html, /07:00/);
});

test("the right rail omits the clock block for payloads without worldTime", () => {
  const html = renderSoloRightRail({ scene: { cast: [] } });
  assert.doesNotMatch(html, /solo-rail-clock/);
});
