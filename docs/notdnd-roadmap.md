# NotDND Roadmap

## Phase 0 - Product Realignment

Goal:

Realign repo/product docs around persistent solo AI-GM sandbox.

Deliverables:

- Product spine.
- MVP spec.
- Architecture doc.
- Roadmap.
- Content safety policy.
- Old VTT/AI-dashboard marked legacy/internal.

Do not build:

- New UI.
- Payments.
- Multiplayer.
- Real image generation.

Proof:

- `docs/notdnd-product-spine.md` exists.
- `docs/notdnd-mvp-spec.md` exists.
- `docs/notdnd-architecture.md` exists.
- `docs/notdnd-roadmap.md` exists.
- `docs/content-safety-policy.md` exists.

## Phase 1 - Server-Authoritative Solo Run Skeleton

Goal:

A user can start/load a solo run with player state, world seed, current location, and timeline.

Deliverables:

- Solo run schema.
- Repository persistence methods.
- Start/load API routes.
- Tests.

Proof:

- Start run.
- Refresh/load run.
- State persists.

## Phase 2 - Location Graph + Movement

Goal:

Player can move between connected locations.

Deliverables:

- Location schema.
- Location connection graph.
- `currentLocationId`.
- Movement action.
- Location memory stub.
- Image asset placeholder metadata.

Proof:

- Player moves location A -> B.
- Location state persists.
- Movement creates memory event.

## Phase 3 - Structured Action + Dice Resolution

Goal:

Player actions resolve through systems before AI narration.

Deliverables:

- Action schema.
- Requirement checks.
- Dice/rules integration.
- Effect application.
- Event timeline.

Proof:

- Action changes player/NPC/location state.
- Roll is deterministic in tests.
- Event is recorded.

## Phase 4 - AI GM Scene Framing

Goal:

AI GM frames scenes using structured state/memory.

Deliverables:

- Solo GM prompt contract.
- Placeholder provider support.
- Real provider path behind existing env/provider system.
- AI output schema.
- No direct mutation from AI.

Proof:

- Prompt includes current location, player state, known facts.
- Output is scene narration + suggested actions.
- State mutation still happens only through action resolver.

## Phase 5 - Memory Graph / Obsidian Backbone

Goal:

World facts are durable, retrievable, and integrity-safe.

Deliverables:

- Entity/fact model.
- Canonical fact records.
- Relationship memories.
- Location histories.
- Quest facts.
- Retrieval helpers.
- Memory tests.

Proof:

- NPC remembers event.
- Location remembers change.
- Memory retrieval returns relevant facts.
- No duplicate spam for repeated facts.

## Phase 6 - NPC Relationship System

Goal:

NPCs become persistent relationship entities.

Deliverables:

- NPC schema.
- Relationship meters.
- Relationship memory facts.
- NPC state changes from actions.
- NPC panel later.

Proof:

- Action changes NPC trust/fear/debt/etc.
- Later scene can retrieve prior NPC memory.
- NPC relationship persists after refresh.

## Phase 7 - Player Asset/Base/Fortress Foundation

Goal:

Player can own/build/upgrade a persistent asset.

Deliverables:

- Base/fortress schema.
- Owned asset state.
- Upgrade/component model.
- Resource hooks.
- Location tie-in.

Proof:

- Player asset can be created.
- Upgrade can be applied.
- Asset appears in memory/state.
- State persists.

## Phase 8 - Image Asset Metadata + Cache Plan

Goal:

Prepare for AI images without making gameplay dependent on generation.

Deliverables:

- Asset metadata schema.
- Image target types: location, NPC, item, base, scene.
- Cache/version rules.
- Placeholder image refs.
- Future generation queue design.

Proof:

- Location/NPC/item can reference image metadata.
- Version changes when canonical visual state changes.
- Gameplay still works without images.

## Phase 9 - Premium Foundations Later

Goal:

Prepare premium systems without payment implementation.

Deliverables:

- Entitlement schema.
- Premium route flags.
- AI NPC access model.
- Human NPC session model.
- Moderation/safety requirements.

Proof:

- Premium flags can gate non-critical content.
- No real payment SDK.
- No live human NPC implementation.

## Phase 10 - Human-Controlled NPCs Later

Goal:

Design-only until core game has traction.

Deliverables:

- Live NPC session design.
- Scheduling.
- Moderation.
- GM tooling.
- Audit logs.
- Safety boundaries.

Do not implement until explicitly approved.

## Machinable First Tickets

### 1. Product Spine Realignment

Goal:

Move product language from VTT/dashboard-first to persistent solo AI-GM sandbox.

Likely files/modules:

- `README.md`
- `notdnd/index.html`
- `src/components/topbar.js`
- `src/components/sidebar.js`
- `docs/notdnd-product-spine.md`

