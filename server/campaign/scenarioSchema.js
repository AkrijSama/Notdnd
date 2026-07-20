// SCENARIO AUTHORING SCHEMA + VALIDATOR (the UGC boundary).
//
// This is the ONE code artifact of the scenario-system spec
// (docs/inkborne-scenarios-spec.md). A scenario is DECLARATIVE JSON — no
// build() functions, no code (D.5 sign-off #3). This module validates that a
// scenario is well-formed and referentially closed BEFORE a run ever loads it,
// so a dangling ref is an author-time content bug, never a runtime surprise
// (D.5 §6.2, the linkedQuestIds integrity pattern in server/solo/schema.js:1103
// applied to the whole scenario). It is PURE and wired into nothing in this
// task; D.5 Phase 1's loader imports `validateScenario` as its gate.
//
// Vocabulary is grounded in Dungeon World Fronts (a decade-proven implementation
// of the D.5 thread model) — the constraints below are enforced, not advisory:
//   * ≤3 fronts, ≤1 foreground        — the anti-noise cap
//   * 2-4 ordered beats per front      — the "grim portents" ladder …
//   * … EXCEPT gated-sequence fronts   — a strictly linear, one-active-rung chain
//                                        (the tower) may exceed 4 (see TOPOLOGY)
//   * each beat observable (telegraph) + preventable (danger fronts)
//   * dual advancement: descriptive (player caused it) AND/OR prescriptive
//     (clock/failed roll) — a pressure front MUST offer descriptive advancement
//     so a busy player never starves it (resolves D.5 §8's pacing risk)
//   * secrets: a pool of tweet-sized discoverable facts tied to fronts
//
// A "front" (authoring) instantiates a "thread" (runtime, run.threads — D.5 §2.1),
// exactly as a quest template instantiates a quest state. Front : thread ::
// questTemplate : questState.

export const SCENARIO_SUBSTRATE_VERSION = 1;

// D.5 §2.1 thread kinds.
export const FRONT_KINDS = Object.freeze(["danger", "secret", "rival", "consequence", "opportunity"]);

// Fronts whose whole point is escalating pressure. These MUST be able to advance
// descriptively (off the player's own actions), or a busy player starves them.
const PRESSURE_KINDS = Object.freeze(["danger", "rival", "consequence"]);

// D.5 §5.3 reveal states.
export const REVEAL_STATES = Object.freeze(["hidden", "rumored", "revealed"]);

// TOPOLOGY (DW simple vs complex front, + the tower concession):
//   linear         — bad→worse→worse; a single ordered ladder, 2-4 beats.
//   parallel       — complex front: 2-4 independent pathways (beats need not chain).
//   gated-sequence — a strictly totally-ordered chain that MAY exceed 4 beats
//                    because only ONE rung is ever eligible at a time (each beat
//                    gates on its predecessor). The anti-noise cap is really a cap
//                    on CONCURRENT pressure; a one-active-rung sequence creates no
//                    noise, so it is exempt from the flat 2-4 limit. This is the
//                    schema addition the floor-gated tower forces (see the report).
export const FRONT_TOPOLOGIES = Object.freeze(["linear", "parallel", "gated-sequence"]);

// D.5 §2.2 commit payload kinds — the momentum kinds (npc/objectState/quest) plus
// the two D.5 additions (fact, hostileNpc). Exactly one per beat; all must be
// committable (D.5: "a beat that changes nothing is invalid content").
export const BEAT_PAYLOAD_KINDS = Object.freeze(["fact", "npc", "objectState", "quest", "hostileNpc"]);

// D.5 §5.2 resolution rule kinds.
export const RESOLUTION_KINDS = Object.freeze(["quest", "beat_final", "ground_lost", "expiry"]);

// The interpolation tokens the loader resolves at commit (D.5 §3.1 / quests.js
// §192-196). A `{token}` outside this set is an author typo → fail-loud.
const INTERPOLATION_TOKENS = Object.freeze(["{world}", "{place}", "{start}", "{tone}", "{player_location}"]);

// Positional symbolic location refs the loader binds against the (post-worldgen)
// graph — the quests.js "second_location"/"third_location" pattern, generalized
// to an ordinal chain (so a vertical tower can name floor positions).
const POSITIONAL_LOCATION_RE =
  /^(start|final_location|(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)_location|floor_(?:[1-9]|1[0-9])_location)$/;

