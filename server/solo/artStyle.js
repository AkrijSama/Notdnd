// ---------------------------------------------------------------------------
// ART-STYLE VOCABULARY RECONCILIATION (art-plumbing item 2).
//
// TWO vocabularies exist for "art style" and they are NOT the same set:
//
//   ENGINE vocab  — what a run carries (run.world.artStyle / artStyleOptions):
//                   "illustrated" | "anime" | "cinematic"
//                   (drives artStyleDirection in imageWorker + STYLE_PRESETS in
//                    ai/comfyui.js — the per-style prompt/checkpoint direction)
//
//   LIBRARY vocab — what the asset library + ComfyUI workflow recipes use
//                   (sidecar .style, scripts/art/workflows/<style>.json):
//                   "anime" | "dark-fantasy"
//
// This module is the ONE table that reconciles them, plus the ONE reader that
// resolves a world's engine style. Every consumer that used to compare the
// legacy `world.artStyle` string by hand now calls resolveWorldArtStyle(world)
// (or runArtStyle(run)) so there is exactly one place the vocab lives.
//
// THE RECONCILIATION FLAG: resolveWorldArtStyle reads `world.artStyleOptions.default`
// FIRST (new saves), and the legacy `world.artStyle` string ONLY as a fallback
// (resume-safety for saves written before this field existed) — never as primary.
// ---------------------------------------------------------------------------

// The three locked engine art styles (was ART_STYLES in solo/worldGen.js; that
// module now re-exports this so there is a single source of truth).
export const ENGINE_STYLES = Object.freeze(["illustrated", "anime", "cinematic"]);
// The library / workflow-recipe styles (asset sidecar .style + workflow json).
export const LIBRARY_STYLES = Object.freeze(["anime", "dark-fantasy"]);

export const DEFAULT_ENGINE_STYLE = "illustrated";
export const DEFAULT_LIBRARY_STYLE = "dark-fantasy";

// ---- THE MAPPING TABLE (engine <-> library), verbatim ---------------------
// engine -> library/workflow recipe. illustrated + cinematic both render on the
// painterly Juggernaut base, which IS the "dark-fantasy" recipe; anime -> anime.
const ENGINE_TO_LIBRARY = Object.freeze({
  illustrated: "dark-fantasy",
  anime: "anime",
  cinematic: "dark-fantasy"
});

// library/workflow -> engine (reverse; library assets are tagged in library
// vocab, so surfacing one back into the engine needs this). "dark-fantasy"
// resolves to the default painterly engine style, "illustrated".
const LIBRARY_TO_ENGINE = Object.freeze({
  anime: "anime",
  "dark-fantasy": "illustrated"
});

function lc(value) {
  return String(value || "").trim().toLowerCase();
}

// Clamp an arbitrary string to a valid engine style (default illustrated).
export function normalizeEngineStyle(style) {
  const key = lc(style);
  return ENGINE_STYLES.includes(key) ? key : DEFAULT_ENGINE_STYLE;
}

// Clamp an arbitrary string to a valid library style (default dark-fantasy).
export function normalizeLibraryStyle(style) {
  const key = lc(style);
  return LIBRARY_STYLES.includes(key) ? key : DEFAULT_LIBRARY_STYLE;
}

// engine style -> library/workflow style.
export function engineToLibraryStyle(style) {
  return ENGINE_TO_LIBRARY[normalizeEngineStyle(style)];
}

// library/workflow style -> engine style.
export function libraryToEngineStyle(style) {
  return LIBRARY_TO_ENGINE[lc(style)] || DEFAULT_ENGINE_STYLE;
}

// Whether a world object carries any usable engine style (new field or legacy).
function worldHasStyle(world) {
  if (!world || typeof world !== "object") {
    return false;
  }
  const opt = world.artStyleOptions && typeof world.artStyleOptions === "object"
    ? world.artStyleOptions.default
    : null;
  return (typeof opt === "string" && opt.trim().length > 0) ||
    (typeof world.artStyle === "string" && world.artStyle.trim().length > 0);
}

/**
 * THE reconciliation reader. Resolves a world's ENGINE art style, reading
 * `world.artStyleOptions.default` FIRST and the legacy `world.artStyle` string
 * only as a fallback (never primary). Always returns a valid engine style.
 * @param {object} world run.world (or a scenario/def world object)
 * @returns {"illustrated"|"anime"|"cinematic"}
 */
export function resolveWorldArtStyle(world) {
  if (world && typeof world === "object") {
    const opt = world.artStyleOptions && typeof world.artStyleOptions === "object"
      ? world.artStyleOptions.default
      : null;
    if (typeof opt === "string" && opt.trim()) {
      return normalizeEngineStyle(opt);
    }
    if (typeof world.artStyle === "string" && world.artStyle.trim()) {
      return normalizeEngineStyle(world.artStyle);
    }
  }
  return DEFAULT_ENGINE_STYLE;
}

/**
 * Run-level convenience: resolve a run's engine art style. run.world is
 * authoritative (via resolveWorldArtStyle); run.flags.artStyle is the historical
 * enqueue MIRROR, kept only as a last resort for a partial/legacy run object.
 * @param {object} run
 * @returns {"illustrated"|"anime"|"cinematic"}
 */
export function runArtStyle(run) {
  if (!run || typeof run !== "object") {
    return DEFAULT_ENGINE_STYLE;
  }
  if (worldHasStyle(run.world)) {
    return resolveWorldArtStyle(run.world);
  }
  if (run.flags && typeof run.flags.artStyle === "string" && run.flags.artStyle.trim()) {
    return normalizeEngineStyle(run.flags.artStyle);
  }
  return DEFAULT_ENGINE_STYLE;
}

/**
 * Producer helper: stamp both the new `artStyleOptions.default` (primary) and the
 * legacy `artStyle` string (back-compat) onto a plain object of world fields, so
 * new saves exercise the new primary path while old readers still work.
 * @param {object} target the object to mutate (world fields)
 * @param {string} engineStyle an engine style (clamped)
 * @returns {object} target
 */
export function stampArtStyle(target, engineStyle) {
  const style = normalizeEngineStyle(engineStyle);
  target.artStyle = style;
  target.artStyleOptions = { ...(target.artStyleOptions || {}), default: style };
  return target;
}
