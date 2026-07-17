// Map-layout law (docs/design/map-layout-law.md): spatial minting.
//
// A LOCATION LAYOUT is committed server state — bounds, terrain features,
// structures, committed-object markers, and entity positions. The first time a
// location's layout is needed it is MINTED deterministically from the location
// seed and a TYPE TEMPLATE (world-book data: data/layout-templates.json), then
// committed on the run (resume-safe). Same seed = same layout, forever.
//
// SCOPE FENCE: the map is an exploration/orientation surface. Combat remains
// positionless per the sealed D.4 ruling — nothing here feeds combat mechanics.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATES_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "data",
  "layout-templates.json"
);

const GRID_SIZE = 12;
const HOME_LOCATION_ID = "start_location";

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Deterministic 0..1 hash (FNV-1a, normalized) — the repo's standard seeded
// primitive (scene.js areaHash01 uses the same construction).
export function layoutHash01(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 100000) / 100000;
}

let templatesCache = null;
export function loadLayoutTemplates() {
  if (!templatesCache) {
    const raw = JSON.parse(fs.readFileSync(TEMPLATES_PATH, "utf8"));
    templatesCache = isPlainObject(raw.templates) ? raw.templates : {};
  }
  return templatesCache;
}

// ---------------------------------------------------------------------------
// Type inference — location type from committed data only. Ordered: authored
// pin > worldgen start-location type > tags/name > default. Returns
// { templateId, via } so the choice is auditable.
const START_TYPE_TEMPLATE = {
  tavern: "interior",
  "city gate": "town-approach",
  wilderness: "forest",
  dungeon: "cave",
  port: "town-street",
  market: "town-street",
  temple: "interior",
  ruins: "ruin",
  camp: "clearing",
  crossroads: "road"
};

// Ordered: first match wins. "gatehouse" must hit town-approach before
// interior's "house"; a ruined temple reads ruin before interior's "temple".
const TAG_NAME_RULES = [
  ["ruin", /ruin|crypt|tomb|barrow|collaps/],
  ["cave", /cave|cavern|grotto|mine\b|tunnel/],
  ["town-approach", /gatehouse|\bgate\b|approach|outskirt|checkpoint|palisade|rampart/],
  ["interior", /tavern|\binn\b|room|cellar|clinic|shop|house|\bhall\b|booth|chamber|temple|shrine|office|\bbar\b/],
  ["town-street", /town|village|city|market|square|street|\bport\b|plaza|district|sector|sprawl/],
  ["road", /\broad\b|trail|\bpath\b|crossroad|highway|bridge/],
  ["forest", /forest|wood|grove|thicket|jungle|\bwilds?\b/],
  ["clearing", /clearing|glade|meadow|field|\bcamp\b/]
];

export function inferLayoutTemplate(location, run) {
  const templates = loadLayoutTemplates();
  if (isString(location?.layoutTemplate) && templates[location.layoutTemplate.trim()]) {
    return { templateId: location.layoutTemplate.trim(), via: "authored" };
  }
  if (location?.locationId === HOME_LOCATION_ID) {
    const startType = String(run?.world?.startingLocationType || "").toLowerCase().trim();
    if (startType && START_TYPE_TEMPLATE[startType]) {
      return { templateId: START_TYPE_TEMPLATE[startType], via: "world-config" };
    }
  }
  const hay = [
    ...(Array.isArray(location?.tags) ? location.tags : []),
    isString(location?.name) ? location.name : ""
  ]
    .join(" ")
    .toLowerCase();
  for (const [templateId, re] of TAG_NAME_RULES) {
    if (re.test(hay)) {
      return { templateId, via: "tags-name" };
    }
  }
  return { templateId: "clearing", via: "default" };
}

