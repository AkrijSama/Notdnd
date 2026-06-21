# NotDND MVP Spec

## MVP Name

Solo AI-GM Persistent Campaign Slice

This MVP is not a BitLife-like MVP, not a full VTT, not multiplayer, and not an open-ended AI dungeon master. It proves persistent solo campaign play with structured truth, durable memory, constrained AI GM narration, location movement, NPC relationship continuity, and schema-ready player-owned assets.

The clarified product target is a persistent solo AI-GM spatial sandbox: the player is in a real structured place, moves node-by-node or tile-by-tile, inspects durable entities, and receives GM narration derived from server truth.

## 1. Start Solo Run

The user can create a server-backed solo campaign/save.

Required state:

- `soloRunId`
- `ownerUserId`
- `playerState`
- `worldSeed`
- `currentLocationId`
- `timeline`
- `createdAt`
- `updatedAt`
- `stateVersion`

The player has identity/state. The world has seed/state. Creative lore values should be supplied by Akrij-authored content later, not invented by scaffolding.

## 2. Location Movement

The player starts at a location and can move to at least 2-3 connected locations.

Each location has:

- `id`
- `title` or placeholder label
- `type`
- `state`
- `connections`
- `memoryRefs`
- `assetRefs`
- `updatedAt`

Each location can have associated image asset placeholder metadata. Movement is a structured action that updates `currentLocationId` and records a memory event.

## 2.5 Spatial Scene Contract

The MVP target screen is not pure chat. A future solo scene should be composed from structured state:

- Location image asset reference.
- Location name and description.
- Available movement directions/connections.
- Clickable visible entities such as NPCs, items, party/player entities, and player-owned assets if present.
- Available structured actions.
- GM narration generated from state and memory, not used as the source of truth.

Structured Action Bar: future UI should render server-provided actions as buttons/controls, starting with movement and later inspect, talk, search, interact, use item, rest, enter, and exit. This keeps play spatial/action-first instead of raw chat-first.

Entity Detail Panels: future character/entity sheets should feel modern but tabletop-readable, Roll20/DND-adjacent in mental model, mobile-friendly, and themed later around Akrij-approved IP. They should eventually support portrait/image, name/title/role, stats, status, relationships, inventory/equipment, memory facts/history, recent timeline events, and available actions without becoming generic web forms or Codex-authored lore.

Solo Scene Payload: future UI should render from one server-built scene payload containing current location, location image reference, description, visible entities, available moves, available actions, recent timeline events, relevant memory facts, and edition/policy info. AI GM narration can later attach to this payload, but it does not own truth.

Minimal Solo Scene UI Shell: the first UI surface should render that payload directly: location image placeholder, location description, visible inspectable entities, movement exits, structured action bar, recent timeline, relevant memory facts, and inspect details. It should stay spatial and server-truth-first, not raw chat-first, dashboard-first, final VTT clone, image-generation demo, or final IP theme.

Entity Detail Sheet: inspect panels should act like modern tabletop/RPG sheets: readable, familiar, structured, mobile-friendly, and themeable later around Akrij-approved IP. They should show only server-provided identity, summary, image references, stats, relationships, memories, tags, and available actions.

## 3. AI GM Scene Framing

The AI GM can generate or placeholder-generate scene text from current structured state.

AI GM input should include:

- Player state summary.
- Current location state.
- Relevant memory facts.
- Known NPC state.
- Recent timeline events.
- Allowed action surface.
- Safety policy.

AI GM output must not mutate state directly.

AI GM Scene Framing Contract: MVP narration is attached to the server scene payload through a validated, provider-agnostic contract. The GM input is filtered by edition/policy and contains only structured scene data: location, visible entities, moves, actions, recent timeline, and relevant memory facts. The accepted GM output is plain-text narration plus optional action labels and warnings; `stateMutations` must remain empty. A deterministic placeholder GM may be used for plumbing, but real providers and Akrij-approved lore voice come later.

Real AI Provider Adapter: provider-backed narration must stay feature-flagged and model-agnostic. The default path remains placeholder narration. When enabled, provider output is parsed, validated, sanitized, and rejected/fallbacked if it attempts state mutation, unsafe markup, policy leakage, or malformed output. Provider integration must not create lore, mutate saves, expose prompts/secrets, or lock NotDND to one vendor.

Accepted AI output for MVP:

- Scene narration.
- Suggested structured actions.
- Atmosphere and continuity notes.
- Optional recap.

