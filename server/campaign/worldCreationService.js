// WORLD-CREATION SERVICE — the glue between the HTTP routes and the pure engine.
//
// Holds the two things the pure modules deliberately don't: the live provider
// resolution (a lazy generateUtility adapter, so tests never load openrouter.js) and
// the per-session cost ledgers (keyed by a client creationId, printed to the log). The
// engine (worldDraft.js) + schema (worldBook.js) do all the real work; this only wires
// them to a provider + persistence.
//
// TEST SEAM: setWorldDraftProviderForTests(fn) injects a mock provider so the whole
// route→engine→save→run path is exercisable with ZERO real LLM calls.

import crypto from "node:crypto";
import { draftWorld, twistCard, assembleWorldBook, reviewToDraft, createCostLedger } from "./worldDraft.js";
import { compileWorldBook, validateWorldBook } from "./worldBook.js";
import { addUserWorld, listUserWorlds, deleteUserWorld } from "../db/repository.js";

let __testProvider = null;
/** Inject a mock draft provider (tests). Pass null to restore the live path. */
export function setWorldDraftProviderForTests(fn) { __testProvider = typeof fn === "function" ? fn : null; }

// The live provider: the cheap structured (utility/flash) tier, reasoning off. Lazily
// imported so a test with an injected provider never pulls the openrouter module.
async function liveProvider({ messages, campaignId }) {
  const { generateUtility } = await import("../ai/openrouter.js");
  const res = await generateUtility(messages, campaignId || null, { reasoning: { enabled: false } });
  return { content: res?.content, model: res?.model, tokensUsed: res?.tokensUsed, cost: res?.cost };
}
function resolveProvider() { return __testProvider || liveProvider; }

// Per-creation-session ledgers (best-effort, in-memory; drop on restart).
const ledgers = new Map();
function ledgerFor(creationId) {
  const id = String(creationId || "anon");
  if (!ledgers.has(id)) ledgers.set(id, createCostLedger({ label: `world-creation:${id}` }));
  return ledgers.get(id);
}

/** Draft the world tables from an interview (ONE provider call + at most one retry). */
export async function serviceDraft({ creationId, interview, campaignId = null } = {}) {
  const ledger = ledgerFor(creationId);
  const { draft, source } = await draftWorld({ interview, provider: resolveProvider(), ledger, campaignId });
  ledger.print(); // incremental session line to the log
  return { ok: true, draft, source, ledger: ledger.totals() };
}

/** Regenerate a single card from a one-line twist (ONE provider call). */
export async function serviceTwist({ creationId, cardType, card, instruction, context, campaignId = null } = {}) {
  const ledger = ledgerFor(creationId);
  const { card: next, source } = await twistCard({ cardType, card, instruction, context, provider: resolveProvider(), ledger, campaignId });
  return { ok: true, card: next, source, ledger: ledger.totals() };
}

/**
 * Compile + validate + SAVE a curated draft as an owner-scoped user WORLD. Deterministic
 * (no provider call). Accepts either a review object or a plain draft (reviewToDraft is
 * idempotent on a plain draft). Returns { ok, worldId, world } or { ok:false, errors }.
 */
export function serviceSaveWorld({ userId, creationId, draft, interview, overrides = {}, art = null } = {}) {
  const curated = reviewToDraft(draft || {});
  const book = assembleWorldBook({ draft: curated, interview, overrides });
  const vwb = validateWorldBook(book);
  if (!vwb.ok) return { ok: false, errors: vwb.errors, stage: "world-book" };

  // The record id IS the compiled scenarioId (stable + unique across same-named worlds).
  const worldId = `uw_${crypto.randomBytes(8).toString("hex")}`;
  const { scenario, validation } = compileWorldBook(book, { scenarioId: worldId });
  if (!validation.ok) return { ok: false, errors: validation.errors, stage: "compile" };

  const record = addUserWorld(userId, {
    id: worldId,
    name: book.name,
    tagline: book.identity?.tagline || book.vibe || "",
    art: art || null,
    worldBook: book,
    scenario,
    schemaVersion: 1
  });

  const ledger = ledgerFor(creationId);
  ledger.print(); // final session ledger line
  ledgers.delete(String(creationId || "anon"));

  return { ok: true, worldId: record.id, world: toSelectCard(record), ledger: ledger.totals() };
}

// world record → the world-select card shape the client merges into WORLD_SELECT_CARDS.
function toSelectCard(w) {
  return { userWorldId: w.id, title: w.name, hook: w.tagline || "A world you made.", art: w.art || null, kind: "user" };
}

/** The user's created worlds, in world-select card shape (owner-scoped). */
export function listWorldsForSelect(userId) {
  return listUserWorlds(userId).map(toSelectCard);
}

/** Delete a user world (owner-scoped). */
export function serviceDeleteWorld(userId, worldId) {
  return { ok: deleteUserWorld(userId, worldId) };
}