// ---------------------------------------------------------------------------
// Bearings — exits are undirected adjacency (connectedLocationIds), so compass
// facing is derived from the same deterministic geometry the area map uses
// (worldSeed+locationId angle/radius): the gate faces the direction the
// approach location actually sits on the region map. Screen frame: y grows
// south, so N is row 0.
function areaPoint(worldSeed, locationId) {
  if (locationId === HOME_LOCATION_ID) {
    return { x: 0, y: 0 };
  }
  const a = layoutHash01(`${worldSeed}:${locationId}:angle`) * Math.PI * 2;
  const r = 2 + layoutHash01(`${worldSeed}:${locationId}:radius`) * 6;
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

export function locationBearing(worldSeed, fromId, toId) {
  const from = areaPoint(worldSeed, fromId);
  const to = areaPoint(worldSeed, toId);
  let dx = to.x - from.x;
  let dy = to.y - from.y;
  if (dx === 0 && dy === 0) {
    dy = 1; // degenerate — default south
  }
  const angle = Math.atan2(dy, dx); // -π..π, 0 = east, +π/2 = south (screen y)
  if (angle >= -Math.PI / 4 && angle < Math.PI / 4) return "E";
  if (angle >= Math.PI / 4 && angle < (3 * Math.PI) / 4) return "S";
  if (angle >= (-3 * Math.PI) / 4 && angle < -Math.PI / 4) return "N";
  return "W";
}

const SIDE_OPPOSITE = { N: "S", S: "N", E: "W", W: "E" };
const SIDE_TO_DIRECTION = { N: "north", S: "south", E: "east", W: "west" };
const DIRECTION_TO_SIDE = {
  north: "N",
  south: "S",
  east: "E",
  west: "W",
  northeast: "N",
  northwest: "N",
  southeast: "S",
  southwest: "S"
};

// Directional hint in a narrated sentence ("half-buried to the north") — the
// found-object auditor commits this so the marker can place itself honestly.
export function detectDirectionHint(sentence) {
  const m = /\b(north|south|east|west)(?:-?(east|west))?(?:ern|ward|wards)?\b/i.exec(String(sentence || ""));
  if (!m) {
    return null;
  }
  const primary = m[1].toLowerCase();
  const secondary = m[2] ? m[2].toLowerCase() : "";
  return secondary && (primary === "north" || primary === "south") ? `${primary}${secondary}` : primary;
}

// ---------------------------------------------------------------------------
// Mint engine — interprets template ops on a square grid. All randomness comes
// from layoutHash01(seed:salt): same seed, same layout, forever.

function cellKey(x, y) {
  return `${x},${y}`;
}

function edgeCell(side, along, size) {
  const max = size - 1;
  if (side === "N") return { x: along, y: 0 };
  if (side === "S") return { x: along, y: max };
  if (side === "W") return { x: 0, y: along };
  return { x: max, y: along };
}

// Deterministic free-cell walk (the areaPlace idiom): step right/down until an
// unoccupied cell is found.
function nudgeFree(x, y, size, taken) {
  let guard = 0;
  while (taken.has(cellKey(x, y)) && guard < size * size) {
    x = (x + 1) % size;
    if (x === 0) {
      y = (y + 1) % size;
    }
    guard += 1;
  }
  return { x, y };
}

export function mintLocationLayout(run, locationId) {
  const location = run?.locations?.[locationId];
  if (!isPlainObject(location)) {
    return null;
  }

  // A world author can hand-place a full set-piece layout on the location
  // (scenario data). It is adopted verbatim — minted means "committed", not
  // "always generated".
  if (isPlainObject(location.layout) && Array.isArray(location.layout.cells)) {
    return location.layout;
  }

  const templates = loadLayoutTemplates();
  const { templateId, via } = inferLayoutTemplate(location, run);
  const template = templates[templateId] || templates.clearing || {};
  const size = Number.isFinite(template.size) ? template.size : GRID_SIZE;
  const seed = `${run?.worldSeed || "seed"}:${locationId}:layout`;
  const centre = Math.floor(size / 2);
  const h = (salt) => layoutHash01(`${seed}:${salt}`);

  const connected = Array.isArray(location.connectedLocationIds) ? location.connectedLocationIds : [];

  // Approach exit: the road-shaped neighbour if any, else the first exit —
  // the side the player "comes from", which the gate/door must face.
  let approachId = connected[0] || null;
  for (const id of connected) {
    const neighbour = run?.locations?.[id];
    if (neighbour && inferLayoutTemplate(neighbour, run).templateId === "road") {
      approachId = id;
      break;
    }
  }
  const approachSide = approachId ? locationBearing(run?.worldSeed, locationId, approachId) : "S";

  // Exit sides for every connected location (deterministic collision spread:
  // two exits on the same side sit at different points along it).
  const exits = connected.map((id) => {
    const neighbour = run?.locations?.[id];
    const side = locationBearing(run?.worldSeed, locationId, id);
    const along = 2 + Math.floor(h(`exit:${id}`) * (size - 4));
    return {
      locationId: id,
      side,
      along,
      name:
        neighbour?.state?.discovered && isString(neighbour?.name)
          ? neighbour.name
          : "an unmarked path"
    };
  });

  const cells = [];
  const taken = new Set(); // structural occupancy — nothing else may land here
  const reserved = new Set(); // kept open (clearing, road) — scatter avoids it
  const anchors = { posts: [] };
  const put = (kind, x, y, name) => {
    if (x < 0 || y < 0 || x >= size || y >= size || taken.has(cellKey(x, y))) {
      return false;
    }
    const cell = name ? { kind, x, y, name } : { kind, x, y };
    cells.push(cell);
    taken.add(cellKey(x, y));
    return true;
  };

  anchors.center = { x: centre, y: centre };
  anchors.approachSide = approachSide;

  // Wall geometry shared between ops (perimeter carves openings; road stops at
  // the gate; scatter's outsideWallsOnly needs the wall line).
  let wallInfo = null;

  for (const op of Array.isArray(template.ops) ? template.ops : []) {
    if (op.op === "clearing") {
      const radius = Number.isFinite(op.radius) ? op.radius : 2;
      for (let y = centre - radius; y <= centre + radius; y += 1) {
        for (let x = centre - radius; x <= centre + radius; x += 1) {
          reserved.add(cellKey(x, y));
        }
      }
    } else if (op.op === "perimeter") {
      const inset = Number.isFinite(op.inset) ? op.inset : 0;
      const kind = isString(op.kind) ? op.kind : "wall";
      const ruined = Number.isFinite(op.ruined) ? op.ruined : 0;
      const lo = inset;
      const hi = size - 1 - inset;
      const openings = new Map(); // cellKey -> {kind, name}
      if (op.sides === "far") {
        // Town-approach: one wall line between the approach edge and the town
        // beyond, gate where the road crosses, facing the approach.
        const wallDistFromFar = 3;
        const gateAlong = Math.floor(size / 2);
        const wallCoord =
          approachSide === "S" ? wallDistFromFar
          : approachSide === "N" ? size - 1 - wallDistFromFar
          : approachSide === "E" ? wallDistFromFar
          : size - 1 - wallDistFromFar;
        const horizontal = approachSide === "S" || approachSide === "N";
        wallInfo = { horizontal, coord: wallCoord, gate: gateAlong, approachSide };
        for (let i = 0; i < size; i += 1) {
          const x = horizontal ? i : wallCoord;
          const y = horizontal ? wallCoord : i;
          if (i === gateAlong) {
            put("gate", x, y, "the gate");
            anchors.gate = { x, y };
          } else {
            put(kind, x, y);
          }
        }
      } else {
        // Full bounds: openings carved per exit on its own side (door for the
        // approach and every other exit — interiors stay consistent with exits).
        for (const exit of exits) {
          const along = Math.max(lo + 1, Math.min(hi - 1, exit.along));
          const cell =
            exit.side === "N" ? { x: along, y: lo }
            : exit.side === "S" ? { x: along, y: hi }
            : exit.side === "W" ? { x: lo, y: along }
            : { x: hi, y: along };
          openings.set(cellKey(cell.x, cell.y), {
            kind: op.opening === "door" ? "door" : "exit",
            name: exit.name
          });
        }
        if (openings.size === 0) {
          // No exits at all — still leave one opening on the approach side.
          const cell = edgeCell(approachSide, Math.floor(size / 2), size);
          const x = Math.max(lo, Math.min(hi, cell.x));
          const y = Math.max(lo, Math.min(hi, cell.y));
          openings.set(cellKey(x, y), { kind: op.opening === "door" ? "door" : "exit", name: "the way out" });
        }
        for (let x = lo; x <= hi; x += 1) {
          for (let y = lo; y <= hi; y += 1) {
            const onBorder = x === lo || x === hi || y === lo || y === hi;
            if (!onBorder) continue;
            const opening = openings.get(cellKey(x, y));
            if (opening) {
              put(opening.kind, x, y, opening.name);
              if (!anchors.door) anchors.door = { x, y };
              continue;
            }
            if (ruined > 0 && h(`ruin:${x}:${y}`) < ruined) {
              if (h(`rubble:${x}:${y}`) < 0.5) put("rubble", x, y);
              continue; // fallen wall segment — a gap
            }
            put(kind, x, y);
          }
        }
        wallInfo = { lo, hi };
      }
    } else if (op.op === "road") {
      const along = anchors.gate
        ? (wallInfo?.horizontal ? anchors.gate.x : anchors.gate.y)
        : Math.floor(size / 2) + (Math.floor(h("road:jitter") * 3) - 1);
      const horizontal = approachSide === "E" || approachSide === "W";
      // Lay from the approach edge toward the gate, or straight through.
      const from = 0;
      const to = op.to === "gate" && anchors.gate
        ? (wallInfo?.horizontal ? anchors.gate.y : anchors.gate.x)
        : size - 1;
      const start = approachSide === "S" || approachSide === "E" ? size - 1 : 0;
      const end = op.to === "gate" && anchors.gate ? to : (approachSide === "S" || approachSide === "E" ? from : size - 1);
      const step = start <= end ? 1 : -1;
      for (let i = start; step > 0 ? i <= end : i >= end; i += step) {
        const x = horizontal ? i : along;
        const y = horizontal ? along : i;
        if (!taken.has(cellKey(x, y))) {
          put("road", x, y);
        }
        reserved.add(cellKey(x, y));
      }
      anchors.entry = horizontal
        ? { x: start, y: along }
        : { x: along, y: start };
    } else if (op.op === "scatter") {
      const kind = isString(op.kind) ? op.kind : "tree";
      const count = Number.isFinite(op.count) ? op.count : 8;
      const clearRadius = Number.isFinite(op.clearRadius) ? op.clearRadius : 0;
      let placed = 0;
      for (let i = 0; i < count * 6 && placed < count; i += 1) {
        const x = Math.floor(h(`${kind}:${i}:x`) * size);
        const y = Math.floor(h(`${kind}:${i}:y`) * size);
        if (taken.has(cellKey(x, y)) || reserved.has(cellKey(x, y))) continue;
        if (clearRadius > 0 && Math.max(Math.abs(x - centre), Math.abs(y - centre)) <= clearRadius) continue;
        if (op.outsideWallsOnly && wallInfo) {
          if (wallInfo.horizontal !== undefined) {
            // Line wall: outside = the approach side of the line.
            const coord = wallInfo.horizontal ? y : x;
            const outside =
              approachSide === "S" || approachSide === "E" ? coord > wallInfo.coord : coord < wallInfo.coord;
            if (!outside) continue;
          } else if (x >= wallInfo.lo && x <= wallInfo.hi && y >= wallInfo.lo && y <= wallInfo.hi) {
            continue;
          }
        }
        if (put(kind, x, y)) placed += 1;
      }
    } else if (op.op === "buildings") {
      const count = Number.isFinite(op.count) ? op.count : 3;
      for (let b = 0; b < count; b += 1) {
        const w = 2 + Math.floor(h(`bld:${b}:w`) * 2);
        const hgt = 2;
        const leftOfRoad = b % 2 === 0;
        const roadAlong = Math.floor(size / 2);
        const bx = leftOfRoad
          ? Math.max(0, roadAlong - 2 - w)
          : Math.min(size - w, roadAlong + 2);
        const by = 1 + Math.floor(h(`bld:${b}:y`) * (size - hgt - 2));
        let door = null;
        for (let x = bx; x < bx + w; x += 1) {
          for (let y = by; y < by + hgt; y += 1) {
            if (!reserved.has(cellKey(x, y))) {
              put("building", x, y);
              door = door || { x, y };
            }
          }
        }
        if (door) anchors.posts.push(nudgeFree(leftOfRoad ? door.x + w : Math.max(0, door.x - 1), door.y, size, taken));
      }
    } else if (op.op === "pond") {
      const radius = Number.isFinite(op.radius) ? op.radius : 1;
      const px = 2 + Math.floor(h("pond:x") * (size - 4));
      const py = 2 + Math.floor(h("pond:y") * (size - 4));
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dy = -radius; dy <= radius; dy += 1) {
          if (Math.abs(dx) + Math.abs(dy) <= radius && !taken.has(cellKey(px + dx, py + dy))) {
            put("water", px + dx, py + dy);
          }
        }
      }
    } else if (op.op === "posts") {
      const count = Number.isFinite(op.count) ? op.count : 1;
      for (let p = 0; p < count; p += 1) {
        let spot;
        if (op.at === "gate" && anchors.gate) {
          // Just inside the gate — the keeper stands at their post.
          const inward = approachSide === "S" ? -1 : approachSide === "N" ? 1 : 0;
          const inwardX = approachSide === "E" ? -1 : approachSide === "W" ? 1 : 0;
          spot = nudgeFree(anchors.gate.x + inwardX + p, anchors.gate.y + inward, size, taken);
        } else if (op.at === "counter" && anchors.door) {
          // Across the room from the door: the keeper behind their counter.
          spot = nudgeFree(
            size - 1 - anchors.door.x < anchors.door.x ? 2 + p : size - 3 - p,
            size - 1 - anchors.door.y < anchors.door.y ? 2 : size - 3,
            size,
            taken
          );
        } else if (op.at === "buildings") {
          continue; // building op already pushed door-front posts
        } else {
          spot = nudgeFree(centre + 2 + p, centre - 2, size, taken);
        }
        anchors.posts.push(spot);
      }
    }
  }

  // Open templates (no perimeter): exits appear as edge markers so orientation
  // is honest — each connected location shows on the side it actually lies.
  if (!wallInfo) {
    for (const exit of exits) {
      const cell = edgeCell(exit.side, exit.along, size);
      if (!taken.has(cellKey(cell.x, cell.y))) {
        put("exit", cell.x, cell.y, exit.name);
      }
    }
  }

  if (!anchors.entry) {
    const cell = edgeCell(approachSide, Math.floor(size / 2), size);
    // One step inward from the approach edge (inside walls when present).
    const inward =
      approachSide === "N" ? { x: cell.x, y: cell.y + 1 }
      : approachSide === "S" ? { x: cell.x, y: cell.y - 1 }
      : approachSide === "W" ? { x: cell.x + 1, y: cell.y }
      : { x: cell.x - 1, y: cell.y };
    anchors.entry = nudgeFree(inward.x, inward.y, size, taken);
  }
  if (anchors.door) {
    const inwardX = anchors.door.x === 0 ? 1 : anchors.door.x === size - 1 ? -1 : 0;
    const inwardY = anchors.door.y === 0 ? 1 : anchors.door.y === size - 1 ? -1 : 0;
    anchors.entry = nudgeFree(anchors.door.x + inwardX, anchors.door.y + inwardY, size, taken);
  }

  return {
    version: 1,
    templateId,
    inferredVia: via,
    seed,
    width: size,
    height: size,
    ground: isString(template.ground) ? template.ground : "stone",
    playerAnchor: isString(template.playerAnchor) ? template.playerAnchor : "center",
    cells,
    anchors,
    mintedAt: null
  };
}

