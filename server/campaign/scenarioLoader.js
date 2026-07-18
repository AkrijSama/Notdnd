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
import { resolveWorldArtStyle, stampArtStyle } from "../solo/artStyle.js";
import { normalizeAgeClass, ensureFaction } from "../solo/reputation.js";

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
    // `variant` is the world-family discriminator (e.g. "babel") the scene
    // payload surfaces so the client can render a world-specific STATUS WINDOW
    // (Babel's six-stat / rank / milestone panel) instead of the default sheet.
    // `era` closes the art-pipeline ERA LAW gap (scripts/art/promptAssembly.js
    // eraDescriptor reads world.era): with it set, minted attire carries the
    // world's era instead of defaulting to modern dress. Additive; worlds without
    // it ride bare exactly as before.
    for (const k of ["name", "tone", "flavor", "artStyle", "variant", "era"]) {
      if (isString(scenario.world[k])) run.world[k] = scenario.world[k];
    }
    // Carry the scenario's engine art style into BOTH the new primary
    // (artStyleOptions.default) and the legacy string + flags mirror. A scenario
    // may author either the new artStyleOptions object or the legacy artStyle
    // string; resolveWorldArtStyle reads whichever is present.
    const scenarioDeclaresStyle =
      isString(scenario.world.artStyle) ||
      (scenario.world.artStyleOptions &&
        typeof scenario.world.artStyleOptions === "object" &&
        isString(scenario.world.artStyleOptions.default));
    if (scenarioDeclaresStyle) {
      stampArtStyle(run.world, resolveWorldArtStyle(scenario.world));
      run.flags = { ...(run.flags || {}), artStyle: run.world.artStyle };
    }
  }

  // AWAKENING ORIGIN — the race slot, data-driven. A scenario may declare the
  // player's origin (chassis race contract: a stat boost + a named feat). Babel
  // fills this with the Beckoned (the player's canon origin: +1 INT, +1 Spirit,
  // and the live STATUS WINDOW as its feat). Applied onto the already-built
  // player abilities so it composes with character creation; real, not worldgen.
  const origin = scenario.playerOrigin;
  if (origin && typeof origin === "object" && run.player) {
    run.player.abilities = { ...(run.player.abilities || {}) };
    if (origin.boost && typeof origin.boost === "object") {
      for (const [ability, delta] of Object.entries(origin.boost)) {
        if (typeof run.player.abilities[ability] === "number" && Number.isFinite(delta)) {
          run.player.abilities[ability] = Math.min(30, Math.max(1, run.player.abilities[ability] + delta));
        }
      }
    }
    if (isString(origin.name)) run.player.origin = origin.name.trim();
    if (isString(origin.feat)) run.player.originFeat = origin.feat.trim();
  }

  for (const [locRef, loc] of Object.entries(scenario.locations || {})) {
    const id = resolveLocationRef(locRef);
    if (!loc || typeof loc !== "object") continue;
    let target = run.locations[id];
    if (!target) {
      // WORLD-BOOK POIs: a scenario may author locations BEYOND the 3 positional
      // worldgen seeds (the Verdance region's 20-POI table). Instantiate them as
      // real, schema-valid nodes so the region graph (regionMap), movement, and
      // services have ground to consume. Minimal: a valid record; the authored
      // exits / danger / services / template are copied below.
      target = run.locations[id] = {
        locationId: id,
        name: isString(loc.name) ? loc.name : id,
        description: "",
        connectedLocationIds: [],
        state: { visited: false, discovered: false },
        memoryFactIds: [],
        tags: [],
        flags: {}
      };
    }
    if (isString(loc.name)) target.name = loc.name;
    if (isString(loc.description)) target.description = loc.description;
    // Drop stale worldgen flavor tags (ruins/features) that contradict the scene.
    if (Array.isArray(loc.tags)) target.tags = [...loc.tags];
    // Region edges: authored adjacency (the exits the regionMap draws + movement
    // walks). Symmetrized below so reachability is undirected.
    if (Array.isArray(loc.connectedLocationIds)) {
      target.connectedLocationIds = loc.connectedLocationIds.map(resolveLocationRef).filter(isString);
    }
    // Danger tier (committed): drives the regionMap hazard read + scene framing.
    if (Number.isFinite(loc.dangerLevel)) {
      target.state = { ...target.state, dangerLevel: loc.dangerLevel };
    }
    // Committed services (affordances-map-law Part A): inn/market/training seed
    // the input-dock service chips. Copied verbatim (validated by validateSoloRun).
    if (Array.isArray(loc.services)) {
      target.services = JSON.parse(JSON.stringify(loc.services));
    }
    // Map-layout law: a scenario may pin a layout template or hand-place a full
    // set-piece layout (world-book data) — the mint engine adopts it verbatim.
    if (isString(loc.layoutTemplate)) target.layoutTemplate = loc.layoutTemplate.trim();
    if (loc.layout && typeof loc.layout === "object" && Array.isArray(loc.layout.cells)) {
      target.layout = JSON.parse(JSON.stringify(loc.layout));
    }
  }

  // EDGE SYMMETRIZATION — authored adjacency is undirected (the regionMap and the
  // move pipeline both treat connectedLocationIds as an undirected graph). Author
  // an edge once; guarantee the reciprocal so travel works both ways and no node
  // is stranded by a one-way authoring slip. Only touches real, existing nodes.
  for (const [id, loc] of Object.entries(run.locations)) {
    if (!loc || !Array.isArray(loc.connectedLocationIds)) continue;
    for (const other of loc.connectedLocationIds) {
      const dest = run.locations[other];
      if (!dest) continue;
      dest.connectedLocationIds = Array.isArray(dest.connectedLocationIds) ? dest.connectedLocationIds : [];
      if (!dest.connectedLocationIds.includes(id)) dest.connectedLocationIds.push(id);
    }
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
      ageClass: normalizeAgeClass(c.ageClass), // scenario cast adult unless the scenario says child
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
      const offer = scenario.questOffers[c.questOffer];
      // #51: a scenario offer must carry an acceptable `quest` payload — the accept
      // flow (resolveQuestAccept) instantiates offer.quest, so without it the board
      // bounty could never be taken. Auto-build it from the offer (unless the
      // scenario supplied one) so the objective ARRIVES DIEGETICALLY on acceptance
      // (reach the board → accept → tracked) instead of being asserted cold.
      run.npcs[c.npcId].questOffer = {
        ...offer,
        // The line the GM voices when work comes up (buildOpenJobOffers surfaces
        // only offers with an offerText) — so the bounty is presented in-fiction at
        // the board, not asserted as a pre-owned objective.
        offerText: (typeof offer.offerText === "string" && offer.offerText.trim()) ? offer.offerText : (offer.summary || offer.title || "There's work on the board."),
        quest: (offer.quest && typeof offer.quest === "object" && !Array.isArray(offer.quest))
          ? offer.quest
          : {
              questId: `quest_${c.questOffer}`,
              status: "active",
              stage: 0,
              title: offer.title || "Job",
              description: offer.summary || offer.title || "",
              objective: offer.summary || offer.title || "",
              relatedEntityIds: [],
              memoryFactIds: [],
              authoredBy: "scenario",
              isMain: offer.kind === "delivery",
              flags: {}
            }
      };
    }
  }

  // 1.5. FACTIONS — world-book faction seeds → run.factions via the existing
  // faction engine (ensureFaction). Minimal rows: name + standing + discovery.
  // A secret faction (Hollow Congregation) is seeded discovered:false so it stays
  // publicly ordinary until the player uncovers it. `wants` (narrative agenda) has
  // no engine field; it rides flags.wants for grounding. No new faction machinery —
  // tiers/standing/preferences are the existing reputation engine's.
  for (const f of Array.isArray(scenario.factions) ? scenario.factions : []) {
    if (!f || !isString(f.factionId)) continue;
    const faction = ensureFaction(run, f.factionId, {
      name: f.name,
      standing: Number.isFinite(f.standing) ? f.standing : 0,
      discovered: f.discovered === true
    });
    if (isString(f.disposition)) faction.flags.disposition = f.disposition;
    if (isString(f.wants)) faction.flags.wants = f.wants;
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

  // Locations the OPENING makes KNOWN (the VOICE named the town to the north): the
  // character has been told of them, so they are DISCOVERED — a legitimate told-of-
  // knowledge event, exactly as a campaign main quest discovers its named
  // destination (onboarding.js). This keeps the first move a NAMED, motivated step
  // ("take the north road to Hollow Pine") instead of a fogged "unexplored path",
  // giving the opening real traction.
  for (const ref of Array.isArray(scenario.opening?.knownLocations) ? scenario.opening.knownLocations : []) {
    const loc = run.locations[resolveLocationRef(ref)];
    if (loc && loc.state && typeof loc.state === "object") loc.state.discovered = true;
  }

  // 5. FAIL-LOUD — the whole run must validate after loading.
  const runV = validateSoloRun(run);
  if (!runV.ok) {
    const err = new Error(`Run invalid after loading scenario "${scenario.scenarioId}": ${JSON.stringify(runV.errors.slice(0, 6))}`);
    err.code = "SCENARIO_LOAD_INVALID";
    throw err;
  }
  return run;
}
