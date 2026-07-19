// THE DRAFT ENGINE (server/campaign/worldDraft.js). Provider content is NEVER trusted
// raw: coerce/repair → validate → one retry → deterministic fallback. Plus keep/twist/kill
// review state, assembly, and cost-ledger accounting. All with a MOCKED provider — zero
// real LLM calls.
import assert from "node:assert/strict";
import test from "node:test";
import {
  draftWorld, twistCard, coerceDraft, validateDraft, fallbackDraft, extractJsonObject,
  createReview, keepCard, killCard, replaceCard, reviewToDraft, assembleWorldBook,
  createCostLedger, estimateCostUsd, CREATION_BUDGET_USD
} from "../server/campaign/worldDraft.js";
import { compileWorldBook } from "../server/campaign/worldBook.js";
import { createInterview, answerQuestion, justBuild } from "../server/campaign/worldInterview.js";

function interview() {
  let iv = createInterview("neon cyberpunk city, corporate gods, rain that never stops");
  iv = answerQuestion(iv, "a hundred-floor arcology that prints weather");
  iv = answerQuestion(iv, { id: "powers", answer: "Zaibatsu, the Drowned Court, the Meat Church" });
  return justBuild(iv);
}

const validPayload = () => JSON.stringify({
  identity: { name: "Neon Reach", tagline: "rain that never stops", era: "late-corporate", tone: "neon-noir" },
  cosmology: "The corporations became gods when they learned to print weather.",
  signatureDanger: { name: "The Static Rain", description: "rain that erases memory" },
  pois: Array.from({ length: 14 }, (_, i) => ({ name: `District ${i + 1}`, poiClass: i < 6 ? "settlement" : "wilds", description: "a place", dangerLevel: i % 4 })),
  factions: [{ name: "Zaibatsu", disposition: "hostile-reserved", wants: "control" }, { name: "Drowned Court", disposition: "neutral", wants: "tribute" }, { name: "Meat Church", disposition: "friendly-secret", wants: "converts" }],
  threatLadder: [{ rung: "drones", rarity: "common" }, { rung: "gangers", rarity: "common" }, { rung: "cyber-psychos", rarity: "uncommon" }, { rung: "corp security", rarity: "rare" }, { rung: "the Static", rarity: "very-rare" }]
});
const validProvider = async () => ({ model: "mock-flash", tokensUsed: { prompt: 1400, completion: 900 }, cost: 0, content: validPayload() });

// ── draft: provider / repair / fallback ──────────────────────────────────────

test("valid provider output → source 'provider' with full tables", async () => {
  const ledger = createCostLedger();
  const { draft, source } = await draftWorld({ interview: interview(), provider: validProvider, ledger });
  assert.equal(source, "provider");
  assert.equal(draft.identity.name, "Neon Reach");
  assert.equal(draft.pois.length, 14);
  assert.equal(draft.factions.length, 3);
  assert.equal(draft.threatLadder.length, 5);
  assert.equal(ledger.totals().calls, 1, "exactly one draft call");
});

test("unusable output retries ONCE then falls back to the human answers (2 calls)", async () => {
  const ledger = createCostLedger();
  const garbage = async () => ({ model: "mock", tokensUsed: { prompt: 100, completion: 20 }, content: "Sorry, I can't help with that." });
  const { draft, source } = await draftWorld({ interview: interview(), provider: garbage, ledger });
  assert.equal(source, "fallback");
  assert.ok(draft.pois.length >= 1, "fallback still yields a playable draft from answers");
  // the region/powers answers survive into the fallback.
  assert.ok(draft.factions.some((f) => /Zaibatsu/i.test(f.name)), "fallback seats the answered factions");
  assert.equal(ledger.totals().calls, 2, "one draft + one retry, then fallback");
});

test("a throwing provider falls back without crashing", async () => {
  const { draft, source } = await draftWorld({ interview: interview(), provider: async () => { throw new Error("timeout"); } });
  assert.equal(source, "fallback");
  assert.ok(draft.pois.length >= 1);
});

test("second-try-valid output is accepted as 'repaired'", async () => {
  let n = 0;
  const flaky = async () => (++n === 1 ? { content: "not json" } : { model: "m", tokensUsed: { prompt: 1, completion: 1 }, content: validPayload() });
  const { source, draft } = await draftWorld({ interview: interview(), provider: flaky });
  assert.equal(source, "repaired");
  assert.equal(draft.pois.length, 14);
});

// ── coercion / validation primitives ─────────────────────────────────────────

test("extractJsonObject tolerates fences + prose; coerceDraft clamps + drops junk", () => {
  const parsed = extractJsonObject("here you go:\n```json\n{\"identity\":{\"name\":\"X\"},\"pois\":[{\"name\":\"P\",\"dangerLevel\":99},{\"noName\":true}]}\n```\nenjoy");
  const draft = coerceDraft(parsed, { answers: {}, spark: "s" });
  assert.equal(draft.identity.name, "X");
  assert.equal(draft.pois.length, 1, "the nameless poi is dropped");
  assert.equal(draft.pois[0].dangerLevel, 4, "danger clamped to 0-4");
  assert.equal(validateDraft(draft).ok, true);
  assert.equal(extractJsonObject("no json here"), null);
  assert.equal(validateDraft(null).ok, false);
});

