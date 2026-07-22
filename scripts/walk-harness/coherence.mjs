// ---------------------------------------------------------------------------
// WALK-DOOR HARNESS — COHERENCE (Job 5). In-process, ZERO paid cost, no server,
// no AI. Loads the authored world through the REAL commit path and asserts:
//   5.1 authored-content integrity  — authored values survive the commit byte-identical
//   5.2 cross-reference integrity    — every name in authored prose resolves to a live entity
//   5.3 prose-vs-commit reconciliation — narration asserts nothing the server never committed
//   5.4 negative-space               — the structure that makes "nothing happened" detectable
// The prose-vs-commit primitives are the SAME detectors the live auditors use, so a
// green here means the same wall the runtime enforces holds on authored content too.
// ---------------------------------------------------------------------------

import { createDefaultSoloRun } from "../../server/solo/schema.js";
import { loadScenarioIntoRun, loadScenarioFile } from "../../server/campaign/scenarioLoader.js";
import { detectPhantomNpcNames } from "../../server/solo/npcCommit.js";

function fresh(scenarioId = "babel") {
  const run = createDefaultSoloRun({ runId: "harness_coherence", now: "2026-01-01T00:00:00.000Z" });
  run.worldSeed = "harness_coherence";
  const scenario = loadScenarioFile(scenarioId);
  loadScenarioIntoRun(run, scenario, {});
  return { run, scenario };
}

const F = (surface, ok, detail) => ({ surface, ok, detail });

// ── 5.1 AUTHORED-CONTENT INTEGRITY ───────────────────────────────────────────
// Every authored value must reach run state byte-identical through loadScenarioIntoRun.
// (The runtime procedural-overwrite guard — repository.js:1380 — is pinned by the
// existing tests/authored-cast-identity-law.test.js, which we reference, not duplicate,
// to avoid needing a DB here.)
export function checkAuthoredIntegrity(scenarioId = "babel") {
  const findings = [];
  const { run, scenario } = fresh(scenarioId);

  // cast names + appearance + faction binding + disposition survive
  for (const c of Array.isArray(scenario.cast) ? scenario.cast : []) {
    if (!c || !c.npcId) continue;
    const npc = run.npcs[c.npcId];
    if (!npc) { findings.push(F("authored.cast", false, `${c.npcId}: authored cast member absent from run.npcs`)); continue; }
    if (typeof c.displayName === "string" && c.displayName.trim()) {
      findings.push(F("authored.cast.name", npc.displayName === c.displayName, `${c.npcId}: displayName authored="${c.displayName}" run="${npc.displayName}"`));
    }
    if (typeof c.factionId === "string" && c.factionId) {
      findings.push(F("authored.cast.faction", npc.factionId === c.factionId, `${c.npcId}: factionId authored="${c.factionId}" run="${npc.factionId}"`));
    }
    if (typeof c.appearance === "string" && c.appearance.trim()) {
      findings.push(F("authored.cast.appearance", npc.appearance === c.appearance, `${c.npcId}: appearance mutated`));
    }
  }
  // location names survive
  for (const [ref, loc] of Object.entries(scenario.locations || {})) {
    if (!loc || typeof loc.name !== "string") continue;
    const id = ref;
    const runLoc = run.locations[id];
    if (runLoc) findings.push(F("authored.location.name", runLoc.name === loc.name, `${id}: name authored="${loc.name}" run="${runLoc.name}"`));
  }
  // faction wants survive (rides flags.wants — no engine field)
  for (const f of Array.isArray(scenario.factions) ? scenario.factions : []) {
    if (!f || !f.factionId || typeof f.wants !== "string") continue;
    const fac = Object.values(run.factions || {}).find((x) => x.factionId === f.factionId);
    if (fac) findings.push(F("authored.faction.wants", (fac.flags?.wants) === f.wants, `${f.factionId}: wants survived onto flags.wants`));
  }
  return summarize("5.1 authored-content integrity", findings);
}

