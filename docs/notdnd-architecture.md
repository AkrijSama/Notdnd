# NotDND Architecture

## 1. System Truth Layer

Responsible for:

- Player state.
- Locations.
- NPCs.
- Quests.
- Inventory/items.
- Dice/rules.
- Relationships.
- Base/fortress assets.
- Time/world tick.
- Server-authoritative save state.

Suggested repo area:

- New `server/game/*` for solo run schema, action resolution, effect application, location movement, relationship state, asset/base state, and world ticks.
- Existing `server/rules/engine.js` for dice/check resolution.
- Existing `server/db/repository.js` integration later for persistence and versioned operations.
- Existing `server/index.js` for API routes.

Rules:

- This layer is canonical for mutable game state.
- AI GM may request or suggest actions but must not directly mutate this layer.
- All persistent state changes must be validated, versioned, and testable.
- Placeholder data must remain clearly non-canon.
- Movement/action resolvers must create structured timeline events and memory facts so continuity is stored outside AI narration.

## 2. Memory Graph Layer

Responsible for:

- Obsidian-like persistent facts.
- Entity notes.
- Relationship memories.
- Location history.
- Quest history.
- Canonical world facts.
- Summaries and retrieval for AI GM.

Suggested repo area:

- Existing `server/gm/memoryStore.js` may be reused/adapted.
- New `server/world/memoryGraph.js` if a cleaner solo-focused wrapper is needed.
- Existing `data/campaigns/*/memory` pattern may inform `data/memory` or a server-managed JSON/markdown store later.

Memory model requirements:

- Facts need sources, timestamps, tags, related entities, confidence, and canonical status.
- AI-generated text is not canon by default.
- Akrij-authored facts can be marked canonical.
- System-derived facts from resolved actions can be canonical for that player run.
- Retrieval should prefer relevant canonical and run-specific facts.
- Repeated facts must dedupe or summarize instead of spamming memory.

## 3. AI GM Orchestration Layer

Responsible for:

- Scene framing.
- Choice/action suggestions.
- Atmosphere.
- Consequence narration.
- Recaps.
- Respecting canonical memory.

AI GM must not:

- Invent durable canon without recording/approval.
- Mutate game state directly.
- Override system truth.
- Generate unsupported rewards/items/NPC changes.
- Bypass safety policy.
- Become an open-ended AI NPC runtime for MVP.

Suggested repo area:

- `server/solo/gm.js` defines the solo scene GM contract and deterministic placeholder narration.
- `server/solo/gmProvider.js` defines the feature-flagged provider adapter and placeholder fallback path.
- Existing `server/gm/prompting.js` may be revised.
- Existing `server/ai/providers.js` may be reused.
- Existing `server/ai/openrouter.js` may be reused.
- Create new `server/gm/soloGm.js` for a constrained solo GM contract if needed.

Contract boundary:

- GM input is built from the validated solo scene payload and filtered by edition/policy.
- GM output is plain text narration, tone, sensory details, focus entity IDs, optional labels, and warnings.
- `stateMutations` must be empty; action resolvers and repository saves remain the only durable mutation path.
- Placeholder narration is allowed for plumbing. Real OpenAI/Anthropic/OpenRouter/Ollama adapters come later behind explicit provider selection and safety checks.
- Real provider calls are disabled unless `NOTDND_GM_PROVIDER_ENABLED=true`. Provider/model selection uses `NOTDND_GM_PROVIDER` and `NOTDND_GM_MODEL`, validates/sanitizes output, and falls back to placeholder narration on failure without exposing raw prompts, secrets, or provider errors to the client.
- GM narration quality is evaluated by deterministic checks in `server/solo/gmEval.js`: grounding to the current scene, no state mutation claims, no blocked mainline content, no unsafe markup, reasonable length, no raw JSON/table output, and no unavailable action suggestions.
- Safe provider smoke lives in `server/solo/gmSmoke.js`. It creates a neutral scene, attempts provider mode only when explicitly enabled/configured, validates/sanitizes/evaluates the result, and returns a safe summary without raw prompts, provider dumps, headers, stack traces, or env values.
- The committed `local` provider is a mock provider suitable for secret-free adapter smoke. Its output must still pass through the same validation, sanitization, evaluation, and prompt-leak prevention as external providers.
- `GET /api/solo/runs/:runId/gm-scene` returns `gmStatus` so UI can show placeholder/provider/fallback mode honestly. `?mode=placeholder` forces placeholder narration; `?mode=provider` requests provider mode but still falls back safely when disabled, misconfigured, failed, or invalid.

Prompt contract should include:

