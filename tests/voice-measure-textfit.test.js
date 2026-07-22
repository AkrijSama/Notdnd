import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  renderSoloSceneOpening,
  renderNarrationLog,
  renderLocationPanel,
  renderSoloSceneShell,
  renderSoloSceneInputBar,
  dispatchSoloClick,
  readHealedLogScale,
  readHealedVnScale,
  renderSoloCharacterSidebar,
  SOLO_LOG_SCALE_STORAGE_KEY,
  SOLO_VN_SCALE_STORAGE_KEY
} from "../src/components/soloSceneShell.js";

const css = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

// ---- voice-block-layout-fix: ONE measure rule for every prose block ----

test("VOICE opening (all variants) carries the shared measure class", () => {
  // WALK-3 V4: paced beats with NO committed speaker are GM narration (the VOICE's spoken
  // beats now route to the real VN box, not this prose renderer) — still the measure class.
  const paced = renderSoloSceneOpening("", ["First beat.", "Second beat."]);
  assert.match(paced, /solo-scene-opening solo-opening-paced solo-measure/);
  assert.match(paced, /The GM sets the scene/);
  assert.doesNotMatch(paced, /The VOICE speaks/, "no committed speaker → GM narration, not a VN look-alike");
  // paced beats WITH a committed speaker (the defensive direct-call frame) also carry it
  const withSpeaker = renderSoloSceneOpening("", ["Beat."], { npcId: "npc_voice", displayName: "The VOICE" });
  assert.match(withSpeaker, /solo-scene-opening solo-opening-paced solo-measure/);
  const plain = renderSoloSceneOpening("A single opening block.", null);
  assert.match(plain, /solo-scene-opening solo-measure/);
});

test("log entries and the location card carry the shared measure class", () => {
  const log = renderNarrationLog([{ id: "n1", intent: "look", text: "Quiet." }]);
  assert.match(log, /solo-log-entry has-action solo-measure/);
  const ambient = renderNarrationLog([{ id: "n1", intent: "", text: "Quiet." }]);
  assert.match(ambient, /solo-log-entry solo-measure/);
  const loc = renderLocationPanel({ name: "Tavern", description: "Old." });
  assert.match(loc, /solo-location-card solo-measure/);
});

test("styles.css defines the ONE measure rule: NO cap, left-anchored (owner overrule 2026-07-19)", () => {
  // Measure cap REMOVED (final): measure = container width − 32px padding, at every
  // width. max-width:none, left-anchored (margin-left:0, no auto-centering).
  assert.match(css, /\.solo-measure \{[^}]*max-width: none;[^}]*margin-left: 0;[^}]*margin-right: 0;[^}]*text-align: left;/s);
  assert.doesNotMatch(css, /\.solo-measure \{[^}]*max-width:\s*\d/s); // no px/ch cap
  assert.match(css, /\.solo-measure p \{[^}]*text-align: left;/s);
  // the root-cause shorthand: .solo-scene-opening horizontal margins stay auto so
  // the later .solo-measure longhands (left clamp / right auto) win the cascade
  const opening = css.match(/\.solo-scene-opening \{[^}]*\}/s)[0];
  assert.match(opening, /margin: 4px auto 14px/);
});

// ---- JOB 3: the VN dialogue box has its OWN sizer, decoupled from narration ----

test("VN dialogue text sizes on --solo-vn-scale, NOT the narration --solo-log-scale", () => {
  const vnRule = css.match(/\.solo-vn-box-text \{[^}]*\}/s)[0];
  const fontSizeDecl = vnRule.match(/font-size:[^;]*;/)[0];
  assert.match(fontSizeDecl, /var\(--solo-vn-scale, 1\)/, "VN text consumes --solo-vn-scale");
  assert.doesNotMatch(fontSizeDecl, /--solo-log-scale/, "VN text size no longer follows the narration control");
});

test("the VN sizer buttons render IN the VN box (data-solo-vnfont), not in the top-right chrome", () => {
  const shell = renderSoloSceneShell({
    scene: { location: { name: "T" }, cast: [{ npcId: "m", displayName: "Mara", portraitUri: "/m.png" }] },
    dialogueActive: true,
    talkResult: { npcId: "m", speakerName: "Mara", line: "Hi.", expression: "neutral", expressionVariants: {} }
  });
  // both buttons present, inside the VN box head-actions
  assert.match(shell, /solo-vn-box-head-actions/);
  assert.match(shell, /data-solo-vnfont="down"/);
  assert.match(shell, /data-solo-vnfont="up"/);
  // and the shell stamps the independent multiplier var the CSS consumes
  assert.match(shell, /--solo-vn-scale:/);
});