Acceptance criteria:

- Docs define NotDND as persistent solo AI-GM fantasy sandbox.
- VTT, campaign forge, and AI dashboard surfaces are marked legacy/internal for MVP.
- Product copy no longer presents the MVP as a generic AI DND chatbot.
- Lore rule is visible.

Proof required:

- Documentation diff.
- No runtime behavior changed unless explicitly requested.

What not to build:

- New UI.
- Multiplayer.
- Payments.
- Image generation.

### 2. Solo Run Schema

Goal:

Define the server-authoritative solo run shape.

Likely files/modules:

- New `server/solo/schema.js`
- New `tests/solo-run.test.js`
- Later `server/db/repository.js`

Acceptance criteria:

- Schema includes run ID, owner user ID, player state, world seed, current location, timeline, state version, timestamps.
- Uses neutral placeholder values only.
- Invalid run records fail validation.

Proof required:

- Unit tests validate a minimal solo run and reject malformed records.

What not to build:

- API routes.
- UI.
- AI GM.
- Lore content.

### 3. Solo Run Persistence API

Goal:

Persist and load solo runs through the existing server.

Likely files/modules:

- `server/db/repository.js`
- `server/index.js`
- `src/api/client.js`
- `tests/solo-run.test.js`

Acceptance criteria:

- Authenticated user can start a solo run.
- Authenticated user can load own solo run.
- State persists after process-level repository reload in tests.
- Other users cannot read/write the run.

Proof required:

- Repository/API tests.

What not to build:

- Movement.
- AI GM.
- Multiplayer roles.
- Payment/entitlements.

### 4. Location Graph Schema

Goal:

Define location state and connections for solo runs.

Likely files/modules:

- New `server/world/locationSchema.js`
- New `server/world/seedWorld.js`
- `tests/solo-run.test.js`

Acceptance criteria:

- Location records include ID, label/title placeholder, type, state, connections, memory refs, asset refs.
- Graph validation catches missing target IDs.
- No canon place names are hardcoded.

Proof required:

- Unit tests validate a 3-location neutral graph.

What not to build:

- VTT map UI.
- Tactical movement.
- AI-generated locations.

### 5. Movement Action Resolver

Goal:

Move a player between connected locations through structured system resolution.

Likely files/modules:

- New `server/solo/actions.js`
- New `server/world/movement.js`
- `server/db/repository.js`
- `tests/solo-run.test.js`

Acceptance criteria:

- Movement only succeeds along valid connections.
- `currentLocationId` updates.
- Timeline event records movement.
- Location memory fact is queued or written.
- Destination visit/discovery state is updated by the resolver, not by AI narration.
- Movement preserves location image metadata and edition/policy lane metadata for the future spatial scene UI.

Proof required:

- Tests for valid move, invalid move, memory/timeline writes, policy-lane rejection, and resulting run validation.

What not to build:

- Pathfinding.
- Full tile renderer.
- Multiplayer presence.
- Raw AI chat movement.
- Image generation.

### 6. Structured Action Dispatcher

Goal:

Create the structured action pipeline and persist move actions through the server before broader action types are implemented.

Likely files/modules:

- New `server/solo/actionResolver.js`
- `server/rules/engine.js`
- `server/db/repository.js`
- `tests/solo-run.test.js`

Acceptance criteria:

- Server returns structured actions for the future action bar.
- `move` resolves through the movement resolver and persists through the solo run repository.
- Recognized future actions return `ACTION_NOT_IMPLEMENTED` instead of fake success.
- AI text cannot apply effects directly.

Proof required:

- Tests show a move action changing location, recording event/memory fact, saving the run, and returning available actions.

What not to build:

- Open natural-language parser.
- Full combat system.
- AI NPC chat.

### 7. Inspect / Visible Entity Foundation

Goal:

Expose visible, inspectable entities in the current location from structured server state.

Likely files/modules:

- New `server/solo/entities.js`
- `server/solo/actions.js`
- `tests/solo-run-entities.test.js`
- `tests/solo-run-actions.test.js`

Acceptance criteria:

- Current location appears as an inspectable entity.
- NPCs at the current location appear as visible inspectable entities.
- Hidden or different-location entities are excluded.
- Inspect returns structured detail payloads from server truth.
- Mainline/forbidden policy lanes are respected.

Proof required:

- Tests for visible entity derivation, inspect payloads, policy filtering, and read-only inspect actions.

What not to build:

- UI panels.
- AI-generated descriptions.
- Full inventory, combat, or character sheet mechanics.

### 8. Solo Scene Payload

Goal:

Create the server payload future UI and AI GM context will consume.

Likely files/modules:

- New `server/solo/scene.js`
- Existing `server/solo/entities.js`
- Existing `server/solo/actions.js`
- Existing `server/solo/movement.js`
- `tests/solo-run-scene.test.js`