// Symbolic NPC refs the loader recognizes even when the scenario doesn't declare
// them in cast (D.5 uses npc_quest_giver / npc_far_witness as loader-bound roles).
const SYMBOLIC_NPC_RE = /^npc_(quest_giver|far_witness)$/;

const TWEET_MAX = 280;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function push(errors, path, message) {
  errors.push({ path, message });
}

// A location ref resolves if it is a recognized interpolation token, a positional
// symbolic ref, or an id the scenario itself declares (in `locations`).
function locationRefResolves(ref, declared) {
  if (!isString(ref)) return false;
  if (INTERPOLATION_TOKENS.includes(ref)) return true;
  if (POSITIONAL_LOCATION_RE.test(ref)) return true;
  return declared.locations.has(ref);
}
function npcRefResolves(ref, declared) {
  if (!isString(ref)) return false;
  if (ref === "{player_location}") return false; // not an npc
  if (SYMBOLIC_NPC_RE.test(ref)) return true;
  return declared.npcs.has(ref);
}
function questRefResolves(ref, declared) {
  return isString(ref) && (declared.quests.has(ref) || declared.questOffers.has(ref));
}

// Collect every id the scenario declares, so refs can be checked against a closed
// world (declared ids ∪ recognized symbolic tokens). Fail-loud on anything else.
function collectDeclaredIds(scenario) {
  const declared = {
    npcs: new Set(),
    quests: new Set(),
    questOffers: new Set(),
    fronts: new Set(),
    beats: new Set(),
    locations: new Set(),
    secrets: new Set()
  };
  for (const c of Array.isArray(scenario.cast) ? scenario.cast : []) {
    if (isString(c?.npcId)) declared.npcs.add(c.npcId);
  }
  if (isPlainObject(scenario.quests)) for (const k of Object.keys(scenario.quests)) declared.quests.add(k);
  if (isPlainObject(scenario.questOffers)) for (const k of Object.keys(scenario.questOffers)) declared.questOffers.add(k);
  if (Array.isArray(scenario.locations)) {
    for (const l of scenario.locations) {
      if (isString(l?.id)) declared.locations.add(l.id);
      else if (isString(l)) declared.locations.add(l);
    }
  } else if (isPlainObject(scenario.locations)) {
    // World-book scenarios (e.g. babel's Verdance region) key locations as an
    // object MAP; the loader reads them with Object.entries, so their keys are
    // real declared location ids. (The array form above is the legacy authoring
    // shorthand.) Without this, object-keyed POIs were invisible to ref-checking
    // and any front/cast/secret grounding in one failed validation.
    for (const k of Object.keys(scenario.locations)) declared.locations.add(k);
  }
  for (const f of Array.isArray(scenario.fronts) ? scenario.fronts : []) {
    if (isString(f?.frontId)) declared.fronts.add(f.frontId);
    for (const b of Array.isArray(f?.beats) ? f.beats : []) {
      if (isString(b?.beatId)) declared.beats.add(b.beatId);
    }
  }
  for (const s of Array.isArray(scenario.secrets) ? scenario.secrets : []) {
    if (isString(s?.secretId)) declared.secrets.add(s.secretId);
  }
  return declared;
}

// ── grounding (D.5 §2.1 groundedIn) ──────────────────────────────────────────
function validateGrounding(grounding, path, declared, errors) {
  if (grounding === undefined) return; // grounding is optional at the object level; a front SHOULD ground (checked by caller)
  if (!isPlainObject(grounding)) {
    push(errors, path, "groundedIn must be an object");
    return;
  }
  for (const ref of Array.isArray(grounding.entityRefs) ? grounding.entityRefs : []) {
    if (!npcRefResolves(ref, declared)) push(errors, `${path}.entityRefs`, `unresolved entity ref "${ref}"`);
  }
  for (const ref of Array.isArray(grounding.locationRefs) ? grounding.locationRefs : []) {
    if (!locationRefResolves(ref, declared)) push(errors, `${path}.locationRefs`, `unresolved location ref "${ref}"`);
  }
  for (const ref of Array.isArray(grounding.questRefs) ? grounding.questRefs : []) {
    if (!questRefResolves(ref, declared)) push(errors, `${path}.questRefs`, `unresolved quest ref "${ref}"`);
  }
}

