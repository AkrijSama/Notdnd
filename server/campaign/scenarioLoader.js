// D.5 PHASE 1 — THE SCENARIO LOADER (the front→thread bridge).
//
// A scenario is declarative JSON (the UGC boundary). This loader is the ONLY code
// that turns a `front` (authoring) into a `thread` (runtime run.threads) — exactly
// as resolveQuestAccept turns a questOffer into a quest state. It gates on
// validateScenario (fail-loud on a dangling ref BEFORE a player ever sees it),
// resolves symbolic refs against the post-worldgen graph, and instantiates cast →
// quests → threads in that order, then re-validates the whole run.
//
// Threads are born ONLY here (a server event) — never from model output. The
// loader carries no behavior: trigger evaluation, beat commit, and pacing all live
// in threads.js. This module is instantiation only.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateScenario } from "./scenarioSchema.js";
import { validateSoloRun, createEmptyExpressionVariants } from "../solo/schema.js";

const SCENARIO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "scenarios");

function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// The generated world graph keys locations by the symbolic positional ids
// (start_location / second_location / third_location), so a positional ref is
// already a real id. The one alias: the authoring shorthand "start".
const LOCATION_ALIAS = { start: "start_location" };
function resolveLocationRef(ref) {
  if (typeof ref !== "string") return ref;
  if (ref === "{player_location}") return ref; // dynamic — resolved at commit in threads.js
  return LOCATION_ALIAS[ref] || ref;
}

