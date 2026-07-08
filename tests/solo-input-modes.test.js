import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyInput,
  createAttemptAction,
  renderNarrationLog,
  renderSoloSceneInputBar,
  renderSoloSceneShell,
  renderSoloThinkingIndicator,
  resolveSceneSpeaker,
  soleSceneSpeaker,
  SOLO_INPUT_MAXLEN,
  SOLO_INPUT_MODE_META
} from "../src/components/soloSceneShell.js";

function stagePatchScene() {
  return {
    ok: true,
    runId: "run_test",
    location: { locationId: "loc1", name: "The Hollow", description: "x", state: {}, tags: [], contentTags: [] },
    visibleEntities: [],
    availableActions: [],
    availableMoves: [],
    recentTimeline: [],
    quests: {},
    player: { displayName: "V", resources: { hitPoints: { current: 8, max: 10 } } }
  };
}

// ---- #37/#38: input classification ----

test("classifyInput: plain text is an ACTION with intent unchanged", () => {
  const r = classifyInput("open the door");
  assert.equal(r.mode, "action");
  assert.equal(r.intent, "open the door");
});

test("classifyInput: leading quote is SPEECH and KEEPS the quotes", () => {
  for (const raw of ['"Hello there"', "“Who goes?”", "'stand down'"]) {
    const r = classifyInput(raw);
    assert.equal(r.mode, "speech", `${raw} should be speech`);
    assert.equal(r.intent, raw.trim(), "speech keeps its quotes so the GM sees it spoken");
  }
});

test("classifyInput: /ooc is OOC and STRIPS the marker", () => {
  const r = classifyInput("/ooc can I retry that check?");
  assert.equal(r.mode, "ooc");
  assert.equal(r.intent, "can I retry that check?");
});

test("classifyInput: bare /ooc yields empty intent (submit no-ops)", () => {
  const r = classifyInput("/ooc");
  assert.equal(r.mode, "ooc");
  assert.equal(r.intent, "");
});

test("classifyInput: a lone quote char is not treated as speech", () => {
  const r = classifyInput('"');
  assert.equal(r.mode, "action");
});

// ---- #37/#38: the mode travels with the action payload ----

test("createAttemptAction carries the classified mode; defaults to action", () => {
  assert.equal(createAttemptAction({ intent: "x", mode: "speech" }).mode, "speech");
  assert.equal(createAttemptAction({ intent: "x" }).mode, "action");
  // still a well-formed attempt action
  const a = createAttemptAction({ intent: "look" });
  assert.equal(a.type, "attempt");
  assert.equal(a.intent, "look");
});

// ---- #39: char counter + limit ----

test("input bar renders the char counter against the 500-char limit", () => {
  assert.equal(SOLO_INPUT_MAXLEN, 500);
  const html = renderSoloSceneInputBar({ attemptDraft: "hello" });
  assert.match(html, /data-solo-charcount/);
  assert.match(html, /5\/500/);
  assert.match(html, /maxlength="500"/);
});

test("input bar reflects the current draft's mode in the chip", () => {
  const speech = renderSoloSceneInputBar({ attemptDraft: '"hi"' });
  assert.match(speech, /solo-input-mode--speech/);
  assert.match(speech, new RegExp(SOLO_INPUT_MODE_META.speech.label));
  const ooc = renderSoloSceneInputBar({ attemptDraft: "/ooc test" });
  assert.match(ooc, /solo-input-mode--ooc/);
  const action = renderSoloSceneInputBar({ attemptDraft: "walk north" });
  assert.match(action, /solo-input-mode--action/);
});

// ---- #20-full: multi-NPC speaker resolution ----

test("resolveSceneSpeaker names the active VN speaker even with 2+ NPCs present", () => {
  const scene = {
    speakerId: "npc:mira",
    cast: [
      { npcId: "mira", displayName: "Mira" },
      { npcId: "hob", displayName: "Hob" }
    ]
  };
  // soleSceneSpeaker goes silent with 2 NPCs...
  assert.equal(soleSceneSpeaker(scene), null);
  // ...but the resolver uses speakerId -> cast displayName.
  assert.equal(resolveSceneSpeaker(scene, null), "Mira");
});

