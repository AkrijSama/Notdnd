import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSoloRun, validateSoloRun, LOCATION_SERVICE_KINDS } from "../server/solo/schema.js";
import { deriveAffordances } from "../server/solo/affordances.js";
import { captureDeclaredGoal } from "../server/solo/goals.js";
import {
  renderSoloAffordances,
  renderSoloSceneInputBar,
  dispatchSoloClick,
  newSoloTurnId,
  SOLO_AFFORDANCE_CAP
} from "../src/components/soloSceneShell.js";

function baseRun(runId = "run_aff") {
  const run = createDefaultSoloRun({ runId });
  const loc = run.locations[run.currentLocationId];
  loc.name = "The Shattered Flagon";
  loc.tags = ["tavern"];
  return run;
}
const bySource = (list, source) => list.filter((a) => a.source === source);
const byLabel = (list, label) => list.find((a) => a.label === label);

// ── SCHEMA (services, additive/resume-safe) ─────────────────────────────────

test("location.services validates; legacy locations without it stay valid", () => {
  const run = baseRun();
  run.locations[run.currentLocationId].services = [{ kind: "inn", label: "Rooms" }, { kind: "market" }];
  assert.equal(validateSoloRun(run).ok, true);
  assert.deepEqual(LOCATION_SERVICE_KINDS, ["inn", "market", "training"]);
  // Bogus kind rejects.
  run.locations[run.currentLocationId].services = [{ kind: "brothel" }];
  assert.equal(validateSoloRun(run).ok, false);
  // Absent is fine.
  delete run.locations[run.currentLocationId].services;
  assert.equal(validateSoloRun(run).ok, true);
});

// ── DERIVATION PER SOURCE ────────────────────────────────────────────────────

test("derivation: standing verbs are the reliable floor (Look around, Search, Rest)", () => {
  const list = deriveAffordances(baseRun());
  const standing = bySource(list, "standing").map((a) => a.label);
  assert.deepEqual(standing, ["Look around", "Search the area", "Rest"]);
  // They come FIRST (the floor).
  assert.equal(list[0].label, "Look around");
});

test("derivation: service / cast / exit / goal / object sources each derive", () => {
  const run = baseRun();
  const loc = run.locations[run.currentLocationId];
  loc.services = [{ kind: "inn", label: "Take a room" }];
  loc.flags.objectStates = {
    "found-chest": { objectId: "found-chest", label: "iron chest", state: "discovered" },
    "the-sky": { objectId: "the-sky", label: "the sky", state: "storm-breaking" }
  };
  run.npcs.npc_mira = { npcId: "npc_mira", generatedName: "Mira", displayName: "Mira", role: "fence", currentLocationId: run.currentLocationId, status: "active" };
  captureDeclaredGoal(run, "I am going to build a shelter", {});
  const list = deriveAffordances(run);

  // service
  const svc = byLabel(list, "Take a room");
  assert.ok(svc && svc.source === "service" && svc.feasibility === "ok" && /rent a room/i.test(svc.intent));
  // cast
  const talk = byLabel(list, "Talk to Mira");
  assert.ok(talk && talk.source === "cast" && talk.intent === "Talk to Mira.");
  // goal (a Task is actionable anywhere)
  const goal = list.find((a) => a.source === "goal");
  assert.ok(goal && /shelter/i.test(goal.label) && /build a shelter/i.test(goal.intent));
  // object (the interactable chest, NOT the sky hazard)
  const obj = list.find((a) => a.source === "object");
  assert.ok(obj && /iron chest/i.test(obj.label));
  assert.ok(!list.some((a) => /the sky/i.test(a.label)), "sky/weather hazards are never examine chips");
  // exit (start_location connects to second_location)
  assert.ok(bySource(list, "exit").length >= 1, "an available move becomes a go-to affordance");
});

// ── TWO-TIER FEASIBILITY ─────────────────────────────────────────────────────

