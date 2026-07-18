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

// The three locked ENGINE art styles (legacy vocab; was ART_STYLES in worldGen.js,
// re-exported there). Drives artStyleDirection (imageWorker) + STYLE_PRESETS
// (ai/comfyui.js) — the live generation path still speaks this vocab.
export const ENGINE_STYLES = Object.freeze(["illustrated", "anime", "cinematic"]);

// The CANONICAL / library styles — the player-facing, run-locked, butler-resolved
// vocabulary (asset sidecar .style + prompt blocks/<slug> + workflow <lane>-<slug>).
// "realistic" is first-class (art-pipeline-v2): its nearest ENGINE key is
// "cinematic", and it shares the Juggernaut cookbook with "dark-fantasy"
// (differs only in styleVocab). STYLES === LIBRARY_STYLES (one set, two names for
// back-compat with the reconciliation-flag callers).
export const STYLES = Object.freeze(["anime", "dark-fantasy", "realistic"]);
export const LIBRARY_STYLES = STYLES;

export const DEFAULT_ENGINE_STYLE = "illustrated";
export const DEFAULT_LIBRARY_STYLE = "dark-fantasy";
// House fallback for the butler (today's production-quality lane).
export const DEFAULT_STYLE = "dark-fantasy";

// Canonical style -> checkpoint COOKBOOK — a human-readable REPORT table only.
// NOT the live selection path: the live checkpoint is derived from the validated
// exports via comfyui.checkpointForStyle (single source of truth). Keep these short
// names in sync with the exports' checkpoints (see comfyui-checkpoint-drift.test):
// anime = JANKU (Chunk-6, replaced Illustrious); dark-fantasy = nihilmania/YamerMIX;
// realistic = Juggernaut.
export const STYLE_COOKBOOK = Object.freeze({
  anime: "JANKU",
  "dark-fantasy": "nihilmania",
  realistic: "Juggernaut"
});

// ---- THE MAPPING TABLE (engine <-> canonical/library), verbatim -----------
// engine -> canonical. illustrated -> the painterly Juggernaut "dark-fantasy";
// anime -> anime; cinematic -> "realistic" (its nearest key now that realistic is
// first-class — CHANGED from dark-fantasy this round).
const ENGINE_TO_CANONICAL = Object.freeze({
  illustrated: "dark-fantasy",
  anime: "anime",
  cinematic: "realistic"
});
// Back-compat alias (same table): engine -> library.
const ENGINE_TO_LIBRARY = ENGINE_TO_CANONICAL;

// canonical/library -> engine (reverse). dark-fantasy -> illustrated (painterly
// default), anime -> anime, realistic -> cinematic.
const CANONICAL_TO_ENGINE = Object.freeze({
  anime: "anime",
  "dark-fantasy": "illustrated",
  realistic: "cinematic"
});
const LIBRARY_TO_ENGINE = CANONICAL_TO_ENGINE;

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

// ---- CANONICAL STYLE helpers (butler currency) ----------------------------

// Clamp an arbitrary string to a valid CANONICAL style (default dark-fantasy).
export function normalizeStyle(style) {
  const key = lc(style);
  return STYLES.includes(key) ? key : DEFAULT_STYLE;
}

// Accept EITHER vocabulary and return the CANONICAL style, or null if the value
// is not a recognized style in either vocab. A locked run.flags.artStyle may hold
// legacy engine vocab (illustrated/anime/cinematic) OR canonical vocab
// (anime/dark-fantasy/realistic); this normalizes both.
export function toCanonicalStyle(style) {
  const key = lc(style);
  if (!key) {
    return null;
  }
  if (STYLES.includes(key)) {
    return key;
  }
  if (ENGINE_STYLES.includes(key)) {
    return ENGINE_TO_CANONICAL[key];
  }
  return null;
}

// canonical style -> engine style (for the live generation path: artStyleDirection
// + comfyui STYLE_PRESETS still speak engine vocab).
export function styleToEngine(style) {
  return CANONICAL_TO_ENGINE[normalizeStyle(style)];
}

// The canonical styles a world permits (world.artStyleOptions.allowed, normalized).
// Defaults to ALL styles when a world declares no allow-list.
export function allowedStylesFor(world) {
  const raw = world && world.artStyleOptions && Array.isArray(world.artStyleOptions.allowed)
    ? world.artStyleOptions.allowed.map(toCanonicalStyle).filter(Boolean)
    : [];
  return raw.length ? [...new Set(raw)] : [...STYLES];
}

