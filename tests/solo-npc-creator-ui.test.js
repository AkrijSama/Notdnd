import assert from "node:assert/strict";
import test from "node:test";
import {
  characterFromScenePlayer,
  renderNpcCreatorModal,
  renderSoloDialogueOverlay,
  renderSoloRightRail,
  renderSoloRollBanner,
  renderSoloRollHistory,
  renderSoloSceneInputBar,
  renderSoloSceneShell
} from "../src/components/soloSceneShell.js";

test("characterFromScenePlayer maps run.player into the sidebar shape", () => {
  const c = characterFromScenePlayer({
    displayName: "Nyx",
    className: "Knight",
    level: 2,
    hitPoints: { current: 7, max: 12 },
    armorClass: null,
    speed: null,
    abilities: { strength: 14, dexterity: 12, constitution: 10, intelligence: 8, wisdom: 13, charisma: 10 },
    skills: { perception: 3 }
  });
  assert.equal(c.name, "Nyx");
  assert.equal(c.className, "Knight");
  assert.equal(c.level, 2);
  assert.deepEqual(c.hitPoints, { current: 7, max: 12 });
  assert.equal(c.armorClass, 10); // null -> sensible default
  assert.equal(c.speed, 30);
  const str = c.abilities.find((a) => a.key === "STR");
  assert.equal(str.score, 14);
  assert.equal(str.mod, "+2");
  const int = c.abilities.find((a) => a.key === "INT");
  assert.equal(int.mod, "-1"); // floor((8-10)/2)
  assert.equal(c.passivePerception, 11); // 10 + WIS(13)->+1
  assert.equal(c.initiative, "+1"); // DEX(12)->+1
  assert.ok(c.skills.some((s) => s.name === "Perception" && s.mod === "+3"));
  assert.equal(characterFromScenePlayer(null), null);
});

test("rolls surface via the banner + history, not the right rail (ui restructure)", () => {
  // The recent-rolls RAIL panel was removed; the rail must no longer carry rolls.
  const rail = renderSoloRightRail({
    scene: { attemptHistory: [{ intent: "pick the lock", success: true, checkResult: { total: 17, dc: 14, success: true } }] }
  });
  assert.ok(!rail.includes("Recent Rolls"), "the rail no longer holds a Recent Rolls panel");
  assert.ok(!/pick the lock/.test(rail), "roll intents don't render in the rail");

  // The banner surfaces the latest roll; the history drawer lists them.
  const banner = renderSoloRollBanner({ attemptHistory: [{ intent: "pick the lock", checkResult: { total: 17, dc: 14, success: true } }] });
  assert.match(banner, /pick the lock/);
  assert.match(banner, /17/);
  const history = renderSoloRollHistory({ attemptHistory: [{ intent: "pick the lock", checkResult: { total: 17, dc: 14, success: true } }] }, true);
  assert.match(history, /pick the lock/);
  assert.match(history, /vs DC 14/);
  assert.match(renderSoloRollBanner({}), /^$/, "no rolls yet → no banner");
});

const dialogueState = (talkOverrides, cast = []) => ({
  dialogueActive: true,
  scene: { cast },
  talkResult: {
    npcId: "vex",
    speakerName: "Vex",
    expression: "neutral",
    line: "Well met.",
    expressionVariants: {},
    ...talkOverrides
  }
});

test("VN overlay uses the expression variant when present", () => {
  const html = renderSoloDialogueOverlay(
    dialogueState({ expressionVariants: { neutral: "/v/neutral.png" } }, [{ npcId: "vex", portraitUri: "/v/base.png" }])
  );
  assert.match(html, /src="\/v\/neutral.png"/);
});

test("VN overlay falls back to the base portrait when the variant is missing", () => {
  const html = renderSoloDialogueOverlay(
    dialogueState({ expressionVariants: {} }, [{ npcId: "vex", portraitUri: "/v/base.png" }])
  );
  assert.match(html, /src="\/v\/base.png"/);
  assert.doesNotMatch(html, /Portrait incoming/);
});

test("VN overlay renders an EMPTY sprite slot (no glyph, no placeholder) when there is no image", () => {
  const html = renderSoloDialogueOverlay(dialogueState({ expressionVariants: {} }, []));
  // vn-sprite-slot: the "S" glyph + "Portrait incoming…" placeholder are gone — an
  // empty slot shows nothing (no glyph, no grey box), and the container is omitted.
  assert.doesNotMatch(html, /Portrait incoming/);
  assert.doesNotMatch(html, /solo-vn-portrait-placeholder/);
  assert.doesNotMatch(html, /solo-vn-sprite-img/);
  assert.doesNotMatch(html, /class="solo-vn-sprite"/);
  // …but the dialogue textbox itself is unchanged.
  assert.match(html, /class="solo-vn-box"/);
});

// #49: the VN layer is now IN-STAGE (sprite + textbox), not a floating modal.
test("#49 VN layer renders an in-stage sprite + textbox, NOT a dimming modal", () => {
  const html = renderSoloDialogueOverlay(dialogueState({}, [{ npcId: "vex", portraitUri: "/v/base.png" }]));
  assert.match(html, /class="solo-vn-sprite"/, "NPC renders as an in-stage sprite");
  assert.match(html, /class="solo-vn-box"/, "dialogue is a stage textbox");
  assert.doesNotMatch(html, /solo-vn-overlay|solo-vn-backdrop/, "no full-screen modal / dimming backdrop");
  assert.doesNotMatch(html, /aria-modal/, "not a modal dialog");
});