// Resolve the layout the map should draw: the COMMITTED one when present, else
// a pure deterministic mint (identical to what ensure would commit) so the
// payload is never layout-less. Read-only.
export function resolveLocationLayout(run, locationId) {
  const location = run?.locations?.[locationId];
  if (!isPlainObject(location)) {
    return null;
  }
  if (isPlainObject(location.layout) && Array.isArray(location.layout.cells)) {
    return location.layout;
  }
  return mintLocationLayout(run, locationId);
}

// Commit-on-first-mint (the law's resume-safety): mutates the location if and
// only if it has no layout yet. Callers persist the run when `minted` is true.
export function ensureLocationLayout(run, locationId, options = {}) {
  const location = run?.locations?.[locationId];
  if (!isPlainObject(location)) {
    return { layout: null, minted: false };
  }
  if (isPlainObject(location.layout) && Array.isArray(location.layout.cells)) {
    return { layout: location.layout, minted: false };
  }
  const layout = mintLocationLayout(run, locationId);
  if (!layout) {
    return { layout: null, minted: false };
  }
  layout.mintedAt = isString(options.now) ? options.now : new Date().toISOString();
  location.layout = layout;
  return { layout, minted: true };
}

// ---------------------------------------------------------------------------
// Placement — committed markers and entities receive positions within the
// layout. Deterministic: a pure function of committed state.

