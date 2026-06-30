// LLM-backed attempt interpreter for LIVE freeform play.
//
// The structured failure-consequence engine (server/solo/attempt.js) is driven
// by an `attemptProviderFn` that proposes the per-attempt mechanics — recommended
// ability, DC, needsCheck, and crucially the structured `failureConsequence`
// (type/amount/condition/targetObject/objectState/retryEffect/reason). In live
// play the request layer historically passed NO provider, so the engine used the
// deterministic defaultProviderOutput, which never proposes a failureConsequence
// — every real failure fell back to the legacy flat HP cost and the
// object-degradation / retry-foreclosure / type:"none" paths were unreachable.
//
// This module produces that structured output from the real GM model (utility
// tier, so it honors the same edition routing + cloud->local fallback as the rest
// of GM play). It is intentionally dependency-light: the prompt builder + parser
// are PURE (unit-testable without the network); only interpretAttemptWithGm makes
// the bounded model call. Every failure path returns null so the engine falls
// back to its sane default — an attempt turn must NEVER crash or block on the
// interpreter.
//
// SEAM (coordination with Opus 2, pre-roll impossibility gate "G"): a pre-roll
// impossibility classification belongs UPSTREAM of this call (in the request
// layer, before resolveSoloAction) — if an action is judged impossible it should
// short-circuit before we ever interpret/roll it. This module only adjudicates
// the mechanics of an action that is allowed to proceed, so the two compose
// cleanly: gate first, then interpret.

import { generateUtility } from "../ai/openrouter.js";
import { FAILURE_CONSEQUENCE_TYPE_VALUES, OBJECT_RETRY_EFFECT_VALUES } from "../solo/attempt.js";

// The exact field set the engine's validator (validateAttemptProviderOutput)
// accepts. A weaker model (local dolphin-8b) routinely adds stray commentary
// fields or omits a required narration string; either makes the strict validator
// reject the whole proposal — which would silently drop us back to the legacy
// flat HP cost. We coerce the model's parsed JSON to this shape FIRST so a
// usable proposal (especially its failureConsequence) survives, while genuinely
// empty output still falls through to the engine default. Object/array shapes
// pass through untouched for the engine to sanitize.
const ALLOWED_OUTPUT_FIELDS = new Set([
  "summary",
  "recommendedAbility",
  "dc",
  "needsCheck",
  "advantage",
  "disadvantage",
  "successNarration",
  "failureNarration",
  "proposedEffects",
  "failureConsequence"
]);

const INTERPRETER_TIMEOUT_MS = 15000;
const INTERPRETER_MAX_TOKENS = 500;