test("two-tier INFEASIBLE: active combat gates Rest with an in-fiction reason", () => {
  const run = baseRun();
  run.combat = { combatId: "c1", status: "active", round: 1, turnIndex: 0, turnOrder: ["player"], combatants: {} };
  const list = deriveAffordances(run);
  const rest = byLabel(list, "Rest");
  assert.ok(rest);
  assert.equal(rest.feasibility, "gated");
  assert.match(rest.gateReason, /can't make camp while the fight/i);
  // Non-combat affordances are suppressed mid-fight (only Look around + gated Rest).
  assert.deepEqual(list.map((a) => a.label).sort(), ["Look around", "Rest"]);
});

test("two-tier UNWISE: resting in a dangerous location is fully available (submits, takes stakes)", () => {
  const run = baseRun();
  // A dangerous, no-combat location: rest is UNWISE, never gated.
  run.locations[run.currentLocationId].state = { visited: true, discovered: true, dangerLevel: 5 };
  const rest = byLabel(deriveAffordances(run), "Rest");
  assert.equal(rest.feasibility, "ok", "risky-wilds rest is available (not nannied)");
  assert.ok(rest.intent && !("gateReason" in rest && rest.gateReason), "it submits its intent; stakes ride the pipeline");
});

test("two-tier INFEASIBLE: a committed-but-unavailable service is gated with its reason", () => {
  const run = baseRun();
  run.locations[run.currentLocationId].services = [{ kind: "inn", label: "Rent a room", available: false, reason: "The rooms are all taken tonight." }];
  const svc = byLabel(deriveAffordances(run), "Rent a room");
  assert.equal(svc.feasibility, "gated");
  assert.match(svc.gateReason, /rooms are all taken/i);
});

// ── CLIENT: CHIP ROW (cap + overflow, gated distinct) ───────────────────────

function affScene(affordances) {
  return { scene: { affordances } };
}

test("chip row: caps at 7 visible + a 'more' overflow chip; expanded shows all", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ label: `Act ${i}`, intent: `I do act ${i}.`, source: "standing", feasibility: "ok" }));
  assert.equal(SOLO_AFFORDANCE_CAP, 7);
  const capped = renderSoloAffordances(affScene(many));
  assert.equal((capped.match(/data-solo-affordance=/g) || []).length, 7, "7 visible");
  assert.match(capped, /data-solo-affordances-more[^>]*>more \(3\)/);
  const expanded = renderSoloAffordances({ scene: { affordances: many }, affordancesExpanded: true });
  assert.equal((expanded.match(/data-solo-affordance=/g) || []).length, 10, "all shown when expanded");
  assert.match(expanded, /data-solo-affordances-more[^>]*>less/);
  // Empty → nothing.
  assert.equal(renderSoloAffordances(affScene([])), "");
  assert.equal(renderSoloAffordances({}), "");
});

test("chip row: an OK chip submits its intent; a gated chip is distinct, non-submitting, carries the reason", () => {
  const list = [
    { label: "Search the area", intent: "I search the area.", source: "standing", feasibility: "ok" },
    { label: "Rest", intent: "I make camp.", source: "standing", feasibility: "gated", gateReason: "Enemies press the attack." }
  ];
  const html = renderSoloAffordances(affScene(list));
  // OK chip carries the intent to submit.
  assert.match(html, /data-solo-affordance="I search the area\."/);
  // Gated chip is distinct (is-gated), non-submitting (no data-solo-affordance=), reason in title + gate hook.
  assert.match(html, /solo-affordance is-gated[^>]*data-solo-affordance-gated="Enemies press the attack\."/);
  assert.match(html, /title="Enemies press the attack\."/);
  assert.doesNotMatch(html, /data-solo-affordance="I make camp/);
  // A tapped gate note renders when present.
  assert.match(renderSoloAffordances({ scene: { affordances: list }, affordanceGateNote: "Enemies press the attack." }), /solo-affordance-gatenote[^>]*>Enemies press the attack\./);
});

// ── CLIENT: DISPATCH ROUTES THROUGH THE TURN PATH ───────────────────────────

function clickTarget(matches = {}) {
  return {
    closest(selector) {
      if (!(selector in matches)) return null;
      const attrs = matches[selector] || {};
      return { getAttribute: (name) => (name in attrs ? attrs[name] : null) };
    }
  };
}

test("dispatch: an OK affordance routes to onAttempt with the intent (same path as typing)", () => {
  let attempted = null;
  const handled = dispatchSoloClick(
    clickTarget({ "[data-solo-affordance]": { "data-solo-affordance": "I search the area." } }),
    { onAttempt: (a) => (attempted = a) }
  );
  assert.equal(handled, true);
  assert.deepEqual(attempted, { intent: "I search the area." });
});

test("dispatch: a gated affordance routes to onAffordanceGate (never onAttempt); more toggles", () => {
  let gate = null;
  let submitted = false;
  let more = false;
  dispatchSoloClick(
    clickTarget({ "[data-solo-affordance-gated]": { "data-solo-affordance-gated": "No inn here." } }),
    { onAffordanceGate: (g) => (gate = g), onAttempt: () => (submitted = true) }
  );
  assert.deepEqual(gate, { reason: "No inn here." });
  assert.equal(submitted, false, "a gated chip NEVER submits");
  dispatchSoloClick(clickTarget({ "[data-solo-affordances-more]": {} }), { onAffordancesMore: () => (more = true) });
  assert.equal(more, true);
});

test("turn lifecycle: the client can mint a turnId for a submitted turn (idempotency rides free)", () => {
  const id = newSoloTurnId("run_aff");
  assert.match(id, /^turn_run_aff_/);
  assert.notEqual(newSoloTurnId("run_aff"), id, "each turn gets a fresh id");
});

// ── TEXT-BOX SOVEREIGNTY ─────────────────────────────────────────────────────

test("text-box sovereignty: the input bar (field + font sizer) is untouched by the affordance row", () => {
  const bar = renderSoloSceneInputBar({ attemptDraft: "hello" });
  // The affordance row is a SEPARATE node — it is NOT inside renderSoloSceneInputBar.
  assert.doesNotMatch(bar, /solo-affordances/);
  // The text field, font sizer, and meta row remain intact.
  assert.match(bar, /data-solo-attempt-input/);
  assert.match(bar, /data-solo-logfont="up"/);
  assert.match(bar, /data-solo-charcount/);
});