test("dispatch routes the VN sizer to onVnFontScale (independent of onLogFontScale)", () => {
  const vn = [];
  const log = [];
  dispatchSoloClick(
    { closest: (s) => (s === "[data-solo-vnfont]" ? { getAttribute: () => "up" } : null) },
    { onVnFontScale: (a) => vn.push(a), onLogFontScale: (a) => log.push(a) }
  );
  assert.deepEqual(vn, [{ dir: "up" }]);
  assert.deepEqual(log, [], "the VN control must not fire the narration handler");
});

test("readHealedVnScale self-heals like the narration sizer, on its OWN key", () => {
  const writes = [];
  const store = (val) => ({ getItem: () => val, setItem: (k, v) => writes.push([k, v]) });
  assert.equal(readHealedVnScale(store("9")), 1.6);
  assert.deepEqual(writes.pop(), [SOLO_VN_SCALE_STORAGE_KEY, "1.6"]);
  assert.equal(readHealedVnScale(store("garbage")), 1);
  assert.deepEqual(writes.pop(), [SOLO_VN_SCALE_STORAGE_KEY, "1"]);
  assert.equal(readHealedVnScale(store("1.2")), 1.2);
  assert.equal(writes.length, 0);
  assert.notEqual(SOLO_VN_SCALE_STORAGE_KEY, SOLO_LOG_SCALE_STORAGE_KEY, "distinct persistence keys");
});

// ---- JOB 2: the identity block lives in the player tab, not the always-on dock ----

test("Babel STATUS identity (name/level/tier) renders INSIDE the character tab, not the dock", () => {
  const html = renderSoloCharacterSidebar(
    { babel: { displayLevel: 1, milestoneTier: "Tier I — Local", rank: "UNASSESSED", origin: "The Beckoned" }, name: "Ash", hitPoints: { current: 5, max: 5 } },
    { open: true, scene: {} }
  );
  const identityIdx = html.indexOf("solo-dock-identity");
  const tabBodyIdx = html.indexOf("solo-char-tab-body");
  assert.ok(tabBodyIdx > -1, "the character tab body exists");
  assert.ok(identityIdx > tabBodyIdx, "the identity block is now inside the tab body, after it opens");
  // the portrait dock aside no longer carries the identity block as a direct always-on sibling
  const asideHead = html.slice(html.indexOf("solo-portrait-dock-aside"), tabBodyIdx);
  assert.doesNotMatch(asideHead, /solo-dock-identity/, "identity is not between the portrait and the tab anymore");
});

// ---- sizer: every prose surface consumes the multiplier ----

test("ALL prose surfaces consume --solo-log-scale (opening + location/gm prose included)", () => {
  const openingP = css.match(/\.solo-scene-opening p \{[^}]*\}/s)[0];
  assert.match(openingP, /var\(--solo-log-scale, 1\)/, "VOICE opening prose scales with A-/A+");
  const locP = css.match(/\.solo-scene-center \.solo-location-copy > p,\s*\.solo-scene-center \.solo-gm-narration p \{[^}]*\}/s)[0];
  assert.match(locP, /var\(--solo-log-scale, 1\)/, "location/GM prose scales with A-/A+");
  assert.match(css, /\.solo-scene-center \.solo-log-prose p \{[^}]*var\(--solo-log-scale, 1\)/s, "log prose scales");
});

