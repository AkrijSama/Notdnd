import assert from "node:assert/strict";
import test from "node:test";
import { renderSoloCharacterSidebar, renderSoloRightRail } from "../src/components/soloSceneShell.js";

// The targeted portrait poll (no full re-render) finds slots by
// data-portrait-for. These hooks must exist or portraits stop updating.

test("player sidebar exposes a player portrait slot", () => {
  const html = renderSoloCharacterSidebar({ name: "Kael", className: "Ranger" });
  assert.match(html, /data-portrait-for="player"/);
  assert.match(html, /data-portrait-img-class="solo-portrait-img"/);
});

test("cast roster exposes per-NPC portrait slots", () => {
  const html = renderSoloRightRail({
    scene: {
      cast: [{ npcId: "n1", displayName: "Garrick", role: "Warden", present: true, portraitUri: "" }]
    }
  });
  assert.match(html, /data-portrait-for="npc:n1"/);
});
