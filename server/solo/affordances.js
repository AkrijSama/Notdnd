// COMMITTED AFFORDANCES (affordances-map-law Part A) — derive the pre-typed
// action chips from committed state only. Each affordance is
//   { label, intent, source, feasibility: "ok" | "gated", gateReason? }
// `intent` is the free-text phrase a tap submits through the normal turn path
// (the reply is normal GM narration + committed deltas — never a [SYSTEM] line).
//
// TWO-TIER FEASIBILITY (owner ruling):
//   INFEASIBLE — committed state makes the verb impossible (rest during active
//     combat) → rendered gated with the in-fiction reason; a tap does not submit.
//     Gating derives from COMMITTED STATE ONLY.
//   UNWISE — possible but risky (resting in dangerous wilds) → fully available;
//     the act takes its normal stakes through the pipeline. Never gated.
//
// Pure: reads run state, mutates nothing. The client caps the visible count +
// overflow "more"; the server returns the full ordered list.

import { combatActive } from "./combat.js";
import { activeGoals } from "./goals.js";
import { followableTrailsAtCurrent, sightPhrase, traceBandTooltip } from "./essence.js";
import { entityNature } from "./entityNature.js";

function isPlainObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}
function isStr(v) {
  return typeof v === "string" && v.trim().length > 0;
}
function clip(s, n) {
  const t = String(s || "").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// STANDING VERBS — super-common only: Look around · Search the area · Rest.
// Rest is two-tier: INFEASIBLE (gated) during active combat, OK otherwise
// (resting in dangerous wilds is UNWISE, not gated — it submits and takes its
// stakes through the pipeline).
function standingAffordances(inCombat) {
  const out = [{ label: "Look around", intent: "I look around and take in my surroundings.", source: "standing", feasibility: "ok" }];
  if (!inCombat) {
    out.push({ label: "Search the area", intent: "I search the area.", source: "standing", feasibility: "ok" });
    out.push({ label: "Rest", intent: "I make camp and rest to recover.", source: "standing", feasibility: "ok" });
  } else {
    out.push({ label: "Rest", intent: "I make camp and rest to recover.", source: "standing", feasibility: "gated", gateReason: "You can't make camp while the fight is still on." });
  }
  return out;
}

const SERVICE_META = {
  inn: { label: "Rent a room", intent: "I rent a room for the night." },
  market: { label: "Browse the market", intent: "I browse what the market has for sale." },
  training: { label: "Seek training", intent: "I seek training to sharpen my skills." },
  // Content plumbing (2026-07-19): non-travel contextual services that route as
  // NORMAL intents through the turn path (the chip is a pre-typed intent, not a menu).
  "quest-board": { label: "Check the notice board", intent: "I check the notice board for postings." },
  lore: { label: "Ask about the region", intent: "I ask about the region and what's known of these parts." }
};
function serviceAffordances(location) {
  const services = Array.isArray(location?.services) ? location.services : [];
  const out = [];
  for (const svc of services) {
    if (!isPlainObject(svc)) continue;
    const meta = SERVICE_META[svc.kind];
    if (!meta) continue;
    const label = isStr(svc.label) ? svc.label.trim() : meta.label;
    // A committed-but-unavailable service is INFEASIBLE → gated with its reason.
    if (svc.available === false) {
      out.push({ label, intent: meta.intent, source: "service", feasibility: "gated", gateReason: isStr(svc.reason) ? svc.reason.trim() : `${label} is not on offer here right now.` });
    } else {
      out.push({ label, intent: meta.intent, source: "service", feasibility: "ok" });
    }
  }
  return out;
}

// COMMITTED LOCATION NAMES — the personification guard's reference (U1). A talk /
// face chip whose "subject" collides with a committed LOCATION name is a place that
// was mis-read as a person (the "Talk to Mile" bug, from the ROAD "the Waking Mile")
// and must be dropped. The comparison is on distinctive name TOKENS so a fragment
// ("Mile") still matches its parent location ("The Waking Mile").
const LOCATION_NAME_STOPWORDS = new Set(["the", "a", "an", "of", "and", "to", "at", "in", "on", "near", "old", "new"]);
function locationNameTokens(name) {
  return String(name || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !LOCATION_NAME_STOPWORDS.has(token));
}
function committedLocationTokenSets(run) {
  const locations = isPlainObject(run?.locations) ? Object.values(run.locations) : [];
  const sets = [];
  for (const loc of locations) {
    if (!isPlainObject(loc) || !isStr(loc.name)) continue;
    const tokens = locationNameTokens(loc.name);
    if (tokens.length) sets.push(new Set(tokens));
  }
  return sets;
}
// A subject NAME personifies a place when ALL its distinctive tokens fall inside a
// single committed location's token set (so "Mile" ⊆ {waking,mile} and "Waking Mile"
// ⊆ {waking,mile} both match). A subject with no distinctive tokens never matches.
// A rare token-collision with a real person's name (an NPC literally named "Pine"
// beside a "Hollow Pine") is an accepted trade for never personifying geography.
function subjectPersonifiesLocation(subjectName, locationTokenSets) {
  const tokens = locationNameTokens(subjectName);
  if (!tokens.length) return false;
  return locationTokenSets.some((set) => tokens.every((token) => set.has(token)));
}

// Generate one raw candidate chip per NPC, carrying subject metadata (subjectId /
// subjectName / subjectKind) for the sanity auditor. Kind + verb are derived from
// committed nature (entityNature): "Talk to" is for the SOCIAL-CAPABLE rung (humans,
// bandits, demons); a beast / chaos-beast gets Face (hostile) or Approach — never a
// Talk chip implying human speech.
function castCandidates(run) {
  const npcs = isPlainObject(run?.npcs) ? Object.values(run.npcs) : [];
  const out = [];
  for (const npc of npcs) {
    if (!isPlainObject(npc)) continue;
    const name = npc.generatedName || npc.displayName || npc.role;
    if (!isStr(name)) continue;
    const nat = entityNature(npc);
    const beast = Boolean(nat && nat.socialCapable === false);
    let subjectKind;
    let label;
    let intent;
    if (beast) {
      const hostile = npc.flags?.hostile === true;
      subjectKind = hostile ? "face" : "approach";
      label = `${hostile ? "Face" : "Approach"} ${clip(name, 22)}`;
      intent = `${hostile ? "Face" : "Approach"} ${name}.`;
    } else {
      subjectKind = "talk";
      label = `Talk to ${clip(name, 22)}`;
      intent = `Talk to ${name}.`;
    }
    out.push({ label, intent, source: "cast", feasibility: "ok", subjectId: npc.npcId, subjectName: name, subjectKind });
  }
  return out;
}

// AFFORDANCE-SANITY AUDITOR (U1). Every talk-class chip must resolve to a committed
// entity that is (1) PRESENT at the player's current location, (2) NOT a personified
// LOCATION name, and (3) tagged with the verb its committed nature warrants (Talk for
// social-capable cast; Face / Approach for beasts). A chip that fails any gate is
// DROPPED — a place is never a talk subject ("Talk to Mile"), an absent NPC never
// gets a chip ("Talk to Esk"), and a beast never gets "Talk". Exported for testing.
export function auditCastAffordances(run, chips) {
  const here = isStr(run?.currentLocationId) ? run.currentLocationId : null;
  const npcs = isPlainObject(run?.npcs) ? run.npcs : {};
  const locationTokenSets = committedLocationTokenSets(run);
  const out = [];
  for (const chip of Array.isArray(chips) ? chips : []) {
    if (!isPlainObject(chip)) continue;
    // (1) subject must resolve to a PRESENT committed NPC (co-located, not gone/dead).
    const npc = isStr(chip.subjectId) ? npcs[chip.subjectId] : null;
    if (!isPlainObject(npc)) continue;
    if (!here || npc.currentLocationId !== here) continue;
    if (npc.status === "gone" || npc.status === "dead") continue;
    // (2) a location name is NEVER a talk/face subject.
    if (subjectPersonifiesLocation(chip.subjectName, locationTokenSets)) continue;
    // (3) the chip verb must match the subject's committed nature.
    const nat = entityNature(npc);
    const social = !nat || nat.socialCapable !== false;
    if (chip.subjectKind === "talk" && !social) continue;
    if ((chip.subjectKind === "face" || chip.subjectKind === "approach") && social) continue;
    out.push(chip);
  }
  return out;
}

function castAffordances(run) {
  // Generate candidates from committed cast, run them through the sanity auditor,
  // then strip the internal subject metadata so the emitted chip keeps the minimal
  // { label, intent, source, feasibility } shape.
  return auditCastAffordances(run, castCandidates(run)).map((chip) => ({
    label: chip.label,
    intent: chip.intent,
    source: chip.source,
    feasibility: chip.feasibility
  }));
}

// TRAVEL IS NOT A CHIP (owner ruling 2026-07-19): exit/travel affordances were
// removed from the chip row. Chips must not pre-reveal geography the player hasn't
// engaged — discovery flows through play. Travel lives in the Exits rail and the
// map ONLY. (Trail-following via essence-sight is NOT travel-by-geography: it's a
// sight-driven pursuit of committed state, so it stays — see trailAffordances.)

// A goal is actionable HERE when it's a Task (immediate doable anywhere) OR its
// match tokens overlap this location (name / tags / committed object labels).
function goalActionableHere(goal, location) {
  if (goal.scale === "task") return true;
  const tokens = Array.isArray(goal.matchTokens) ? goal.matchTokens : [];
  if (!tokens.length) return false;
  const hay = [
    location?.name,
    ...(Array.isArray(location?.tags) ? location.tags : []),
    ...Object.values(location?.flags?.objectStates || {}).map((o) => o?.label)
  ].filter(isStr).join(" ").toLowerCase();
  return tokens.some((t) => hay.includes(t));
}
function goalAffordances(run, location) {
  const out = [];
  for (const goal of activeGoals(run)) {
    if (!goalActionableHere(goal, location)) continue;
    const summary = String(goal.summary || "").trim();
    if (!summary) continue;
    let intent = /^(i|we)\b/i.test(summary) ? summary : `I ${summary}`;
    if (!/[.!?]$/.test(intent)) intent += ".";
    out.push({ label: `Pursue: ${clip(summary, 26)}`, intent, source: "goal", feasibility: "ok" });
  }
  return out;
}

// Sky/weather objectStates are hazards, not interactable — never an examine chip.
const SKY_OBJECT_RE = /\bsky\b|weather|storm|the-sky/i;
function objectAffordances(location) {
  const states = isPlainObject(location?.flags?.objectStates) ? Object.values(location.flags.objectStates) : [];
  const out = [];
  for (const o of states) {
    if (!isPlainObject(o)) continue;
    const label = isStr(o.label) ? o.label.trim() : (isStr(o.objectId) ? o.objectId : null);
    if (!label) continue;
    if (SKY_OBJECT_RE.test(label) || SKY_OBJECT_RE.test(String(o.objectId || ""))) continue;
    out.push({ label: `Examine ${clip(label, 22)}`, intent: `I examine the ${label}.`, source: "object", feasibility: "ok" });
  }
  return out;
}

// ESSENCE-SIGHT (verdance-region-v1 §law-5): a committed FOLLOWABLE trail at the
// current location surfaces a "Follow the trail — <band>" chip (source: sight).
// Its intent routes through detectMoveIntent's trail branch → the normal move
// pipeline, tracking along the trail's committed edge. Only the MC sees these.
function trailAffordances(run) {
  const out = [];
  for (const trail of followableTrailsAtCurrent(run)) {
    const band = isStr(trail.bandWord) ? trail.bandWord.toLowerCase() : (isStr(trail.band) ? trail.band.toLowerCase() : "clear");
    const kind = isStr(trail.kind) ? trail.kind : "trail";
    out.push({
      // DIEGETIC LABEL (Law-6 phrase table): the character's PERCEPTION, never a field
      // name or a raw band, and never with an em-dash (the ban). The mechanical band
      // rides the hint/tooltip for players who want the strength read.
      label: sightPhrase(kind, band),
      hint: traceBandTooltip(kind, band),
      // Phrased so detectMoveIntent's trail branch resolves it against committed state,
      // with NO directional cue word (onward/deeper) so a location with no committed
      // trail falls through to a normal attempt instead of a stray forward move.
      intent: "I follow the essence trail my sight reads.",
      source: "sight",
      feasibility: "ok"
    });
  }
  return out;
}

// Dedupe by label (stable, first wins) — the reliable floor keeps priority.
function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const a of list) {
    const key = String(a.label).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

// The ordered affordance list for a run's current scene. Reliable floor (standing
// verbs incl. any gated Rest) first, then contextual sources. During active
// combat, non-combat affordances are suppressed — only Look around + gated Rest.
export function deriveAffordances(run) {
  if (!isPlainObject(run)) return [];
  const location = run?.locations?.[run?.currentLocationId] || {};
  const inCombat = combatActive(run);
  if (inCombat) {
    return dedupe(standingAffordances(true).filter((a) => a.label === "Look around" || a.label === "Rest"));
  }
  return dedupe([
    ...standingAffordances(false),
    ...trailAffordances(run),
    ...goalAffordances(run, location),
    ...castAffordances(run),
    ...serviceAffordances(location),
    ...objectAffordances(location)
  ]);
}