// ── beat payload (D.5 §2.2 — exactly one committable kind) ────────────────────
function validateBeatPayload(payload, path, declared, errors) {
  if (!isPlainObject(payload)) {
    push(errors, path, "beat payload must be an object with exactly one committable kind");
    return;
  }
  const kinds = Object.keys(payload).filter((k) => BEAT_PAYLOAD_KINDS.includes(k));
  if (kinds.length !== 1) {
    push(errors, path, `beat payload must carry exactly one of ${BEAT_PAYLOAD_KINDS.join("|")} (found ${kinds.length}); a beat that commits nothing is invalid content`);
    return;
  }
  const kind = kinds[0];
  const body = payload[kind];
  if (!isPlainObject(body)) {
    push(errors, `${path}.${kind}`, "payload body must be an object");
    return;
  }
  if (kind === "fact" && !isString(body.text)) {
    push(errors, `${path}.fact`, "fact payload requires non-empty text");
  }
  if (kind === "hostileNpc") {
    // D.4 Phase 0 §3.4: statBlockId is a non-empty string; the bestiary owns
    // resolution. The scenario schema validates the string contract only.
    if (!isString(body.statBlockId)) push(errors, `${path}.hostileNpc`, "hostileNpc requires a non-empty statBlockId string");
    if (!isString(body.npcId)) push(errors, `${path}.hostileNpc`, "hostileNpc requires an npcId");
    if (body.placeAt !== undefined && !locationRefResolves(body.placeAt, declared)) {
      push(errors, `${path}.hostileNpc.placeAt`, `unresolved location ref "${body.placeAt}"`);
    }
  }
  if ((kind === "npc") && !isString(body.npcId)) push(errors, `${path}.npc`, "npc payload requires an npcId");
  if (kind === "objectState") {
    // Mirrors commitMomentumPayload's objectState shape (server/solo/momentum.js
    // :219-243): a keyed flag on a location, optionally foreclosing retry.
    if (!isString(body.key)) push(errors, `${path}.objectState`, "objectState payload requires a key");
    if (body.locationId !== undefined && !locationRefResolves(body.locationId, declared)) {
      push(errors, `${path}.objectState.locationId`, `unresolved location ref "${body.locationId}"`);
    }
    if (body.retryEffect !== undefined && !["none", "harder", "blocked"].includes(body.retryEffect)) {
      push(errors, `${path}.objectState.retryEffect`, 'retryEffect must be one of none|harder|blocked');
    }
  }
  if (kind === "quest" && !isString(body.questRef) && !isString(body.questId) && !isString(body.template)) {
    push(errors, `${path}.quest`, "quest payload requires a questRef (to scenario.quests), an inline questId, or a template");
  }
  if (kind === "quest" && isString(body.questRef) && !questRefResolves(body.questRef, declared)) {
    push(errors, `${path}.quest.questRef`, `unresolved quest ref "${body.questRef}"`);
  }
}

