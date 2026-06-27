import { generateUtility } from "../ai/openrouter.js";

// ---------------------------------------------------------------------------
// PDF sourcebook import. Two genuinely hard steps, handled honestly:
//   1. Extract text from an uploaded PDF (pdf-parse). Scanned-image or encrypted
//      books yield no usable text — we detect that and tell the user to paste
//      instead, never crash.
//   2. Use the cheap utility LLM to STRUCTURE the named character options (races,
//      subclasses, backgrounds, feats) out of the messy extracted text into
//      review candidates. Parsing is imperfect, so we NEVER auto-save: the
//      endpoint returns candidates for the user to edit/confirm. Output is
//      sanitized and capped regardless of what the model (or a malicious PDF)
//      returns. Any failure degrades to { ok:false, reason } — "try manual entry".
// ---------------------------------------------------------------------------

// PDFs are far larger than the text-import cap; allow a generous but bounded size.
export const MAX_PDF_BYTES = Number(process.env.NOTDND_PDF_IMPORT_MAX_BYTES || 16 * 1024 * 1024);
// Cap the text actually sent to the model so a 300-page book can't blow the
// context / cost. ~60k chars ≈ a couple of chapters; users paste a section anyway.
const MAX_EXTRACT_CHARS = 60_000;
const MIN_USEFUL_CHARS = 200;
const MAX_PER_CATEGORY = 25;
const PARSE_TIMEOUT_MS = 30_000;

function clean(value, max = 400) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function cleanName(value) {
  return clean(value, 80);
}

function strList(value, maxItems = 12, maxLen = 160) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => clean(entry, maxLen)).filter(Boolean).slice(0, maxItems);
}

function clampSpeed(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 5 && n <= 120 ? Math.round(n) : 30;
}

export function emptyCandidates() {
  return { races: [], subclasses: [], backgrounds: [], feats: [] };
}

function candidateCount(candidates) {
  return (
    candidates.races.length +
    candidates.subclasses.length +
    candidates.backgrounds.length +
    candidates.feats.length
  );
}

// Forces the model output into our shape, drops anything unnamed, and caps every
// list — so review candidates are always well-formed and bounded.
export function normalizeCandidates(parsed) {
  const obj = parsed && typeof parsed === "object" ? parsed : {};
  const arr = (value) => (Array.isArray(value) ? value : []);

  const races = arr(obj.races)
    .map((race) => ({
      kind: "race",
      name: cleanName(race?.name),
      size: clean(race?.size, 16) || "Medium",
      speed: clampSpeed(race?.speed),
      traits: strList(race?.traits)
    }))
    .filter((race) => race.name)
    .slice(0, MAX_PER_CATEGORY);

  const subclasses = arr(obj.subclasses)
    .map((sub) => ({
      kind: "subclass",
      name: cleanName(sub?.name),
      className: cleanName(sub?.className),
      features: strList(sub?.features)
    }))
    .filter((sub) => sub.name)
    .slice(0, MAX_PER_CATEGORY);

  const backgrounds = arr(obj.backgrounds)
    .map((bg) => ({
      kind: "background",
      name: cleanName(bg?.name),
      skillProficiencies: strList(bg?.skillProficiencies, 6, 40),
      feature: {
        name: cleanName(bg?.feature?.name),
        description: clean(bg?.feature?.description, 500)
      }
    }))
    .filter((bg) => bg.name)
    .slice(0, MAX_PER_CATEGORY);

  const feats = arr(obj.feats)
    .map((feat) => ({
      kind: "feat",
      name: cleanName(feat?.name),
      prerequisite: clean(feat?.prerequisite, 120),
      description: clean(feat?.description, 500)
    }))
    .filter((feat) => feat.name)
    .slice(0, MAX_PER_CATEGORY);

  return { races, subclasses, backgrounds, feats };
}

