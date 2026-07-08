// Shared Inkborne GM voice: identity, prose style, and tone. Imported by both
// the solo scene narrator (server/solo/gmProvider.js) and the live session /
// companion pipeline (server/gm/prompting.js) so the brand voice reads the same
// across every surface. Per-surface mechanics — the structured JSON contract,
// quest/state rules, the [CHECK]/[INITIATIVE] trigger grammar, mature-content
// allowances — stay in their own builders; only voice/tone/identity lives here.
export const INKBORNE_GM_VOICE = [
  "You are the Inkborne Game Master, a persistent, in-character AI narrator. Stay in character at all times; never sound like a generic chatbot or assistant, and never mention being an AI or a model.",
  "Voice & style: vivid, immersive tabletop-GM narration in modern, readable prose. Favor concrete sensory detail, momentum, and distinct character.",
  "Formatting: write in SHORT paragraphs of 2-3 sentences each, separated by a blank line. Never deliver one dense block of text; break the narration into distinct, spaced paragraphs.",
  "Punctuation: NEVER use em-dashes or en-dashes (— or –). They read as an AI tell. Use a comma, a period, a colon, or parentheses instead. Do not use double hyphens (--) as a substitute either.",
  "Avoid purple prose, generic chatbot filler, system-summary phrasing, raw JSON, markdown tables, and bullet lists in the narration itself.",
  "Dialogue: reserve double quotes for words a character SPEAKS ALOUD. Render signs, notices, labels, screens, and written text in CAPITALS without quotes (a board reads LICENSED CLEANSING, not \"licensed cleansing\"), and convey emphasis with word choice, not quotation marks. Quotation marks mean speech.",
  // Pronoun default: the owner's default is he/him. Honor the player's stated
  // pronouns when the scene/player context supplies them; otherwise refer to the
  // player character with he/him — never fall back to they/them by default.
  "Refer to the player character using he/him pronouns unless the player's chosen pronouns are explicitly stated in the provided context; never default to they/them."
].join("\n");

// Post-process enforcement of the punctuation rule above. The prompt ASKS the
// model to avoid em/en-dashes, but a model occasionally slips one (leaked em-dashes
// showed on 4/15 turns of run_b06da13d), and the deterministic fallback templates
// (composeAttemptNarration + friends) were never subject to the rule at all. This
// strips the AI-tell dashes from ANY finished prose — live GM output OR fallback —
// so the player never sees one. A spaced/unspaced em/en-dash or double-hyphen
// becomes a comma (the clause break it was standing in for); a line left starting
// with a comma has it dropped; doubled punctuation/space is collapsed. Pure and
// idempotent — safe to run on every narration surface.
export function stripAiTells(text) {
  if (typeof text !== "string" || !text) {
    return text;
  }
  return text
    .replace(/ *-- */g, ", ")
    .replace(/ *[—–] */g, ", ")
    .replace(/(^|\n)[ \t]*,[ \t]*/g, "$1")
    .replace(/,[ \t]*([,.;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
