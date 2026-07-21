# INSPECTOR CHARTER — the standing adversarial audit

**Status:** SEALED 2026-07-20. This is the role that keeps ratified canon, sealed
laws, and shipped systems from silently rotting into unbuilt intent, dead content,
or unre-derivable claims. The inspector works **READ-ONLY** (the sole write is this
charter and the findings queue it produces). The inspector **never fixes** — it
files a ranked, evidence-anchored follow-up queue. Fixing is a separate pass.

Companion ledgers the inspector reconciles against: `canon-code-gaps.md` (the single
canon-ahead-of-code ledger), every `docs/design/*.md` sealed law, and
`docs/worlds/**` world-books.

---

## THE RATCHET RULE (read this first)

> **Every finding graduates into a test or a law. The same finding may never appear
> twice.**

A finding is not closed by being fixed. It is closed by being made **impossible to
regress silently**: either a test fails the suite if it recurs, or a law names it so
a future author is on notice. If the inspector finds the same class of defect a
second time, the *first* finding failed the ratchet — the miss is that no guard was
minted, and that meta-failure is itself a finding. This is what makes the audit
converge instead of looping. When you file a finding, you MUST name its **ratchet
target** (the specific test file or law doc it becomes).

Corollary: stale ledgers are ratchet hazards. A gap marked "NOT BUILT" that has
since shipped can be "re-found" as new — so ledger reconciliation (check `a`/`e`) is
a first-class inspector duty, not bookkeeping.

---

## CADENCE

Run the full walkthrough **before every owner walk** and **after every batch day**.
A partial run (one or two checks) is fine mid-batch when a specific system just
landed; the full eight-check sweep is the gate before an owner sees the build.

Each run ends with a **BADGE STATE** line (standing rule): the loaded server sha +
clean/stale vs the disk tip (mirrors the loud BUILD-line stale face). A finding set
derived from a stale process is worthless — verify the badge first.

---

## STANDING LAWS THE INSPECTOR ENFORCES (context)

- **No dates / percentages / codenames** on any player-facing roadmap surface
  (law). Driven guard: `tests/home-roadmap.test.js`.
- **Em-dash ban** on player-facing strings. Driven guard:
  `tests/em-dash-server-strings.test.js` + the chokepoint substitution in
  `server/gm/prompting.js`.
- **The art choke-point wall.** Every runtime image request flows
  imageWorker → providers.generateImage → comfyui.comfyuiImage. A new door FAILS
  THE SUITE BY EXISTING. Guard: `tests/art-path-wall.test.js`.
- **The three lifecycle fates** an artifact may hold: **library-keep**,
  **run-state**, or **destroy**. (A fourth, **quarantine** — a holding pen — is
  being added in W5.) Anything that defaults-to-existing with no fate is a
  lifecycle finding (check `c`).

---

## THE EIGHT CHECKS

Each finding carries: **id · one-line title · evidence (file:line or doc quote) ·
why it matters · ratchet target**. Rank the queue by severity (critical→low).

### (a) WIRING-VS-SPEC
Every sealed law doc (`docs/design/*.md`, `docs/worlds/**`) maps to where it is
**enforced in code**, cited `file:line`. For each law: find the enforcing
module/function; confirm it is imported by the live path (not orphaned); confirm a
test asserts the behavior. A law with no code cite is unbuilt intent; a law whose
enforcer is imported by nothing is dead scaffolding. Method: grep the law's named
functions/constants across `server/`, then confirm a non-test importer.

### (b) REACHABILITY
Every shipped system is **exercised on the flagship live path (Babel)**. Load a real
Babel run (`createDefaultSoloRun` → `loadScenarioIntoRun(run, loadScenarioFile("babel"))`)
and inspect the *committed* run — never the raw scenario JSON (worldgen seeds the
positional start/second/third chain that the raw JSON omits; a raw-JSON graph read
gives false stranding). Then: BFS the committed exit graph for node reachability;
enumerate placed hostiles/cast/services/traces actually present; confirm each sealed
system has ≥1 reachable instance. A system reachable only in a unit test but never on
Babel is not shipped for a player.