function buildMessages(text) {
  const excerpt = String(text || "").slice(0, MAX_EXTRACT_CHARS);
  return [
    {
      role: "system",
      content:
        "You extract D&D 5e CHARACTER OPTIONS from raw sourcebook text into JSON for a human to review. " +
        "Find only NAMED races, subclasses, backgrounds, and feats that actually appear in the text — never invent any. " +
        "Summarize features/traits as short bullet strings (a few words each), not full rules text. " +
        "Reply ONLY with compact JSON in exactly this shape (omit a category if you find none):\n" +
        '{"races":[{"name":string,"size":string,"speed":number,"traits":[string]}],' +
        '"subclasses":[{"name":string,"className":string,"features":[string]}],' +
        '"backgrounds":[{"name":string,"skillProficiencies":[string],"feature":{"name":string,"description":string}}],' +
        '"feats":[{"name":string,"prerequisite":string,"description":string}]}'
    },
    { role: "user", content: excerpt || "(no text)" }
  ];
}

function parseJsonObject(text) {
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[0]);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("parse timeout")), ms))
  ]);
}

/**
 * Extracts text from a PDF buffer. Loaded lazily so the rest of this module (and
 * its tests) never pull in pdf-parse. Never throws — returns a reason on failure.
 * @param {Buffer} buffer
 * @returns {Promise<{ok: boolean, text: string, pages?: number|null, reason?: string}>}
 */
export async function extractPdfText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, text: "", reason: "No PDF data received." };
  }
  // Magic bytes: a real PDF starts with "%PDF-".
  if (buffer.slice(0, 5).toString("latin1") !== "%PDF-") {
    return { ok: false, text: "", reason: "That file is not a PDF. Upload a .pdf or paste the text instead." };
  }
  try {
    // Direct lib import avoids pdf-parse/index.js's debug-mode test-file read.
    const mod = await import("pdf-parse/lib/pdf-parse.js");
    const pdf = mod.default || mod;
    const data = await pdf(buffer);
    const text = String(data?.text || "").replace(/\u0000/g, "").trim();
    if (text.length < MIN_USEFUL_CHARS) {
      return {
        ok: false,
        text: "",
        reason: "Couldn't extract usable text — this PDF is likely scanned images or encrypted. Paste the text instead."
      };
    }
    return { ok: true, text, pages: Number.isFinite(data?.numpages) ? data.numpages : null };
  } catch {
    return {
      ok: false,
      text: "",
      reason: "This PDF couldn't be read (it may be encrypted or corrupted). Paste the text instead."
    };
  }
}

/**
 * Structures raw sourcebook text into review candidates via the utility LLM.
 * Never throws; degrades to { ok:false, reason } so the caller can show a
 * "try manual entry" message. `options.generate` is injectable for tests.
 * @param {string} text
 * @param {{generate?: Function, campaignId?: string, timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, candidates: object, reason?: string, count?: number}>}
 */
export async function parseSourcebookText(text, options = {}) {
  const source = String(text || "").trim();
  if (source.length < MIN_USEFUL_CHARS) {
    return {
      ok: false,
      candidates: emptyCandidates(),
      reason: "Not enough text to parse. Paste a section of the book (e.g. a races or subclasses chapter), or add content manually."
    };
  }
  const generate = typeof options.generate === "function" ? options.generate : generateUtility;
  try {
    const result = await withTimeout(
      generate(buildMessages(source), options.campaignId || "homebrew", {
        temperature: 0.2,
        maxResponseTokens: 1500
      }),
      options.timeoutMs || PARSE_TIMEOUT_MS
    );
    const parsed = parseJsonObject(result?.content);
    if (parsed) {
      const candidates = normalizeCandidates(parsed);
      const count = candidateCount(candidates);
      if (count > 0) {
        return { ok: true, candidates, count };
      }
    }
    return {
      ok: false,
      candidates: emptyCandidates(),
      reason: "Couldn't find recognizable races, subclasses, backgrounds, or feats in that text. Try pasting a more specific section, or add content manually."
    };
  } catch {
    return {
      ok: false,
      candidates: emptyCandidates(),
      reason: "Parsing failed or timed out. Try a smaller section of the book, or add content manually."
    };
  }
}
