// ---------------------------------------------------------------------------
// FRIDGE-TASTER VISION ASSESSOR — the taster's actual BRAIN.
//
// server/solo/fridgeTaster.js ships with a deterministic zero-cost MOCK that can
// only read the assembled prompt (a proxy). This module is the real adapter: it
// looks at the PIXELS and answers the same CANON_QUESTIONS, so the biplane class
// of defect (a validated recipe that paints the wrong thing) is caught by sight
// rather than inferred from text.
//
// MODEL — google/gemini-2.5-flash-lite (owner-selected 2026-07-21):
//   $0.10 / M input tokens, $0.40 / M output tokens (OpenRouter live pricing).
//   Chosen over the marginally cheaper gpt-5-nano ($0.05/$0.40) because the nano
//   tier is REASONING-class and spends hidden reasoning tokens — the exact cost
//   unpredictability that burned the GM lane (see the v4-flash collapse note in
//   .env). flash-lite is non-reasoning, has reliable strict-JSON structured
//   output, and at our volume the price gap is < $0.001.
//   Measured working cost: ~$0.00025 per image (~1600 image+prompt tokens in,
//   ~150 out). See docs/design/fridge-taster.md for the ledger.
//
// THE FENCE HOLDS. This module registers NOTHING on import. A paid call happens
// only when the owner sets NOTDND_TASTER_MODEL to this model id AND something
// calls registerVisionAssessor(). Seat unset => fridgeTaster keeps using the mock.
// ---------------------------------------------------------------------------

import { registerAssessor, CANON_QUESTIONS } from "../solo/fridgeTaster.js";
import { createCostLedger, extractJsonObject } from "../campaign/worldDraft.js";

export const TASTER_VISION_MODEL = "google/gemini-2.5-flash-lite";

// $ per MILLION tokens (OpenRouter, verified live 2026-07-21).
export const TASTER_VISION_PRICING = Object.freeze({ promptPerM: 0.1, completionPerM: 0.4 });

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export function estimateVisionCostUsd({ prompt = 0, completion = 0 } = {}) {
  return (
    (Number(prompt) || 0) * (TASTER_VISION_PRICING.promptPerM / 1e6) +
    (Number(completion) || 0) * (TASTER_VISION_PRICING.completionPerM / 1e6)
  );
}

// The running cost ledger for taster calls (per-image cost, printable). Shared by
// the live intake path and the offline batch tool so one number covers both.
const LEDGER = createCostLedger({
  label: "fridge-taster",
  // createCostLedger's pricing is per-MILLION tokens ({promptPer1M, completionPer1M}).
  pricing: { promptPer1M: TASTER_VISION_PRICING.promptPerM, completionPer1M: TASTER_VISION_PRICING.completionPerM }
});
export function tasterLedger() {
  return LEDGER;
}

function apiKey() {
  return String(process.env.OPENROUTER_API_KEY || "").trim();
}

function dataUrlFor(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!buf.length) throw new Error("taster-vision: no image bytes");
  // Sniff PNG vs JPEG so the data URL mime is honest.
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  const mime = isPng ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

// The questions this kind is judged on (falls back to the portrait set).
function questionsFor(kind) {
  return CANON_QUESTIONS[kind] || CANON_QUESTIONS.portrait;
}

// Build the judge instruction. The model does ONLY what vision can do: describe
// what is actually depicted and answer the canon questions from the pixels. It is
// told explicitly to answer "expected subject present?" as not-applicable when no
// expected subject is known, so a context-less asset is never failed unfairly.
// The committed SETTING, so "no aircraft/vehicles/modern-city UNLESS COMMITTED" is
// actually answerable. Calibration proved this is load-bearing: without it the
// judge passed a fantasy forest scene that depicts train tracks and a power-line
// tower, because it could not know modern infrastructure was uncommitted.
// Every shipped world is pre-modern fantasy (there is still no `era` world field —
// see the ERA world-data gap), so that is the strict default.
export const DEFAULT_SETTING_ERA =
  "pre-modern high fantasy — NO aircraft, cars, trains, railways, power lines, " +
  "utility poles, modern signage, or modern city infrastructure of any kind";