test("#49 VN layer preserves the typewriter / reply / end hooks", () => {
  const html = renderSoloDialogueOverlay(dialogueState({ line: "Well met." }, []));
  assert.match(html, /data-solo-dialogue-panel/, "panel hook (skip-typewriter) present");
  assert.match(html, /data-solo-dialogue-text[^>]*data-fulltext="Well met\."/, "typewriter target + fulltext");
  assert.match(html, /data-solo-dialogue-reply-input/, "reply input hook");
  assert.match(html, /data-solo-dialogue-reply-submit/, "reply submit hook");
  assert.match(html, /data-solo-dialogue-end/, "end hook");
});

test("#49 VN layer is empty when no conversation is active", () => {
  assert.equal(renderSoloDialogueOverlay({ dialogueActive: false }), "");
  assert.equal(renderSoloDialogueOverlay({ dialogueActive: true, talkResult: null }), "");
});

test("#49 the pinned stage gets vn-active and hosts the layer during dialogue", () => {
  const html = renderSoloSceneShell({
    scene: { runId: "run_x", location: { name: "Tavern" }, cast: [{ npcId: "vex", portraitUri: "/v/base.png" }] },
    dialogueActive: true,
    talkResult: { npcId: "vex", speakerName: "Vex", line: "Well met.", expression: "neutral", expressionVariants: {} }
  });
  assert.match(html, /solo-stage vn-active/, "stage flagged vn-active");
  assert.match(html, /class="solo-vn-box"/, "VN textbox is inside the shell/stage");
});

test("renderNpcCreatorModal is empty when closed", () => {
  assert.equal(renderNpcCreatorModal({}), "");
  assert.equal(renderNpcCreatorModal({ npcCreator: { open: false } }), "");
});

test("renderNpcCreatorModal renders the 3 fields and repopulates from state", () => {
  const html = renderNpcCreatorModal({
    npcCreator: {
      open: true,
      mode: "upload",
      name: "Vex",
      description: "a sly fence",
      introInstructions: "slips in through the back"
    }
  });
  assert.match(html, /Bring someone in/);
  assert.match(html, /data-solo-npc-file/);
  assert.match(html, /data-solo-npc-imagine/);
  assert.match(html, /data-solo-npc-name/);
  assert.match(html, /data-solo-npc-desc/);
  assert.match(html, /data-solo-npc-intro/);
  assert.match(html, /data-solo-npc-submit/);
  assert.match(html, /value="Vex"/);
  assert.match(html, /a sly fence/);
  assert.match(html, /slips in through the back/);
});

test("renderNpcCreatorModal reflects imagine mode, loading, and error", () => {
  const imagine = renderNpcCreatorModal({ npcCreator: { open: true, mode: "imagine" } });
  assert.match(imagine, /data-solo-npc-imagine checked/);
  assert.match(imagine, /data-solo-npc-file disabled/);

  const loading = renderNpcCreatorModal({ npcCreator: { open: true, loading: true } });
  assert.match(loading, /The GM is preparing to introduce them/);
  assert.match(loading, /data-solo-npc-submit disabled/);

  const errored = renderNpcCreatorModal({ npcCreator: { open: true, error: "Too big" } });
  assert.match(errored, /Too big/);
});

test("input bar has NO bring-in trigger (#22 removed) but still shows confirmation", () => {
  const bar = renderSoloSceneInputBar({});
  // #22: the orphaned "+ Bring someone in" multiplayer stub is gone from the
  // solo input bar. The free-text input is the whole interface.
  assert.ok(!/data-solo-npc-create/.test(bar), "bring-in trigger removed");
  assert.ok(!/Bring someone in/.test(bar), "bring-in label removed");
  assert.match(bar, /data-solo-attempt-input/); // the input itself stays

  const withConfirm = renderSoloSceneInputBar({ npcCreatorConfirmation: "Brynn is entering the story…" });
  assert.match(withConfirm, /Brynn is entering the story/);
});

test("right rail renders a cast roster from visible NPCs", () => {
  const populated = renderSoloRightRail({
    scene: {
      visibleEntities: [
        { entityType: "npc", entityId: "npc:vex", displayName: "Vex", summary: "Fence" },
        { entityType: "location_object", entityId: "location:x", displayName: "Room" }
      ]
    }
  });
  assert.match(populated, /Cast/);
  assert.match(populated, /Vex/);
  assert.match(populated, /Fence/);
  assert.match(populated, /data-solo-npc-bringback/);
  assert.match(populated, /data-entity-id="npc:vex"/);

  const empty = renderSoloRightRail({ scene: { visibleEntities: [] } });
  assert.match(empty, /No one is here yet/);
});

test("right rail prefers scene.cast with portrait URIs and away state", () => {
  const withCast = renderSoloRightRail({
    scene: {
      cast: [
        { npcId: "vex", displayName: "Vex", role: "Fence", portraitUri: "/data/assets/r/vex/base.png", present: true }
      ]
    }
  });
  assert.match(withCast, /<img src="\/data\/assets\/r\/vex\/base.png"/);
  assert.match(withCast, /Vex/);
  assert.match(withCast, /data-entity-id="npc:vex"/);

  const away = renderSoloRightRail({
    scene: { cast: [{ npcId: "drift", displayName: "Drift", role: "Scout", present: false }] }
  });
  assert.match(away, /away/);
});