test("sizer control pinned to the CURRENT DOM: buttons render, dispatch routes, target exists", () => {
  // buttons in the input bar
  const bar = renderSoloSceneInputBar({ attemptDraft: "" });
  assert.match(bar, /data-solo-logfont="down"/);
  assert.match(bar, /data-solo-logfont="up"/);
  // delegated dispatch still routes (the f3ae7eb orphaned-handler class)
  const dirs = [];
  dispatchSoloClick(
    { closest: (s) => (s === "[data-solo-logfont]" ? { getAttribute: () => "up" } : null) },
    { onLogFontScale: (a) => dirs.push(a) }
  );
  assert.deepEqual(dirs, [{ dir: "up" }]);
  // the handler's target selector (.solo-scene-shell) matches the shell root
  const shell = renderSoloSceneShell({ scene: { location: { name: "T" } } });
  assert.match(shell, /class="solo-scene-shell /);
  // and the shell stamps the multiplier var the CSS consumes
  assert.match(shell, /--solo-log-scale:/);
});

test("readHealedLogScale self-heals a stale/invalid persisted value", () => {
  const writes = [];
  const store = (val) => ({
    getItem: () => val,
    setItem: (k, v) => writes.push([k, v])
  });
  // out-of-range "9" → clamps to 1.6 AND writes the healed value back
  assert.equal(readHealedLogScale(store("9")), 1.6);
  assert.deepEqual(writes.pop(), [SOLO_LOG_SCALE_STORAGE_KEY, "1.6"]);
  // garbage → defaults to 1 and heals
  assert.equal(readHealedLogScale(store("garbage")), 1);
  assert.deepEqual(writes.pop(), [SOLO_LOG_SCALE_STORAGE_KEY, "1"]);
  // valid value → returned as-is, NO write
  assert.equal(readHealedLogScale(store("1.2")), 1.2);
  assert.equal(writes.length, 0);
  // nothing stored → default 1, no write
  assert.equal(readHealedLogScale(store(null)), 1);
  assert.equal(writes.length, 0);
});

// ---- item 3 (client-clearout): the input dock shares the ONE measure ----

test("the input bar carries the shared measure class — dock can never misalign from prose", () => {
  const bar = renderSoloSceneInputBar({ attemptDraft: "" });
  assert.match(bar, /class="solo-scene-input solo-measure"/);
  // the dock's horizontal inset matches the narration log's flat 32px (owner 2026-07-19)
  assert.match(css, /\.solo-input-dock \{[^}]*padding: 14px 32px 10px;/s);
  // the bespoke dock 75ch rule is gone — one measure rule governs both
  assert.doesNotMatch(css, /\.solo-input-dock \.solo-scene-input \{[^}]*max-width: 75ch/s);
});

// ---- turn-scroll phases (owner fix: GM-thinking must not reset to top) ----

test("turn-scroll policy: submit pins bottom ONCE, interim preserves, completion anchors newest", async () => {
  const { resolveTurnScrollMode } = await import("../src/components/soloSceneShell.js");
  // passive render (no live turn) → preserve the player's position
  assert.equal(resolveTurnScrollMode({ pending: false }), "restore");
  // submit render (turn pending, no new entry yet, not yet pinned) → bottom once
  assert.equal(resolveTurnScrollMode({ pending: true, freshEntry: false, submitScrolled: false }), "pin-bottom");
  // interim thinking renders (already pinned) → NEVER yank; preserve scroll
  assert.equal(resolveTurnScrollMode({ pending: true, freshEntry: false, submitScrolled: true }), "restore");
  // completion (the new log entry exists) → anchor ITS top (newest dialogue /
  // most recent player action), never the top of the whole text
  assert.equal(resolveTurnScrollMode({ pending: true, freshEntry: true, submitScrolled: true }), "anchor-newest");
  assert.equal(resolveTurnScrollMode({ pending: true, freshEntry: true, submitScrolled: false }), "anchor-newest");
});

// ---- dialogue colors: NPC light blue, VOICE (god) yellow ----

test("bracketed VOICE god-speech wraps in .solo-voice-dialogue; quoted NPC speech in .solo-dialogue", () => {
  const html = renderNarrationLog([
    { id: "n1", intent: "", text: '[ YOU ARE HEARD. ] The trees lean in. "Stay close to the fire," the barkeep says.' }
  ]);
  assert.match(html, /<span class="solo-voice-dialogue">\[ YOU ARE HEARD\. \]<\/span>/);
  assert.match(html, /<span class="solo-dialogue">.*Stay close to the fire.*<\/span>/);
});

test("CSS pins NPC dialogue LIGHT BLUE and VOICE dialogue YELLOW; VN line is NPC-blue", () => {
  assert.match(css, /\.solo-dialogue \{[^}]*color: #9ed6ff;/s, "NPC dialogue light blue");
  assert.match(css, /\.solo-voice-dialogue \{[^}]*color: #f5d76e;/s, "VOICE god-speech yellow");
  assert.match(css, /\.solo-vn-box-text \{[^}]*color: #9ed6ff;/s, "VN textbox speech light blue");
});

// ---- textFit: fixed-box text only, never prose ----

test("textFit vendor is a dependency-free ESM function", async () => {
  const mod = await import("../src/vendor/textFit.js");
  assert.equal(typeof mod.default, "function");
});

test("fixed-box text carries data-textfit; prose does NOT", () => {
  const shell = renderSoloSceneShell({
    scene: {
      location: { name: "Tavern" },
      cast: [{ npcId: "m", displayName: "Mara", portraitUri: "/m.png" }],
      attemptHistory: [{ intent: "x", checkResult: { total: 17, dc: 14, success: true } }]
    },
    dialogueActive: true,
    talkResult: { npcId: "m", speakerName: "Mara", line: "Hi.", expression: "neutral", expressionVariants: {} }
  });
  assert.match(shell, /solo-vn-box-speaker" data-textfit/, "VN speaker fits");
  assert.match(shell, /solo-cast-name" data-textfit/, "cast names fit");
  // NOTE: the local presence map's "Where you are" location label (.solo-presence-loc) was
  // REMOVED (owner ruling 2026-07-22) — redundant with the map itself. The REGION map keeps
  // its own .solo-presence-loc; textfit coverage is still asserted via the chips above/below.
  assert.match(shell, /solo-roll-total [^"]*" data-textfit/, "roll chips fit");
  // prose renderers never get fit-scaling
  const log = renderNarrationLog([{ id: "n1", intent: "", text: "Prose." }]);
  assert.doesNotMatch(log, /data-textfit/);
  assert.doesNotMatch(renderSoloSceneOpening("Opening prose.", null), /data-textfit/);
});
