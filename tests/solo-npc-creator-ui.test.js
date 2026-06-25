import assert from "node:assert/strict";
import test from "node:test";
import {
  renderNpcCreatorModal,
  renderSoloDialogueOverlay,
  renderSoloRightRail,
  renderSoloSceneInputBar
} from "../src/components/soloSceneShell.js";

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

test("VN overlay shows the placeholder only when neither variant nor base exists", () => {
  const html = renderSoloDialogueOverlay(dialogueState({ expressionVariants: {} }, []));
  assert.match(html, /Portrait incoming/);
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

test("input bar shows the bring-in trigger and confirmation", () => {
  const bar = renderSoloSceneInputBar({});
  assert.match(bar, /data-solo-npc-create/);
  assert.match(bar, /Bring someone in/);

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