export function loadScenarioFile(scenarioId) {
  const file = path.join(SCENARIO_DIR, `${String(scenarioId).replace(/[^a-z0-9_]/gi, "")}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Resolve which scenario (if any) a run should load. Gated: never in sandbox.
// Source: an explicit per-run scenarioId, else the INKBORNE_SCENARIO env default
// (the flag, default-on for the grade target).
export function resolveRequestedScenario({ scenarioId, sandbox }) {
  if (sandbox) return null;
  const id = scenarioId || process.env.INKBORNE_SCENARIO;
  if (!id) return null;
  return loadScenarioFile(id);
}

// ── ref rewriting (symbolic → real ids at load) ───────────────────────────────
function resolveTrigger(trigger) {
  if (!trigger || typeof trigger !== "object") return {};
  const out = {};
  for (const mode of ["descriptive", "prescriptive"]) {
    if (!trigger[mode] || typeof trigger[mode] !== "object") continue;
    const t = { ...trigger[mode] };
    if (t.onPlayerAt) t.onPlayerAt = resolveLocationRef(t.onPlayerAt);
    if (t.playerAt) t.playerAt = resolveLocationRef(t.playerAt);
    for (const k of ["onQuestStage", "onQuestState", "questState"]) {
      if (t[k]?.questRef) t[k] = { ...t[k], questId: t[k].questRef };
    }
    out[mode] = t;
  }
  return out;
}
function resolvePayload(payload) {
  if (!payload || typeof payload !== "object") return {};
  const out = { ...payload };
  if (out.objectState?.locationId) out.objectState = { ...out.objectState, locationId: resolveLocationRef(out.objectState.locationId) };
  if (out.hostileNpc?.placeAt) out.hostileNpc = { ...out.hostileNpc, placeAt: resolveLocationRef(out.hostileNpc.placeAt) };
  if (out.quest?.questRef) out.quest = { ...out.quest, questId: out.quest.questRef };
  return out;
}

function instantiateThread(front, run) {
  const g = front.groundedIn || {};
  const groundedIn = {
    entityIds: (g.entityRefs || []).filter((id) => run.npcs[id] || id === run.player?.playerId),
    locationIds: (g.locationRefs || []).map(resolveLocationRef),
    questIds: (g.questRefs || []).filter((id) => run.quests[id]),
    factIds: []
  };
  const beats = (front.beats || []).map((b) => ({
    beatId: b.beatId,
    label: b.label || "",
    telegraph: b.telegraph || "",
    brief: b.brief || "",
    decision: b.decision || "",
    trigger: resolveTrigger(b.trigger),
    payload: resolvePayload(b.payload),
    status: "pending"
  }));
  return {
    threadId: front.frontId,
    kind: front.kind,
    status: "active",
    origin: "scenario",
    title: front.title || front.frontId,
    agenda: front.agenda || "",
    groundedIn,
    beatIndex: 0,
    beats,
    // Per-thread cadence — the reconciled spine paces the ladder at ≤1 beat / N
    // turns; the ≤1-driver rule already spaces distinct threads. Slice default: 1.
    clock: { minTurnsBetweenBeats: front.clock?.minTurnsBetweenBeats ?? 1, lastFiredTurn: null, dormantUntilTurn: null },
    revealState: front.revealState || "hidden",
    resolution: (front.resolution || []).map((r) => ({ ...r, questId: r.questRef || r.questId })),
    callbackQuery: { entityIds: front.callbackQuery?.entityRefs || [], keywords: front.callbackQuery?.keywords || [] },
    flags: {}
  };
}

/**
 * Instantiate a validated scenario into a run: cast → quests → threads → opening.
 * Fail-loud on validation (author-time content bug, never a runtime surprise).
 * Mutates and returns run.
 */
export function loadScenarioIntoRun(run, scenario, options = {}) {
  const v = validateScenario(scenario);
  if (!v.ok) {
    const err = new Error(`Scenario "${scenario?.scenarioId}" failed validation: ${JSON.stringify(v.errors.slice(0, 6))}`);
    err.code = "SCENARIO_INVALID";
    throw err;
  }
  run.npcs = run.npcs || {};
  run.quests = run.quests || {};
  run.threads = run.threads || {};
  run.locations = run.locations || {};

  // 0. WORLD + LOCATIONS — the scenario is the AUTHORITATIVE setting. A pre-built
  // scenario cannot share sandbox worldgen: the player's chosen world/location
  // (e.g. dark-fantasy ruins) would collide with the authored fiction (the Terra
  // night market) and bleed into narration/suggestions. Onboarding skips the
  // worldgen flavor for a scenario run (createWorldOnboardingRun, scenarioActive
  // guards); here we overwrite world tone/name and the location name+description
  // with the scenario's, so there is exactly ONE source of setting truth.
  run.world = { ...run.world };
  if (scenario.world && typeof scenario.world === "object") {
    for (const k of ["name", "tone", "flavor", "artStyle"]) {
      if (isString(scenario.world[k])) run.world[k] = scenario.world[k];
    }
    if (isString(scenario.world.artStyle)) {
      run.flags = { ...(run.flags || {}), artStyle: scenario.world.artStyle };
    }
  }

  for (const [locRef, loc] of Object.entries(scenario.locations || {})) {
    const id = resolveLocationRef(locRef);
    const target = run.locations[id];
    if (!target || !loc || typeof loc !== "object") continue;
    if (isString(loc.name)) target.name = loc.name;
    if (isString(loc.description)) target.description = loc.description;
    // Drop stale worldgen flavor tags (ruins/features) that contradict the scene.
    if (Array.isArray(loc.tags)) target.tags = [...loc.tags];
  }

  // RESIDUAL 2 — NO WORLDGEN LOCATION IDENTITY may persist. run.world still carries
  // the worldgen start-location metadata (e.g. startingLocationName "The Ember
  // Tavern", startingLocationType "ruins"), which the opening-narration templates
  // and world-field trackers in worldGen.js read. Replace with the scenario's own
  // start identity: an explicit scenario value, else the authored start location's
  // name (read AFTER the override loop above, so it is the authored name, not the
  // stale default); the type is cleared (a scenario's setting is its authored
  // locations, not a worldgen location type) so no "ruins"/"tavern" survives.
  const startRefRaw = scenario.opening?.startLocationRef || "";
  const authoredStartName = scenario.locations?.[startRefRaw]?.name;
  const startLoc = run.locations[resolveLocationRef(startRefRaw)] || null;
  run.world.startingLocationName = isString(scenario.world?.startingLocationName)
    ? scenario.world.startingLocationName
    : (isString(authoredStartName) ? authoredStartName : (isString(startLoc?.name) ? startLoc.name : ""));
  run.world.startingLocationType = isString(scenario.world?.startingLocationType)
    ? scenario.world.startingLocationType
    : "";

  // RESIDUAL 1 — SCRUB default-world searchDetails across the WHOLE graph. A scenario
  // run's every location is authored setting, so no default location-graph
  // searchDetail (dark-fantasy debris like a "Scuffed Mark" on the sprawl fringe)
  // may survive to be surfaced by a search. Keep ONLY scenario-authored details
  // (empty for scenarios that author none). Scoped to scenario runs: this function
  // only runs when scenarioActive, so sandbox/guided-worldgen searchDetails are
  // untouched.
  const authoredDetails = new Map();
  for (const [locRef, loc] of Object.entries(scenario.locations || {})) {
    authoredDetails.set(resolveLocationRef(locRef), Array.isArray(loc?.searchDetails) ? loc.searchDetails : []);
  }
  for (const [id, target] of Object.entries(run.locations)) {
    if (target && typeof target === "object") {
      target.searchDetails = [...(authoredDetails.get(id) || [])];
    }
  }

  // RESIDUAL 3 — the default PLACEHOLDER starting inventory (createDefaultSoloRun's
  // "Trail Loaf") carries a dark-fantasy flavor description that names a default-
  // world LOCATION ("...the tavern keeper before you left the Shattered Flagon") —
  // a phantom tavern in a cyberpunk market's pack. Same class as the location/world
  // bleed. Neutralize placeholder items' location-referencing flavor for a scenario
  // run (identity/use untouched); an authored scenario can supply its own starting
  // kit later. Placeholder items are tagged "placeholder".
  for (const item of Object.values(run.inventory || {})) {
    if (item && typeof item === "object" && Array.isArray(item.tags) && item.tags.includes("placeholder")) {
      item.description = "Basic rations, enough to keep you moving.";
    }
  }

  // 1. CAST — create the scenario's NPCs at resolved locations (replacing the
  // hand-wired cast). questOffer descriptors ride the NPC for the accept flow.
  for (const c of scenario.cast || []) {
    run.npcs[c.npcId] = {
      npcId: c.npcId,
      displayName: c.displayName || c.npcId,
      role: c.role || "stranger",
      currentLocationId: resolveLocationRef(c.at),
      known: true,
      status: "present",
      memoryFactIds: [],
      expressionVariants: createEmptyExpressionVariants(),
      tags: [c.role || "stranger"],
      flags: {},
      edition: "mainline",
      policyProfileId: "mainline_default",
      contentTags: [],
      origin: "procedural",
      dialogueBeats: (c.dialogueBeats || []).map((d, i) => ({
        beatId: `${c.npcId}_beat_${i}`,
        label: d.label || "",
        text: d.text || "",
        revealed: false,
        repeatable: true,
        linkedQuestIds: [],
        contentTags: []
      }))
    };
    if (c.questOffer && scenario.questOffers?.[c.questOffer]) {
      run.npcs[c.npcId].questOffer = scenario.questOffers[c.questOffer];
    }
  }

  // 2. QUESTS — declared scenario quests become real active records (the objects
  // fronts ground in and triggers read). Kept thin; the quest engine tolerates it.
  for (const [qid, q] of Object.entries(scenario.quests || {})) {
    if (run.quests[qid]) continue;
    run.quests[qid] = {
      questId: qid,
      status: "active",
      stage: 0,
      title: q.title || qid,
      description: q.summary || q.description || "",
      objective: q.summary || q.title || "",
      relatedEntityIds: [],
      memoryFactIds: [],
      authoredBy: "scenario",
      isMain: q.kind === "delivery",
      flags: {}
    };
  }

  // 3. THREADS — fronts → run.threads (refs resolved to real ids).
  for (const front of scenario.fronts || []) {
    run.threads[front.frontId] = instantiateThread(front, run);
  }

  // 4. OPENING — bind the start location + the objective the opening names.
  const startRef = scenario.opening?.questObjectiveFrom;
  if (scenario.opening?.startLocationRef) {
    const startId = resolveLocationRef(scenario.opening.startLocationRef);
    if (run.locations[startId]) run.currentLocationId = startId;
  }
  void startRef;

  // 5. FAIL-LOUD — the whole run must validate after loading.
  const runV = validateSoloRun(run);
  if (!runV.ok) {
    const err = new Error(`Run invalid after loading scenario "${scenario.scenarioId}": ${JSON.stringify(runV.errors.slice(0, 6))}`);
    err.code = "SCENARIO_LOAD_INVALID";
    throw err;
  }
  return run;
}
