# MAP-LAYOUT LAW — spatial minting

**Status:** SEALED 2026-07-17. Items marked **PROVISIONAL** are
Claude-recommended defaults awaiting owner confirm.

The founding defect: the map draws a token-huddle — the player centred, every
NPC spiralled around them, features on a synthetic ring — regardless of where
anything actually is. A forest has no trees; a walled town has no wall; three
NPCs stand in the player's pocket. The founding acceptance test: **a forest
mints trees and a clearing, a town mints a wall with the gate facing the road,
the cast stands where the cast is — and it's the same map every time you look.**

---

## THE LAW

### A LOCATION LAYOUT is committed server state
`location.layout` is a first-class, resume-safe record on the location:
bounds/shape, terrain features (trees, water, rock), structures (walls, gate,
buildings), committed-object markers (POIs, discovered objects, the generator),
and entity positions. **The map renders ONLY committed layout — it never
decorates.** No client-side invention, no synthetic rings, no name-regex
guesswork where committed data exists.

### MINTED, NOT HAND-AUTHORED
The first time a location's layout is needed, the server **MINTS** it
deterministically from the location's seed and a **TYPE TEMPLATE**
(forest / clearing / road / town-approach / town / interior / ruin / cave…).
Same seed = same layout, forever — and the mint **commits on first use**, so a
resumed run re-opens onto the identical map (resume-safe by commitment, not by
re-derivation). Legacy locations carry no layout and mint lazily on first map
view (additive/optional — old runs behave identically until looked at).

### TEMPLATES ARE WORLD-BOOK DATA (Law 6)
The template set is a data file, world-book extensible. The world author can
hand-place set-piece layouts (the Tower); everything else mints itself. Code
ships the mint engine; data ships the shapes.

### COMMON SENSE IS THE TEMPLATE'S JOB
- A forest mints scattered trees and a clearing.
- A town approached by road mints a perimeter wall with the **gate facing the
  approach exit**.
- Interiors mint walls and a door consistent with their exits.
- Committed facts **place themselves**: an object narrated "north" positions
  north; committed discoveries (found-object auditor) receive positions at
  commit time.

### ENTITIES HAVE POSITIONS
NPCs and the player hold committed positions within the layout. Sensible
defaults at mint: the keeper near their post, arrivals at the gate/edge,
the player at the entrance they came through. Movement within a location
updates position. **No more token-huddle.**

### SCOPE FENCE — D.4 stands
The map is an **exploration/orientation surface**. Combat remains positionless
per the sealed D.4 ruling — layouts inform narration and the map, **never
combat mechanics** (no range, no line-of-sight, no movement economy). This law
does not reopen D.4.

### NARRATOR CONSUMES LAYOUT
Committed layout rides the GM prompt as scene-geometry facts: the narrator
describes the clearing where the clearing IS. The narrator never invents
geometry. (Geometry-contradiction auditor — narration placing a committed
feature somewhere it isn't — is a ledgered extension of the auditor family,
not built this pass; see canon-code-gaps.md.)

---

## REPRESENTATION (built this pass)

`location.layout` is a **grid feature list** on the existing battle-map
contract — `{ width, height, cells: [{ kind, x, y, name? }], seed, templateId,
mintedAt }` — because the existing presence-map renderer already consumes
positioned `{ kind, x, y, name }` features on a CSS grid; the layout mints
straight into the surface that draws it, with no coordinate-space translation
layer. Entity positions live as committed token positions keyed by entityId.

Type inference derives the template from committed data (world hand-placed
`layoutTemplate` wins; else worldgen `startingLocationType` for the start
location; else tags/name; else a sane default).

Entity positions resolve in committed order: a player-dragged token position
persisted on `run.battleMap.tokens` wins; otherwise the position is a **pure
deterministic function of committed state** (layout anchors + committed
rosters), so the same run always renders the same map — committed by
derivation, with drag as the explicit override channel.

**PROVISIONAL defaults:** grid 12×12 (matches the renderer's square aspect and
the existing battle-map contract); template set v1 = forest, clearing,
road/trail, town-approach, town-street, interior (tavern/room), ruin, cave.
