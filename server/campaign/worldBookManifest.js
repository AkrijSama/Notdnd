// WORLD-BOOK BILL OF MATERIALS (steel/furniture split, owner 2026-07-21).
//
// "Authoring world #2 must be form-filling, not archaeology." This module answers, for
// any world, the only question an author actually has: WHICH SLOTS HAVE I FILLED, which
// is the engine covering for me, and what is left?
//
// It reads WORLD_BOOK_SLOTS (server/campaign/worldBook.js) — the ONE registry that
// declares every furniture slot and its mint-default — so the manifest can never drift
// from the compiler. Per slot it reports:
//
//   filled    — the author supplied a real value
//   defaulted — absent; the engine's declared default/mint covers it (the world still plays)
//   empty     — absent AND no default exists. After the slot-registry law this must be
//               impossible for every slot except `name`; a non-`name` `empty` is a BUG.
//
// Pure — no I/O except the optional scenario-file resolution in resolveWorldBook().

import { WORLD_BOOK_SLOTS, worldBookName, worldBookVibe } from "./worldBook.js";
import { loadScenarioFile } from "./scenarioLoader.js";

function isPlainObject(v) { return Boolean(v) && typeof v === "object" && !Array.isArray(v); }

// A slot counts as FILLED only when the author put something real there — an empty
// string / array / object is an unfilled slot wearing a costume.
function isFilled(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isPlainObject(v)) return Object.keys(v).length > 0;
  return true;
}

// How to READ an authored value for each slot. The aliases mirror exactly what
// normalizeWorldBook()/worldBookName()/worldBookVibe() accept, so babel's native shape
// (title, world.*, locations map) reads as FILLED rather than falsely "defaulted".
const SLOT_READERS = Object.freeze({
  "name": (wb) => worldBookName(wb),
  "vibe": (wb) => worldBookVibe(wb),
  "identity.era": (wb) => wb.identity?.era ?? wb.world?.era,
  "identity.tone": (wb) => wb.identity?.tone ?? wb.world?.tone ?? (Array.isArray(wb.tones) ? wb.tones[0] : undefined),
  "identity.genre": (wb) => wb.identity?.genre ?? wb.genre,
  "cosmology": (wb) => wb.cosmology ?? wb.world?.flavor,
  "poiTable": (wb) => wb.pois ?? wb.poiTable ?? wb.locations,
  "startArea": (wb) => wb.startArea,
  "factions": (wb) => wb.factions,
  "threatLadder": (wb) => wb.threatLadder ?? wb.bestiary?.threatLadder,
  "bestiary": (wb) => wb.bestiary,
  "nameBanks": (wb) => wb.nameBanks ?? wb.world?.nameBanks,
  "orientationMix": (wb) => wb.orientationMix ?? wb.world?.orientationMix,
  "deathLaw": (wb) => wb.deathLaw ?? wb.world?.deathLaw,
  "services": (wb) => wb.services,
  "fronts": (wb) => wb.fronts,
  "secrets": (wb) => wb.secrets,
  "cast": (wb) => wb.cast,
  "questOffers": (wb) => wb.questOffers,
  "quests": (wb) => wb.quests,
  "opening.situation": (wb) => wb.opening?.situation,
  "world.artStyle": (wb) => wb.world?.artStyle ?? wb.artStyle
});

// Accept a world-book object, or a scenario/world id to load from disk.
export function resolveWorldBook(bookOrId) {
  if (isPlainObject(bookOrId)) return bookOrId;
  if (typeof bookOrId === "string" && bookOrId.trim()) {
    const loaded = loadScenarioFile(bookOrId.trim());
    if (loaded) return loaded;
    throw new Error(`worldBookManifest: no world/scenario "${bookOrId}"`);
  }
  throw new Error("worldBookManifest: pass a world-book object or a worldId");
}

/**
 * The bill of materials for one world.
 * @param {object|string} bookOrId world-book object, or a worldId/scenarioId on disk
 * @returns {{worldId, name, slots: Array, summary: object}}
 */
export function worldBookManifest(bookOrId) {
  const wb = resolveWorldBook(bookOrId);
  const worldId = (typeof bookOrId === "string" ? bookOrId : wb.scenarioId) || "(unsaved)";

  const slots = WORLD_BOOK_SLOTS.map((slot) => {
    const reader = SLOT_READERS[slot.path];
    let raw;
    try {
      raw = reader ? reader(wb) : undefined;
    } catch {
      raw = undefined; // a malformed book reads as unfilled, never throws
    }
    const filled = isFilled(raw);
    // planned = declared by law (ROADMAP-CANON) but engine-unbuilt. Reported as its own
    // status so a "gap" is never confused with a slot the engine is quietly covering.
    const status = filled
      ? (slot.defaultKind === "planned" ? "filled-inert" : "filled")
      : slot.defaultKind === "planned" ? "planned"
      : slot.defaultKind === "required" ? "empty"
      : "defaulted";
    return {
      path: slot.path,
      label: slot.label,
      status,
      defaultKind: slot.defaultKind,
      // What covers the slot when the author left it blank.
      coveredBy: filled ? null : (slot.mintedBy || describeDefault(slot.default)),
      consumer: slot.consumer,
      note: slot.note || null,
      size: measure(raw)
    };
  });

  const counts = { filled: 0, "filled-inert": 0, defaulted: 0, planned: 0, empty: 0 };
  for (const s of slots) counts[s.status] += 1;
  // LIVE slots are the ones the engine actually consumes — the honest denominator for
  // "how much of this world did the author write?". Planned slots are counted apart.
  const live = slots.filter((s) => s.defaultKind !== "planned");
  const summary = {
    total: slots.length,
    liveTotal: live.length,
    ...counts,
    // Coverage over LIVE slots. Defaulted slots still play; they are the engine covering,
    // which is exactly what the author needs to see.
    authoredPct: Math.round((counts.filled / live.length) * 100),
    // A non-`name` empty slot violates the {name,vibe}-plays law.
    lawHolds: slots.every((s) => s.status !== "empty" || s.path === "name"),
    deadSlots: slots.filter((s) => /NONE|DEAD SLOT/.test(s.consumer || "")).map((s) => s.path),
    plannedSlots: slots.filter((s) => s.defaultKind === "planned").map((s) => s.path)
  };
  return { worldId, name: worldBookName(wb) || "(unnamed)", slots, summary };
}