const DIRECTION_BAND = {
  north: (size, t) => ({ x: 1 + Math.floor(t * (size - 2)), y: 1 }),
  south: (size, t) => ({ x: 1 + Math.floor(t * (size - 2)), y: size - 2 }),
  east: (size, t) => ({ x: size - 2, y: 1 + Math.floor(t * (size - 2)) }),
  west: (size, t) => ({ x: 1, y: 1 + Math.floor(t * (size - 2)) }),
  northeast: (size) => ({ x: size - 2, y: 1 }),
  northwest: () => ({ x: 1, y: 1 }),
  southeast: (size) => ({ x: size - 2, y: size - 2 }),
  southwest: (size) => ({ x: 1, y: size - 2 })
};

// Positions a list of committed markers ({ id, direction? }) on the layout.
// A directional hint is honored (the marker lands in that edge band); without
// one the marker takes a deterministic open mid-band cell. Returns id -> {x,y}.
export function placeMarkers(layout, items, extraTaken = []) {
  const size = layout.width;
  const taken = new Set(layout.cells.map((c) => cellKey(c.x, c.y)));
  for (const cell of extraTaken) {
    if (cell) taken.add(cellKey(cell.x, cell.y));
  }
  const positions = new Map();
  for (const item of items) {
    const t = layoutHash01(`${layout.seed}:marker:${item.id}`);
    let cell;
    const band = item.direction && DIRECTION_BAND[item.direction];
    if (band) {
      cell = band(size, t);
    } else {
      cell = {
        x: 2 + Math.floor(layoutHash01(`${layout.seed}:marker:${item.id}:x`) * (size - 4)),
        y: 2 + Math.floor(layoutHash01(`${layout.seed}:marker:${item.id}:y`) * (size - 4))
      };
    }
    cell = nudgeFree(cell.x, cell.y, size, taken);
    taken.add(cellKey(cell.x, cell.y));
    positions.set(item.id, cell);
  }
  return positions;
}

