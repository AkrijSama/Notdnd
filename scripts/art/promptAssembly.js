// ---------------------------------------------------------------------------
// PROMPT CONTRACT (art-pipeline-v2) — templated generation, never freehand.
//
// Every image prompt is ASSEMBLED from a versioned per-lane TEMPLATE
// (scripts/art/prompts/<lane>.json) whose ordered segments are:
//   { literal }  — a fixed invariant (lane rules baked as text)
//   { block }    — a per-model vocabulary block (blocks/<styleSlug>.json:
//                  quality | styleVocab | negativeBase) the OWNER tunes
//   { slot }     — a named hole filled from COMMITTED STATE or explicit params
//
// buildPrompt(lane, style, slotValues, context) -> { positive, negative, meta }.
// Slot values are PLAIN WORDS: any prompt-weight / embedding punctuation
// ( () [] <> :digit ) is rejected — structure lives in templates, not user text.
// A required slot with no value THROWS (never silently generate underspecified).
//
// The 14/14 toss batch failed on prompt discipline (duplicate heads, void floors,
// framing). This module is the enforcement point for that discipline.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";

// Env-overridable (tests point it at a temp dir); resolved at call time.
function promptsDir() {
  return process.env.NOTDND_ART_PROMPT_DIR
    ? path.resolve(process.env.NOTDND_ART_PROMPT_DIR)
    : path.resolve(process.cwd(), "scripts/art/prompts");
}

// Per-kind lane filenames collapse the style hyphen (matches the workflow-recipe
// convention): "dark-fantasy" -> "darkfantasy".
export function styleSlug(style) {
  return String(style).replace(/-/g, "");
}

// The asset KIND -> prompt LANE (templates are per-lane). world-card uses the
// dedicated worldcard template (cover framing, tower-permitted); every other kind
// maps 1:1, and a value that is already a lane passes through.
const KIND_TO_LANE = Object.freeze({ "world-card": "worldcard" });
export function laneForKind(kind) {
  return KIND_TO_LANE[String(kind)] || String(kind);
}

// The canonical cover-art tower phrase (worldcard `horizon` slot). The Tower is
// PROMOTIONAL, not diegetic: allowed on the cover, banned in starter-zone scenes.
export const TOWER_HORIZON_PHRASE = "distant impossible tower on the horizon";

// Scene context tags that trigger the diegetic tower BAN (tower -> negative).
const STARTER_TOWER_BAN_TAGS = new Set(["starter", "distant-from-tower"]);

// Reject prompt-weight / embedding punctuation in a slot value: parentheses,
// brackets, angle brackets, and a colon immediately followed by a digit (":1.2").
const INJECTION_RE = /[()[\]<>{}]|:\s*\d/;

function isFilled(value) {
  return value != null && String(value).trim() !== "";
}

function assertPlainSlotValue(name, value) {
  if (INJECTION_RE.test(String(value))) {
    throw new Error(
      `promptAssembly: slot "${name}" contains prompt-weight/embedding punctuation ("${value}") — slot values must be plain words`
    );
  }
}

