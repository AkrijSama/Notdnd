// AFFORDANCES-MAP LAW (Part B) — the MIDDLE MAP region-graph read model.
// See docs/design/affordances-map-law.md. A derived read over committed state:
// nodes from run.locations, edges from connectedLocationIds. Invents nothing.
//
// FOG (owner ruling): an unvisited node is HIDDEN ENTIRELY — absent from the
// payload — unless revealed by committed MAP-KNOWLEDGE (a fact tagged map:*;
// rumors do NOT reveal). Knowledge gating is SERVER-SIDE: the client never
// receives hidden geography, so devtools carries no spoilers. Edges appear only
// between included (visited-or-revealed) nodes.

import { inferLayoutTemplate } from "./layout.js";
import { tracesAtLocation } from "./essence.js";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isString(value) {
  return typeof value === "string" && value.length > 0;
}

// A committed node is VISITED when its persisted state says so.
function isVisited(location) {
  return Boolean(location?.state?.visited);
}

// Committed per-edge travel time, or null. Not modeled per-edge in the current
// world (a move is a ~10-min constant, NOT committed geography), so this reads a
// committed `travelMinutes` field if a world-book ever stamps one — never a
// guessed constant (the map shows travel time ONLY where committed).
function committedTravelTime(location) {
  const t = Number(location?.travelMinutes);
  return Number.isFinite(t) && t > 0 ? Math.trunc(t) : null;
}

const BLOCKED_STATE_RE = /block|seal|barr|impass|caved|collaps|flooded|guarded-shut/i;

// An edge is BLOCKED where committed: a destination flagged blocked, or a
// committed objectState on either endpoint whose state reads as an impassable
// passage. Honest read — no block is invented.
function isEdgeBlocked(a, b) {
  if (a?.state?.blocked === true || b?.state?.blocked === true) {
    return true;
  }
  for (const loc of [a, b]) {
    const states = loc?.flags?.objectStates;
    if (!isPlainObject(states)) {
      continue;
    }
    for (const key of Object.keys(states)) {
      if (!/road|path|gate|bridge|pass|route|way|trail|door/i.test(key)) {
        continue;
      }
      const st = states[key];
      if (st && typeof st.state === "string" && BLOCKED_STATE_RE.test(st.state)) {
        return true;
      }
    }
  }
  return false;
}

// The nodes committed MAP-KNOWLEDGE reveals: Map<locationId, factId>. Only a fact
// tagged map:* counts (owner ruling — rumors never reveal). Grammar:
//   map:all | map:<world.variant>  -> the whole known graph
//   map:node:<locationId>          -> one node
//   map:region:<tag> | map:<tag>   -> nodes carrying that location tag
export function mapKnowledgeReveals(run) {
  const revealed = new Map();
  const locations = isPlainObject(run?.locations) ? run.locations : {};
  const locIds = Object.keys(locations);
  const facts = Array.isArray(run?.memoryFacts) ? run.memoryFacts : [];
  const variant = isString(run?.world?.variant) ? run.world.variant.toLowerCase() : "";
  const tagsOf = (id) => (Array.isArray(locations[id]?.tags) ? locations[id].tags : []).map((t) => String(t).toLowerCase());
  const grant = (id, factId) => {
    if (locations[id] && !revealed.has(id)) {
      revealed.set(id, factId || null);
    }
  };
  for (const fact of facts) {
    if (!isPlainObject(fact) || !Array.isArray(fact.tags)) {
      continue;
    }
    for (const rawTag of fact.tags) {
      const tag = String(rawTag || "").toLowerCase().trim();
      if (!tag.startsWith("map:")) {
        continue;
      }
      const key = tag.slice(4);
      if (key === "all" || (variant && key === variant)) {
        locIds.forEach((id) => grant(id, fact.factId));
      } else if (key.startsWith("node:")) {
        grant(key.slice(5), fact.factId);
      } else {
        const regionTag = key.startsWith("region:") ? key.slice(7) : key;
        if (regionTag) {
          locIds.forEach((id) => {
            if (tagsOf(id).includes(regionTag)) {
              grant(id, fact.factId);
            }
          });
        }
      }
    }
  }
  return revealed;
}

/**
 * The knowledge-gated region graph, or null when a run has no locations.
 * @param {object} run
 * @returns {{ current: string|null, nodes: object[], edges: object[], goalPins: object[] }|null}
 */