function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function compact(value, max = 600) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Pulls the first JSON object out of a model response (tolerates ```json fences
// and leading/trailing prose). Returns the parsed object, or null when there is
// no parseable object — the caller then falls back.
export function extractJsonObject(text = "") {
  const source = String(text || "").trim();
  if (!source) {
    return null;
  }
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : source;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Pure. Builds the system+user messages for the attempt interpreter from the
// engine's providerInput (buildAttemptProviderInput). The system prompt pins the
// output contract and the PER-CASE consequence discipline; the user message
// carries the compact scene context. No narration, no state mutation — the server
// rolls the dice and enforces the consequence.
export function buildAttemptInterpreterMessages(providerInput) {
  const ctx = (providerInput && typeof providerInput === "object" && providerInput.context) || {};
  const player = ctx.player || {};
  const resources = player.resources || {};
  const hp = resources.hitPoints || resources.hp || null;
  const hpText = hp && (hp.current !== undefined || hp.max !== undefined)
    ? `${hp.current ?? "?"}/${hp.max ?? "?"}`
    : "unknown";
  const target = ctx.targetEntity
    ? `${ctx.targetEntity.displayName || ctx.targetEntity.entityId || "target"}${isString(ctx.targetEntity.kind) ? ` (${ctx.targetEntity.kind})` : ""}`
    : (isString(ctx.targetId) ? ctx.targetId : "none");
  const location = ctx.location || {};

  const typeValues = FAILURE_CONSEQUENCE_TYPE_VALUES.join(" | ");
  const retryValues = OBJECT_RETRY_EFFECT_VALUES.join(" | ");

  const system = [
    "You are the RULES ADJUDICATOR for a solo 5e-style tabletop RPG. The player declares an action; you decide ONLY the mechanics.",
    "You do NOT narrate the story, you do NOT change game state, and you do NOT roll dice — the server rolls the check and enforces what you propose.",
    "",
    "Return ONE JSON object and NOTHING else (no prose, no markdown fences, no tables, no 'SYSTEM:'/'USER:' text). Use ONLY these fields:",
    "{",
    '  "summary": string,            // one short neutral line: what is being attempted',
    '  "recommendedAbility": string|null,  // a 5e ability or skill (e.g. "strength","stealth","perception","persuasion"), or null',
    '  "dc": number|null,            // 5..25 difficulty for the check, or null to let the server choose',
    '  "needsCheck": boolean,        // true only for genuinely uncertain/contested actions; false for trivial/no-stakes ones',
    '  "advantage": boolean,',
    '  "disadvantage": boolean,',
    '  "successNarration": string,   // 1 sentence, what success looks like (the live GM rewrites this — keep it short)',
    '  "failureNarration": string,   // 1 sentence, what failure looks like; MUST agree with failureConsequence.reason',
    `  "failureConsequence": {       // the SINGLE consequence that best fits a FAILURE of this action`,
    `    "type": ${typeValues},`,
    '    "amount": number|null,      // for "damage" (1-6 typical) or "resource"',
    '    "condition": string|null,   // for "condition", e.g. "frightened","prone","poisoned"',
    '    "targetObject": string|null,// for "objectState": the object that degrades (e.g. "the rusted lock","the old map")',
    '    "objectState": string|null, // for "objectState": its new broken state (e.g. "jammed","torn")',
    `    "retryEffect": ${retryValues},  // for "objectState": "blocked" forecloses retrying it; "harder" raises the bar; "none" leaves it open`,
    '    "reason": string|null       // short justification, consistent with failureNarration',
    "  }",
    "}",
    "",
    "PER-CASE INTEGRITY — this is the whole point. Do NOT reflexively punish every failure:",
    '- type "none" is valid and COMMON. A failed perception in an empty room, a failed recall, a clumsy-but-harmless try → {"type":"none"}. No cost.',
    '- Use "damage" only when failing plausibly hurts the body (a fall, a trap, a backlash). Keep amounts small (1-6).',
    '- Use "condition" when failure imposes a status (frightened after a horror, prone after a slip).',
    '- Use "objectState" when failure DEGRADES a physical thing the action acted on, AND retrying the same thing should change: set retryEffect "blocked" (it cannot be done that way again — a torn map, a snapped key) or "harder" (a jammed lock). Leave retryEffect "none" if re-attempting should stay open.',
    '- Use "resource" for a non-HP cost (spent charges, a dropped torch).',
    "Choose the ONE consequence that best fits the fiction. When in doubt, prefer \"none\" over an unearned cost.",
    "Match failureConsequence.reason to failureNarration so the prose and the mechanics can never disagree."
  ].join("\n");

  const user = [
    `Action (player intent): ${compact(ctx.intent, 400) || "an action"}`,
    `Target: ${target}`,
    `Location: ${isString(location.name) ? location.name : "unknown"}${isString(location.description) ? ` — ${compact(location.description, 300)}` : ""}`,
    `Player HP: ${hpText}`,
    "",
    "Adjudicate this attempt. Respond with the single JSON object only."
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

// Pure. Coerces a model's parsed JSON into the engine's accepted output shape:
// drops unknown fields and guarantees the three required narration strings are
// present (filled from the intent when the model omitted them), so a usable
// proposal — above all its structured failureConsequence — isn't rejected
// wholesale by a weak model's stray/missing fields. Returns null when there is no
// usable signal at all (so the engine falls back to its own default). The engine
// still re-validates + sanitizes whatever we return; this only widens what
// survives, never bypasses enforcement.
export function coerceInterpreterOutput(parsed, context = {}) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const intent = isString(context.intent) ? context.intent.trim() : "the action";
  const out = {};
  for (const key of Object.keys(parsed)) {
    if (ALLOWED_OUTPUT_FIELDS.has(key)) {
      out[key] = parsed[key];
    }
  }
  // A proposal is only worth forwarding if the model gave us SOMETHING actionable
  // (a consequence, a DC, an ability, or a narration). Otherwise let the engine
  // default stand rather than fabricating a full proposal from nothing.
  const hasSignal =
    out.failureConsequence !== undefined ||
    out.dc !== undefined ||
    out.recommendedAbility !== undefined ||
    isString(out.summary) ||
    isString(out.successNarration) ||
    isString(out.failureNarration) ||
    out.needsCheck !== undefined;
  if (!hasSignal) {
    return null;
  }
  // Fill the three required strings so the engine validator accepts the proposal;
  // the live GM narration call rewrites these afterward, so they only need to be
  // valid, not polished.
  if (!isString(out.summary)) {
    out.summary = `You attempt: ${intent}`;
  }
  if (!isString(out.successNarration)) {
    out.successNarration = `You ${intent}, and it works.`;
  }
  if (!isString(out.failureNarration)) {
    const reason = out.failureConsequence && isString(out.failureConsequence.reason)
      ? out.failureConsequence.reason
      : "it doesn't come together";
    out.failureNarration = `You try to ${intent}, but ${reason}.`;
  }
  if (!Array.isArray(out.proposedEffects)) {
    out.proposedEffects = [];
  }
  return out;
}

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
  });
  return Promise.race([
    Promise.resolve(promise).then(
      (value) => {
        if (timer) clearTimeout(timer);
        return value;
      },
      () => {
        if (timer) clearTimeout(timer);
        return null;
      }
    ),
    timeout
  ]);
}

// Calls the GM (utility tier, edition-routed with cloud->local fallback) to
// produce the structured attempt output for a LIVE attempt. Returns the parsed
// object on success, or null on any failure (empty/timeout/unparseable) — the
// engine then validates it and, on null/invalid, falls back to its sane default.
// Never throws.
export async function interpretAttemptWithGm({ providerInput, campaignId, edition = "mainline", actorUserId } = {}) {
  if (!providerInput || providerInput.ok !== true || !isString(campaignId)) {
    return null;
  }
  try {
    const messages = buildAttemptInterpreterMessages(providerInput);
    const result = await withTimeout(
      generateUtility(messages, campaignId, {
        edition,
        actorUserId,
        temperature: 0.2,
        maxResponseTokens: INTERPRETER_MAX_TOKENS
      }),
      INTERPRETER_TIMEOUT_MS
    );
    const content = result && typeof result.content === "string" ? result.content : "";
    const parsed = extractJsonObject(content);
    return coerceInterpreterOutput(parsed, providerInput.context || {});
  } catch {
    return null;
  }
}
