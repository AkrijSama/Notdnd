// THE DRAFT ENGINE — interview answers + spark → structured world drafts.
//
// The house rule for LLM content (server/gm/attemptInterpreter.js): coerce/repair →
// strict-validate → on failure re-ask ONCE → still-invalid → deterministic fallback.
// AI/user content only ever FILLS tables; the engine's mints (server/campaign/worldBook.js)
// enforce every law downstream — the age wall, orientation, budgets, the front cap. A
// draft is NEVER trusted raw and can never inject committed authority.
//
// Provider-agnostic: `provider` is an injected async closure with the SAME contract as
// openrouter.generateUtility —
//     async ({ messages, kind, campaignId }) => { content, model, tokensUsed:{prompt,completion}, cost }
// Tests inject a fake closure; the live route injects a thin generateUtility adapter.
// ZERO real LLM calls happen in this module.
//
// Cost discipline: ONE call per draft, ONE per twist, and compilation is deterministic
// (zero calls). Every call is recorded on a per-session cost ledger, printed to the log.

import { DEFAULT_THREAT_LADDER, DEFAULT_NAME_BANKS, slugify } from "./worldBook.js";
import { interviewAnswers } from "./worldInterview.js";

export const WORLD_DRAFT_VERSION = 1;

// v1 draft table sizes (the review surface renders these as cards).
export const DRAFT_POI_MIN = 12;
export const DRAFT_POI_MAX = 16;
export const DRAFT_FACTION_MIN = 3;
export const DRAFT_FACTION_MAX = 4;
export const DRAFT_THREAT_MIN = 4;
export const DRAFT_THREAT_MAX = 6;

// ── COST LEDGER ──────────────────────────────────────────────────────────────

// Flash/utility-tier estimate (USD per 1M tokens) — used only when the provider
// return carries no real cost (mock/free tiers). Conservative Gemini-flash pricing.
export const FLASH_PRICING = Object.freeze({ promptPer1M: 0.30, completionPer1M: 2.50 });
export const CREATION_BUDGET_USD = 0.15; // a full creation session must estimate under this

export function estimateCostUsd(tokensUsed = {}, pricing = FLASH_PRICING) {
  const p = Number(tokensUsed.prompt) || 0;
  const c = Number(tokensUsed.completion) || 0;
  return (p / 1e6) * pricing.promptPer1M + (c / 1e6) * pricing.completionPer1M;
}

/**
 * A per-session cost ledger. Records one row per provider call (draft/twist), sums
 * tokens + cost, and formats a printable line for the session log.
 */
export function createCostLedger({ label = "world-creation", pricing = FLASH_PRICING } = {}) {
  const calls = [];
  return {
    label,
    calls,
    record({ kind = "call", model = "?", tokensUsed = {}, cost } = {}) {
      const promptTokens = Number(tokensUsed.prompt) || 0;
      const completionTokens = Number(tokensUsed.completion) || 0;
      const costUsd = Number.isFinite(cost) && cost > 0 ? Number(cost) : estimateCostUsd({ prompt: promptTokens, completion: completionTokens }, pricing);
      const row = { kind, model, promptTokens, completionTokens, costUsd, estimated: !(Number.isFinite(cost) && cost > 0) };
      calls.push(row);
      return row;
    },
    totals() {
      return calls.reduce((t, r) => ({
        calls: t.calls + 1,
        promptTokens: t.promptTokens + r.promptTokens,
        completionTokens: t.completionTokens + r.completionTokens,
        costUsd: t.costUsd + r.costUsd
      }), { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 });
    },
    underBudget(max = CREATION_BUDGET_USD) { return this.totals().costUsd <= max; },
    format() {
      const t = this.totals();
      const byKind = {};
      for (const r of calls) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
      const kinds = Object.entries(byKind).map(([k, n]) => `${k}×${n}`).join(" ");
      return `[${label}] ${t.calls} calls (${kinds}) · ${t.promptTokens}+${t.completionTokens} tok · $${t.costUsd.toFixed(4)}` +
        ` (${this.underBudget() ? "under" : "OVER"} $${CREATION_BUDGET_USD.toFixed(2)} budget)`;
    },
    print(logFn = console.warn) { try { logFn(this.format()); } catch { /* best-effort */ } }
  };
}

// ── JSON extraction + coercion (never trust raw) ─────────────────────────────