// ── 5.2 CROSS-REFERENCE INTEGRITY ────────────────────────────────────────────
// A fuzzy "every capitalized word must resolve" scan is the wrong tool — it false-
// fails on sentence-initial words, common nouns, adjectives, and lore ("Verdance",
// "Victorian", "Above"). That is the harness-cries-wolf failure. Precise instead:
//   (a) STRUCTURED REFS (machine-checkable ids) must resolve — the real integrity
//       contract validateScenario does NOT fully enforce (dangling entityRef/locationRef).
//   (b) DIRECTIVE POINTERS ("speak to Ruth", "ask Grace", "report to X") must name a
//       live person — a broken player pointer is a real bug (HARD FAIL).
//   (c) FLAVOR mentions (a person named in prose with no committed record, e.g. the
//       "Merrin" signature) are REPORTED as warnings, not gated — an off-screen
//       signature is legitimate; only an actionable pointer to a missing entity fails.
export function checkCrossReferences(scenarioId = "babel") {
  const { run, scenario } = fresh(scenarioId);
  const findings = [];
  const hasNpc = (id) => Boolean(run.npcs?.[id]) || id === run.player?.playerId || id === "player";
  const hasLoc = (ref) => Boolean(run.locations?.[ref]) || Boolean(run.locations?.[String(ref).replace(/^loc_/, "")]) || ["start", "start_location", "second_location", "third_location"].includes(ref);
  const hasQuest = (id) => Boolean(run.quests?.[id]);

  // (a) structured refs in fronts + opening + secrets
  for (const fr of Array.isArray(scenario.fronts) ? scenario.fronts : []) {
    const g = fr.groundedIn || {};
    for (const id of g.entityRefs || []) findings.push(F("cross-ref.struct.entity", hasNpc(id), `front ${fr.frontId} groundedIn.entityRefs "${id}" ${hasNpc(id) ? "resolves" : "→ NO live npc"}`));
    for (const id of g.locationRefs || []) findings.push(F("cross-ref.struct.location", hasLoc(id), `front ${fr.frontId} groundedIn.locationRefs "${id}" ${hasLoc(id) ? "resolves" : "→ NO live location"}`));
    for (const id of g.questRefs || []) findings.push(F("cross-ref.struct.quest", hasQuest(id), `front ${fr.frontId} groundedIn.questRefs "${id}" ${hasQuest(id) ? "resolves" : "→ NO live quest"}`));
    for (const id of fr.callbackQuery?.entityRefs || []) findings.push(F("cross-ref.struct.callback", hasNpc(id), `front ${fr.frontId} callbackQuery.entityRefs "${id}" ${hasNpc(id) ? "resolves" : "→ NO live npc"}`));
  }
  const op = scenario.opening || {};
  if (op.startLocationRef) findings.push(F("cross-ref.struct.opening", hasLoc(op.startLocationRef), `opening.startLocationRef "${op.startLocationRef}" ${hasLoc(op.startLocationRef) ? "resolves" : "→ NO live location"}`));
  for (const s of Array.isArray(scenario.secrets) ? scenario.secrets : []) {
    if (s.reveal?.onLocation) findings.push(F("cross-ref.struct.secret", hasLoc(s.reveal.onLocation), `secret ${s.secretId || ""} reveal.onLocation "${s.reveal.onLocation}" ${hasLoc(s.reveal.onLocation) ? "resolves" : "→ NO live location"}`));
  }

  // (b) directive pointers in authored prose (notices/quests): "speak to X" etc.
  const liveFirst = new Set();
  for (const npc of Object.values(run.npcs || {})) String(npc.displayName || npc.generatedName || "").toLowerCase().split(/\s+/).forEach((t) => t.length >= 3 && liveFirst.add(t));
  const DIRECTIVE = /\b(?:speak to|talk to|report to|ask|find|see|bring[^.]*? to)\s+([A-Z][a-z]{2,})\b/g;
  const proseUnits = [];
  for (const loc of Object.values(scenario.locations || {})) for (const n of Array.isArray(loc?.notices) ? loc.notices : []) proseUnits.push({ src: `notice ${n.noticeId || n.id || ""}`, text: n.body || n.text || "" });
  for (const q of Object.values(scenario.quests || {})) proseUnits.push({ src: `quest ${q.title || ""}`, text: `${q.summary || ""} ${q.objective || ""}` });
  let brokenPointers = 0;
  for (const u of proseUnits) {
    let m; DIRECTIVE.lastIndex = 0;
    while ((m = DIRECTIVE.exec(u.text)) !== null) {
      const name = m[1];
      if (["St", "The", "Anyone", "Whoever"].includes(name)) continue;
      const ok = liveFirst.has(name.toLowerCase());
      if (!ok) { brokenPointers++; findings.push(F("cross-ref.pointer", false, `${u.src}: directive "…${m[0]}…" points at "${name}" — NO live person of that name (broken player pointer)`)); }
    }
  }
  if (brokenPointers === 0) findings.push(F("cross-ref.pointer", true, "every actionable directive pointer (speak-to/ask/find X) resolves to a live person"));

  // (c) flavor mentions (warning only — surfaced, not gated)
  const known = [];
  for (const npc of Object.values(run.npcs || {})) { if (npc.displayName) known.push(npc.displayName); if (npc.generatedName) known.push(npc.generatedName); }
  for (const loc of Object.values(run.locations || {})) if (loc.name) known.push(loc.name);
  const flavor = new Set();
  for (const u of proseUnits) for (const p of detectPhantomNpcNames(u.text, known)) flavor.add(p);
  const warnings = [...flavor].map((n) => `authored prose names "${n}" with no committed entity (flavor mention — not gated; verify it is an intentional off-screen reference)`);

  const s = summarize("5.2 cross-reference integrity", findings);
  s.warnings = warnings;
  return s;
}