- Current solo run state.
- Current location.
- Visible entities in the current location.
- Relevant memory facts.
- Current NPC relationship state.
- Recent timeline.
- Allowed structured action IDs.
- Safety policy summary.
- Clear instruction that durable canon/state changes must come from system outputs, not freeform narration.

Output contract should include:

- `narration`
- `suggestedActions`
- `recapFacts`
- `needsImageRefresh`
- `safetyFlags`

State mutation still happens only through the action resolver.

Anti-drift rule: the AI GM reads server truth and memory, then narrates. It is not the database, not the rules engine, and not the authority for location/entity changes.

## 4. Asset/Image Layer

Responsible for:

- Location images.
- Tile/environment images.
- NPC portraits.
- Item art.
- Base/fortress images.
- Generated/cached metadata.
- Versioning when world state changes.

No actual generation is required in the current ticket.

Suggested repo area:

- New `server/assets/*` for asset metadata, version rules, and generation queue design.
- Later `public/generated` or `data/assets` for generated files/metadata.
- Existing `server/ai/providers.js` image provider support may be reused later.
- Existing VTT `imageUrl` fields show a prior placeholder path but should not become the whole asset system.

Rules:

- Gameplay cannot depend on image generation success.
- Assets have target type and target ID.
- Asset versions should change when canonical visual state changes.
- Prompts and provider metadata should be stored carefully without secrets.
- Real generation calls are not MVP unless explicitly approved.

## 5. Player Experience Layer

Responsible for:

- Solo run UI.
- Location view.
- GM narration.
- Choice/action input.
- Stats/memory recap.
- NPC relationship panel.
- Base/fortress panel later.

Suggested repo area:

- New `src/components/soloGameShell.js`.
- New `src/components/locationView.js`.
- New `src/components/gmScene.js`.
- New `src/components/npcPanel.js`.
- New `src/components/worldMemoryPanel.js`.
- Existing `src/state/store.js` for client state methods.
- Existing `src/api/client.js` for API calls.

Rules:

- MVP player front door should be solo run first.
- Existing dashboard/VTT/forge surfaces can remain but should be marked legacy/internal for MVP.
- Location movement should be lightweight and not require full VTT controls.
- Natural language input should be constrained or secondary until structured action resolution is reliable.
- The target scene is spatial and inspectable: location image reference, location name/description, movement controls, visible clickable entities, available structured actions, and GM narration derived from state.
- The action bar should be generated from server-provided structured actions: movement first, then inspect, talk, search, interact, use item, rest, enter, and exit as resolvers become real.
- Search Area is the first deterministic non-movement gameplay verb: it reveals only pre-existing structured `searchDetails`, logs timeline/memory when a real detail is discovered, and never calls AI or invents lore, items, NPCs, exits, or quests.
- Talk is a deterministic NPC verb: it targets visible NPCs, reveals only pre-existing `dialogueBeats`, may use optional ability checks, logs timeline/memory for new meaningful information, and never calls AI or becomes freeform chat.
- Rules adjudication is server-side through a ruleset adapter. The current adapter supports a small 5e-style ability-check contract for actions, not full 5e; future `5e_srd` or custom rules can plug into the same action resolver path.
- Character and entity detail panels should be modern, tabletop-readable, mobile-friendly, and Roll20/DND-adjacent in mental model. They should read server entities, relationships, memory facts, status, inventory/equipment, recent timeline, and available actions from structured state.
- The UI should request one solo scene payload for the current screen: location image reference, location description, visible entities, moves, actions, recent timeline, relevant memory facts, and policy/edition lane. AI GM narration can later be layered onto that payload but must not replace it.
- The minimal scene shell should render from this payload before final theme work: image placeholder, description, exits, visible entities, action bar, memory/timeline, and inspect detail payloads.
- Entity detail sheets should stay structured and themeable: image placeholder, title/type, summary, stats, relationships, memories, tags, and server-provided actions. They must not become raw JSON dumps or frontend-authored lore.
- Do not let the MVP drift into raw AI chat-only gameplay, BitLife-only pacing, VN-only routes, image-generation-first demos, full multiplayer, full fortress building, or human NPC platform work.

## 6. Premium Social Layer Later

Responsible for:

- Premium AI NPCs.
- Human-controlled NPC sessions.
- Live events.
- Moderation.
- Safety logging.
- Scheduling/access control.

Not MVP.

Suggested future repo area:

- New `server/social/*` only after explicit approval.
- Existing `server/realtime/wsHub.js` may be reused later for live presence, server-driven events, and human NPC sessions.
- Existing auth/session infrastructure can support access control later.

Rules:

- No human-controlled NPC implementation until core solo campaign traction exists.
- No open AI NPC chat until the constrained AI GM, memory, and safety contracts are proven.
- No payment SDK in current architecture work.
