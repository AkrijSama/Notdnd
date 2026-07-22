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
import { normalizeAgeClass, ensureFaction, romanceableDefault } from "../solo/reputation.js";
import { seedEssenceTracesFromScenario, mintTraceFromSpawn, currentWorldMinutes } from "../solo/essence.js";
import { resolveStatBlock, registerStatBlock } from "./bestiary.js";

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
  // T6 (sealed ruling): a sandbox is a MODULE WITHIN A WORLD. When a world is named
  // explicitly (scenarioId), a sandbox BINDS to that world's canon (loadScenarioIntoRun
  // then loads the world minus the authored opening — see its `sandbox` gate). A truly
  // WORLDLESS sandbox (no id) still falls to worldgen. The env fallback stays campaign-
  // only — it must never auto-bind a sandbox to INKBORNE_SCENARIO.
  const id = scenarioId || (sandbox ? null : process.env.INKBORNE_SCENARIO);
  if (!id) return null;
  return loadScenarioFile(id);
}

// USER-WORLD PATH (additive, beside the authored resolver above). A user world (the
// Custom World flow) stores a pre-compiled, pre-validated scenario
// (server/campaign/worldBook.compileWorldBook). This returns that scenario for the
// SAME loadScenarioIntoRun pipeline, or null if the record is absent/invalid — the
// authored path, its env fallback, and its sandbox gate are all untouched. The caller
// (onboarding) fetches the owner-scoped record; this validates it before load.
export function resolveUserWorldScenario(userWorld) {
  if (!userWorld || typeof userWorld !== "object") return null;
  const scenario = userWorld.scenario && typeof userWorld.scenario === "object" ? userWorld.scenario : null;
  if (!scenario) return null;
  return validateScenario(scenario).ok ? scenario : null;
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
    // LEDGERED BUG FIX (audit §3): the scenario front→thread path dropped
    // `reputationEffects`, so an authored front's standing effects never fired on
    // resolution (fireThreadReputation reads thread.reputationEffects). The worldgen
    // seeding path (threads.js) already copies it; this reconciles the two closers.
    reputationEffects: Array.isArray(front.reputationEffects) ? front.reputationEffects : [],
    resolution: (front.resolution || []).map((r) => ({ ...r, questId: r.questRef || r.questId })),
    callbackQuery: { entityIds: front.callbackQuery?.entityRefs || [], keywords: front.callbackQuery?.keywords || [] },
    flags: {}
  };
}

/**
 * Commit authored `scenario.bestiary.placements` into the run: each placed creature
 * becomes a HOSTILE NPC carrying its statBlockId (combat entry resolves the stat
 * block off the NPC), plus the essence trail that leads the bloodhound to it. Never
 * places a phantom (an unknown stat block is skipped); idempotent by npc id.
 */