function settingFor(input) {
  const era = String(input?.settingEra || input?.run?.world?.era || "").trim();
  return era || DEFAULT_SETTING_ERA;
}

function buildMessages({ kind, expectedSubject, declaredSubject, promptUsed, dataUrl, settingEra }) {
  const questions = questionsFor(kind);
  const expected = String(expectedSubject || declaredSubject || "").trim();
  const system = [
    "You are an art QA judge for a fantasy RPG's image library.",
    "Answer ONLY from what is visibly depicted in the image. Never infer from the prompt text.",
    "You are checking whether an image is fit to be reused across future play sessions.",
    "Be strict about canon violations but do NOT invent problems: an ordinary, competent image passes.",
    'If a question cannot be judged (e.g. no expected subject was supplied), set ok=true and note "n/a".',
    "Respond with STRICT JSON only, no prose, no code fences."
  ].join(" ");
  const lines = [
    `IMAGE KIND: ${kind}`,
    `COMMITTED SETTING: ${settingEra}`,
    expected ? `EXPECTED SUBJECT (what this image is supposed to depict): ${expected}` : "EXPECTED SUBJECT: (unknown — treat 'expected subject present?' as n/a)",
    promptUsed ? `GENERATION PROMPT (context only, may itself be wrong — judge the pixels, not this): ${String(promptUsed).slice(0, 400)}` : "",
    "",
    "Answer each CANON QUESTION with ok=true (passes) or ok=false (violation):",
    ...questions.map((q, i) => `  ${i + 1}. ${q}`),
    "",
    // CONDITIONAL-QUESTION LAW — mirrors the mock's subjectIsDeclaredNonHuman gate.
    // Without this the judge marks a wolf ok=false for "human-when-declared-human?"
    // and "clothed?", which would trash every correct animal portrait.
    "IMPORTANT — questions are CONDITIONAL on the declared subject:",
    "  · If the EXPECTED SUBJECT is a non-human (an animal, beast, creature, demon or chaosling),",
    "    then 'human-when-declared-human?' is NOT APPLICABLE — set ok=true, note 'n/a: declared non-human'.",
    "    'clothed?' is likewise NOT APPLICABLE to an animal — set ok=true, note 'n/a: animal'.",
    "    An animal correctly depicted AS that animal is a PASS, not a violation.",
    "  · 'clothed?' fails ONLY on actual nudity of a human/humanoid figure (exposed breasts or genitals).",
    "    Bare arms, shirtless-but-decent, or armour gaps are NOT violations.",
    "  · 'single head?' fails only on a reference/model sheet, multiple views, or a genuine extra head.",
    "",
    "Also report observedSubject: a short factual description of the main subject you actually see (e.g. 'a grey wolf', 'a young woman in a dark shirt', 'a forest clearing at dusk').",
    "",
    'JSON shape: {"observedSubject":"...","checks":[{"question":"<verbatim question>","ok":true,"note":"<short reason>"}],"verdict":"pass"|"suspect","reason":"<one sentence>"}',
    'Set verdict="suspect" if ANY check is ok=false, else "pass".'
  ].filter(Boolean);
  return [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        { type: "text", text: lines.join("\n") },
        { type: "image_url", image_url: { url: dataUrl } }
      ]
    }
  ];
}

const RESPONSE_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "taste_assessment",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["observedSubject", "checks", "verdict", "reason"],
      properties: {
        observedSubject: { type: "string" },
        verdict: { type: "string", enum: ["pass", "suspect"] },
        reason: { type: "string" },
        checks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["question", "ok", "note"],
            properties: {
              question: { type: "string" },
              ok: { type: "boolean" },
              note: { type: "string" }
            }
          }
        }
      }
    }
  }
};

/**
 * The real assessor. Async — resolve it via fridgeTaster.tasteAsync().
 * @param {{id, bytes, kind, run, subjectId, promptUsed, expectedSubject, declaredSubject, fetchImpl}} input
 * @returns {Promise<{verdict, checks, reason, observedSubject, usage, costUsd, model}>}
 */