// ── beat trigger (DUAL ADVANCEMENT — the DW/anti-starvation contract) ─────────
// A beat must offer at least one firing mode. `prescriptive` fires on the
// momentum clock (quiet/failed turn) when its predicates hold; `descriptive`
// fires immediately on finalize when the player's OWN committed action matches
// (D.5 §4.2.4's "hard player-borne condition", promoted to a first-class mode).
function validateBeatTrigger(trigger, path, declared, errors, priorBeatIds) {
  if (!isPlainObject(trigger)) {
    push(errors, path, "beat requires a trigger object");
    return { hasDescriptive: false };
  }
  const pre = trigger.prescriptive;
  const desc = trigger.descriptive;
  if (pre === undefined && desc === undefined) {
    push(errors, path, "beat trigger must define prescriptive and/or descriptive advancement");
  }
  if (pre !== undefined && !isPlainObject(pre)) push(errors, `${path}.prescriptive`, "prescriptive must be an object");
  if (desc !== undefined && !isPlainObject(desc)) push(errors, `${path}.descriptive`, "descriptive must be an object");

  // requiresBeat (ladder ordering) must name an earlier beat in THIS front.
  if (isPlainObject(pre) && pre.requiresBeat !== undefined) {
    if (!priorBeatIds.has(pre.requiresBeat)) {
      push(errors, `${path}.prescriptive.requiresBeat`, `requiresBeat "${pre.requiresBeat}" must reference an earlier beat in the same front`);
    }
  }
  // Ref-check any location/quest refs inside triggers.
  for (const t of [pre, desc]) {
    if (!isPlainObject(t)) continue;
    if (t.playerAt !== undefined && t.playerAt !== null && !locationRefResolves(t.playerAt, declared)) {
      push(errors, `${path}.playerAt`, `unresolved location ref "${t.playerAt}"`);
    }
    if (t.onPlayerAt !== undefined && !locationRefResolves(t.onPlayerAt, declared)) {
      push(errors, `${path}.onPlayerAt`, `unresolved location ref "${t.onPlayerAt}"`);
    }
    if (isPlainObject(t.questState) && !questRefResolves(t.questState.questRef, declared)) {
      push(errors, `${path}.questState.questRef`, `unresolved quest ref "${t.questState?.questRef}"`);
    }
    if (isPlainObject(t.onQuestStage) && !questRefResolves(t.onQuestStage.questRef, declared)) {
      push(errors, `${path}.onQuestStage.questRef`, `unresolved quest ref "${t.onQuestStage?.questRef}"`);
    }
  }
  return { hasDescriptive: isPlainObject(desc) };
}

// ── front (a thread template) ────────────────────────────────────────────────
function validateFront(front, path, declared, errors) {
  if (!isPlainObject(front)) {
    push(errors, path, "front must be an object");
    return;
  }
  if (!isString(front.frontId)) push(errors, `${path}.frontId`, "front requires a frontId");
  if (!FRONT_KINDS.includes(front.kind)) push(errors, `${path}.kind`, `kind must be one of ${FRONT_KINDS.join("|")}`);
  if (!REVEAL_STATES.includes(front.revealState)) push(errors, `${path}.revealState`, `revealState must be one of ${REVEAL_STATES.join("|")}`);
  const topology = front.topology;
  if (!FRONT_TOPOLOGIES.includes(topology)) push(errors, `${path}.topology`, `topology must be one of ${FRONT_TOPOLOGIES.join("|")}`);

  // Grounding: a front SHOULD ground in real state (D.5 §2.1). Grounding is
  // required to be present and non-empty for all but pure-opportunity fronts.
  const g = front.groundedIn;
  const grounded =
    isPlainObject(g) &&
    ((Array.isArray(g.entityRefs) && g.entityRefs.length) ||
      (Array.isArray(g.locationRefs) && g.locationRefs.length) ||
      (Array.isArray(g.questRefs) && g.questRefs.length));
  if (!grounded) push(errors, `${path}.groundedIn`, "front must ground in at least one real entity/location/quest ref");
  validateGrounding(g, `${path}.groundedIn`, declared, errors);

  // Beats.
  const beats = Array.isArray(front.beats) ? front.beats : null;
  if (!beats || beats.length < 2) {
    push(errors, `${path}.beats`, "a front requires an ordered ladder of at least 2 beats");
    return;
  }
  // THE ANTI-NOISE CAP — conditional on topology. linear/parallel: 2-4 (the DW
  // grim-portent cap). gated-sequence: >4 allowed BUT the total order is enforced
  // below, so only one rung is ever eligible (no concurrent noise).
  if (topology !== "gated-sequence" && beats.length > 4) {
    push(errors, `${path}.beats`, `a ${topology} front is capped at 4 beats (the anti-noise grim-portent limit); use topology "gated-sequence" for a longer strictly-gated chain`);
  }

  const priorBeatIds = new Set();
  let frontHasDescriptive = false;
  beats.forEach((beat, i) => {
    const bpath = `${path}.beats[${i}]`;
    if (!isPlainObject(beat)) {
      push(errors, bpath, "beat must be an object");
      return;
    }
    if (!isString(beat.beatId)) push(errors, `${bpath}.beatId`, "beat requires a beatId");
    // OBSERVABLE (DW grim portent must be observable): a telegraph is required.
    if (!isString(beat.telegraph)) push(errors, `${bpath}.telegraph`, "every beat requires a telegraph (grim portents must be observable)");
    // brief + decision ride the narrativeDriver (D.5 §4.1): both required.
    if (!isString(beat.brief)) push(errors, `${bpath}.brief`, "beat requires a committed, grounded brief");
    if (!isString(beat.decision)) push(errors, `${bpath}.decision`, "beat requires a decision (the pressure/choice)");

    validateBeatPayload(beat.payload, `${bpath}.payload`, declared, errors);
    const { hasDescriptive } = validateBeatTrigger(beat.trigger, `${bpath}.trigger`, declared, errors, priorBeatIds);
    if (hasDescriptive) frontHasDescriptive = true;

    // GATED-SEQUENCE total-order enforcement: every beat after the first must gate
    // on the immediately prior beat, guaranteeing one-active-rung.
    if (topology === "gated-sequence" && i > 0) {
      const req = beat.trigger?.prescriptive?.requiresBeat ?? beat.trigger?.descriptive?.requiresBeat;
      const prevId = beats[i - 1]?.beatId;
      if (req !== prevId) {
        push(errors, `${bpath}.trigger`, `gated-sequence beats must gate on the immediately prior beat ("${prevId}") to stay one-active; got "${req ?? "none"}"`);
      }
    }
    if (isString(beat.beatId)) priorBeatIds.add(beat.beatId);
  });

  // DUAL ADVANCEMENT anti-starvation: a PRESSURE front must offer descriptive
  // advancement somewhere, or a busy player never triggers it (D.5 §8 risk).
  if (PRESSURE_KINDS.includes(front.kind) && !frontHasDescriptive) {
    push(errors, `${path}.beats`, `a ${front.kind} front must offer descriptive advancement on at least one beat (else a busy player starves it)`);
  }

  // Resolution (D.5 §5.2): at least one rule; dangers never silently expire.
  const res = Array.isArray(front.resolution) ? front.resolution : [];
  if (!res.length) push(errors, `${path}.resolution`, "front requires at least one resolution rule");
  res.forEach((r, i) => {
    if (!RESOLUTION_KINDS.includes(r?.kind)) push(errors, `${path}.resolution[${i}].kind`, `resolution kind must be one of ${RESOLUTION_KINDS.join("|")}`);
    if (r?.kind === "quest" && !questRefResolves(r.questRef, declared)) push(errors, `${path}.resolution[${i}].questRef`, `unresolved quest ref "${r?.questRef}"`);
  });
  if (front.kind === "danger" && res.every((r) => r?.kind === "expiry")) {
    push(errors, `${path}.resolution`, "a danger front must not resolve solely by expiry (dangers resolve or escalate, never silently lapse)");
  }
}