/**
 * THE BUTLER — the single art-style resolution chain, consulted by every
 * art-request site (library query + generation dispatch). Data-driven, deterministic.
 * Rungs, in order:
 *   1. run.flags.artStyle          — the player's LOCKED choice (item 3)
 *   2. run.edition === "forbidden" — forbidden-mode prefers "realistic"
 *   3. world.artStyleOptions.default (then legacy world.artStyle, resume-safety)
 *   4. house fallback: DEFAULT_STYLE ("dark-fantasy")
 * Returns a CANONICAL style (anime | dark-fantasy | realistic).
 * @param {object} run  the run (may be null — then only rungs 3-4 apply)
 * @param {object} [world] the world (defaults to run.world)
 * @returns {"anime"|"dark-fantasy"|"realistic"}
 */
export function styleForRun(run, world) {
  // Rung 1 — the player's locked choice (accepts either vocab).
  const locked = run && run.flags ? toCanonicalStyle(run.flags.artStyle) : null;
  if (locked) {
    return locked;
  }
  // Rung 2 — forbidden-mode preference. The forbidden-mode flag that EXISTS today
  // is run.edition === "forbidden" (schema.js EDITIONS); a forbidden run with no
  // explicit lock prefers the realistic lane.
  if (run && lc(run.edition) === "forbidden") {
    return "realistic";
  }
  // Rung 3 — the world's default (new field first, legacy string as resume-safety).
  const w = world || (run && run.world) || null;
  if (w && typeof w === "object") {
    const opt = w.artStyleOptions && typeof w.artStyleOptions === "object" ? w.artStyleOptions.default : null;
    const fromWorld = toCanonicalStyle(opt) || toCanonicalStyle(w.artStyle);
    if (fromWorld) {
      return fromWorld;
    }
  }
  // Rung 4 — house fallback.
  return DEFAULT_STYLE;
}

// Butler result mapped into ENGINE vocab for the live generation path (imageWorker
// artStyleDirection + ai/comfyui STYLE_PRESETS). Same single chain, engine output.
export function engineStyleForRun(run, world) {
  return styleToEngine(styleForRun(run, world));
}

/**
 * STYLE LOCK LAW (owner ruling): art style is chosen at run creation and LOCKED
 * for the campaign. The guarded setter writes run.flags.artStyle ONCE; a later
 * write that CHANGES the style is rejected unless an explicit styleSwitch grant is
 * passed (the Ink-purchase hook — this is the guarded setter only; no purchase
 * flow / UI / pricing here). The chosen style is validated against the world's
 * allowed list. Returns the canonical style written.
 * @param {object} run
 * @param {string} style requested style (either vocab)
 * @param {{ grant?: boolean }} [opts] grant:true = a paid styleSwitch override
 * @returns {"anime"|"dark-fantasy"|"realistic"}
 */
export function lockRunArtStyle(run, style, { grant = false } = {}) {
  if (!run || typeof run !== "object") {
    throw new Error("artStyle: lockRunArtStyle requires a run object");
  }
  const canonical = toCanonicalStyle(style);
  const allowed = allowedStylesFor(run.world);
  if (!canonical || !allowed.includes(canonical)) {
    throw new Error(`artStyle: "${style}" is not an allowed style for this world (allowed: ${allowed.join(", ")})`);
  }
  run.flags = run.flags || {};
  const current = toCanonicalStyle(run.flags.artStyle);
  if (current && current !== canonical && !grant) {
    throw new Error(
      "artStyle: art style is LOCKED for this run — mid-campaign style switching is a premium (Ink-priced) service; pass an explicit styleSwitch grant to override"
    );
  }
  run.flags.artStyle = canonical;
  return canonical;
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
  const prev = target.artStyleOptions && typeof target.artStyleOptions === "object" ? target.artStyleOptions : {};
  target.artStyleOptions = {
    ...prev,
    default: style,
    // The lock's allow-list (canonical vocab). Defaults to ALL styles; a world may
    // pre-declare a narrower `allowed` and it is preserved.
    allowed: Array.isArray(prev.allowed) && prev.allowed.length ? prev.allowed : [...STYLES]
  };
  return target;
}