export async function visionAssess(input = {}) {
  const key = apiKey();
  if (!key) throw new Error("taster-vision: OPENROUTER_API_KEY is not set");
  const kind = String(input.kind || "portrait");
  const dataUrl = dataUrlFor(input.bytes);
  const fetchImpl = input.fetchImpl || fetch;
  const body = {
    model: TASTER_VISION_MODEL,
    messages: buildMessages({ ...input, kind, dataUrl, settingEra: settingFor(input) }),
    response_format: RESPONSE_SCHEMA,
    // Calibration found 600 truncated the JSON mid-string on a descriptive answer
    // (an unparseable response = a false quarantine). Output is billed per token
    // produced, so a generous ceiling costs nothing on short answers.
    max_tokens: 1600,
    temperature: 0
  };
  // One RETRY on an unparseable body. Observed ~3/11 intermittent malformed JSON
  // even with a strict schema and finish_reason=stop; a false "assessor error"
  // quarantines a good image, so a cheap second attempt is worth ~$0.0003.
  let json = null;
  let text = "";
  let parsed = null;
  let lastDiag = "";
  for (let attempt = 1; attempt <= 2 && !parsed; attempt += 1) {
    const res = await fetchImpl(OPENROUTER_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "x-title": "inkborne-fridge-taster"
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`taster-vision: HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
    json = await res.json();
    const choice = json?.choices?.[0];
    text = choice?.message?.content ?? "";
    // Never trust raw: tolerate fences/prose around the object.
    parsed = extractJsonObject(text);
    if (!parsed) {
      lastDiag =
        `finish_reason=${choice?.finish_reason}/${choice?.native_finish_reason} ` +
        `completion_tokens=${json?.usage?.completion_tokens} len=${String(text).length} ` +
        `body=${JSON.stringify(String(text).slice(-400))}`;
    }
  }
  if (!parsed) throw new Error(`taster-vision: unparseable response after 2 attempts — ${lastDiag}`);

  const usage = {
    prompt: Number(json?.usage?.prompt_tokens) || 0,
    completion: Number(json?.usage?.completion_tokens) || 0
  };
  // OpenRouter may return an authoritative cost; else estimate from our pricing.
  const reportedCost = Number(json?.usage?.cost);
  const costUsd = Number.isFinite(reportedCost) && reportedCost > 0 ? reportedCost : estimateVisionCostUsd(usage);
  LEDGER.record({ kind: `taste:${kind}`, model: TASTER_VISION_MODEL, tokensUsed: usage, cost: costUsd });

  const checks = (Array.isArray(parsed.checks) ? parsed.checks : []).map((c) => ({
    question: String(c?.question || ""),
    ok: c?.ok !== false,
    note: String(c?.note || "")
  }));
  const failed = checks.filter((c) => !c.ok);
  // The VERDICT IS DERIVED, not trusted: any failed check means suspect, whatever
  // the model wrote in its verdict field (models sometimes contradict themselves).
  const verdict = failed.length ? "suspect" : parsed.verdict === "suspect" ? "suspect" : "pass";
  return {
    verdict,
    checks,
    reason: failed.length
      ? failed.map((c) => `${c.question} ${c.note}`.trim()).join("; ")
      : String(parsed.reason || "all canon checks passed"),
    observedSubject: String(parsed.observedSubject || ""),
    usage,
    costUsd,
    model: TASTER_VISION_MODEL
  };
}

/**
 * Arm the real assessor. Call this ONCE at boot (or from a batch tool) when the
 * owner has set the seat. Returns the registered model id, or null when the seat
 * is not set to this model / no API key — in which case the mock stays in place.
 */
export function registerVisionAssessor({ force = false } = {}) {
  const seat = String(process.env.NOTDND_TASTER_MODEL || "").trim();
  if (!force && seat !== TASTER_VISION_MODEL) return null;
  if (!apiKey()) {
    // eslint-disable-next-line no-console
    console.error(
      `[fridgeTaster] seat NOTDND_TASTER_MODEL="${seat}" wants the vision assessor but OPENROUTER_API_KEY is unset — staying on the mock (no paid call).`
    );
    return null;
  }
  registerAssessor(TASTER_VISION_MODEL, visionAssess);
  return TASTER_VISION_MODEL;
}