test("fallbackDraft is coherent straight from the answers", () => {
  const d = fallbackDraft({ answers: { region: "The Verdance", powers: "Wardens, Reavers", threats: "rats, raiders, wraiths" }, spark: "a drowned frontier" });
  assert.equal(d.identity.name, "The Verdance");
  assert.equal(d.source, "fallback");
  assert.ok(d.factions.length >= 2 && d.threatLadder.length >= 3);
});

// ── twist: single-card regeneration ──────────────────────────────────────────

test("twistCard regenerates one card; unusable output leaves it unchanged", async () => {
  const ledger = createCostLedger();
  const card = { id: "poi_1", name: "District 1", poiClass: "settlement", description: "x", dangerLevel: 1 };
  const good = async () => ({ model: "m", tokensUsed: { prompt: 200, completion: 80 }, content: JSON.stringify({ name: "The Sunken Bazaar", poiClass: "market", description: "a flooded market", dangerLevel: 2 }) });
  const r1 = await twistCard({ cardType: "poi", card, instruction: "make it a flooded market", provider: good, ledger });
  assert.equal(r1.source, "provider");
  assert.equal(r1.card.name, "The Sunken Bazaar");
  assert.equal(r1.card.id, "poi_1", "id is preserved across a twist");
  const r2 = await twistCard({ cardType: "poi", card, instruction: "x", provider: async () => ({ content: "garbage" }) });
  assert.equal(r2.source, "unchanged");
  assert.equal(r2.card.name, "District 1");
  assert.equal(ledger.totals().calls, 1);
});

// ── keep / twist / kill review state ─────────────────────────────────────────

test("review: keep default, kill drops from the curated draft, replace swaps in", () => {
  const draft = { identity: { name: "R" }, pois: [{ id: "a", name: "A" }, { id: "b", name: "B" }], factions: [], threatLadder: [] };
  let review = createReview(draft);
  assert.equal(review.pois[0].status, "keep");
  review = killCard(review, "pois", "a");
  assert.equal(review.pois.find((c) => c.id === "a").status, "killed");
  review = keepCard(review, "pois", "a");
  assert.equal(review.pois.find((c) => c.id === "a").status, "keep");
  review = replaceCard(review, "pois", "b", { name: "B-prime", poiClass: "x" });
  assert.equal(review.pois.find((c) => c.id === "b").name, "B-prime");
  review = killCard(review, "pois", "a");
  const curated = reviewToDraft(review);
  assert.equal(curated.pois.length, 1, "killed cards are gone from the curated draft");
  assert.equal(curated.pois[0].name, "B-prime");
  assert.ok(!("status" in curated.pois[0]), "review bookkeeping stripped");
});

test("assembleWorldBook → compileWorldBook yields a valid scenario", () => {
  const draft = { identity: { name: "Neon Reach", tagline: "rain" }, cosmology: "gods of weather", pois: [{ id: "p1", name: "District 1", poiClass: "settlement", description: "x", dangerLevel: 1 }], factions: [{ id: "f1", name: "Zaibatsu", disposition: "hostile", wants: "control" }], threatLadder: [{ id: "t0", rung: "drones", rarity: "common" }] };
  const book = assembleWorldBook({ draft, interview: interview(), overrides: { artStyle: "cinematic", era: "late-corporate" } });
  const { validation, scenario } = compileWorldBook(book);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.equal(scenario.world.artStyle, "cinematic");
  assert.equal(scenario.factions.length, 1);
});

// ── cost ledger ──────────────────────────────────────────────────────────────

test("cost ledger accounts calls/tokens/cost, estimates free tiers, checks budget", () => {
  const ledger = createCostLedger();
  ledger.record({ kind: "draft", model: "flash", tokensUsed: { prompt: 2000, completion: 1500 }, cost: 0 });
  ledger.record({ kind: "twist", model: "flash", tokensUsed: { prompt: 300, completion: 120 }, cost: 0.0009 });
  const t = ledger.totals();
  assert.equal(t.calls, 2);
  assert.equal(t.promptTokens, 2300);
  assert.equal(t.completionTokens, 1620);
  assert.ok(t.costUsd > 0, "a free-tier call is cost-ESTIMATED, not zeroed");
  assert.equal(ledger.underBudget(), true, "a whole session is far under the $0.15 flash budget");
  assert.match(ledger.format(), /draft×1 twist×1/);
  // estimateCostUsd is the flash-priced estimate.
  assert.ok(estimateCostUsd({ prompt: 1e6, completion: 0 }) > 0);
  assert.ok(CREATION_BUDGET_USD <= 0.15);
});