Acceptance criteria:

- Payload includes current location, image asset reference, description, visible entities, moves, actions, recent timeline, relevant memory facts, and policy/edition lane.
- Payload is built from server truth, not AI narration.
- Mainline/forbidden filtering applies to entities, facts, events, moves, and actions.
- UI hints identify the target as a spatial scene with action bar and entity panel.

Proof required:

- Tests for default payload, invalid location, policy filtering, memory/timeline inclusion, validation, and deterministic shape.

What not to build:

- UI shell.
- AI GM scene generation.
- Image generation/display.

### 9. Minimal Solo Scene UI Shell

Goal:

Render the server-built solo scene payload as the first playable visual surface.

Likely files/modules:

- New `src/components/soloSceneShell.js`
- New `src/components/soloSceneApi.js`
- Existing `src/api/client.js`
- Existing `src/main.js` only for a small mount hook.
- New UI/helper tests if no browser test harness exists.

Acceptance criteria:

- The shell renders current location, image placeholder, description, visible entities, movement exits, action bar, recent timeline, relevant memory facts, and inspect details.
- Movement posts a structured `move` action and refreshes the scene.
- Inspect posts a structured `inspect` action and shows the returned detail payload.
- Disabled future actions remain visible but not clickable.
- The UI reads server scene truth instead of inventing location, entity, movement, or memory data.

Proof required:

- Unit/helper tests for render and API helper behavior.
- `npm run check`.
- `npm run unit`.

What not to build:

- Final art/theme.
- AI GM scene generation.
- Image generation/display pipeline.
- Full talk/search/use/rest actions.
- Character sheet UI.

### 10. Solo Scene UX Polish + Character/Entity Detail Panel

Goal:

Improve the mounted solo scene shell so it reads like an early playable RPG/tabletop screen.

Likely files/modules:

- Existing `src/components/soloSceneShell.js`
- Existing `src/styles.css`
- Existing `tests/solo-scene-ui.test.js`

Acceptance criteria:

- Location, image placeholder, exits, entities, action bar, timeline, and memory panels are visually organized.
- Entity cards can be clicked to inspect.
- Selected entity state is visible.
- Inspect detail panel reads like a structured tabletop/RPG sheet, not a raw JSON dump.
- Missing stats, relationships, memories, and images show neutral empty states.
- Layout remains mobile-friendly and themeable later.

Proof required:

- UI helper tests.
- Browser screenshot proof.
- `npm run check`.
- `npm run unit`.

What not to build:

- AI GM narration.
- Final character sheet system.
- Final theme or Akrij lore.
- New gameplay actions.

### 11. Placeholder GM Scene Generator

Goal:

Define the AI GM scene framing contract and generate deterministic placeholder narration without requiring real AI.

Likely files/modules:

- New `server/solo/gm.js`
- Existing `server/solo/scene.js`
- Existing `src/components/soloSceneShell.js`
- New `tests/solo-run-gm.test.js`
- Existing `tests/solo-scene-ui.test.js`

Acceptance criteria:

- GM input is built from the validated solo scene payload.
- GM input includes edition/policy, location, visible entities, moves, actions, recent timeline, and relevant memory facts.
- Mainline GM input excludes forbidden entities/facts and blocked content tags.
- GM output validates as plain-text narration with supported tone, optional labels/warnings, and empty `stateMutations`.
- Placeholder GM returns deterministic neutral narration.
- Scene payload can optionally include placeholder GM narration.
- UI renders GM narration when present and keeps the fallback when absent.

Proof required:

- Unit tests verify input shape, policy filtering, output validation, sanitization, deterministic placeholder narration, unchanged scene/run state, optional scene integration, and UI rendering.

What not to build:

- Real provider calls.
- Real image generation.
- Open-ended chat.
- Final Akrij lore voice.
- AI-owned state mutation.
- NPC romance runtime.

### 12. Real AI Provider Adapter for GM Narration

Goal:

Route GM narration through a feature-flagged, model-agnostic provider adapter while preserving placeholder fallback.

Likely files/modules:

- New `server/solo/gmProvider.js`
- Existing `server/solo/gm.js`
- Existing `server/index.js`
- New `tests/solo-run-gm-provider.test.js`
- Existing `tests/solo-run-gm-api.test.js`

Acceptance criteria:

- Real provider calls are disabled by default.
- `NOTDND_GM_PROVIDER_ENABLED`, `NOTDND_GM_PROVIDER`, and `NOTDND_GM_MODEL` control provider mode.
- Provider prompts are built from filtered GM scene input, not raw database state.
- Output is parsed, validated, sanitized, and rejected/fallbacked if malformed, unsafe, or state-mutating.
- Provider failures return safe placeholder narration with warning codes.
- Mainline/forbidden policy filters apply before provider calls.

