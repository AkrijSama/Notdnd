// ---------------------------------------------------------------------------
// SYSTEM LORE — committed world-law facts about a world's diegetic system (e.g.
// Babel's VOICE + WINDOW).
//
// Canon (owner ruling, Jul 10): the VOICE and the WINDOW never lie — and they
// never do anything beyond their committed capabilities. Live-observed
// violation: the GM narrated "The window will remember what direction you go"
// — the STATUS WINDOW has no memory.
//
// STEEL/FURNITURE MIGRATION (2026-07-21, CLI-2). The lore CONTENT used to be a
// hardcoded engine constant injected into EVERY world's narrator prompt — a
// cyberpunk-alley GM was told about "the champion", "the WINDOW", and "the VOICE".
// The content is now FURNITURE: it rides `world.systemLore` (babel.json authors it;
// the loader carries it — scenarioLoader.js widened whitelist). A world that
// declares no systemLore gets NO clause and NO auditor (engine default is neutral).
// The window/voice clause TEMPLATE stays engine steel (the phrasing is a rendering
// convention); only the vocabulary moved. The shape is still the ONE contract the
// prompt clause AND the live auditor both read, so does/does-not can never drift.
// ---------------------------------------------------------------------------

// A valid lore pane: {what: string, does: string[], doesNot: string[]}.
function validPane(p) {
  const strs = (a) => Array.isArray(a) && a.length > 0 && a.every((s) => typeof s === "string" && s);
  return Boolean(p) && typeof p === "object" && typeof p.what === "string" && p.what.trim() && strs(p.does) && strs(p.doesNot);
}
// The window/voice panes a world commits, or nulls. `world.systemLore` is the map
// { window: {…}, voice: {…} }; a world without it (or a malformed one) yields nulls,
// which is how a non-VOICE/WINDOW world opts out of the whole subsystem.
function panesFor(world) {
  const lore = world && typeof world === "object" ? world.systemLore : null;
  if (!lore || typeof lore !== "object") return { w: null, v: null };
  return { w: validPane(lore.window) ? lore.window : null, v: validPane(lore.voice) ? lore.voice : null };
}

// The grounding clause a narration path receives for a world that commits a
// VOICE + WINDOW. Byte-identical to the pre-migration clause when `world.systemLore`
// carries Babel's canon. A world with no committed system gets "" (no leak).
export function buildSystemLoreClause(world) {
  const { w, v } = panesFor(world);
  if (!w || !v) return "";
  return (
    ` SYSTEM LORE (committed world-law — never contradict): ${w.what} It ONLY ${w.does.join("; ")}. ` +
    `It does NOT ${w.doesNot.join(", ")} — never attribute any of those to the window. ` +
    `${v.what} It does NOT ${v.doesNot.join(", ")}. ` +
    `If the player asks what the window or voice can do, answer strictly from these facts.`
  );
}

// --- LIVE AUDITOR CHECK ------------------------------------------------------
// Flags narration that attributes to the WINDOW or VOICE a capability from its
// does-NOT list: the pattern is window/voice as the grammatical subject of a
// capability verb ("the window will remember…", "the voice watches…"). A
// NEGATED attribution ("the window does not remember") is the lore stated
// correctly and is never flagged. Pure; returns [{ subject, verb, sentence }].
// The verb vocabulary is now per-world (built from world.systemLore.*.doesNot) —
// a world with no committed system audits nothing.
const VERB_FORMS = (verbs) => verbs.map((v) => `${v}(?:es|s)?`).join("|");

function violationRe(subject, verbs) {
  // subject … (aux) verb, within one clause (no sentence punctuation between).
  return new RegExp(
    `\\b(${subject})\\b(?![^.!?]{0,60}\\b(?:not|never|cannot|can['’]t|won['’]t|doesn['’]t|does not|will not)\\b[^.!?]{0,20}\\b(?:${verbs})\\b)[^.!?]{0,60}?\\b(?:will\\s+|would\\s+|can\\s+|shall\\s+|is\\s+going\\s+to\\s+)?(${verbs})\\b`,
    "gi"
  );
}

export function detectSystemLoreViolations(narrationText, world) {
  const text = String(narrationText || "");
  if (!text.trim()) {
    return [];
  }
  const { w, v } = panesFor(world);
  if (!w && !v) {
    return [];
  }
  const res = [];
  if (w) res.push(violationRe("window", VERB_FORMS(w.doesNot)));
  if (v) res.push(violationRe("voice", VERB_FORMS(v.doesNot)));
  const out = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    for (const re of res) {
      re.lastIndex = 0;
      const m = re.exec(sentence);
      if (m) {
        out.push({ subject: m[1].toLowerCase(), verb: m[2].toLowerCase(), sentence: sentence.trim().slice(0, 160) });
      }
    }
  }
  return out;
}
