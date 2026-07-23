// JOB 1.3 — the form-shifting entity's forms are AUTHORED in the world-book, not welded into the
// engine. Babel authors npc_voice.forms; the loader carries npc.forms; entityFormsSpec reads it
// FIRST (the engine ENTITY_FORMS registry is now only a resume-safety fallback). GATE: (a) Babel
// byte-identical — the authored forms equal the old engine registry; (b) a world declaring its own
// forms works with ZERO engine change.
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultSoloRun } from "../server/solo/schema.js";
import { loadScenarioIntoRun, loadScenarioFile } from "../server/campaign/scenarioLoader.js";
import { entityFormsSpec, resolveEntityForm, ENTITY_FORMS } from "../server/solo/entityForms.js";
import { commitNpcReveal } from "../server/solo/npcReveal.js";

test("GATE(babel byte-identical): the VOICE's forms are AUTHORED in babel.json and reach run.npcs, identical to the engine registry", () => {
  const run = createDefaultSoloRun({ runId: "forms_babel" });
  loadScenarioIntoRun(run, loadScenarioFile("babel"), {});
  const voice = run.npcs.npc_voice;
  assert.ok(voice && voice.forms && voice.forms.forms, "the loader carries the AUTHORED npc_voice.forms into run.npcs");
  // entityFormsSpec must return the AUTHORED forms (npc.forms), not the engine registry.
  const spec = entityFormsSpec(voice);
  assert.equal(spec, voice.forms, "entityFormsSpec returns the authored forms, not the engine fallback");
  // byte-identical to what the engine used to weld: same forms, same appearances.
  assert.deepEqual(voice.forms.forms, ENTITY_FORMS.npc_voice.forms, "authored forms are byte-identical to the (now-fallback) engine registry");
  assert.equal(voice.forms.default, ENTITY_FORMS.npc_voice.default);
  assert.deepEqual(voice.forms.byBand, ENTITY_FORMS.npc_voice.byBand);
});

test("GATE(babel byte-identical): resolveEntityForm yields the same forms via the AUTHORED path (unmet→ball, met+trusted→woman)", () => {
  const run = createDefaultSoloRun({ runId: "forms_resolve" });
  loadScenarioIntoRun(run, loadScenarioFile("babel"), {});
  const voice = run.npcs.npc_voice;
  // unmet (not manifested) → ball_of_light, non-humanoid — unchanged from the engine-registry era.
  const unmet = resolveEntityForm(run, voice);
  assert.equal(unmet.id, "ball_of_light");
  assert.equal(unmet.humanoid, false);
  // met (manifested) + trusted disposition → woman, humanoid.
  commitNpcReveal(run, "npc_voice", "voice_manifest");
  run.relationships = { r1: { sourceEntityId: "player", targetEntityId: "npc_voice", affinity: 30 } };
  const met = resolveEntityForm(run, voice);
  assert.equal(met.id, "woman");
  assert.equal(met.humanoid, true);
});

test("JOB 1.3 (a world declares its own forms, ZERO engine change): a non-Babel npc.forms drives the mechanism", () => {
  // No engine registry entry for this id — the mechanism reads the authored npc.forms directly.
  const npc = {
    npcId: "npc_oracle_x",
    forms: {
      default: "mist",
      byBand: { hostile: "storm", wary: "storm", neutral: "mist", warm: "mist", trusted: "seer", devoted: "seer" },
      forms: {
        mist: { humanoid: false, appearance: "a drifting bank of silver mist" },
        storm: { humanoid: false, appearance: "a coiling thundercloud shot with lightning" },
        seer: { humanoid: true, appearance: "a robed seer with silver eyes" }
      }
    }
  };
  assert.equal(ENTITY_FORMS.npc_oracle_x, undefined, "no engine registry entry — proves zero engine change is needed");
  const run = { npcs: { npc_oracle_x: npc }, relationships: {}, flags: { npcRevealed: { npc_oracle_x: true } } };
  const form = resolveEntityForm(run, npc); // met + neutral (no rel) → mist
  assert.equal(form.id, "mist");
  assert.match(form.appearance, /silver mist/);
});