test("resolveSceneSpeaker prefers the NPC who just spoke this turn (talkResult)", () => {
  const scene = {
    speakerId: "npc:mira",
    cast: [
      { npcId: "mira", displayName: "Mira" },
      { npcId: "hob", displayName: "Hob" }
    ]
  };
  assert.equal(resolveSceneSpeaker(scene, { npcId: "hob", speakerName: "Hob" }), "Hob");
});

test("resolveSceneSpeaker falls back to the sole NPC when nothing else names a speaker", () => {
  const scene = { cast: [{ npcId: "solo", displayName: "The Hermit" }] };
  assert.equal(resolveSceneSpeaker(scene, null), "The Hermit");
});

// ---- #15: the turn fast-path's DOM anchors + thinking indicator ----
// Structural guards for the in-place patch (the painted-DOM node-preservation is
// verified live in-browser). If any of these anchors move/rename, the fast-path
// silently falls back to a full rebuild — these lock them in place.

test("#15: the scene stage exposes the stable patch anchors", () => {
  const html = renderSoloSceneShell({ scene: stagePatchScene(), narrationLog: [{ id: "n1", text: "A beat." }] });
  assert.match(html, /data-solo-log/, "narration log container (append target)");
  assert.match(html, /data-solo-outcome/, "outcome-strip wrapper (in-place repaint)");
  assert.match(html, /data-solo-dock-status/, "thinking-indicator wrapper (in-place toggle)");
  assert.match(html, /data-solo-attempt-input/, "the persistent input node");
});

// ---- #20-full CROSS-WIRE: server dialogueLines -> client nameplates ----

test("renderNarrationLog nameplates each grounded NPC from the server's dialogueLines", () => {
  const html = renderNarrationLog([
    {
      id: "n1",
      text: '“We should go,” said Mira. “Not yet,” Hob answered.',
      dialogueLines: [
        { text: "We should go", speakerId: "mira", speakerName: "Mira", kind: "npc" },
        { text: "Not yet", speakerId: "hob", speakerName: "Hob", kind: "npc" }
      ]
    }
  ]);
  assert.match(html, /solo-log-speakers/, "multi-speaker plate row");
  assert.match(html, /Mira/);
  assert.match(html, /Hob/);
});

test("renderNarrationLog ignores player/unknown lines and never invents a name", () => {
  const html = renderNarrationLog([
    {
      id: "n1",
      text: '“Hello?” you call. “...” someone whispers.',
      speaker: null,
      dialogueLines: [
        { text: "Hello?", speakerId: null, speakerName: "Vesh", kind: "player" },
        { text: "...", speakerId: null, speakerName: "a voice", kind: "unknown" }
      ]
    }
  ]);
  assert.doesNotMatch(html, /solo-log-speakers/, "no NPC plate for player/unknown-only lines");
  assert.doesNotMatch(html, /a voice/, "an ungrounded name is never shown as a plate");
});

test("renderNarrationLog falls back to single-speaker attribution when dialogueLines is empty", () => {
  const html = renderNarrationLog([
    { id: "n1", text: '“Welcome,” she says.', speaker: "The Hermit", dialogueLines: [] }
  ]);
  assert.match(html, /solo-log-speaker/);
  assert.match(html, /The Hermit/);
});

test("#15: the thinking indicator is empty when idle, present while working", () => {
  assert.equal(renderSoloThinkingIndicator({}), "");
  assert.match(renderSoloThinkingIndicator({ gmThinking: true }), /GM is thinking/);
  assert.match(renderSoloThinkingIndicator({ sceneReloading: true }), /Loading scene/);
  // the wrapper is always in the DOM (so the fast-path can toggle it) but carries
  // no stale ".solo-thinking" node when idle
  const idle = renderSoloSceneShell({ scene: stagePatchScene(), narrationLog: [{ id: "n1", text: "x" }] });
  assert.match(idle, /data-solo-dock-status/);
  assert.doesNotMatch(idle, /solo-thinking/);
});