export function buildRegionMapPayload(run) {
  if (!isPlainObject(run) || !isPlainObject(run.locations)) {
    return null;
  }
  const locations = run.locations;
  const current = isString(run.currentLocationId) ? run.currentLocationId : null;
  const revealedByMap = mapKnowledgeReveals(run);

  // INCLUDED = visited OR map-revealed. The current node is always included (you
  // are standing in it). Everything else stays HIDDEN — absent from the payload.
  const included = new Set();
  for (const [id, loc] of Object.entries(locations)) {
    if (id === current || isVisited(loc) || revealedByMap.has(id)) {
      included.add(id);
    }
  }

  // ESSENCE-SIGHT (verdance-region-v1 §law-5): a FOLLOWABLE trail at the current
  // location reveals its next node as a SILHOUETTE — heard-of-by-sight, distinct
  // from a map-item reveal. Provisional per the dispatch ruling (sight is an
  // in-fiction perception and MAY reveal the next node only). The silhouette is
  // fog-safe: no name/type/kind crosses the wire, only that a trail leads there,
  // and it links ONLY to the current node (no further geography leaks).
  const sightTrails = current ? tracesAtLocation(run, current).filter((t) => t.followable && isString(t.targetLocationId)) : [];
  const silhouettes = new Map(); // locationId -> strength band
  const trailEdgeBands = new Map(); // "a|b" -> band (for the edge glow)
  for (const t of sightTrails) {
    const target = t.targetLocationId;
    if (!locations[target]) {
      continue;
    }
    if (!included.has(target)) {
      included.add(target);
      silhouettes.set(target, t.band);
    }
    const [a, b] = current < target ? [current, target] : [target, current];
    if (!trailEdgeBands.has(`${a}|${b}`)) {
      trailEdgeBands.set(`${a}|${b}`, t.band);
    }
  }

  // Reachable = an exit of the CURRENT location that is itself included (tappable
  // as a travel intent). A revealed-but-nonadjacent node is shown, not tappable.
  const currentExits = Array.isArray(locations[current]?.connectedLocationIds)
    ? locations[current].connectedLocationIds
    : [];
  const reachable = new Set(currentExits);

  const nodes = [];
  for (const id of included) {
    const loc = locations[id];
    // SILHOUETTE (sight-revealed): fog-safe — no name/type/hazard/exit-count, only
    // that a trail of a given band leads here. Rendered dimmed + dashed, distinct
    // from a map-item reveal; tappable (it is a committed exit of the current node).
    if (silhouettes.has(id)) {
      nodes.push({
        id,
        name: "",
        type: null,
        visited: false,
        revealedBy: null,
        isCurrent: false,
        reachable: reachable.has(id),
        unexploredExits: 0,
        hazard: null,
        sightReveal: silhouettes.get(id)
      });
      continue;
    }
    const visited = isVisited(loc);
    const revealedBy = revealedByMap.get(id) || null;
    const { templateId } = inferLayoutTemplate(loc, run);
    const conns = Array.isArray(loc.connectedLocationIds) ? loc.connectedLocationIds : [];
    // A spoiler-free COUNT of exits leading to still-hidden nodes (no id/name/type).
    const unexploredExits = conns.filter((c) => !included.has(c)).length;
    const sky = loc?.flags?.objectStates?.["the-sky"];
    const hazard = sky && typeof sky.state === "string" ? sky.state : null;
    nodes.push({
      id,
      name: String(loc.name || id),
      type: templateId,
      visited,
      revealedBy,
      isCurrent: id === current,
      reachable: reachable.has(id),
      unexploredExits,
      hazard
    });
  }

  // EDGES between included nodes only (undirected, deduped). No edge ever touches
  // a hidden node — hidden geography never crosses the wire.
  const seen = new Set();
  const edges = [];
  for (const id of included) {
    const conns = Array.isArray(locations[id].connectedLocationIds) ? locations[id].connectedLocationIds : [];
    for (const c of conns) {
      if (!included.has(c)) {
        continue;
      }
      // A SILHOUETTE endpoint links ONLY to the current node (you sense where the
      // trail leads from HERE); it never leaks the rest of its geography.
      if ((silhouettes.has(id) || silhouettes.has(c)) && id !== current && c !== current) {
        continue;
      }
      const [a, b] = id < c ? [id, c] : [c, id];
      const key = `${a}|${b}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const travelTime = committedTravelTime(locations[b]) ?? committedTravelTime(locations[a]);
      const blocked = isEdgeBlocked(locations[a], locations[b]);
      const edge = { a, b };
      if (travelTime != null) {
        edge.travelTime = travelTime;
      }
      if (blocked) {
        edge.blocked = true;
      }
      // ESSENCE-SIGHT edge glow: this edge carries a followable trail of this band.
      if (trailEdgeBands.has(key)) {
        edge.trail = trailEdgeBands.get(key);
      }
      edges.push(edge);
    }
  }

  // GOAL PINS: committed active goals carrying a locationId on an included node.
  // Goals do not yet stamp a locationId (plumbing point — see the law doc); when
  // they do, pins appear here with no further render work. No name-regex guessing.
  const goalPins = [];
  const goals = isPlainObject(run.goals) ? Object.values(run.goals) : [];
  for (const g of goals) {
    if (!isPlainObject(g) || g.state !== "active") {
      continue;
    }
    const locId = isString(g.locationId) ? g.locationId : null;
    if (locId && included.has(locId)) {
      goalPins.push({ goalId: g.goalId || null, locationId: locId, summary: g.summary || "", scale: g.scale || null });
    }
  }

  return { current, nodes, edges, goalPins };
}