### (c) LIFECYCLE
Every artifact type walks **created → judged → destroyed**. For each mutable
collection on `run` (essenceTraces, mintedStatBlocks, npcs, memoryFacts, timeline,
imageAssets, threads, quests): find where it is CREATED, where it is JUDGED
(scored/banded/graded), and where it is DESTROYED (pruned/archived/marked-terminal).
**Anything defaulting-to-existing — created and judged but never given a destroy
fate — is flagged.** Unbounded committed-state growth and never-resolving affordances
both live here. Map each type to one of the three fates (library-keep / run-state /
destroy); an artifact with no fate is the finding.

### (d) ROUTE INVENTORY DELTA
New generation / prompt / provider call sites **OUTSIDE the art choke-point**
(imageWorker → providers.generateImage → comfyui.comfyuiImage). The import-scan guard
`tests/art-path-wall.test.js` is the standing net; the inspector's job is to confirm
it still passes AND to diff the LLM/provider call sites (`server/gm/*`,
`server/ai/*`, `server/campaign/world*` draft/interview engines) for a NEW model or
prompt door that the wall does not cover (the wall guards IMAGE generation only —
text/LLM fan-out has its own routing in `server/ai/providers.js` /
`server/gm/gmProvider.js`). A new provider chain or a raw fetch to a model endpoint
is the finding.

### (e) CLAIM AUDIT
Spot-check recent report / commit / memory claims against the repo; **re-derive
numbers**. Every headline count (POIs, base animals, tests, tiers, latencies, costs)
must reproduce from a command the inspector runs. A number that does not re-derive —
or whose denominator is undocumented — is the finding, and its ratchet target is a
counting test or a pinned reproduce-command, so the number can never drift
unnoticed. The thesis's own discipline ("combat-62 is a phantom") is the standard:
apply it to the thesis too.

### (f) CONFIG HAZARDS
Scenario flags, keys, stale process, NODE_ENV, new env footguns. Read `.env` (redact
secrets) for: a persisted scenario force (`INKBORNE_SCENARIO` — contaminates every
plain restart), a **testing-only provider chain left active** (a training-tier free
lane that leaks prompts), GM local-fallback GPU-load flags, image-provider drift, and
NODE_ENV/bind exposure. The rule from the scenario-flag scar applies to ALL
testing-only flags: **never persisted in `.env`; set per-session only.** A persisted
testing flag with a live effect is the finding.

### (g) NEGATIVE SPACE
What has **no owner, no fate, no test**. The inverse of the other checks: authored
DATA with no consuming engine (name banks, service kinds, layout templates), a stat
row with no placement, a payload field the client never reads, a collection with no
prune. Enumerate authored assets and ask of each: who consumes it, who ends it, what
proves it. Silence on all three is the finding.

### (h) CANON-WALK (the bandit-class-gap detector)
Everything named as **committed canon** + every **owner interview ruling** that a
PLAYER CANNOT YET TOUCH. Read the world-books and law docs; list every named entity,
mechanic, faction, encounter rung, loot, and ruling; for each, prove a reachable code
path on Babel or file it. The canonical smell: a threat-ladder rung, a POI, a loot
item, or an NPC that is SEALED in a doc but has zero placement / zero spawner / zero
consumer. Named-in-canon but untouchable-in-play is the finding. Cross-read at
minimum: `docs/worlds/babel/verdance-region-v1.md`,
`docs/worlds/babel/verdance-bestiary-v1.md` (the threat ladder verbatim —
wildlife / bandits / chaoslings / demons), `docs/design/world-module-law.md`,
`docs/design/product-thesis.md`, `docs/design/chaos-is-purple.md`.

---

## OUTPUT CONTRACT

A single ranked queue (critical → low). Each row:

```
[ID] one-line title
  evidence:  file:line  or  "doc quote"
  why:       one sentence — the player/canon/claim cost
  ratchet:   the exact test file or law doc this finding becomes
```

Findings are the deliverable. The inspector does not fix, does not open PRs, does not
touch code. It hands the owner a queue where **every row already names the guard that
will retire it forever.**