Rejected AI output for MVP:

- New canonical lore not backed by memory/state.
- Unsupported items, rewards, NPC changes, location changes, or quest changes.
- Direct save mutation.
- Open-ended sexual or unsafe NPC behavior.

Validated outcomes are recorded separately by the system truth layer.

## 3.5 Consistency Contract

To stop AI drift:

- Canonical facts live in server state and memory facts.
- Entity/detail panels read from structured state.
- Movement and action resolvers create timeline events and memory facts.
- Future AI prompts must receive current location, visible entities, relevant memory facts, and allowed actions.
- AI GM narration cannot directly mutate durable truth.

## 4. Structured Action Resolution

Player choices/actions resolve through systems.

Actions can include:

- Move to connected location.
- Inspect a location/object.
- Talk to an NPC through a constrained action.
- Attempt a risky action using the dice/rules engine.
- Accept/refuse/advance a quest.
- Update an NPC relationship.
- Discover or record a fact.
- Create or update owned asset state.

The existing `server/rules/engine.js` dice/check functions can be reused. Results become structured timeline events and memory facts.

## 5. Memory Graph

Facts are recorded as durable notes/entities.

Entity types can include:

- `player`
- `npc`
- `location`
- `item`
- `quest`
- `faction`
- `event`
- `relationship`
- `asset`
- `base`

Facts should support:

- `id`
- `entityId`
- `type`
- `text`
- `source`
- `timestamp`
- `tags`
- `confidence`
- `canonical`
- `runId`
- `relatedEntityIds`

`server/gm/memoryStore.js` already supports several related entity types and retrieval. It can be reused or wrapped by a new solo/world memory layer.

## 6. NPC Relationship Model

MVP needs placeholder support for NPC memory and relationship state. It does not need open-ended AI NPC chat.

Relationship meters may include:

- `trust`
- `affection`
- `fear`
- `debt`
- `suspicion`
- `loyalty`
- `rivalry`

Use only meters appropriate to Akrij-approved content. NPCs should remember key events through memory facts and relationship deltas.

## 7. Player Asset/Base/Fortress Foundation

MVP does not need a full fortress builder.

It should define schema for a player-owned asset/base so future progression has a durable home.

Owned asset schema should be ready for:

- `id`
- `runId`
- `ownerUserId`
- `kind`
- `label`
- `locationId`
- `state`
- `level`
- `components`
- `rooms`
- `upgrades`
- `resources`
- `assetRefs`
- `memoryRefs`
- `createdAt`
- `updatedAt`

MVP may include one placeholder owned asset or future-claim state. The placeholder must not define canon.

## 8. Image Asset Layer

No real image generation is required in MVP unless already present and explicitly wired later.

Define asset metadata for:

- Location images.
- NPC portraits.
- Item art.
- Base/fortress images.
- Tile/environment images.
- Scene images.

Image asset metadata should support:

- `assetId`
- `targetType`
- `targetId`
- `runId`
- `status`
- `provider`
- `promptHash`
- `sourcePrompt`
- `imageUrl`
- `version`
- `canonicalVisualStateHash`
- `createdAt`
- `updatedAt`

Images must never block core gameplay. Missing images should degrade to placeholders.

## 9. Safety/Policy

The mainline product is mobile-safe.

MVP must avoid:

- Explicit sexual acts.
- Explicit anatomy.
- Rape or sexual assault.
- Trafficking.
- Sexual slavery.
- Erotic captivity.
- Player-controlled sexual coercion.
- Forced pregnancy or breeding themes.
- Non-consensual sexual content.

Future AI NPCs must be constrained by structured state, route boundaries, moderation, and safety logging.

## MVP Acceptance Criteria

- User can start a solo run.
- User can visit multiple locations.
- AI GM or placeholder GM frames a scene.
- User action resolves through structured systems.
- Outcome is stored in memory.
- NPC/location/player state persists after refresh.
- At least one relationship change persists.
- At least one location fact persists.
- At least one future base/fortress schema object exists.
- Tests prove memory/state integrity.

## Non-Goals

- No full multiplayer.
- No human-controlled NPCs.
- No real payments.
- No full VTT dependency.
- No open AI NPC runtime.
- No real image generation requirement.
- No canon lore authored by Codex.
- No raw AI chat-only gameplay.
- No image-generation-first tech demo.
- No full fortress builder in MVP.
