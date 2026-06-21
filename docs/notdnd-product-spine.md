# NotDND Product Spine

## Product Definition

NotDND is a persistent solo AI-GM fantasy sandbox.

The player starts a solo fantasy campaign that runs on server-authoritative game state, durable world memory, structured action resolution, and constrained AI GM narration. The player should feel like they are inside a solo DND-style campaign that remembers them, not inside a generic chatbot, a pure VTT, or a static visual novel.

The product spine is:

Game systems are truth. Memory graph is continuity. AI GM is narrator/orchestrator. Images are immersion assets. Human NPCs are a future premium layer.

## What NotDND Is

- A solo campaign experience where one player can start, continue, and grow a persistent fantasy run.
- A server-authoritative persistent world with durable save state.
- An AI GM-guided scene system that frames situations from structured state and memory.
- A structured action and consequence game where important outcomes are resolved by systems, not by AI improvisation alone.
- A long-term memory graph for world facts, player history, NPC memories, relationship facts, location history, quests, and owned assets.
- An NPC relationship sandbox where NPCs remember key events and relationship meters change over time.
- A location movement experience where the player can move through connected places and see persistent local state.
- An image-assisted immersion layer for locations, NPCs, items, scenes, and player-owned assets.
- A progression space for player-built assets such as a base, fortress, lab, stronghold, or other approved long-term holdings.
- A future premium platform for constrained AI NPCs, human-controlled NPCs, and live events after the solo core works.

## What NotDND Is Not

- Not a generic AI chatbot.
- Not a pure VTT.
- Not a pure BitLife clone.
- Not a visual-novel-first romance app.
- Not multiplayer-first.
- Not a full NSFW mobile product.
- Not a lore-authoring system without Akrij approval.
- Not a place where AI creates durable canon by accident.
- Not a system where AI can directly mutate game state without validation.

## Lore Rule

Akrij is the Loremaster.

Systems can define structure. Codex and implementation work can define schemas, placeholders, validation, workflows, UI shells, and test fixtures. Codex must not invent canon factions, gods, cities, cosmology, main NPCs, plot arcs, world history, or Alchemist God details unless Akrij explicitly provides or approves them.

Placeholder content must be clearly neutral and disposable. The architecture should be lore-ready, not lore-authoring.

## Core Product Loop

Player enters location

-> AI GM frames scene using structured memory/state

-> player chooses or enters constrained action

-> game systems resolve outcome

-> memory graph records facts

-> NPC/location/world state changes

-> image/assets update only if needed

-> next scene opens

The AI GM may describe, summarize, suggest, and dramatize. The system truth layer decides what actually changed.

## MVP Design Goal

MVP proves:

- Solo campaign play feels coherent.
- The world remembers choices.
- NPCs remember relationships.
- Locations persist state.
- AI GM narrates within constraints.
- Player can make progress toward a long-term goal.
- Structured state can feed AI GM prompts.
- Structured outcomes can feed memory.
- Image metadata can exist without blocking play.
- Player-owned assets can exist as schema-backed future progression.
- No full multiplayer, no human NPCs, and no payment systems yet.

## Current Repo Alignment

The current repo already contains useful infrastructure:

- `server/db/repository.js` has JSON persistence, auth/session logic, role checks, and versioned operations.
- `server/gm/memoryStore.js` has filesystem-backed entity memory and retrieval.
- `server/gm/prompting.js` has an existing GM pipeline that can inform a future constrained solo GM layer.
- `server/ai/providers.js` and `server/ai/openrouter.js` provide provider wrappers and placeholder paths.
- `server/rules/engine.js` has dice/check/attack resolution that can support structured actions.
- `server/realtime/wsHub.js` can remain for future server-driven updates and later premium social layers.
- `src/components/aiGmConsole.js` proves GM/memory UI concepts, but it is not the desired player front door.
- `src/components/vttTable.js` is legacy/internal for MVP; location movement should not require full VTT play.

The current product language still over-indexes on VTT, campaign dashboard, and AI DND cockpit. The next work should create a solo campaign layer beside the legacy code, not delete the legacy code.