function describeDefault(value) {
  if (value === undefined || value === null) return "(none)";
  if (Array.isArray(value)) return value.length ? `default list (${value.length})` : "empty list";
  if (isPlainObject(value)) return `default table (${Object.keys(value).length} keys)`;
  if (value === "") return "empty string";
  return `"${String(value)}"`;
}

function measure(v) {
  if (Array.isArray(v)) return v.length;
  if (isPlainObject(v)) return Object.keys(v).length;
  if (typeof v === "string") return v.trim().length ? 1 : 0;
  return v === undefined || v === null ? 0 : 1;
}

const MARK = { filled: "[x]", "filled-inert": "[x!]", defaulted: "[~]", planned: "[…]", empty: "[ ]" };

/** CLI-printable manifest. */
export function formatManifest(manifest) {
  const { worldId, name, slots, summary } = manifest;
  const w = Math.max(...slots.map((s) => s.path.length), 12);
  const lines = [
    `WORLD-BOOK BILL OF MATERIALS — ${name}  (${worldId})`,
    "",
    `  [x] filled by author   [~] engine default/mint   […] PLANNED (law-declared, engine-unbuilt)`,
    `  [x!] filled but inert (nothing consumes it yet)   [ ] EMPTY (no default — bug)`,
    ""
  ];
  for (const s of slots) {
    const pad = s.path.padEnd(w);
    const tail = s.status === "filled" || s.status === "filled-inert"
      ? `${s.size} authored`
      : s.status === "planned"
        ? "not built yet — authoring it is inert"
        : `covered by: ${s.coveredBy}`;
    lines.push(`  ${MARK[s.status]} ${pad}  ${tail}`);
  }
  lines.push("");
  lines.push(`  ${summary.filled}/${summary.liveTotal} LIVE slots authored (${summary.authoredPct}%), ${summary.defaulted} engine-covered, ${summary.empty} empty.`);
  lines.push(`  {name,vibe}-plays law: ${summary.lawHolds ? "HOLDS" : "VIOLATED — a slot has no default"}`);
  if (summary.deadSlots.length) {
    lines.push(`  DEAD SLOTS (authored + validated, consumed by nothing): ${summary.deadSlots.join(", ")}`);
  }
  if (summary.plannedSlots.length) {
    lines.push(`  PLANNED (the world #2 gap): ${summary.plannedSlots.join(", ")}`);
  }
  return lines.join("\n");
}

/** Owner-readable markdown manifest doc for a world. */
export function manifestMarkdown(manifest) {
  const { worldId, name, slots, summary } = manifest;
  const STATUS_LABEL = {
    filled: "**filled**",
    "filled-inert": "**filled** (inert)",
    defaulted: "_engine default_",
    planned: "_planned_",
    empty: "**EMPTY**"
  };
  const rows = slots.map((s) => {
    const covered = s.status === "filled" || s.status === "filled-inert"
      ? `${s.size} authored`
      : s.status === "planned" ? "— (not built)" : s.coveredBy;
    return `| \`${s.path}\` | ${s.label} | ${STATUS_LABEL[s.status]} | ${covered} | ${s.consumer} |`;
  });
  return [
    `# World-book manifest — ${name}`,
    "",
    "<!-- GENERATED by scripts/world-manifest.mjs — re-run after editing the world. -->",
    "",
    `**World:** \`${worldId}\` · **Authored:** ${summary.filled}/${summary.liveTotal} live slots (${summary.authoredPct}%) · **Engine-covered:** ${summary.defaulted} · **Empty:** ${summary.empty} · **Planned (unbuilt):** ${summary.planned}`,
    "",
    `\`{name,vibe}\`-plays law: **${summary.lawHolds ? "HOLDS" : "VIOLATED"}**`,
    "",
    "| Slot | What it is | Status | Filled / covered by | Consumed by |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    summary.deadSlots.length
      ? `> **Dead slots** — authored + validated, consumed by nothing. Filling these changes nothing until a consumer ships: ${summary.deadSlots.map((d) => `\`${d}\``).join(", ")}`
      : "> No dead slots.",
    "",
    summary.plannedSlots.length
      ? `> **Planned slots** — declared by \`docs/ROADMAP-CANON.md\` ("Law of Creating Worlds") but engine-unbuilt. This is the real world-#2 gap: ${summary.plannedSlots.map((d) => `\`${d}\``).join(", ")}`
      : "",
    ""
  ].join("\n");
}
