// Pure battle-map movement engine (Phase 2). No DOM, no I/O — unit-testable.
//
// Grid model: integer cells, origin top-left. Movement is 8-directional and each
// step costs 1 tile = 5 ft (a deliberate simplification; the 5e 5-10-5 diagonal
// rule is deferred). Other tokens are impassable. Speed (in feet) converts to a
// per-activation tile budget; partial moves spend the budget down.

export const FEET_PER_TILE = 5;

/** Tiles a creature can cover given its speed in feet. */
export function tilesForSpeed(speed) {
  const s = Number.isFinite(speed) ? speed : 30;
  return Math.max(0, Math.floor(s / FEET_PER_TILE));
}

function cellKey(x, y) {
  return `${x},${y}`;
}

/** Chebyshev (8-direction) distance in tiles, ignoring obstacles. */
export function chebyshev(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

// Set of "x,y" keys occupied by every token except the mover.
function blockedCells(positions, moverId) {
  const blocked = new Set();
  for (const [id, pos] of Object.entries(positions || {})) {
    if (id === moverId || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      continue;
    }
    blocked.add(cellKey(pos.x, pos.y));
  }
  return blocked;
}

/**
 * BFS shortest-path distances (in tiles) from the mover's cell to every
 * reachable cell, treating other tokens as impassable. Returns a Map of
 * "x,y" -> distance (the start cell is distance 0). Pure.
 * @param {{width:number,height:number,positions:object,tokenId:string}} grid
 * @param {number} [maxBudget] stop expanding past this distance (perf cap)
 * @returns {Map<string, number>}
 */
export function bfsDistances(grid, maxBudget = Infinity) {
  const { width, height, positions, tokenId } = grid || {};
  const start = positions?.[tokenId];
  const dist = new Map();
  if (!start || !Number.isFinite(start.x) || !Number.isFinite(start.y)) {
    return dist;
  }
  dist.set(cellKey(start.x, start.y), 0);
  const blocked = blockedCells(positions, tokenId);
  let frontier = [[start.x, start.y]];
  while (frontier.length) {
    const next = [];
    for (const [x, y] of frontier) {
      const d = dist.get(cellKey(x, y));
      if (d >= maxBudget) {
        continue;
      }
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) {
            continue;
          }
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
            continue;
          }
          const k = cellKey(nx, ny);
          if (blocked.has(k) || dist.has(k)) {
            continue;
          }
          dist.set(k, d + 1);
          next.push([nx, ny]);
        }
      }
    }
    frontier = next;
  }
  return dist;
}

/**
 * Set of "x,y" keys legally reachable within `budget` tiles (excludes the start
 * cell and any cell occupied by another token). Pure.
 */
export function computeReachable(grid, budget) {
  const reachable = new Set();
  if (!Number.isFinite(budget) || budget <= 0) {
    return reachable;
  }
  const dist = bfsDistances(grid, budget);
  for (const [k, d] of dist) {
    if (d > 0 && d <= budget) {
      reachable.add(k);
    }
  }
  return reachable;
}

/** Minimum tile cost to reach (x,y), or Infinity if unreachable. Pure. */
export function moveCost(grid, x, y) {
  const dist = bfsDistances(grid);
  const v = dist.get(cellKey(x, y));
  return v === undefined ? Infinity : v;
}

/** True if (x,y) is reachable within `budget` tiles for the mover. Pure. */
export function isLegalMove(grid, budget, x, y) {
  return computeReachable(grid, budget).has(cellKey(x, y));
}

// ---------------------------------------------------------------------------
// Fog of war (Phase 3). Vision is a simple circular radius in tiles (no
// line-of-sight). A creature with speed 30 sees ~20ft by default.
// ---------------------------------------------------------------------------
export const DEFAULT_VISION_TILES = 4;

/**
 * Set of "x,y" keys within `radiusTiles` (circular, in-bounds) of (x,y). Pure.
 */
export function visibleFrom(width, height, x, y, radiusTiles) {
  const cells = new Set();
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return cells;
  }
  const r = Math.max(0, Math.floor(Number.isFinite(radiusTiles) ? radiusTiles : DEFAULT_VISION_TILES));
  const minY = Math.max(0, y - r);
  const maxY = Math.min(height - 1, y + r);
  const minX = Math.max(0, x - r);
  const maxX = Math.min(width - 1, x + r);
  for (let cy = minY; cy <= maxY; cy += 1) {
    for (let cx = minX; cx <= maxX; cx += 1) {
      const dx = cx - x;
      const dy = cy - y;
      if (dx * dx + dy * dy <= r * r) {
        cells.add(cellKey(cx, cy));
      }
    }
  }
  return cells;
}

/**
 * Union of the vision circles of every viewer. viewers: [{x,y,radius}]. Pure.
 * @returns {Set<string>} revealed "x,y" keys
 */
export function computeRevealed(width, height, viewers = []) {
  const revealed = new Set();
  for (const viewer of viewers) {
    if (!viewer) {
      continue;
    }
    for (const cell of visibleFrom(width, height, viewer.x, viewer.y, viewer.radius)) {
      revealed.add(cell);
    }
  }
  return revealed;
}
