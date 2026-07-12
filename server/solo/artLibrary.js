// ---------------------------------------------------------------------------
// LIBRARY -> GAME read path (art-plumbing item 3).
//
// The curated asset library (scripts/art/library.mjs) is consulted FIRST for the
// two in-game art slots — world-select card art and the scene stage — before the
// existing generated / pollinations path. A slot serves a library image ONLY when
// the owner has rated a matching asset "keep"; with zero keeps for a slot the
// caller falls through to its untouched fallback path (zero behavior change until
// keeps exist — the moment a keep is rated it appears in game with no dispatch).
//
// This module is read-only and never throws: any library error resolves to null
// so a broken/absent library can never break scene rendering.
// ---------------------------------------------------------------------------

import { queryAssets } from "../../scripts/art/library.mjs";
import { engineToLibraryStyle, runArtStyle } from "./artStyle.js";

// Served URI for a library asset PNG. The library lives at data/assets/library/
// under the repo root, which serveStatic serves verbatim, so <id>.png is public.
export function libraryAssetUri(id) {
  return `/data/assets/library/${encodeURIComponent(String(id))}.png`;
}

// Deterministic, STABLE pick from a set of assets: newest first (createdAt desc),
// id ascending as a stable tiebreak — so a slot resolves to the SAME asset on
// every render (scenes never reshuffle between renders).
function pickStable(assets) {
  return assets
    .slice()
    .sort((a, b) => {
      const ta = Date.parse(a.createdAt || "") || 0;
      const tb = Date.parse(b.createdAt || "") || 0;
      if (tb !== ta) {
        return tb - ta;
      }
      return String(a.id).localeCompare(String(b.id));
    })[0] || null;
}

// The "keep" assets for a slot. queryAssets already drops toss-rated images;
// null-rated (unreviewed) assets must NOT surface either — only an explicit
// "keep" is an owner OK to show in game. When an engine `style` is given it is
// mapped to library vocab and matched exactly (return [] if none — the caller
// then keeps the run's chosen style via its fallback rather than showing an
// off-style image); omit style to accept any style (world-card, pre-style-pick).
function keepsFor({ world, kind, style }) {
  if (!world || !kind) {
    return [];
  }
  let found;
  try {
    found = queryAssets({ world, kind }).filter((a) => a && a.rating === "keep");
  } catch {
    return [];
  }
  if (style) {
    const libStyle = engineToLibraryStyle(style);
    return found.filter((a) => a.style === libStyle);
  }
  return found;
}

/**
 * Resolve the served URI of a library "keep" for a slot, or null when there is
 * none. `style` (engine vocab, optional) narrows to a matching library style.
 * @param {{ world?: string, kind?: string, style?: string }} slot
 * @returns {string|null}
 */
export function resolveLibraryArt({ world, kind, style } = {}) {
  const chosen = pickStable(keepsFor({ world, kind, style }));
  return chosen ? libraryAssetUri(chosen.id) : null;
}

// The library `world` key for a run: the world-family discriminator (variant,
// e.g. "babel") when present, else a lowercased world name. null for a run with
// no world (nothing to look up).
export function worldKeyForRun(run) {
  const w = run && typeof run === "object" ? run.world : null;
  if (!w || typeof w !== "object") {
    return null;
  }
  if (typeof w.variant === "string" && w.variant.trim()) {
    return w.variant.trim();
  }
  if (typeof w.name === "string" && w.name.trim()) {
    return w.name.trim().toLowerCase();
  }
  return null;
}

/**
 * Scene-stage read path: a curated library "scene" keep for the run's world +
 * art style, or null (caller falls back to the generated per-location image).
 * @param {object} run
 * @returns {string|null}
 */
export function resolveSceneArtForRun(run) {
  return resolveLibraryArt({
    world: worldKeyForRun(run),
    kind: "scene",
    style: runArtStyle(run)
  });
}
