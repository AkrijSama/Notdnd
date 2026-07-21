# Product Thesis — v1 (2026-07-20)

*Sealed after adversarial review. Findings-first, evidence-anchored. This is strategy
canon: what a "10" is, what is actually built vs. what only exists as capability, and
where the bet is. It corrects the pre-review PM thesis where the code overruled it —
those dissents are recorded, not buried. Companion: [[competitive-landscape]].*

---

## 0. The one-line thesis

Most AI RPGs cap at a **~6.5–7 fun ceiling** (see the fun table in
[[competitive-landscape]]) because of **structural** failures — memory decay,
bully-able stakes, fog prose, no game underneath — never because of prose. The moat is
the **commit/consequence spine**, not the prose and not "durable memory" in the
abstract. We are ~90% built on the spine and ~35% built on the *payload* that turns the
spine into a campaign that is provably **yours**.

## 1. The 10 — the north star (unchanged)

A 10 is a campaign that is **provably, durably, consequentially YOURS at session forty**:

- the world **moves without you** (threads advance, deadlines bite, factions act on a clock, not only on your turn);
- **promises are remembered with weight** (an old, load-bearing fact resurfaces because it *matters*, not because it is recent);
- **player-authored ambitions reorganize the world** (a rival becomes a real antagonist, a faction shifts, a place changes — not a narrated sentence);
- **death is un-negotiable** (engine-committed, no narration mercy);
- the **prose is loaded** (every sentence references committed state).

This is the right north star. It is also mostly **aspirational today**: of the five, only
un-negotiable death is fully delivered; weighted memory, ambition→world, and (as of this
session) the entry-gate integrity behind "stakes" are v1 or just-shipped; validated
prose is not delivered on any stack. Do not let the north star read as a status report.

## 2. THE FORCED SPLIT — three axes, not two (the core reframe)

The pre-review thesis measured **durability vs. beauty** and rated durability ~90%. The
review forced a three-way split, because "durability" conflated a nearly-finished spine
with a barely-started payload, and the decomposition hid a third axis that is
empirically the worst.

### Axis A — the COMMIT-SPINE  ·  ~90% built  ·  **THE MOAT**

> **The model may describe, but never adjudicate, committed truth.**

This is the uncopyable asset. It is real and it is rare:

- **Commit → persist → narrate** is a hard boundary: the roll, band, damage, and death
  are computed, committed, and saved *before* the narrator writes; narration can only
  describe a settled outcome or be stripped, never rewrite it (`index.js` resolve→save→
  narrate; scrub-fabricated-numbers audit).
- **Deterministic authority gate**: impossibility/possession/retcon are pure-regex
  refusals a forced nat-20 cannot move (`attempt.js classifyIntentAuthority`).
- **Un-negotiable death**: engine-owned, closed action set, LLM firewalled from
  adjudicating or reviving (`death.js`).
- **Real combat**: CTB tempo, three-band resolution with committed costs, statuses,
  morale/flee, telegraphed AI — **76 behavioral tests** across the combat suite
  (reproduce: `node --test tests/combat-*.test.js` → `# tests 76`; add the substrate
  vertical-slice test, `tests/substrate-combat.test.js`, for 90). Corrected 2026-07-21
  from a stale "83"; the count is now self-verifying via the command shown.
- **Provider cannot mutate state**: `stateMutations` hard-rejected (`attempt.js`).

Rename the moat accordingly: it is **not "durability"** (copyable) — it is the
adjudication discipline. Protect `server/solo/*`; that is the line.

### Axis B — the DURABILITY-PAYLOAD  ·  ~35% built  ·  the open problem

What actually makes a campaign feel *yours* at session forty. The executor *can* do all
of this; the payload paths mostly opted out. Gated on **wiring existing capability**,
not new architecture:

| Payload | Pre-session state | Now (this session) |
|---|---|---|
| **Weighted fact retrieval** | `memoryFacts.slice(-10)` — pure recency; an old promise silently evicted | **v1 shipped**: scored recency × relevance × importance (`factSelection.js`); old high-stakes facts float over recent noise |
| **Ambition → world mutation** | goal fronts emitted `fact`-sentences only (0 of 5 structural payloads); no faction reaction; unreachable deadline | **v1 shipped**: rival/interested party commit as real NPCs, cost/price as object-state, `reputationEffects` on a relevant faction, reachable Law-6 deadlines (`goalDoors.js`) |
| **Entry-gate integrity ("stakes")** | contested-ness decided by soft LLM `needsCheck`; DC floor 1 → bluffable | **shipped**: deterministic contested classification outranks the provider; DC floored to the resolution-law EASY band (`attempt.js`) |
| **Per-intent commit routing** | observe/wait/repeat resolve "success" but commit nothing (narrate-into-void) | **NEXT ARC** (§ Traction) — spec'd, not built |

### Axis C — TRACTION (consequence-density)  ·  grade **F**  ·  the hidden third axis

Durability is about session-40 memory; beauty is about the sentence. Neither answers
**"did my action just produce a committed, legible change *now*."** Empirically this is
the worst axis: the auto-grade aggregate reads **Depth/Traction F (~53)** with
**"narrate-into-void" in 5/5 sessions** — the engine reports success but commits no
state delta for observe/wait/repeat intents
(`docs/grades/auto-grade-AGGREGATE-2026-07-08.md`). A perfectly durable, beautiful game
where "wait and watch" commits nothing is still not a 10. **Minute-3 fun is traction;
session-40 ownership is durability.** The pre-review two-axis frame omitted the axis the
grades actually flunk. This is the **next arc** (§7).

## 3. The BEAUTY axis — restated honestly

Beauty is **not** ~50% built and is **not** on a free ride:

- **"Beauty" is unmeasured, on any stack.** Every "Narration A / 95" is a deterministic
  defect-linter default (`selfplayAudit.mjs AXIS_BASE=95`) — "no em-dash / no
  recycled-loop," explicitly "structural, not aesthetic." Human-validated fun is **0%,
  unmeasured on any build** (`ROADMAP-CANON.md`). So "beauty ~50%" invents a number for
  something measured at zero.
- **The proxy that exists ran on the PREMIUM model.** All five-axis grades used
  `deepseek-v4-pro`; production is `deepseek-v4-flash`, never prose-graded. No Claude is
  in the loop.
- **"Beauty gets cheaper for free" is false for THIS game's prose.** The loaded-prose
  contract (80–120 words, every sentence references committed state) is exactly what
  makes a cheap *reasoning* model fragile: v4-flash's hidden reasoning tokens **starved
  narration to empty/mid-sentence live** (`.env` 2026-07-16 note), now held by three
  stacked patches. Beauty got ~10× cheaper *per call* and bought a **new failure mode**,
  not a free lunch. Freeform RP (no contract) tolerates cheap models far better than our
  grounded loop does. The prose contract also **trades against speed** (+47% GM latency).
- **The economic answer is a premium lane, not a hope.** Because grounded prose degrades
  worst on the cheapest reasoning model, quality is a **model-tier decision**: reserve a
  premium narration lane (v4-pro / Claude-class) for the beats that must land, keep flash
  for cheap turns. Beauty is bought, not free — budget it. Unit economics: ~$0.11/session
  (70b) / ~$0.05 (routed) per [[unit-economics-measured]]; a premium narration lane is a
  line item, not a blocker.

## 4. Dramatic memory — PORT, don't invent

Ranking memory by *importance* is **published prior art**, not our invention. Stanford's
**Generative Agents** (Park et al., 2023) retrieves from a memory stream scored by
**recency + relevance + an LLM-rated importance/poignancy (1–10)** — precisely the
"dramatic weight" axis. MemGPT/Letta and commercial memory layers (Mem0, ChatGPT memory)
extend it.

Re-price the work from "invention moat" to **"port the importance-scored retrieval into
our commit pipeline."** Our narrow, real novelty is *game-tuned poignancy folded into
commit* — score a fact's drama at commit time and rank on it. That is exactly what
`factSelection.js` (this session) begins: importance v1 is a deterministic commit-time
heuristic in the schema's `importance` slot; **v2 = an LLM poignancy score writing the
same slot** (ledgered, small). This is wiring, not R&D.

## 5. Competitor trajectory — the moat is the DISCIPLINE, not the persistence

