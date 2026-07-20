// FACT SELECTION v1 (product-thesis wiring, 2026-07-20).
//
// The committed-fact "librarian" was `memoryFacts.slice(-10)` — pure recency. At
// session depth that silently evicts an old, emotionally-loaded fact (a promise, a
// death, a betrayal) the moment ten newer facts land. This module scores a fact pool
// by IMPORTANCE × recency and returns the top-K, so a durable high-stakes fact floats
// over ten recent low-stakes ones. RELEVANCE (scene/entity overlap) is applied by the
// caller as a pre-gate (getRelevantMemoryFacts) so this stays a pure, testable ranker.
//
// Importance v1 is a deterministic heuristic: it reads a fact's stamped `importance`
// slot when present (stamped at commit for player facts), else derives it from the
// fact's type/tags/text. LLM-scored poignancy is the ledgered v2.

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

// High-drama classes — the facts a campaign is REMEMBERED by.
const HIGH_DRAMA_RE = /\b(death|died|dead|kill|killed|slain|slay|slew|betray|betrayed|betrayal|promise|promised|swore|sworn|vow|vowed|oath|debt|owed?|marriage|married|wed|sacrifice[d]?|revenge|avenge[d]?|spared?)\b/;
// Mid-drama — arc-bearing state (goals, factions, threats, reveals).
const MID_DRAMA_RE = /\b(quest|goal|ambition|faction|ally|allied|rival|enemy|threat|reveal|revealed|secret|deal|bargain|bounty|wanted|hostile|defeated|fled)\b/;
// Low-drama — ambient/observational colour.
const LOW_DRAMA_RE = /\b(weather|breeze|wind|sky|cloud|clouds|rain|sunlight|warmth|chill|scenery|ambient|smell|scent|birdsong|dust|quiet|calm|still)\b/;

/**
 * A deterministic importance score in [0,1] for a committed fact. A stamped
 * `importance` wins (v2 poignancy overwrites this same slot); otherwise derive from
 * type/tags/text. Pure; never throws.
 */
export function importanceOf(fact) {
  if (!fact || typeof fact !== "object") return 0;
  if (Number.isFinite(fact.importance)) return clamp01(fact.importance);
  const type = String(fact.type || "").toLowerCase();
  const tags = Array.isArray(fact.tags) ? fact.tags.map((t) => String(t).toLowerCase()) : [];
  const text = String(fact.text || "").toLowerCase();
  const hay = `${type} ${tags.join(" ")} ${text}`;
  if (type === "combat_outcome" || HIGH_DRAMA_RE.test(hay)) return 1;
  if (
    type === "thread_beat" ||
    tags.includes("thread") || tags.includes("quest") || tags.includes("goal") || tags.includes("faction") ||
    MID_DRAMA_RE.test(hay)
  ) {
    return 0.7;
  }
  if (type === "observation" || LOW_DRAMA_RE.test(hay)) return 0.15;
  return 0.4; // unclassified — mid-low
}

// Importance weighted ABOVE recency so a max-importance old fact always outranks a
// min-importance recent one (1.2 * 1.0 > 0.5 * 1.0 + 1.2 * 0.15).
const IMPORTANCE_WEIGHT = 1.2;
const RECENCY_WEIGHT = 0.5;

/**
 * Rank an (already policy-/relevance-gated) fact pool by importance × recency and
 * return the top `limit`, restored to chronological (append) order for the prompt,
 * deduped by normalized text. A pool at or under the limit is returned unchanged
 * (no need to rank), preserving the pre-existing small-pool behaviour.
 * @param {Array} pool facts in append (chronological) order
 * @param {number} limit max facts to return
 */
export function rankFactsByImportance(pool, limit = 10) {
  if (!Array.isArray(pool)) return [];
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 10;
  if (pool.length <= cap) return dedupeByText(pool);
  const n = pool.length;
  const ranked = pool
    .map((fact, i) => ({
      fact,
      i,
      score: IMPORTANCE_WEIGHT * importanceOf(fact) + RECENCY_WEIGHT * (n > 1 ? i / (n - 1) : 1)
    }))
    .sort((a, b) => (b.score - a.score) || (b.i - a.i)) // ties → newer wins
    .slice(0, cap)
    .sort((a, b) => a.i - b.i) // restore chronological order for the reader
    .map((s) => s.fact);
  return dedupeByText(ranked);
}

function dedupeByText(facts) {
  const seen = new Set();
  const out = [];
  for (const f of Array.isArray(facts) ? facts : []) {
    const key = String(f?.text || "").trim().toLowerCase();
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(f);
  }
  return out;
}