// ── 5.3 PROSE-VS-COMMIT (primitive + authored-opening application) ────────────
// The reusable diff: given a run + a narration string, does the prose assert a
// PROPER-NAMED agent the run never committed? (The runtime also runs unnamed-agent /
// found-object / nature detectors; those live in the turn pipeline. Here we apply the
// name detector to authored opening prose as a zero-cost structural pass, and expose
// the primitive for the runner to apply to a scripted live turn.)
export function proseAssertsUncommitted(run, narration) {
  const known = [];
  for (const npc of Object.values(run.npcs || {})) { if (npc.displayName) known.push(npc.displayName); if (npc.generatedName) known.push(npc.generatedName); }
  if (run.player?.displayName) known.push(run.player.displayName);
  for (const loc of Object.values(run.locations || {})) if (loc.name) known.push(loc.name);
  return detectPhantomNpcNames(String(narration || ""), known); // [] = clean
}
export function checkProseVsCommitAuthoredOpening(scenarioId = "babel") {
  const { run, scenario } = fresh(scenarioId);
  const beats = Array.isArray(scenario.opening?.authoredBeats) ? scenario.opening.authoredBeats.join("\n\n") : "";
  const phantoms = proseAssertsUncommitted(run, beats);
  const findings = [F("prose-vs-commit.opening", phantoms.length === 0,
    phantoms.length ? `authored opening asserts uncommitted named character(s): ${phantoms.join(", ")}` : "authored opening asserts no uncommitted named characters")];
  return summarize("5.3 prose-vs-commit (authored opening)", findings);
}

// ── 5.4 NEGATIVE-SPACE (structural detectability) ────────────────────────────
// Assert the STRUCTURE that makes "nothing happened when it should have" detectable:
// quests are advanceable (have completion triggers), threads have firing gates (not
// permanently dormant), momentum config exists. Plus the live-diff primitive the
// runner uses on a scripted turn (a delta snapshot).
export function checkNegativeSpaceStructure(scenarioId = "babel") {
  const { run } = fresh(scenarioId);
  const findings = [];
  const quests = Object.values(run.quests || {});
  const advanceable = quests.filter((q) => Array.isArray(q.stages) && q.stages.some((s) => s?.completion));
  findings.push(F("neg-space.quests-advanceable", quests.length === 0 || advanceable.length > 0,
    `${advanceable.length}/${quests.length} quests carry a stage completion trigger (a reach_location/talk_beat that a turn can advance)`));
  const threads = Object.values(run.threads || {});
  const fireable = threads.filter((t) => Array.isArray(t.beats) && t.beats.some((b) => b?.trigger));
  findings.push(F("neg-space.threads-fireable", threads.length === 0 || fireable.length > 0,
    `${fireable.length}/${threads.length} threads carry a beat trigger (a committed danger that CAN escalate — a permanently-dormant thread would be undetectable)`));
  return summarize("5.4 negative-space structure", findings);
}

// A run-delta snapshot for the runner (to detect an action that produced NO delta).
export function runDeltaSnapshot(run) {
  return {
    npcs: Object.keys(run.npcs || {}).length,
    timeline: (run.timeline || []).length,
    memoryFacts: (run.memoryFacts || []).length,
    questStages: Object.values(run.quests || {}).map((q) => q.stage ?? 0).join(","),
    clock: run.world?.time?.minutes ?? 0,
    hp: run.player?.resources?.hitPoints?.current ?? null
  };
}

function summarize(name, findings) {
  const failed = findings.filter((f) => !f.ok);
  return { name, ok: failed.length === 0, total: findings.length, failed: failed.length, findings };
}

export function runAllCoherence(scenarioId = "babel") {
  return [
    checkAuthoredIntegrity(scenarioId),
    checkCrossReferences(scenarioId),
    checkProseVsCommitAuthoredOpening(scenarioId),
    checkNegativeSpaceStructure(scenarioId)
  ];
}