The pre-review thesis banked the moat on "durable memory is uncopyable." It is not:
**durable memory is commoditizing now** — 1M-token context, prompt caching, and agentic
memory products (Letta, Mem0, ChatGPT/Gemini memory) all ship persistence. A bigger
context window copies "we remember." What a context window **cannot** copy is the
**server-authoritative adjudication discipline** — the model describes, the engine
commits, and the two never cross (`stateMutations` rejected; authority gate; death
firewalled). Bank the moat there. The repo's own architecture docs already say this
("the engine is the moat — protect it", `PRODUCT-ARCHITECTURE.md`); the thesis now agrees.

## 6. PM DISSENTS (recorded — where the PM was overruled by evidence)

| # | PM position (pre-review) | Evidence verdict | Anchor |
|---|---|---|---|
| D1 | Durability is ~90% architecture-complete | Split: spine ~90%, **payload ~35%**; the 90% credited scaffolding elsewhere | §2 |
| D2 | Dramatic memory is unsolved industry-wide — our invention | **Prior art** (Generative Agents, 2023); port, don't invent | §4 |
| D3 | Beauty is ~50% and gets cheaper for free | Beauty is **unmeasured (0%)**; cheap grounded prose got a **live collapse**, not a free ride | §3 |
| D4 | Durability is the uncopyable moat | The **adjudication discipline** is the moat; durable memory is commoditizing | §5 |
| D5 | "combat-62" proves the game | **Phantom citation** — no artifact "62"; the real proof is **76 combat tests** (`node --test tests/combat-*.test.js`) + the mechanics | §2A |
| D6 | Stakes are un-bully-able | Un-*reversible* once committed, but was **bluff-able at the entry gate**; **fixed this session** | §2B |

The PM's *core instinct* survived every check: the field ships chat products, not
engines, and this repo's commit discipline is genuinely rarer than memory. The
corrections are to the *scoreboard*, not the strategy's spine.

## 7. NEXT ARC — per-intent commit routing (close the Traction F)

The single highest-leverage open problem is **Axis C**: the general per-turn loop
narrates-into-void 5/5 for observe/wait/repeat intents — the engine says "success" and
commits no state (`docs/grades/auto-grade-AGGREGATE-2026-07-08.md` finding #1;
[[harness-tests-player-loop]]). This is spec'd here, **built next**, not tonight:

- **Detect → route → commit for the passive/observe/repeat classes** in
  `server/solo/actions.js`: a passive "look around" either commits a *discovery* (a new
  detail, a moved object-state, a fact) or is not graded a "success." A repeated
  "search" past the first must escalate or exhaust, never re-succeed into nothing.
- **Anti-void guard**: a "success" band that commits zero deltas is a content bug; flag
  it at finalize (mirror the auto-grader's narrate-into-void detector server-side).
- **Success metric**: Depth/Traction F → C+ on the next auto-grade battery; zero
  narrate-into-void on observe/wait/repeat.
- **Sequencing**: this arc runs **after the human fun verdict** on the current build (the
  payload wiring shipped this session needs a play read first — [[validation-baseline]]).

## 8. What shipped this session (payload work begun)

The three review-named "cheap convictions," implemented + tested (suite green):

1. **Entry-gate integrity** — deterministic contested classification outranks provider
   `needsCheck`; DC floored to 8. The bluff "I obviously, easily pick the lock, no
   stakes" now rolls (`attempt.js`; `tests/ch3-resolution.test.js`).
2. **Fact selection v1** — importance × recency × relevance replaces `slice(-10)`; an
   old promise beats ten recent weather facts (`factSelection.js`;
   `tests/fact-selection.test.js`).
3. **Goal payloads v1** — ambition/project fronts commit real NPCs + object-states +
   faction `reputationEffects`, on reachable Law-6 deadlines; declaring an ambition now
   produces a committed non-fact world change (`goalDoors.js`;
   `tests/goal-doors.test.js`).

These move Axis B from ~30% toward its v1; they do **not** touch Axis C (traction),
which is the next arc.

---

*Evidence base: the adversarial review (memory librarian = `attempt.js:666`/`scene.js`
slice-10 → now scored; goals skeleton → `goalDoors.js` structural; combat real,
"combat-62" phantom; entry-gate bluff → fixed; grades `docs/grades/`; economics `.env` /
[[unit-economics-measured]]). Extends [[inkborne-strategic-pivot]], [[inkborne-game-shape]].*