// ── secrets pool (tweet-sized discoverable facts tied to fronts) ──────────────
function validateSecret(secret, path, declared, errors) {
  if (!isPlainObject(secret)) {
    push(errors, path, "secret must be an object");
    return;
  }
  if (!isString(secret.secretId)) push(errors, `${path}.secretId`, "secret requires a secretId");
  if (!isString(secret.text)) push(errors, `${path}.text`, "secret requires text");
  else if (secret.text.length > TWEET_MAX) push(errors, `${path}.text`, `secret text must be tweet-sized (≤${TWEET_MAX} chars); got ${secret.text.length}`);
  // A secret illuminates a front — the frontRef must exist.
  if (!isString(secret.frontRef) || !declared.fronts.has(secret.frontRef)) {
    push(errors, `${path}.frontRef`, `secret must reference a declared front; got "${secret.frontRef}"`);
  }
  // Reveal condition grounds the discovery.
  if (!isPlainObject(secret.reveal)) push(errors, `${path}.reveal`, "secret requires a reveal condition object");
  else {
    const r = secret.reveal;
    if (r.onLocation !== undefined && !locationRefResolves(r.onLocation, declared)) push(errors, `${path}.reveal.onLocation`, `unresolved location ref "${r.onLocation}"`);
    if (r.onEntityKnown !== undefined && !npcRefResolves(r.onEntityKnown, declared)) push(errors, `${path}.reveal.onEntityKnown`, `unresolved entity ref "${r.onEntityKnown}"`);
  }
}

/**
 * Validate a declarative scenario. Pure; never throws. Returns { ok, errors }
 * with errors = [{ path, message }] (the house convention).
 */
