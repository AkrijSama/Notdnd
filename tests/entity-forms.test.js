// FORM-SHIFTING ENTITY (v1). The VOICE is an entity that takes a physical FORM chosen by her
// disposition toward the player: unmet -> ball-of-light, then non-threat -> elk, threat ->
// dragon, trusted -> woman. The server OWNS the form (derived from committed reveal + reputation);
// a non-humanoid form skips the humanoid scaffold; a humanoid form uses it. General mechanism:
// ANY entity may declare forms.
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveEntityForm,
  entityHasForms,
  entityFormsSpec,
  entityFormAssetSuffix,
  nonHumanoidBodyArtDirection,
  ENTITY_FORMS
} from "../server/solo/entityForms.js";
import { sealPortraitPrompt } from "../server/ai/comfyui.js";

function run({ revealed = false, affinity = null } = {}) {
  return {
    npcs: { npc_voice: { npcId: "npc_voice", displayName: "The VOICE", known: true } },
    relationships: affinity == null ? {} : { r1: { sourceEntityId: "player", targetEntityId: "npc_voice", affinity } },
    flags: { npcRevealed: revealed ? { npc_voice: true } : {} },
    world: { tone: "dark fantasy" }
  };
}
const voice = (r) => r.npcs.npc_voice;

test("UNMET (not manifested) resolves to the default ball-of-light, non-humanoid (1.4)", () => {
  const r = run({ revealed: false, affinity: null });
  const form = resolveEntityForm(r, voice(r));
  assert.equal(form.id, "ball_of_light");
  assert.equal(form.humanoid, false);
  assert.match(form.appearance, /orb of warm green and gold light/);
  // met is the committed reveal, NOT authored `known` — she is known:true (she speaks) but
  // has no body until she manifests.
  assert.equal(voice(r).known, true);
});

test("disposition selects the form once MET: trusted->woman, threat->dragon, non-threat->elk (1.2)", () => {
  const woman = resolveEntityForm(run({ revealed: true, affinity: 30 }), { npcId: "npc_voice" });
  assert.equal(woman.id, "woman");
  assert.equal(woman.humanoid, true);
  const dragon = resolveEntityForm(run({ revealed: true, affinity: -40 }), { npcId: "npc_voice" });
  assert.equal(dragon.id, "dragon");
  assert.equal(dragon.humanoid, false);
  const elk = resolveEntityForm(run({ revealed: true, affinity: 3 }), { npcId: "npc_voice" });
  assert.equal(elk.id, "elk");
  assert.equal(elk.humanoid, false);
  // devoted (>=45) still reads as the trusted WOMAN form.
  assert.equal(resolveEntityForm(run({ revealed: true, affinity: 60 }), { npcId: "npc_voice" }).id, "woman");
});

test("the Goddess is green/gold, never violet (CHAOS-IS-PURPLE law)", () => {
  for (const f of Object.values(ENTITY_FORMS.npc_voice.forms)) {
    assert.doesNotMatch(f.appearance, /purple|violet|magenta/i, "the Goddess must never be chaos-violet");
    assert.match(f.appearance, /green|gold/i, "every VOICE form carries her green-gold signature");
  }
});

test("an ordinary NPC declares no forms -> null (general mechanism, not a VOICE special-case)", () => {
  const r = { npcs: { npc_guard: { npcId: "npc_guard" } }, relationships: {}, flags: {} };
  assert.equal(resolveEntityForm(r, r.npcs.npc_guard), null);
  assert.equal(entityHasForms(r.npcs.npc_guard), false);
  assert.equal(entityFormAssetSuffix(null), "");
  // an AUTHORED forms map on the npc (world-book path, future) is honored over the registry.
  const authored = { npcId: "npc_x", forms: { default: "a", forms: { a: { humanoid: false, appearance: "x" } } } };
  assert.equal(entityFormsSpec(authored).default, "a");
});

test("per-form asset suffix keeps forms from colliding in imageAssets", () => {
  assert.equal(entityFormAssetSuffix({ id: "ball_of_light" }), "_ball_of_light");
  assert.equal(entityFormAssetSuffix({ id: "woman" }), "_woman");
});

test("the SEAL applies the humanoid scaffold to WOMAN, not to a non-humanoid form (1.3)", () => {
  const assemble = (form) => {
    const dir = form.humanoid
      ? "full-body standing character, head to toe, plain dark background, visual novel sprite, dark fantasy, detailed face and clothing"
      : nonHumanoidBodyArtDirection("dark fantasy");
    return sealPortraitPrompt("anime", `${form.appearance}, ${dir}`, "");
  };
  const orb = assemble(resolveEntityForm(run({ revealed: false }), { npcId: "npc_voice" }));
  assert.doesNotMatch(orb.positive, /wearing a plain dark shirt|covered chest/, "a ball of light must NOT be clothed");
  const woman = assemble(resolveEntityForm(run({ revealed: true, affinity: 30 }), { npcId: "npc_voice" }));
  assert.match(woman.positive, /wearing a plain dark shirt|covered chest/, "the woman form takes the humanoid wardrobe floor");
});