export function placeBestiaryEncounters(run, scenario, { resolveLocationRef = (x) => x } = {}) {
  // A compiled USER world mints its own tier-1 threat (mintChaosling) and carries the
  // block in bestiary.statBlocks — register those into the runtime overlay so the
  // placement + combat resolve them (they are not in the frozen bestiary REGISTRY).
  const statBlocks = scenario?.bestiary?.statBlocks;
  if (statBlocks && typeof statBlocks === "object") {
    for (const block of Array.isArray(statBlocks) ? statBlocks : Object.values(statBlocks)) {
      registerStatBlock(block);
    }
  }
  const placements = Array.isArray(scenario?.bestiary?.placements) ? scenario.bestiary.placements : [];
  run.npcs = run.npcs || {};
  for (const p of placements) {
    if (!p || typeof p !== "object" || !isString(p.statBlockId) || !isString(p.locationRef)) continue;
    const block = resolveStatBlock(p.statBlockId);
    if (!block) continue; // never place a phantom (coherence — unknown stat block)
    const locId = resolveLocationRef(p.locationRef);
    const npcId = `npc_${p.statBlockId}`;
    if (!run.npcs[npcId]) {
      run.npcs[npcId] = {
        npcId,
        displayName: block.name,
        role: "hostile",
        currentLocationId: locId,
        known: false, // undiscovered until seen/read — the bloodhound reveals it
        status: "present",
        memoryFactIds: [],
        expressionVariants: createEmptyExpressionVariants(),
        tags: ["hostile", ...(Array.isArray(block.tags) ? block.tags : [])],
        flags: { hostile: true, statBlockId: p.statBlockId, encounter: true },
        statBlockId: p.statBlockId,
        ageClass: "adult",
        edition: "mainline",
        policyProfileId: "mainline_default",
        contentTags: [],
        origin: "procedural",
        dialogueBeats: []
      };
    }
    // Seed the essence trail toward the encounter (fromRef sees it, heading towardRef).
    const et = p.essenceTrail;
    if (et && typeof et === "object" && isString(et.fromRef) && isString(et.towardRef)) {
      const fromLoc = resolveLocationRef(et.fromRef);
      mintTraceFromSpawn(
        run,
        { kind: "trail", trailTo: resolveLocationRef(et.towardRef), source: et.source || p.statBlockId, meta: { encounter: npcId } },
        { id: `trace_${p.statBlockId}`, locationId: fromLoc, nowMinutes: currentWorldMinutes(run) }
      );
    }
  }
  return run;
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
    // `sceneRegister` is the per-world scene-art tone clause (steel/furniture split
    // 2026-07-21). It used to be a hardcoded Verdance line appended to EVERY world's
    // scene prompt — a cyberpunk alley rendered with "over-still water". Babel now
    // carries its own register as data; a world that declares none gets no clause.
    for (const k of ["name", "tone", "flavor", "artStyle", "variant", "era", "sceneRegister", "sightAccent"]) {
      if (isString(scenario.world[k])) run.world[k] = scenario.world[k];
    }
    // STEEL/FURNITURE WIDENING (2026-07-21). The string loop above carries only
    // scalars; the audit's GOVERNING FINDING was that every OBJECT/ARRAY world knob
    // authored on `scenario.world` was silently dropped here — that one omission, not
    // the schema, is what stranded orientationMix/deathLaw/etc. as "dead despite
    // authored". `validateWorldState` treats run.world as an open bag, so a structured
    // tuning block may legitimately ride through. Carried when authored with the right
    // shape; a world that declares none rides bare (byte-identical). Several of these
    // have no engine consumer YET (planned slots) — carrying them is the reachability
    // half, so a future consumer reads run.world.<slot> directly rather than forcing
    // this whitelist to be re-widened per feature. `deathLaw` is consumed today (the
    // death-screen epilogue payload); the rest are reachable-and-tested planned gates.
    const carryObject = (k) => {
      const v = scenario.world[k];
      if (v && typeof v === "object" && !Array.isArray(v)) run.world[k] = v;
    };
    const carryArray = (k) => {
      if (Array.isArray(scenario.world[k])) run.world[k] = scenario.world[k];
    };
    for (const k of ["deathLaw", "orientationMix", "systemLore", "playerSense", "speechConventions", "rankLadder", "sheetSpec", "nameBanks"]) carryObject(k);
    for (const k of ["suggestionExemplars"]) carryArray(k);
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
      // LEDGERED BUG FIX (audit §3): a scenario's NARROWED `artStyleOptions.allowed`
      // was silently discarded — stampArtStyle preserves `run.world`'s pre-existing
      // allowed (the full STYLES list from worldgen), so babel's ["anime","dark-fantasy"]
      // never bound and any style could be stamped. Seat the scenario's allowed list
      // onto run.world BEFORE stamping so stampArtStyle's preserve-branch honors it.
      const scenAllowed = scenario.world.artStyleOptions?.allowed;
      if (Array.isArray(scenAllowed) && scenAllowed.length) {
        run.world.artStyleOptions = { ...(run.world.artStyleOptions || {}), allowed: scenAllowed };
      }
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
    // A3.2 live-spawn: carry an authored spawnOnEnter chaosling spec so arriving there
    // mints the encounter into the scene (server/solo/chaoslingSpawn.js).
    if (loc.spawnOnEnter && typeof loc.spawnOnEnter === "object") {
      target.spawnOnEnter = JSON.parse(JSON.stringify(loc.spawnOnEnter));
    }
    // A3.3: authored quest-board notices (desperate register) ride the location.
    if (Array.isArray(loc.notices)) target.notices = JSON.parse(JSON.stringify(loc.notices));
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

  // ESSENCE-SIGHT SEEDING (verdance-region-v1 §law-5) — after all POIs are minted
  // and edges symmetrized, turn each POI's authored `traceSeeds` into committed
  // run.essenceTraces. Ages are authored relative to run-start; the trail path
  // endpoints are now real committed edges. rapture-sites mint outbound trails,
  // portals mint standing residue, Congregation chalk marks carry handler-scent.
  seedEssenceTracesFromScenario(run, scenario, { resolveLocationRef });

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
    const ageClass = normalizeAgeClass(c.ageClass);
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
      ageClass, // scenario cast adult unless the scenario says child
      // Romance eligibility (law R2): honor an explicit cast flag, else the age-first
      // default. Previously scenario cast never got this (only worldgen did) — every
      // compiled/authored cast NPC read as un-romanceable. (romanceable is stamped
      // just below by the A3.1 reachability line; here we carry the compiled faction.)
      ...(isString(c.factionId) ? { factionId: c.factionId } : {}),
      // W1: an authored cast member may COMMIT its appearance/portrait (overriding the
      // mint) — e.g. the VOICE is a ball of warm green-gold light. Carry the committed
      // fields + the reveal mapping (base form now, a revealed form when a committed
      // event fires — see solo/npcReveal.js).
      ...(isString(c.appearance) ? { appearance: c.appearance } : {}),
      ...(isString(c.portraitPrompt) ? { portraitPrompt: c.portraitPrompt } : {}),
      ...(isString(c.revealForm) ? { revealForm: c.revealForm } : {}),
      ...(isString(c.revealEvent) ? { revealEvent: c.revealEvent } : {}),
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
    // A3.1 ROMANCE REACHABILITY (audit 5d548ac): authored cast gets the law-R2
    // romanceable default — the SAME fail-closed age wall procedural NPCs get via
    // mintNpcReputation — so romance is reachable in authored/user worlds, not only in
    // sandbox runs. An explicit authored `romanceable:false` is honored; a non-adult
    // ageClass can never become eligible (romanceableDefault checks isAdult first).
    run.npcs[c.npcId].romanceable = c.romanceable === false ? false : romanceableDefault(run.npcs[c.npcId]);
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

  // 1.4. BESTIARY PLACEMENTS — authored encounters (e.g. the Limping Grey at the
  // Waking Mile). Each commits a hostile NPC carrying its statBlockId (so combat
  // entry grounds on a real, resolvable creature) and seeds the bloodhound essence
  // trail toward it. Numbers stay owner-table (bestiary Law-6); this only PLACES.
  placeBestiaryEncounters(run, scenario, { resolveLocationRef });

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

  // WORLD-BOUND SANDBOX (T6, sealed ruling): a sandbox is a MODULE WITHIN A WORLD —
  // it inherits the world's canon (locations, cast, factions, bestiary, laws, above)
  // but NOT the authored opening. So the authored quests + directed fronts/threads are
  // skipped in sandbox; the run opens as Verdance-without-the-authored-opening. The
  // start LOCATION binding (section 4) is kept — the world still needs a place to begin.
  const sandbox = options.sandbox === true;

  // 2. QUESTS — declared scenario quests become real active records (the objects
  // fronts ground in and triggers read). Kept thin; the quest engine tolerates it.
  if (!sandbox) for (const [qid, q] of Object.entries(scenario.quests || {})) {
    if (run.quests[qid]) continue;
    // A3.2: carry authored STAGES + completion when present, so a scenario quest is a
    // real advanceable arc (reach_location / talk_beat), not just a static objective.
    const authoredStages = Array.isArray(q.stages)
      ? q.stages.map((s) => ({ objective: String(s.objective || ""), completion: s.completion })).filter((s) => s.completion && typeof s.completion === "object")
      : null;
    const stageZero = authoredStages && authoredStages.length ? authoredStages[0] : null;
    run.quests[qid] = {
      questId: qid,
      status: "active",
      stage: 0,
      title: q.title || qid,
      description: q.summary || q.description || "",
      objective: stageZero ? stageZero.objective : (q.summary || q.title || ""),
      ...(stageZero ? { stages: authoredStages, completion: stageZero.completion } : {}),
      relatedEntityIds: [],
      memoryFactIds: [],
      authoredBy: "scenario",
      isMain: q.kind === "delivery",
      flags: {}
    };
  }

  // 3. THREADS — fronts → run.threads (refs resolved to real ids). Skipped in a
  // world-bound sandbox: the directed fronts ARE the authored opening.
  if (!sandbox) for (const front of scenario.fronts || []) {
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
