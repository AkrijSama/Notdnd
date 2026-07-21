# Fridge Taster — automated intake taste check + quarantine

**Module:** `server/solo/fridgeTaster.js` · **Review UI:** `scripts/art/review.mjs` ·
**State:** `scripts/art/library.mjs` (sidecar `quarantine` field) · **Tests:** `tests/fridge-taster.test.js`

## What it does

The curated art library auto-keeps every live ComfyUI generation the intake guard
admits (`imageWorker.intakeToLibrary`). That admits the **recipe** but not the
**picture** — a validated recipe can still paint the wrong thing (a declared-human
portrait rendered as a skull-demon; a scene that grew a modern aircraft; a
species-untrue animal). The taster inserts a cheap per-kind **taste check** *before*
auto-keep:

| Verdict | Fate | Meaning |
|---|---|---|
| `pass` | **Fridge** | Library keep — served across runs (unchanged behavior). |
| `suspect` | **Quarantine** | A holding pen served to **nothing**, held for owner review. |

### Canon questions (per kind)

- **scene** — expected subject present? no aircraft/vehicles/modern-city unless committed? species-true?
- **portrait / fullbody** — single head? human-when-declared-human? clothed?

### Quarantine is a NEW third lifecycle state

The pre-existing law was two fates only — **library-kept** or **destroyed** (`rating`
= `keep` / `toss`, where `toss` deletes on the spot). Quarantine is layered
**orthogonally** on top of that rating dimension:

- A quarantined asset carries `rating != "keep"` **and** a non-null `quarantine`
  marker object on its sidecar.
- `queryAssets` drops any asset with a `quarantine` marker, so it can never surface on
  any serve path (`resolveSceneArtForRun`, `resolveNpcFaceFromLibrary`, keep queries).
- Quarantine is **not permanent**. Owner review (`scripts/art/review.mjs`) resolves it:
  - **Fridge** → clears the marker, promotes to a `keep` (now served).
  - **Trash** → destroys the image + sidecar (the DESTROY fate).
- A **30-day auto-trash sweep** (Law-6, tunable) drains anything the owner never got
  to, so the pen self-drains. Tunable via `NOTDND_QUARANTINE_MAX_AGE_DAYS` (default 30).
  The sweep runs on `review.mjs` startup and via its `POST /sweep` endpoint / button.

## The assessor interface + config seat

An **assessor** is `{ model, assess(input) -> assessment }`:

```
input      = { id, bytes, kind, run, subjectId, promptUsed }
assessment = { verdict: "pass"|"suspect", checks: [{question, ok, note}], reason }
```

`taste(input)` runs the active assessor and maps the verdict onto the intake
lifecycle fields (`{ rating, quarantine, tags, checks }`) that `intakeToLibrary`
merges into its `addAsset` call. A broken assessor **fails safe to quarantine** —
never to an unreviewed auto-keep.

### HARD FENCE — zero paid calls

The **default assessor is a deterministic MOCK** (`mockAssess`): no network, no cost.
It answers the canon questions from the strongest proxy it has offline — the assembled
prompt + the committed run context (e.g. `entityNature` species-truth, monster/nudity/
reference-sheet token scans, uncommitted-modern-intrusion scans). It is intentionally
**conservative**: it flags only unambiguous violations, so by default the pipeline
behaves exactly like today (pass → auto-keep). Tests inject fixed verdicts by id via
`setTasteFixtures`.

The **config seat** is the env var **`NOTDND_TASTER_MODEL`**:

- unset / `"mock"` → the mock (default).
- set to a model id **with a registered adapter** → that real adapter.
- set **without** a registered adapter → **fails closed to the mock** (loud once). No
  silent paid call is ever made.

**Adapter point:** `registerAssessor(modelId, assessFn)`. No paid adapter ships in this
module (`REAL_ADAPTERS` is empty by construction). The owner wires a real vision
assessor here — reading `input.bytes` (the image) and returning an `assessment` — only
after approving the cost ledger below.

## Cost ledger — ASSUMPTION (owner approval required before enabling a real model)

No real vision/LLM/OpenRouter call is made anywhere in this feature. The numbers below
are **ASSUMPTIONS** to size the decision; confirm live pricing/token counts before
wiring an adapter and flipping `NOTDND_TASTER_MODEL`.

**Recommended candidate: Claude Haiku 4.5** (`claude-haiku-4-5`) — cheapest first-party
Claude model with vision. Pricing (per 1M tokens): **input $1.00, output $5.00**.

Per-image estimate (**ASSUMPTION**):

| Component | Assumed tokens | Rate | Cost |
|---|---:|---|---:|
| Image (downsampled ~512px long edge, ≈ w·h/750) | ~530 | $1.00 / 1M in | $0.00053 |
| Prompt (canon questions + context + instructions) | ~250 | $1.00 / 1M in | $0.00025 |
| Output (structured verdict JSON) | ~120 | $5.00 / 1M out | $0.00060 |
| **Per image (taste check)** | | | **≈ $0.0014** |

At the observed live-intake cadence (**ASSUMPTION**: ~1 keep-eligible image per turn,
a few hundred/day for one active owner), that is on the order of **a few cents/day** —
negligible. Alternatives if even that is unwanted: a smaller open vision model behind a
local endpoint (adapter returns a verdict with **zero** marginal API cost), or leave the
mock on and rely on the deterministic prompt/context heuristics.

**Recommendation:** keep the mock as the shipped default. Enable a real adapter only if
the owner wants pixel-level canon enforcement, at ≈ $0.0014/image (ASSUMPTION), by
registering a Claude Haiku 4.5 (or local) adapter and setting `NOTDND_TASTER_MODEL`.

## Env knobs

| Env var | Default | Effect |
|---|---|---|
| `NOTDND_TASTER_MODEL` | `mock` | Selects the assessor. Unwired real model → fails closed to mock. |
| `NOTDND_QUARANTINE_MAX_AGE_DAYS` | `30` | Law-6 auto-trash age for the quarantine sweep. |

## Wiring touch point

Exactly one line was added to `imageWorker.intakeToLibrary`'s intake decision: a
`taste({...})` call whose result sets `rating`, `quarantine`, extra `tags`, and gates
`checkout` (a quarantined face never checks out). The generate path is untouched.
