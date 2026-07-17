import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSoloRun, validateSoloRun, WORLD_WEATHER_VALUES } from "../server/solo/schema.js";
import { deriveWeather } from "../server/solo/worldClock.js";
import { buildSoloScenePayload } from "../server/solo/scene.js";
import { renderSoloClock } from "../src/components/soloSceneShell.js";

function skyHazard(run, state) {
  const loc = run.locations[run.currentLocationId];
  loc.flags.objectStates = {
    "the-sky": {
      objectId: "the-sky", label: "the sky", state, retryEffect: "harder",
      reason: "test hazard", matchTokens: ["sky"], targetId: null, sourceIntent: "", since: new Date().toISOString()
    }
  };
}

// ── schema + defaults ────────────────────────────────────────────────────────

test("weather enum validates; bogus rejects; new mint defaults clear", () => {
  const run = createDefaultSoloRun({ runId: "run_wx" });
  assert.equal(run.world.weather, "clear");
  assert.equal(validateSoloRun(run).ok, true);
  for (const w of WORLD_WEATHER_VALUES) {
    run.world.weather = w;
    assert.equal(validateSoloRun(run).ok, true, w);
  }
  run.world.weather = "hurricane";
  assert.equal(validateSoloRun(run).ok, false);
});

test("legacy save (no weather field) stays valid and derives clear — resume-safe", () => {
  const run = createDefaultSoloRun({ runId: "run_wx_legacy" });
  delete run.world.weather;
  assert.equal(validateSoloRun(run).ok, true);
  assert.equal(deriveWeather(run), "clear");
});

// ── derived read + overlay precedence ────────────────────────────────────────

test("derived read: persistent value when no sky hazard stands", () => {
  const run = createDefaultSoloRun({ runId: "run_wx_base" });
  run.world.weather = "cloudy";
  assert.equal(deriveWeather(run), "cloudy");
});

test("overlay precedence: an active sky hazard beats the persistent value", () => {
  const run = createDefaultSoloRun({ runId: "run_wx_storm" });
  run.world.weather = "clear";
  skyHazard(run, "storm-breaking"); // tonight's committed momentum convention
  assert.equal(deriveWeather(run), "storm");
  skyHazard(run, "fogbound");
  assert.equal(deriveWeather(run), "fog");
  // An unrecognized sky state falls through to the persistent value.
  skyHazard(run, "weird-shimmer");
  run.world.weather = "snow";
  assert.equal(deriveWeather(run), "snow");
});

test("a sky hazard on a DIFFERENT location does not overlay here", () => {
  const run = createDefaultSoloRun({ runId: "run_wx_elsewhere" });
  run.world.weather = "clear";
  const other = "loc_elsewhere";
  run.locations[other] = { ...run.locations[run.currentLocationId], locationId: other, name: "Elsewhere", flags: { objectStates: { "the-sky": { objectId: "the-sky", label: "the sky", state: "storm-breaking", retryEffect: "none", reason: "", matchTokens: [], targetId: null, sourceIntent: "", since: new Date().toISOString() } } }, exits: [] };
  assert.equal(deriveWeather(run), "clear");
});

// ── scene payload ────────────────────────────────────────────────────────────

test("scene payload carries the derived weather on worldTime", () => {
  const run = createDefaultSoloRun({ runId: "run_wx_payload" });
  const clear = buildSoloScenePayload(run);
  assert.equal(clear.ok, true);
  assert.equal(clear.player.worldTime.weather, "clear");
  skyHazard(run, "storm-breaking");
  const storm = buildSoloScenePayload(run);
  assert.equal(storm.player.worldTime.weather, "storm");
});

// ── time icon render (string-based, per house pattern) ──────────────────────

function sceneWith(weather) {
  return { player: { worldTime: { day: 1, clock: "07:00", phase: "day", minuteOfDay: 420, weather } } };
}

test("icon: each weather state renders its glyph beside the phase icon", () => {
  for (const w of ["cloudy", "rain", "storm", "snow", "fog"]) {
    const html = renderSoloClock(sceneWith(w));
    assert.match(html, new RegExp(`solo-clock-wx-${w}`), w);
    assert.match(html, new RegExp(`data-solo-weather="${w}"`), w);
    assert.match(html, /solo-clock-icon/, "phase icon still present");
  }
});

test("icon: clear (and legacy payloads without weather) render no weather glyph", () => {
  const clear = renderSoloClock(sceneWith("clear"));
  assert.doesNotMatch(clear, /solo-clock-wx/);
  const legacy = renderSoloClock({ player: { worldTime: { day: 1, clock: "07:00", phase: "day" } } });
  assert.doesNotMatch(legacy, /solo-clock-wx/);
  assert.match(legacy, /solo-clock-icon/);
});

test("icon: weather label joins the phase line and the aria string", () => {
  const html = renderSoloClock(sceneWith("rain"));
  assert.match(html, /Day · Rain/);
  assert.match(html, /aria-label="Time 07:00, Day, rain, day 1"/);
});
