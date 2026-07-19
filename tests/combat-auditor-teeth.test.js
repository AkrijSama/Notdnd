// A2 AUDITOR TEETH (audit 5d548ac): the combat-number auditor was log-only — a leaked
// raw HP/damage figure still reached the player. scrubFabricatedCombatNumbers now STRIPS
// it at the trim layer (committed numbers are the only numbers). Fires only in a live fight.
import assert from "node:assert/strict";
import test from "node:test";
import { scrubFabricatedCombatNumbers } from "../server/solo/combatAudit.js";

const LIVE = { status: "active", combatId: "c1" };

test("strips raw HP / damage / remaining-HP figures during a live fight", () => {
  const r = scrubFabricatedCombatNumbers("The wolf takes 8 damage and drops to 3 HP, snarling.", LIVE);
  assert.equal(r.scrubbed.length >= 2, true, "the fabricated numbers were caught");
  assert.doesNotMatch(r.text, /\b\d+\s*(?:hp|damage)\b/i, "no raw HP/damage number survives");
  assert.doesNotMatch(r.text, /drops to \d/i, "no raw remaining-HP claim survives");
  assert.match(r.text, /snarling/, "the surrounding prose is preserved");
});

test("clean band-language prose is untouched", () => {
  const clean = "The wolf reels, badly wounded, frost steaming from its flank.";
  const r = scrubFabricatedCombatNumbers(clean, LIVE);
  assert.equal(r.scrubbed.length, 0);
  assert.equal(r.text, clean);
});

test("no-op outside a live fight (numbers are unremarkable then)", () => {
  const txt = "You have 8 hit points left after the climb.";
  const r = scrubFabricatedCombatNumbers(txt, { status: "ended" });
  assert.equal(r.scrubbed.length, 0);
  assert.equal(r.text, txt);
  assert.equal(scrubFabricatedCombatNumbers(txt, null).text, txt);
});