const KEEPER_ROLE_RE = /keeper|merchant|bartend|barkeep|vendor|shop|trader|fixer|doc\b|smith|innkeep|guard|warden|watch/i;

// Ground an entity can stand on: roads and exit thresholds are walkable; every
// other layout cell (walls, trees, water, the gate arch itself) blocks.
const WALKABLE_KINDS = new Set(["road", "exit"]);

// Positions the co-located roster on the layout. Persisted (player-dragged)
// positions win; otherwise: the player at the template's anchor (entry/center),
// keeper-role NPCs at their posts, everyone else spread across deterministic
// open cells — never a huddle around the player. Returns entityId -> {x,y}.
export function placeEntities(layout, members, savedPositions = new Map(), extraTaken = []) {
  const size = layout.width;
  const taken = new Set(
    layout.cells.filter((c) => !WALKABLE_KINDS.has(c.kind)).map((c) => cellKey(c.x, c.y))
  );
  for (const cell of extraTaken) {
    if (cell) taken.add(cellKey(cell.x, cell.y));
  }
  const positions = new Map();
  const claim = (entityId, x, y) => {
    const cell = nudgeFree(x, y, size, taken);
    taken.add(cellKey(cell.x, cell.y));
    positions.set(entityId, cell);
    return cell;
  };

  // Deterministic open-cell sequence for non-keeper members: spread across the
  // grid, at least 2 cells from the player's anchor.
  const playerAnchor =
    layout.playerAnchor === "entry" && layout.anchors?.entry ? layout.anchors.entry : layout.anchors?.center || { x: Math.floor(size / 2), y: Math.floor(size / 2) };
  const spots = [];
  for (let i = 0; spots.length < 10 && i < 200; i += 1) {
    const x = 1 + Math.floor(layoutHash01(`${layout.seed}:spot:${i}:x`) * (size - 2));
    const y = 1 + Math.floor(layoutHash01(`${layout.seed}:spot:${i}:y`) * (size - 2));
    if (taken.has(cellKey(x, y))) continue;
    if (Math.max(Math.abs(x - playerAnchor.x), Math.abs(y - playerAnchor.y)) < 2) continue;
    if (spots.some((s) => Math.max(Math.abs(x - s.x), Math.abs(y - s.y)) < 2)) continue;
    spots.push({ x, y });
  }

  const posts = Array.isArray(layout.anchors?.posts) ? [...layout.anchors.posts] : [];
  let spotIndex = 0;
  const ordered = [...members].sort((a, b) => {
    if (a.kind === "player") return -1;
    if (b.kind === "player") return 1;
    return String(a.entityId).localeCompare(String(b.entityId));
  });

  for (const member of ordered) {
    const saved = savedPositions.get(member.entityId);
    if (saved && typeof saved.x === "number" && typeof saved.y === "number") {
      positions.set(member.entityId, { x: saved.x, y: saved.y });
      taken.add(cellKey(saved.x, saved.y));
      continue;
    }
    if (member.kind === "player") {
      claim(member.entityId, playerAnchor.x, playerAnchor.y);
      continue;
    }
    if (member.kind === "npc" && KEEPER_ROLE_RE.test(String(member.role || "")) && posts.length) {
      const post = posts.shift();
      claim(member.entityId, post.x, post.y);
      continue;
    }
    const spot = spots[spotIndex % Math.max(1, spots.length)] || { x: 1 + spotIndex, y: 1 };
    spotIndex += 1;
    claim(member.entityId, spot.x, spot.y);
  }
  return positions;
}

