import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  renderSoloDialogueOverlay,
  renderNarrationLog,
  renderSoloSceneInputBar,
  dispositionCueText,
  normalizeTextSpeed,
  VN_TEXT_SPEEDS,
  VN_TEXT_SPEED_ORDER,
  SOLO_TEXT_SPEED_STORAGE_KEY
} from "../src/components/soloSceneShell.js";

const CSS = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const SRC = readFileSync(new URL("../src/components/soloSceneShell.js", import.meta.url), "utf8");

function vnState(talk = {}, scene = {}, extra = {}) {
  return {
    dialogueActive: true,
    dialogueTyped: true,
    scene: { cast: [], ...scene },
    talkResult: { npcId: "npc_mira", speakerName: "Mira", line: "Hm.", found: true, ...talk },
    ...extra
  };
}

// ── BUILD A.2: sprite identity is committed-state-driven ─────────────────────

test("A.2: while VN is active the sprite keys off scene.speakerId, not the client talk target", () => {
  const scene = {
    vnMode: true,
    speakerId: "npc:npc_vex",
    cast: [
      { npcId: "npc_mira", displayName: "Mira", portraitUri: "/img/mira.png" },
      { npcId: "npc_vex", displayName: "Vex", portraitUri: "/img/vex.png" }
    ]
  };
  // Stale client talk target says Mira; the server's committed speaker is Vex.
  const html = renderSoloDialogueOverlay(vnState({ npcId: "npc_mira" }, scene));
  assert.match(html, /src="\/img\/vex\.png"/, "sprite follows the committed speaker");
  assert.doesNotMatch(html, /src="\/img\/mira\.png"/);
});

test("A.2: outside VN mode the server-resolved talk target still drives the sprite", () => {
  const scene = { vnMode: false, cast: [{ npcId: "npc_mira", displayName: "Mira", portraitUri: "/img/mira.png" }] };
  const html = renderSoloDialogueOverlay(vnState({ npcId: "npc_mira" }, scene));
  assert.match(html, /src="\/img\/mira\.png"/);
});

test("A.1: no committed portrait and no vnBody → empty sprite state (no placeholder stranger)", () => {
  const html = renderSoloDialogueOverlay(vnState({}, { vnMode: true, speakerId: "npc_mira", cast: [{ npcId: "npc_mira", displayName: "Mira" }] }));
  assert.doesNotMatch(html, /solo-vn-sprite/);
});

// ── LAW 3: VISIBLE CONSEQUENCE ───────────────────────────────────────────────

test("law3: dispositionCueText derives only from the committed delta", () => {
  assert.equal(dispositionCueText({ targetName: "Mira", meter: "fear", delta: 3 }), "Mira seems warier of you.");
  assert.equal(dispositionCueText({ targetName: "Mira", meter: "trust", delta: 3 }), "Mira seems to trust you a little more.");
  assert.equal(dispositionCueText({ targetName: "Mira", meter: "trust", delta: -2 }), "Mira seems to trust you less.");
  // Failure shape: no primary movement, suspicion rose.
  assert.equal(dispositionCueText({ targetName: "Mira", meter: "trust", delta: 0, suspicionDelta: 2 }), "Mira eyes you with fresh suspicion.");
  // No committed movement → no cue; no name → no cue.
  assert.equal(dispositionCueText({ targetName: "Mira", meter: "trust", delta: 0 }), "");
  assert.equal(dispositionCueText({ meter: "trust", delta: 3 }), "");
  assert.equal(dispositionCueText(null), "");
});

test("law3: the overlay renders the cue as a one-line italic element for the active speaker only", () => {
  const scene = { vnMode: true, speakerId: "npc_mira", cast: [{ npcId: "npc_mira", displayName: "Mira", portraitUri: "/img/mira.png" }] };
  const withCue = renderSoloDialogueOverlay(
    vnState({}, scene, { dispositionCue: { npcId: "npc_mira", text: "Mira seems warier of you." } })
  );
  assert.match(withCue, /class="solo-vn-cue"[^>]*>Mira seems warier of you\./);
  // A cue for a DIFFERENT NPC never renders on this speaker's box.
  const wrongNpc = renderSoloDialogueOverlay(
    vnState({}, scene, { dispositionCue: { npcId: "npc_vex", text: "Vex seems warier of you." } })
  );
  assert.doesNotMatch(wrongNpc, /solo-vn-cue/);
  // Styling is committed in CSS: italic, quiet.
  assert.match(CSS, /\.solo-vn-cue\s*\{[^}]*font-style:\s*italic/s);
});

// ── LAW 4a: TEXT SPEED ───────────────────────────────────────────────────────

test("law4a: speed table + normalize + storage key follow the sizer pattern", () => {
  assert.deepEqual(VN_TEXT_SPEED_ORDER, ["slow", "normal", "fast", "instant"]);
  assert.equal(VN_TEXT_SPEEDS.normal, 10); // UI-10: was 30 (a crawl); much faster
  assert.equal(VN_TEXT_SPEEDS.instant, 0);
  assert.equal(normalizeTextSpeed("fast"), "fast");
  assert.equal(normalizeTextSpeed("warp"), "normal");
  assert.equal(normalizeTextSpeed(undefined), "normal");
  assert.equal(SOLO_TEXT_SPEED_STORAGE_KEY, "notdnd.solo.textSpeed");
});

test("law4a: the input bar renders the cycling control with the current speed", () => {
  const html = renderSoloSceneInputBar({ textSpeed: "fast" });
  assert.match(html, /data-solo-textspeed/);
  assert.match(html, /Aa·fast/);
  // Unset state falls back to normal.
  assert.match(renderSoloSceneInputBar({}), /Aa·normal/);
});

test("law4a: the typewriter reads the persisted speed and instant skips the reveal", () => {
  // Source-level contract: the bind reads the persisted setting per bind and
  // the instant branch finishes without a reveal loop.
  assert.match(SRC, /vnCharMs = \(\) => VN_TEXT_SPEEDS\[normalizeTextSpeed\(readSoloThemePref\(SOLO_TEXT_SPEED_STORAGE_KEY/);
  assert.match(SRC, /charMs <= 0\) \{\s*\n\s*\/\/ Instant: no reveal loop at all/);
});

// ── LAW 4b: VERBATIM REPLAY IN THE LOG ───────────────────────────────────────

test("law4b: a vn transcript entry renders with a speaker plate and the verbatim quoted line", () => {
  const html = renderNarrationLog([
    { id: "n1", kind: "vn", role: "npc", speaker: "Mira", text: "Not for you. Not ever." },
    { id: "n2", kind: "vn", role: "player", speaker: "You", text: "I need that key." }
  ]);
  assert.match(html, /solo-log-vn/);
  assert.match(html, /<div class="solo-log-speaker">Mira<\/div>/);
  assert.match(html, /“Not for you\. Not ever\.”/);
  assert.match(html, /<div class="solo-log-speaker">You<\/div>/);
  assert.match(html, /“I need that key\.”/);
});

test("law4b: the dialogue handlers push every spoken line into the narration log", () => {
  // Source-level contract: all four spoken-line paths feed the transcript —
  // manual Talk, the auto-open speech path, the player's reply, the NPC's reply.
  const pushes = SRC.match(/pushVnLogEntry\(\{ role:/g) || [];
  assert.ok(pushes.length >= 4, `expected >=4 pushVnLogEntry sites, found ${pushes.length}`);
  assert.match(SRC, /pushVnLogEntry\(\{ role: "player", speaker: "You", text: reply \}\)/);
});