function loadJson(file, what) {
  if (!fs.existsSync(file)) {
    throw new Error(`promptAssembly: ${what} not found at ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function loadTemplate(lane) {
  return loadJson(path.join(promptsDir(), `${laneForKind(lane)}.json`), `template for lane "${lane}"`);
}

export function loadBlock(style) {
  return loadJson(path.join(promptsDir(), "blocks", `${styleSlug(style)}.json`), `block file for style "${style}"`);
}

// Resolve one template segment to a string (or "" to be dropped).
function resolveSegment(seg, { lane, template, block, style, slotValues }) {
  if (seg.literal != null) {
    return String(seg.literal);
  }
  if (seg.block != null) {
    if (!(seg.block in block)) {
      throw new Error(
        `promptAssembly: template "${template.lane}" references block "${seg.block}" absent from ${styleSlug(style)}.json`
      );
    }
    return String(block[seg.block] || ""); // an empty block value is dropped
  }
  if (seg.slot != null) {
    const raw = slotValues[seg.slot];
    if (!isFilled(raw)) {
      if (seg.required) {
        throw new Error(`promptAssembly: lane "${lane}" requires slot "${seg.slot}" (no value provided)`);
      }
      return seg.default != null ? String(seg.default) : "";
    }
    const val = String(raw).trim();
    assertPlainSlotValue(seg.slot, val);
    return val;
  }
  return "";
}

/**
 * Assemble a positive+negative prompt for one image from its lane template, the
 * active style's model blocks, and slot values mapped from committed state.
 * Deterministic: identical (lane, style, slotValues, context) -> identical output.
 * @param {string} lane   portrait | fullbody | scene | item | worldcard (or a kind)
 * @param {string} style  engine/library style (anime | dark-fantasy)
 * @param {object} slotValues plain-word fillers for the template's named slots
 * @param {{ tags?: string[] }} [context] structured metadata for lane rules
 * @returns {{ positive: string, negative: string, meta: object }}
 */
export function buildPrompt(lane, style, slotValues = {}, context = {}) {
  const template = loadTemplate(lane);
  const block = loadBlock(style);
  const env = { lane, template, block, style, slotValues };

  const positiveSegs = template.positive.map((s) => resolveSegment(s, env)).filter((x) => x && x.trim());
  const negativeSegs = template.negative.map((s) => resolveSegment(s, env)).filter((x) => x && x.trim());

  // DIEGETIC LANE RULE (canon): a starter-zone / distant-from-tower scene must
  // never render the Tower — inject it into the negative. world-card is EXEMPT
  // (cover art is promotional; the tower is offered via its `horizon` slot).
  const tags = Array.isArray(context.tags) ? context.tags.map((t) => String(t).toLowerCase()) : [];
  const towerBanned = template.lane === "scene" && tags.some((t) => STARTER_TOWER_BAN_TAGS.has(t));
  if (towerBanned) {
    negativeSegs.push("tower");
  }

  return {
    positive: positiveSegs.join(", "),
    negative: negativeSegs.join(", "),
    meta: {
      templateVersion: template.templateVersion,
      lane: template.lane,
      blockVersions: { style: styleSlug(style), blockVersion: block.blockVersion },
      slotValues: { ...slotValues },
      ...(towerBanned ? { laneRulesApplied: ["starter-zone-tower-ban"] } : {})
    }
  };
}

// ---- COMMITTED-STATE mappers ----------------------------------------------
// These translate real records into plain-word slot values. Output is sanitized
// so it always passes buildPrompt's injection guard; buildPrompt re-validates
// (defense in depth) so a hand-built dirty slot value still throws.

// Strip weight/embedding punctuation from a mapped value (colons, all bracket
// families) and collapse whitespace — the result is always injection-safe.
function sanitizeSlot(value) {
  return String(value == null ? "" : value)
    .replace(/[()[\]<>{}:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitClauses(text) {
  return String(text || "")
    .split(/[,.;]/)
    .map((c) => c.trim())
    .filter(Boolean);
}

const HAIR_RE = /\b(hair|bald|shaved head|braided|braid|ponytail|beard)\b/i;
const BUILD_RE = /\b(broad|slender|stocky|muscular|lean|tall|short|thin|heavy|athletic|wiry|burly|petite)\b/i;
const ATTIRE_RE = /\b(coat|apron|dress|armou?r|robe|cloak|tunic|leather|linen|shirt|clothes|jacket|gown|uniform|hood|cape|vest|trousers|boots|glasses)\b/i;

function firstClauseMatching(clauses, re) {
  return clauses.find((c) => re.test(c)) || "";
}

// ERA LAW (all entity lanes): the era qualifier a world carries, sanitized to plain
// words, or "" when the world has no era field. mapNpcToSlots prefixes it onto the
// attire slot; a "" here is a WORLD-DATA GAP the intake reports — we never invent an
// era (the world data must grow the field; see art-pipeline-v2.md).
export function eraDescriptor(world = {}) {
  return sanitizeSlot(world && (world.era || world.eraDescriptor));
}
export function worldHasEra(world = {}) {
  return eraDescriptor(world) !== "";
}

function npcGenderWord(npc) {
  const gender = String(npc.gender || npc.sex || "").toLowerCase();
  const pronouns = String(npc.pronouns || "").toLowerCase();
  if (/\b(female|woman|girl|f)\b/.test(gender) || /\b(she|her)\b/.test(pronouns)) return "woman";
  if (/\b(male|man|boy|m)\b/.test(gender) || /\b(he|him)\b/.test(pronouns)) return "man";
  if (/non-?binary|enby|androgynous|they/.test(gender) || /\b(they|them)\b/.test(pronouns)) return "androgynous person";
  return "";
}

/**
 * Map a committed NPC record to portrait/fullbody slot values. gender comes from
 * the committed gender/sex/pronouns; hair/build/attire are parsed from the
 * committed appearance (parse-or-passthrough); poseHint from a mannerism.
 * An NPC with no gender signal yields no gender slot -> buildPrompt throws (the
 * "never generate underspecified" rule), which is the intended loud failure.
 * @param {object} npc
 * @returns {object} slotValues
 */
export function mapNpcToSlots(npc = {}, world = {}) {
  const appearance = String(npc.appearance || npc.description || "");
  const clauses = splitClauses(appearance);
  let hair = firstClauseMatching(clauses, HAIR_RE);
  let build = firstClauseMatching(clauses, BUILD_RE);
  let attire = firstClauseMatching(clauses, ATTIRE_RE);
  // Passthrough: nothing parsed but appearance exists -> the whole appearance is
  // the attire descriptor (still sanitized to plain words).
  if (!hair && !build && !attire && appearance.trim()) {
    attire = appearance;
  }
  const out = {};
  const set = (key, value) => {
    const clean = sanitizeSlot(value);
    if (clean) {
      out[key] = clean;
    }
  };
  set("gender", npcGenderWord(npc));
  set("age", npc.age);
  set("build", build);
  set("hair", hair);
  // ERA LAW: prefix the world's committed era qualifier onto the clothing slot so
  // the model doesn't default to modern dress. No era in the world data -> attire
  // rides bare (a world-data gap the intake reports; we never invent an era).
  const era = eraDescriptor(world);
  set("attire", attire ? (era ? `${era} ${sanitizeSlot(attire)}` : attire) : attire);
  set("expression", npc.expression);
  set("poseHint", npc.mannerism);
  return out;
}

/**
 * Map a committed location record to scene slot values. subject/setting from the
 * committed name/type; timeOfDay from the committed clock phase; weatherHint from
 * committed weather. Location TAGS are NOT slots — pass them as buildPrompt's
 * context.tags so the diegetic tower ban can fire.
 * @param {object} location
 * @returns {object} slotValues
 */
export function mapLocationToSlots(location = {}) {
  const clockPhase =
    (location.clock && typeof location.clock === "object" ? location.clock.phase : null) ||
    location.timeOfDay ||
    "";
  const out = {};
  const set = (key, value) => {
    const clean = sanitizeSlot(value);
    if (clean) {
      out[key] = clean;
    }
  };
  set("subject", location.name || location.subject);
  set("setting", location.setting || location.type);
  set("timeOfDay", clockPhase);
  set("weatherHint", location.weather || location.weatherHint);
  return out;
}