Proof required:

- Unit tests use fake provider functions and no real network calls.
- API tests verify route default/fallback behavior and no raw prompt/provider dump.

What not to build:

- Provider-specific prompt tuning.
- Real-provider smoke unless safe local config exists.
- Freeform chat.
- Lore voice finalization.

### 13. GM Prompt Quality Pass + Narration Evaluation Harness

Goal:

Improve provider prompt instructions and add a deterministic quality harness for GM narration.

Likely files/modules:

- Existing `server/solo/gmProvider.js`
- Existing `server/solo/gm.js`
- New `server/solo/gmEval.js`
- New `tests/fixtures/solo-gm-scenes.js`
- New `tests/solo-run-gm-eval.test.js`
- Existing `tests/solo-run-gm-provider.test.js`

Acceptance criteria:

- Provider messages clearly define NotDND's GM role, server scene payload as truth, concise tabletop-GM style, no lore invention, no state mutation, no unavailable actions, and the JSON output contract.
- Evaluation checks are deterministic and non-AI.
- Evaluation covers grounding, policy safety, mutation safety, style/readability, blocked mainline content, unsafe markup, unknown focus entities, and unavailable action suggestions.
- Neutral sample scene fixtures can evaluate placeholder and future provider outputs without Akrij canon.

Proof required:

- Unit tests verify prompt instructions, filtered mainline prompt inputs, no secret/env leakage, valid output scoring, mutation rejection, policy rejection, style failures, and deterministic scores.

What not to build:

- Real provider calls.
- AI-judged evaluation.
- Final lore voice.
- Model-specific prompt tuning.

### 10. NPC Relationship State

Goal:

Track persistent NPC relationship meters and memories.

Likely files/modules:

- New `server/world/npcSchema.js`
- New `server/world/relationships.js`
- New or existing memory graph tests.

Acceptance criteria:

- NPC records can store neutral placeholder identity, state, and relationship meters.
- Supported meters include trust, affection, fear, debt, suspicion, loyalty, rivalry.
- Relationship changes produce memory facts.

Proof required:

- Tests for relationship delta, bounds/clamping, persistence, and memory fact creation.

What not to build:

- AI NPC free chat.
- Canon NPCs.
- Romance scenes.

### 11. Player Asset/Base Schema

Goal:

Define player-owned asset/base state for future fortress/base progression.

Likely files/modules:

- New `server/world/ownedAssets.js`
- New tests.

Acceptance criteria:

- Owned asset record supports kind, location ID, level, state, components, rooms, upgrades, resources, asset refs, memory refs.
- One neutral placeholder asset can exist in a test run.
- Upgrade application can be represented without UI.

Proof required:

- Unit tests validate schema and a simple upgrade state change.

What not to build:

- Fortress builder UI.
- Economy.
- Canon base names.

### 12. Image Asset Metadata Schema

Goal:

Prepare image metadata/cache design without real generation.

Likely files/modules:

- New `server/assets/schema.js`
- New `server/assets/assetStore.js`
- Tests.

Acceptance criteria:

- Asset metadata supports target type, target ID, run ID, status, provider, prompt hash, image URL, version, visual state hash, timestamps.
- Target types include location, NPC, item, base, scene.
- Missing image refs degrade to placeholder.

Proof required:

- Unit tests validate metadata and version bump rules.

What not to build:

- Real generation calls.
- Image upload UI.
- Public CDN integration.

### 13. Safety Policy Enforcement/Linting

Goal:

Make safety rules testable before AI/human NPC expansion.

Likely files/modules:

- New `server/safety/contentPolicy.js`
- `docs/content-safety-policy.md`
- Tests.

Acceptance criteria:

- Red-zone categories are represented in a policy module.
- Authored content and AI output can be linted for blocked patterns.
- Yellow-zone content can produce warnings.

Proof required:

- Tests for red-zone block and yellow-zone warning examples using neutral synthetic strings.

What not to build:

- Full moderation vendor integration.
- User report system.
- Human NPC moderation console.

### 14. Legacy UI Demotion Plan

Goal:

Plan how to keep old VTT/campaign code without making it the MVP front door.

Likely files/modules:

- `src/main.js`
- `src/components/topbar.js`
- `src/components/sidebar.js`
- `src/components/commandCenter.js`
- `src/components/vttTable.js`
- `src/components/campaignForge.js`

Acceptance criteria:

- Written plan identifies which tabs become internal/legacy.
- Solo run shell is the intended default route after implementation.
- No legacy code is deleted.

Proof required:

- Doc/update ticket approved before UI work.

What not to build:

- Full UI rewrite.
- Removing VTT.
- Multiplayer features.
