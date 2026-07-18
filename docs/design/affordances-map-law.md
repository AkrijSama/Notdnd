# AFFORDANCES-MAP LAW — the middle map (region graph)

**Status:** SEALED 2026-07-17 (Part B). Companion to
[map-layout-law.md](map-layout-law.md) (Part A, the LOCAL floor plan). Items
marked **PROVISIONAL** are Claude-recommended defaults awaiting owner confirm.

Part A mints and renders where you *are* (a location's floor plan). Part B is the
**middle map**: the region graph of where you *can go* — the committed
locations-and-exits topology, knowledge-gated, drawn as a node graph.

---

## THE LAW

### THE REGION MAP IS A READ MODEL OVER COMMITTED STATE
It is derived, never authored, from `run.locations` + `connectedLocationIds`
(the exits). It invents nothing: a node exists because a location is committed;
an edge exists because an exit is committed. Same doctrine as Part A — the map
renders committed state and never decorates.

- **Nodes** `{ id, name, type, visited, revealedBy }` — `type` reuses the Part A
  layout type-inference table (`inferLayoutTemplate`: forest / clearing / road /
  town-approach / town-street / interior / ruin / cave). `visited` is committed
  (`location.state.visited`). `revealedBy` is the map-knowledge fact id that
  revealed an unvisited node, or `null` (visited-only).
- **Edges** `{ a, b, travelTime?, blocked? }` — undirected adjacency from
  `connectedLocationIds`, deduped. `travelTime` and `blocked` appear ONLY where
  committed (a committed per-edge travel cost; a committed route foreclosure).
  Absent otherwise — never a guessed constant on the map.

### FOG — HIDDEN, NOT DIMMED (owner ruling)
An unvisited node is **HIDDEN ENTIRELY** — absent from the payload, not a greyed
silhouette — **unless revealed by committed MAP-KNOWLEDGE**. Adjacency does not
reveal: standing next to an undiscovered exit shows (on the LOCAL map) that a
path leads out, never where. The region map only ever contains **visited OR
map-revealed** nodes.

- **Map-knowledge reveals; rumors do NOT** (owner ruling). Only a committed fact
  tagged `map:…` (a map item, a document, a signpost fact) reveals geography. A
  narrated rumor ("they say the tower lies east") is not map-knowledge and
  reveals nothing — hearsay never draws a node.
- **No spoilers in devtools.** Knowledge gating is **server-side**: the payload
  is built to contain only revealed nodes and only edges between revealed nodes.
  The client never receives hidden geography. A revealed node may carry an
  `unexploredExits` COUNT (a number, no destination id/name/type) so the render
  can fray a "there's more out there" stub without leaking the destination.

### MAP-KNOWLEDGE TAGS (the reveal grammar)
A committed `memoryFact` (or item-granted fact) whose `tags` include:
- `map:all` or `map:<world.variant>` → reveals the whole known graph (a full
  regional map).
- `map:node:<locationId>` → reveals one node.
- `map:region:<tag>` (or the shorthand `map:<tag>`) → reveals every node whose
  `tags` include `<tag>`.

`revealedBy` records which fact did it, so the reveal is auditable and resume-safe
(the fact is committed state; the reveal re-derives identically on reload).

**Creating map items is world-book / content work** (Law 6 data, not code). This
pass ships the *read* (reveal gating). Starter example a worldgen seed can commit
(ledgered here for the content pass):
```
memoryFact {
  type: "map_knowledge",
  text: "A weathered ranger's map of EZ-44, the trails inked by hand.",
  tags: ["map:babel", "item"],   // map:<variant> → reveals the Babel region graph
  source: "system", canonical: true
}
```

### DEFAULT ZOOM = LOCAL; REGION BEHIND A TOGGLE (owner ruling)
The map surface opens on the **LOCAL floor plan** (Part A). The region graph lives
behind a **zoom toggle** (local ⇄ region) on the same surface. Default view is
local; the toggle is in-memory per session (PROVISIONAL: persist later like the
other solo UI prefs).

### TRAVEL IS EXITS-EQUIVALENT
Tapping a **reachable** node issues a travel intent through the SAME movement
pipeline as an exit (`onMove` → `resolveMovementAction`). A node that is revealed
but not adjacent to the current location is **not tappable** (you know it's there;
you can't teleport). Unreachable nodes render without the move affordance.

### RENDER (this pass)
Region view draws, from committed state only: a **type glyph** per node (never a
generic circle), the **position marker** (current node), **goal pins** (committed
goals carrying a `locationId` on a revealed node), **hazard tint** (a committed
sky/hazard objectState on a node), **edge travel-time labels** and **blocked-edge**
rendering where committed. Node positions are a deterministic client layout (BFS
layers from the current node) — topology is committed, pixel placement is not.

### SCOPE FENCE
Part B is the map SURFACE only: the region read model + the region render + the
zoom toggle. It does not touch the input dock, combat, or the local minting
engine. Goal→location links and map-item authoring are named plumbing points, not
built here.

---

# COMMITTED AFFORDANCES — the action chips (ratified 2026-07-17)

A separate surface on the same law: the input dock's pre-typed action chips.
Affordances **suggest committed actions; they never limit** — the free-text box
stays the whole interface and remains visually primary. A chip is a pre-typed
intent phrase; tapping it submits that phrase through the exact same turn path as
typing it (turn lifecycle, idempotency, `turnId` — everything rides free). The
reply is normal GM narration + committed deltas; there are no `[SYSTEM]`-style
responses anywhere. Owner region: input dock + scene payload (the map surface is
Part B above).

## Sources (committed state only)
- **Location services** — committed service data on the location (inn / market /
  training as starter kinds), seeded by worldgen/world-book/scenario templates
  (additive `location.services`).
- **Present cast** — talk-to per committed-present NPC.
- **Exits** — travel-to per available move.
- **Active goals** — pursue-here when the goal is actionable at this location.
- **Committed objects / POIs** — examine per `objectStates` (weather/sky hazards
  excluded — not interactable).
- **Standing verbs (SUPER-COMMON ONLY)** — Look around · Search the area ·
  Wait/Camp/Rest as context offers. Nothing else is a standing verb.

Each affordance = `{ label, intent, source, feasibility: "ok" | "gated",
gateReason? }`. `source` ∈ {service, cast, exit, goal, object, standing}.

## The two-tier feasibility law (owner ruling)
- **INFEASIBLE** — committed state makes the verb impossible (rest during active
  combat; rent a room with no inn). The affordance renders **gated** with the
  in-fiction reason; a tap does **not** submit. Gating derives from **committed
  state only** — never from a guess about risk.
- **UNWISE** — possible but risky (resting in dangerous wilds). The affordance is
  **fully available**; the act carries its normal stakes through the pipeline
  (stakes exist → rolls/consequences per no-stakes-no-roll). The world answers
  honestly; it never nannies. An UNWISE act is never gated.

## Display (owner rulings — PROVISIONAL where noted)
- One quiet chip row directly **above** the input dock; the text box stays primary.
- **Cap ~7 visible + an overflow "more" chip** (PROVISIONAL default cap = 7).
- Gated chips render distinct, carry the reason on tap/tooltip, and never submit.
- Order: the reliable floor (standing verbs incl. any gated Rest) first, then
  contextual sources (goals, cast, services, objects, exits).
- During active combat, non-combat affordances are suppressed; only Look around
  and the gated Rest remain.

## Lifecycle / integrity
A tap routes through the delegated dispatcher → `onAttempt({ intent })` →
`handleAttempt` → the same `turnId`-stamped, idempotent, queue-one-deep turn as
typing. Text-box sovereignty (field, font sizer, meta row), the roll banner, and
the turn-lifecycle nodes are untouched.