// Tolerate ```json fences + leading/trailing prose: grab the first { … last }.
export function extractJsonObject(text) {
  if (text && typeof text === "object") return text;
  const s = String(text || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

function isNonEmptyString(v) { return typeof v === "string" && v.trim().length > 0; }
function str(v, fallback = "") { return isNonEmptyString(v) ? v.trim() : fallback; }
function clampDanger(v) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(0, Math.min(4, n)) : 1; }

// Coerce a parsed provider object into the canonical draft shape. Drops junk, clamps
// counts + ranges, backfills required strings. This is the REPAIR step.
export function coerceDraft(parsed, { answers = {}, spark = "" } = {}) {
  if (!parsed || typeof parsed !== "object") return null;
  const identity = parsed.identity && typeof parsed.identity === "object" ? parsed.identity : {};
  const pois = (Array.isArray(parsed.pois) ? parsed.pois : Array.isArray(parsed.poiTable) ? parsed.poiTable : [])
    .filter((p) => p && isNonEmptyString(p.name))
    .slice(0, DRAFT_POI_MAX)
    .map((p, i) => ({
      id: `poi_${slugify(p.name, `p${i}`)}`,
      name: str(p.name),
      poiClass: str(p.poiClass || p.class, "place"),
      description: str(p.description, `${str(p.name)} — a place in this world.`),
      dangerLevel: clampDanger(p.dangerLevel)
    }));
  const factions = (Array.isArray(parsed.factions) ? parsed.factions : [])
    .filter((f) => f && isNonEmptyString(f.name))
    .slice(0, DRAFT_FACTION_MAX)
    .map((f, i) => ({
      id: `faction_${slugify(f.name, `f${i}`)}`,
      name: str(f.name),
      disposition: str(f.disposition, "neutral"),
      wants: str(f.wants || f.agenda, "to hold what they have")
    }));
  const threatLadder = (Array.isArray(parsed.threatLadder) ? parsed.threatLadder : Array.isArray(parsed.threats) ? parsed.threats : [])
    .map((t) => (typeof t === "string" ? { rung: t } : t))
    .filter((t) => t && isNonEmptyString(t.rung || t.name))
    .slice(0, DRAFT_THREAT_MAX)
    .map((t, i) => ({ id: `threat_${i}`, rung: str(t.rung || t.name), rarity: str(t.rarity, i === 0 ? "common" : "uncommon") }));

  const draft = {
    version: WORLD_DRAFT_VERSION,
    identity: {
      name: str(identity.name, answers.region || ""),
      tagline: str(identity.tagline, spark),
      era: str(identity.era),
      tone: str(identity.tone)
    },
    cosmology: str(parsed.cosmology || parsed.canon, answers.remnant || spark),
    signatureDanger: parsed.signatureDanger && typeof parsed.signatureDanger === "object"
      ? { name: str(parsed.signatureDanger.name, answers.signature || ""), description: str(parsed.signatureDanger.description) }
      : { name: str(answers.signature || ""), description: "" },
    pois, factions, threatLadder
  };
  return draft;
}

// A draft is usable if it has a name and non-empty tables. (Repair usually makes it so;
// this gates whether we accept, re-ask, or fall back.)
export function validateDraft(draft) {
  const errors = [];
  if (!draft || typeof draft !== "object") return { ok: false, errors: [{ path: "draft", message: "not an object" }] };
  if (!isNonEmptyString(draft.identity?.name)) errors.push({ path: "identity.name", message: "missing world/region name" });
  if (!Array.isArray(draft.pois) || draft.pois.length < 1) errors.push({ path: "pois", message: "no POIs" });
  if (!Array.isArray(draft.factions)) errors.push({ path: "factions", message: "factions not an array" });
  if (!Array.isArray(draft.threatLadder)) errors.push({ path: "threatLadder", message: "threatLadder not an array" });
  return { ok: errors.length === 0, errors };
}

// ── deterministic fallback (from the human answers, no provider) ──────────────

function splitList(value) {
  return String(value || "")
    .split(/[,;\n]|→|->|\band\b/gi)
    .map((s) => s.replace(/^\s*[-•\d.]+\s*/, "").trim())
    .filter(Boolean);
}

// Build a coherent, thin draft straight from the interview answers + spark — the
// safety net when the provider is unusable. The engine still mints laws downstream.
export function fallbackDraft({ answers = {}, spark = "" } = {}) {
  const name = str(answers.region, "") || str(spark.split(/[,.]/)[0], "The Reach").slice(0, 40);
  const banks = DEFAULT_NAME_BANKS;
  const landmark = str(answers.landmark);
  const poiSeeds = [
    landmark && { name: landmark, poiClass: "landmark", dangerLevel: 2 },
    ...banks.settlements.map((n) => ({ name: n, poiClass: "settlement", dangerLevel: 0 })),
    ...banks.wilds.map((n) => ({ name: n, poiClass: "wilds", dangerLevel: 2 }))
  ].filter(Boolean).slice(0, DRAFT_POI_MIN);
  const pois = poiSeeds.map((p, i) => ({
    id: `poi_${slugify(p.name, `p${i}`)}`, name: p.name, poiClass: p.poiClass,
    description: `${p.name} — a ${p.poiClass} of ${name}.`, dangerLevel: clampDanger(p.dangerLevel)
  }));

  const factionNames = splitList(answers.powers).slice(0, DRAFT_FACTION_MAX);
  const factions = (factionNames.length ? factionNames : ["The old power", "The rising power", "The hidden power"]).map((n, i) => ({
    id: `faction_${slugify(n, `f${i}`)}`, name: n, disposition: i === 0 ? "friendly-reserved" : i === 1 ? "neutral" : "hostile-secret",
    wants: "to shape what this world becomes"
  }));

  const rungs = splitList(answers.threats).slice(0, DRAFT_THREAT_MAX);
  const threatLadder = (rungs.length ? rungs : Object.keys(DEFAULT_THREAT_LADDER).slice(0, DRAFT_THREAT_MIN)).map((r, i) => ({
    id: `threat_${i}`, rung: r, rarity: i === 0 ? "common" : i < 2 ? "uncommon" : i < 4 ? "rare" : "very-rare"
  }));

  return {
    version: WORLD_DRAFT_VERSION,
    identity: { name, tagline: str(spark), era: "", tone: "" },
    cosmology: str(answers.remnant, spark),
    signatureDanger: { name: str(answers.signature), description: "" },
    pois, factions, threatLadder,
    source: "fallback"
  };
}

// ── the draft prompt ─────────────────────────────────────────────────────────

function draftMessages({ spark, answers }, { correction = "" } = {}) {
  const lines = [
    `SPARK: ${spark || "(none given)"}`,
    answers.landmark ? `LANDMARK: ${answers.landmark}` : "LANDMARK: (invent one that fits)",
    answers.remnant ? `WHAT THE OLD WORLD LEFT: ${answers.remnant}` : "WHAT THE OLD WORLD LEFT: (invent)",
    answers.temptation ? `THE TEMPTATION: ${answers.temptation}` : "THE TEMPTATION: (invent)",
    answers.threats ? `THREAT RUNGS: ${answers.threats}` : "THREAT RUNGS: (invent 4-6)",
    answers.signature ? `SIGNATURE DANGER: ${answers.signature}` : "SIGNATURE DANGER: (invent)",
    answers.powers ? `WHO HOLDS POWER: ${answers.powers}` : "WHO HOLDS POWER: (invent 3-4 factions)",
    answers.region ? `REGION NAME: ${answers.region}` : "REGION NAME: (name it)"
  ];
  const shape = `{"identity":{"name":string,"tagline":string,"era":string,"tone":string},"cosmology":string,"signatureDanger":{"name":string,"description":string},"pois":[{"name":string,"poiClass":string,"description":string,"dangerLevel":0-4}],"factions":[{"name":string,"disposition":string,"wants":string}],"threatLadder":[{"rung":string,"rarity":string}]}`;
  const system = [
    "You are a world-building partner drafting a playable tabletop world from a few answers.",
    `Return JSON ONLY (no prose, no code fences) with EXACTLY this shape: ${shape}`,
    `Draft ${DRAFT_POI_MIN}-${DRAFT_POI_MAX} pois, ${DRAFT_FACTION_MIN}-${DRAFT_FACTION_MAX} factions, ${DRAFT_THREAT_MIN}-${DRAFT_THREAT_MAX} threat rungs (weakest first).`,
    "Be concrete and evocative and consistent with the answers. Never include stats, rules, or player-authority.",
    correction ? `CORRECTION: your previous reply was unusable (${correction}). Return valid JSON in the exact shape.` : ""
  ].filter(Boolean).join(" ");
  return [
    { role: "system", content: system },
    { role: "user", content: lines.join("\n") }
  ];
}

/**
 * Produce a world DRAFT from an interview. ONE provider call (plus at most ONE retry on
 * unusable output), then a deterministic fallback. Records cost on the ledger.
 *
 * @returns {Promise<{ draft, source: "provider"|"repaired"|"fallback", raw? }>}
 */
export async function draftWorld({ interview, provider, ledger, campaignId = null } = {}) {
  const view = foldAnswers(interview);
  const call = async (opts) => {
    const messages = draftMessages(view, opts);
    const res = await provider({ messages, kind: "draft", campaignId });
    ledger?.record({ kind: opts?.correction ? "draft-retry" : "draft", model: res?.model, tokensUsed: res?.tokensUsed, cost: res?.cost });
    return res;
  };

  let raw = null;
  try {
    const res = await call({});
    raw = res?.content;
    let draft = coerceDraft(extractJsonObject(res?.content), view);
    if (validateDraft(draft).ok) return { draft: { ...draft, source: "provider" }, source: "provider", raw };
    // one bounded re-ask through the same pipeline
    const retry = await call({ correction: "missing name or empty tables" });
    raw = retry?.content;
    draft = coerceDraft(extractJsonObject(retry?.content), view);
    if (validateDraft(draft).ok) return { draft: { ...draft, source: "repaired" }, source: "repaired", raw };
  } catch (err) {
    // provider threw / timed out — fall through to the deterministic net.
    raw = raw || String(err?.message || err);
  }
  return { draft: fallbackDraft(view), source: "fallback", raw };
}

// interview → { spark, answers:{landmark,remnant,temptation,threats,signature,powers,region} }
function foldAnswers(interview) {
  const a = interviewAnswers(interview);
  return {
    spark: a.spark,
    answers: {
      landmark: a.byId.landmark, remnant: a.byId.remnant, temptation: a.byId.temptation,
      threats: a.byId.threats, signature: a.byId.signature, powers: a.byId.powers, region: a.byId.region
    }
  };
}

// ── TWIST: single-card regeneration ──────────────────────────────────────────

function twistMessages({ cardType, card, instruction, context }) {
  const shapes = {
    poi: `{"name":string,"poiClass":string,"description":string,"dangerLevel":0-4}`,
    faction: `{"name":string,"disposition":string,"wants":string}`,
    threat: `{"rung":string,"rarity":string}`
  };
  const system = [
    `You are revising ONE ${cardType} card in a world called "${context?.worldName || "this world"}".`,
    `Return JSON ONLY with EXACTLY this shape: ${shapes[cardType] || shapes.poi}`,
    "Keep it consistent with the world; apply the instruction; change only what's asked."
  ].join(" ");
  const user = `CURRENT: ${JSON.stringify(card)}\nINSTRUCTION: ${instruction || "make it more interesting"}`;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

function coerceCard(cardType, parsed, prev = {}) {
  if (!parsed || typeof parsed !== "object") return null;
  if (cardType === "faction") {
    if (!isNonEmptyString(parsed.name)) return null;
    return { id: prev.id || `faction_${slugify(parsed.name)}`, name: str(parsed.name), disposition: str(parsed.disposition, prev.disposition || "neutral"), wants: str(parsed.wants || parsed.agenda, prev.wants || "") };
  }
  if (cardType === "threat") {
    const rung = parsed.rung || parsed.name;
    if (!isNonEmptyString(rung)) return null;
    return { id: prev.id || `threat_${slugify(rung)}`, rung: str(rung), rarity: str(parsed.rarity, prev.rarity || "uncommon") };
  }
  if (!isNonEmptyString(parsed.name)) return null; // poi
  return { id: prev.id || `poi_${slugify(parsed.name)}`, name: str(parsed.name), poiClass: str(parsed.poiClass || parsed.class, prev.poiClass || "place"), description: str(parsed.description, prev.description || ""), dangerLevel: clampDanger(parsed.dangerLevel ?? prev.dangerLevel) };
}

/**
 * Regenerate a single card from a one-line twist instruction. ONE provider call; on
 * unusable output, returns the previous card with the instruction noted (never blocks
 * the review). Records cost on the ledger.
 */
export async function twistCard({ cardType, card, instruction, context, provider, ledger, campaignId = null } = {}) {
  try {
    const res = await provider({ messages: twistMessages({ cardType, card, instruction, context }), kind: "twist", campaignId });
    ledger?.record({ kind: "twist", model: res?.model, tokensUsed: res?.tokensUsed, cost: res?.cost });
    const next = coerceCard(cardType, extractJsonObject(res?.content), card);
    if (next) return { card: next, source: "provider" };
  } catch { /* fall through */ }
  return { card: { ...card, twistNote: instruction || "" }, source: "unchanged" };
}

// ── KEEP / TWIST / KILL review state (the curation surface) ───────────────────

const REVIEW_SECTIONS = ["pois", "factions", "threatLadder"];

/** Wrap a draft's card tables in review state (every card defaults to "keep"). Pure. */
export function createReview(draft = {}) {
  const wrap = (list) => (Array.isArray(list) ? list : []).map((c) => ({ ...c, status: "keep" }));
  return {
    identity: draft.identity || {},
    cosmology: draft.cosmology || "",
    signatureDanger: draft.signatureDanger || {},
    pois: wrap(draft.pois),
    factions: wrap(draft.factions),
    threatLadder: wrap(draft.threatLadder)
  };
}

function mapSection(review, section, id, fn) {
  if (!REVIEW_SECTIONS.includes(section)) return review;
  return { ...review, [section]: review[section].map((c) => (c.id === id ? fn(c) : c)) };
}
export function keepCard(review, section, id) { return mapSection(review, section, id, (c) => ({ ...c, status: "keep" })); }
export function killCard(review, section, id) { return mapSection(review, section, id, (c) => ({ ...c, status: "killed" })); }
export function replaceCard(review, section, id, next) { return mapSection(review, section, id, (c) => ({ ...next, id: c.id, status: "keep" })); }

/** Collapse review state back into a curated draft — killed cards drop out. */
export function reviewToDraft(review) {
  const kept = (list) => (Array.isArray(list) ? list : []).filter((c) => c.status !== "killed").map(({ status, twistNote, ...c }) => c);
  return {
    version: WORLD_DRAFT_VERSION,
    identity: review.identity || {},
    cosmology: review.cosmology || "",
    signatureDanger: review.signatureDanger || {},
    pois: kept(review.pois),
    factions: kept(review.factions),
    threatLadder: kept(review.threatLadder)
  };
}

// ── ASSEMBLE: curated draft + interview → a world-book ────────────────────────

/**
 * Deterministically assemble a world-book from a curated draft + the interview + the
 * optional defaults-drawer overrides. NO provider call (compilation is free). The
 * result is a world-book; run it through worldBook.compileWorldBook() to get a scenario.
 */
export function assembleWorldBook({ draft = {}, interview, overrides = {} } = {}) {
  const view = interview ? foldAnswers(interview) : { spark: "", answers: {} };
  const name = str(draft.identity?.name) || str(view.answers.region) || str(overrides.name) || "An Unnamed World";
  const threatLadder = {};
  for (const t of Array.isArray(draft.threatLadder) ? draft.threatLadder : []) {
    if (isNonEmptyString(t.rung)) threatLadder[slugify(t.rung)] = str(t.rarity, "uncommon");
  }
  const book = {
    schemaVersion: 1,
    name,
    vibe: str(view.spark),
    identity: {
      name,
      tagline: str(draft.identity?.tagline) || str(view.spark),
      era: str(overrides.era) || str(draft.identity?.era),
      tone: str(overrides.tone) || str(draft.identity?.tone),
      genre: str(overrides.genre)
    },
    cosmology: str(draft.cosmology) || str(view.answers.remnant),
    pois: Array.isArray(draft.pois) ? draft.pois : [],
    factions: (Array.isArray(draft.factions) ? draft.factions : []).map((f) => ({
      factionId: f.id || `faction_${slugify(f.name)}`, name: f.name, disposition: f.disposition, standing: 0, discovered: false, wants: f.wants
    })),
    threatLadder: Object.keys(threatLadder).length ? threatLadder : undefined,
    nameBanks: draft.nameBanks || undefined
  };
  if (overrides.orientationMix) book.orientationMix = overrides.orientationMix;
  if (overrides.deathLaw) book.deathLaw = overrides.deathLaw;
  if (isNonEmptyString(overrides.artStyle)) book.world = { artStyle: overrides.artStyle };
  // normalizeWorldBook fills any remaining gaps; we keep the raw book (compileWorldBook
  // normalizes again) so overrides/defaults stay visible to callers/tests.
  return book;
}