// ---------------------------------------------------------------------------
// Narrator contract — committed layout rides the prompt as scene-geometry
// facts. The narrator describes the clearing where the clearing IS.

function compassOf(cell, layout) {
  const cx = (layout.width - 1) / 2;
  const cy = (layout.height - 1) / 2;
  const dx = cell.x - cx;
  const dy = cell.y - cy;
  if (Math.abs(dx) < layout.width / 6 && Math.abs(dy) < layout.height / 6) {
    return "near the center";
  }
  const ns = dy < -layout.height / 6 ? "north" : dy > layout.height / 6 ? "south" : "";
  const ew = dx < -layout.width / 6 ? "west" : dx > layout.width / 6 ? "east" : "";
  return `to the ${ns}${ew}`;
}

export function buildLayoutDirective(run) {
  const locationId = run?.currentLocationId;
  const layout = resolveLocationLayout(run, locationId);
  const location = run?.locations?.[locationId];
  if (!layout || !isPlainObject(location)) {
    return "";
  }
  const facts = [];
  const counts = {};
  for (const cell of layout.cells) {
    counts[cell.kind] = (counts[cell.kind] || 0) + 1;
  }
  if (counts.tree) facts.push("scattered trees" + (layout.templateId === "forest" ? " around an open clearing at the center" : ""));
  if (counts.wall) facts.push("standing walls");
  if (counts.water) facts.push("open water");
  const gate = layout.cells.find((c) => c.kind === "gate");
  if (gate) facts.push(`the gate ${compassOf(gate, layout)}`);
  const door = layout.cells.find((c) => c.kind === "door");
  if (door) facts.push(`the door ${compassOf(door, layout)}`);
  for (const cell of layout.cells) {
    if (cell.kind === "exit" && cell.name && cell.name !== "an unmarked path") {
      facts.push(`the way to ${cell.name} ${compassOf(cell, layout)}`);
    }
  }
  const objectStates = isPlainObject(location.flags?.objectStates) ? location.flags.objectStates : {};
  const discovered = Object.values(objectStates).filter((o) => o && o.state === "discovered" && isString(o.label));
  const markers = placeMarkers(
    layout,
    discovered.map((o) => ({ id: o.objectId, direction: o.direction || null }))
  );
  for (const obj of discovered.slice(0, 3)) {
    const cell = markers.get(obj.objectId);
    if (cell) facts.push(`${obj.label} ${compassOf(cell, layout)}`);
  }
  if (!facts.length) {
    return "";
  }
  return (
    ` SCENE GEOMETRY (committed map of ${location.name}): ${facts.slice(0, 6).join("; ")}.` +
    ` Everything stands where the committed map places it — never contradict these positions or invent new geometry.`
  );
}
