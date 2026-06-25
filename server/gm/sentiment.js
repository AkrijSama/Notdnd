// Lightweight, dependency-free keyword sentiment classifier.
//
// Extracted from autoMemory.js so it can be reused by the solo dialogue
// expression mapper without pulling the heavy memory-pipeline module graph
// (openrouter / repository / memoryStore) into the solo request path.
// autoMemory.js re-imports from here so there is a single source of truth.

/**
 * Classifies free text as a coarse sentiment bucket.
 * @param {string} text
 * @returns {"positive" | "negative" | "neutral"}
 */
export function detectSentiment(text = "") {
  const lower = String(text || "").toLowerCase();
  if (/\b(trust|allied|friend|helped|saved|grateful|bond)\b/.test(lower)) {
    return "positive";
  }
  if (/\b(hostile|hate|threat|betray|suspicious|angry|fear)\b/.test(lower)) {
    return "negative";
  }
  return "neutral";
}
