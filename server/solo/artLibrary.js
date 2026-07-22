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

import { queryAssets, getAsset } from "../../scripts/art/library.mjs";
import { styleForRun, toCanonicalStyle } from "./artStyle.js";

// OWNER WORLD-CARD PIN (2026-07-21). A world's lobby card may be pinned to a SPECIFIC
// library asset by id, overriding the newest-keep pick. Babel's cover IS the obsidian
// Tower render — a colossal impossible Tower on an antarctic obsidian plain, the Tower
// of Babel's key art — authored in the library under its own world "antarctica-obsidian".
// The pin serves it for babel's card WITHOUT retagging the asset (it keeps its own
// provenance/world). The pin only binds when the asset is present AND owner-rated keep;
// otherwise the resolver falls through to the normal world+kind keep pick.
const WORLD_CARD_PIN = Object.freeze({
  babel: "w7_worldcard_obsidian_tower_anime"
});

function resolvePinnedWorldCard(world) {
  const id = WORLD_CARD_PIN[world];
  if (!id) return null;
  let asset;
  try {
    asset = getAsset(id);
  } catch {
    return null;
  }
  return asset && asset.rating === "keep" ? libraryAssetUri(id) : null;
}

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
    // `style` may arrive as engine OR canonical vocab; normalize to the canonical
    // library vocab the sidecar `.style` is written in.
    const libStyle = toCanonicalStyle(style);
    return libStyle ? found.filter((a) => a.style === libStyle) : [];
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
  // Owner pin wins for a pinned world-card (the asset carries its own world tag).
  if (kind === "world-card" && world) {
    const pinned = resolvePinnedWorldCard(world);
    if (pinned) return pinned;
  }
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

// The `loc:<slug>` library tag for a committed location name — the precision key
// that binds a cooked scene to the location it depicts. Slug rule mirrors the
// batch-cook manifests: lowercase, every non-alphanumeric run collapses to "-".
export function locationLibraryTag(name) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `loc:${slug}` : null;
}

/**
 * Scene-stage read path: a curated library "scene" keep for the run's world +
 * art style, or null (caller falls back to the generated per-location image).
 *
 * Location precision ("never a stranger's location" — the geography analog of
 * the face law): when a `location` is given, a keep TAGGED for that location
 * (`loc:<slug of its committed name>`) wins. The generic world+style rung then
 * only serves keeps that carry NO loc: tag at all — a location-specific image
 * must never surface as another location's backdrop (world families like
 * "babel" share one world key across runs with entirely different geography).
 * @param {object} run
 * @param {object} [location] the committed location record (name drives the tag)
 * @returns {string|null}
 */
export function resolveSceneArtForRun(run, location = null) {
  const slot = { world: worldKeyForRun(run), kind: "scene", style: styleForRun(run) };
  const locTag = locationLibraryTag(location?.name);
  if (locTag) {
    const tagged = keepsFor(slot).filter((a) => Array.isArray(a.tags) && a.tags.includes(locTag));
    const chosen = pickStable(tagged);
    if (chosen) {
      return libraryAssetUri(chosen.id);
    }
  }
  const generic = keepsFor(slot).filter(
    (a) => !(Array.isArray(a.tags) && a.tags.some((t) => String(t).startsWith("loc:")))
  );
  const chosen = pickStable(generic);
  return chosen ? libraryAssetUri(chosen.id) : null;
}

/**
 * Face read path (Law 5): the library portrait/fullbody CHECKED OUT to exactly
 * this (runId, npcId), keep-rated and matching the run's locked art style, or
 * null. A checkout is the face commitment — this never serves a stranger's
 * face (no checkout, no image), never serves off-style art, and never throws
 * (a broken library falls back to the caller's empty state).
 * @param {object} run
 * @param {string} npcId
 * @param {"portrait"|"fullbody"} kind
 * @returns {string|null}
 */
export function resolveNpcFaceFromLibrary(run, npcId, kind) {
  const runId = run && typeof run.runId === "string" ? run.runId : null;
  if (!runId || !npcId || (kind !== "portrait" && kind !== "fullbody")) {
    return null;
  }
  let found;
  try {
    found = queryAssets({ kind }).filter((a) => a && a.rating === "keep");
  } catch {
    return null;
  }
  const libStyle = toCanonicalStyle(styleForRun(run));
  const matches = found.filter(
    (a) =>
      a.checkout &&
      a.checkout.runId === runId &&
      a.checkout.npcId === npcId &&
      (!libStyle || a.style === libStyle)
  );
  const chosen = pickStable(matches);
  return chosen ? libraryAssetUri(chosen.id) : null;
}