export function validateScenario(scenario) {
  const errors = [];
  if (!isPlainObject(scenario)) {
    return { ok: false, errors: [{ path: "scenario", message: "scenario must be an object" }] };
  }
  // UGC version lock (D.5 §8) — a scenario declares the vocabulary it targets.
  if (scenario.substrate !== SCENARIO_SUBSTRATE_VERSION) {
    push(errors, "substrate", `scenario must declare substrate: ${SCENARIO_SUBSTRATE_VERSION}`);
  }
  if (!isString(scenario.scenarioId)) push(errors, "scenarioId", "scenario requires a scenarioId");
  if (!isString(scenario.title)) push(errors, "title", "scenario requires a title");
  if (!isString(scenario.genre)) push(errors, "genre", "scenario requires genre metadata");
  // T5: optional genre TAGS — small player-facing register labels a world carries (1-2:
  // isekai, cyberpunk, cosmic-horror, ...). Distinct from the single `genre` string; a
  // world may declare none. When present it must be an array of 1-2 non-empty strings.
  if (scenario.genreTags !== undefined) {
    if (
      !Array.isArray(scenario.genreTags) ||
      scenario.genreTags.length < 1 ||
      scenario.genreTags.length > 2 ||
      !scenario.genreTags.every((t) => isString(t) && t.trim())
    ) {
      push(errors, "genreTags", "genreTags must be an array of 1-2 non-empty strings when present");
    }
  }
  if (!Array.isArray(scenario.tones) || !scenario.tones.length) push(errors, "tones", "scenario requires a non-empty tones array");
  if (!isString(scenario.stakes)) push(errors, "stakes", "scenario requires a one-line stakes string");
  if (!isPlainObject(scenario.opening)) push(errors, "opening", "scenario requires an opening object");

  const declared = collectDeclaredIds(scenario);

  // FRONTS — the anti-noise cap: ≤3 fronts, ≤1 foreground (DW).
  const fronts = Array.isArray(scenario.fronts) ? scenario.fronts : null;
  if (!fronts) {
    push(errors, "fronts", "scenario requires a fronts array");
  } else {
    if (fronts.length > 3) push(errors, "fronts", `at most 3 active fronts (the anti-noise cap); got ${fronts.length}`);
    const foreground = fronts.filter((f) => f?.foreground === true).length;
    if (foreground > 1) push(errors, "fronts", `at most one foreground front; got ${foreground}`);
    fronts.forEach((f, i) => validateFront(f, `fronts[${i}]`, declared, errors));
  }

  // SECRETS — every scenario carries a pool (the connective tissue).
  const secrets = Array.isArray(scenario.secrets) ? scenario.secrets : null;
  if (!secrets || !secrets.length) {
    push(errors, "secrets", "scenario requires a non-empty secrets pool");
  } else {
    secrets.forEach((s, i) => validateSecret(s, `secrets[${i}]`, declared, errors));
  }

  // OPENING refs resolve.
  if (isPlainObject(scenario.opening)) {
    const o = scenario.opening;
    if (o.questObjectiveFrom !== undefined && !questRefResolves(o.questObjectiveFrom, declared)) {
      push(errors, "opening.questObjectiveFrom", `unresolved quest ref "${o.questObjectiveFrom}"`);
    }
    if (o.startLocationRef !== undefined && !locationRefResolves(o.startLocationRef, declared)) {
      push(errors, "opening.startLocationRef", `unresolved location ref "${o.startLocationRef}"`);
    }
  }

  // CAST refs resolve (placement + quest offers).
  for (const [i, c] of (Array.isArray(scenario.cast) ? scenario.cast : []).entries()) {
    if (!isPlainObject(c)) {
      push(errors, `cast[${i}]`, "cast member must be an object");
      continue;
    }
    if (!isString(c.npcId)) push(errors, `cast[${i}].npcId`, "cast member requires an npcId");
    if (c.at !== undefined && !locationRefResolves(c.at, declared)) push(errors, `cast[${i}].at`, `unresolved location ref "${c.at}"`);
    if (c.questOffer !== undefined && !declared.questOffers.has(c.questOffer)) push(errors, `cast[${i}].questOffer`, `unresolved questOffer "${c.questOffer}"`);
  }

  return { ok: errors.length === 0, errors };
}
