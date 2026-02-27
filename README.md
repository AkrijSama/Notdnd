# Notdnd

Notdnd is a scaffold for a unified tabletop platform combining:

- Roll20-style VTT controls (grid map, tokens, initiative)
- D&D Beyond-style content flows (campaign, books, character vault, compendium)
- AI GM orchestration with provider adapters (GM/image/voice)
- Homebrew ingest so a campaign can be prepared quickly

## Implemented in this pass

- Backend API server (`Node.js` built-ins, no framework dependency)
- SQLite schema blueprint + file-backed runtime datastore (`server/db/notdnd.db.json`) for zero-dependency execution
- Realtime collaboration via WebSockets (campaign rooms + state change broadcast)
- AI adapter layer with providers:
  - `placeholder`
  - `local-mock`
  - `openai-compatible` (env-driven endpoint)
- Frontend store sync to backend operations and realtime refresh
- End-to-end **5-minute campaign quickstart**:
  - Upload homebrew files (`.md`, `.txt`, `.json`)
  - Parse classes/monsters/spells/NPCs/locations
  - Confidence scoring + review gate before launch
  - Auto-generate campaign package (books, characters, map, encounter, tokens, initiative, starter chat)
  - One-click launch to VTT tab

## Run

```bash
npm run dev
```

Open `http://localhost:4173`.

## Key folders

- `server/index.js`: HTTP + API + static hosting + websocket upgrade
- `server/db/schema.sql`: normalized SQL schema blueprint for campaigns/books/sheets/maps/tokens/chat/AI jobs
- `server/db/seed.sql`: SQL seed blueprint
- `server/db/repository.js`: runtime operation processor + state projection + persistence
- `server/db/seedState.js`: runtime seed data
- `server/realtime/wsHub.js`: websocket room and broadcast hub
- `server/ai/providers.js`: pluggable provider adapters
- `server/ai/processor.js`: async AI job worker
- `server/homebrew/parser.js`: homebrew ingest parser
- `server/homebrew/homebrew.schema.json`: canonical JSON schema contract
- `server/homebrew/schema.js`: schema validator helpers
- `server/campaign/quickstart.js`: campaign package generator blueprint
- `server/api/quickstartRoutes.js`: route-level quickstart parse/build handlers
- `src/state/store.js`: optimistic local state + backend sync
- `src/api/client.js`: frontend API client
- `src/realtime/client.js`: frontend websocket client

## API surface

- `GET /api/health`
- `GET /api/state`
- `GET /api/ai/providers`
- `POST /api/ops` with `{ op, payload }`
- `POST /api/ai/generate` for direct provider calls
- `POST /api/quickstart/parse` with `{ files[] }`
- `POST /api/quickstart/build` with `{ campaignName, setting, players[], files[] }` or `{ ... , parsed }`
- `WS /ws?campaignId=<id>` for realtime state change signals

## Canonical homebrew JSON contract

Use the schema at `server/homebrew/homebrew.schema.json`:

```json
{
  "schemaVersion": "1.0",
  "book": {
    "title": "Book Title",
    "tags": ["tag-a", "tag-b"],
    "chapters": ["Overview", "Bestiary"]
  },
  "entities": {
    "classes": [],
    "monsters": [],
    "spells": [],
    "npcs": [],
    "locations": []
  }
}
```

## Testing

```bash
npm run verify
```

This runs:
- Syntax checks across `src/`, `server/`, and `tests/`
- Fixture-driven parser tests
- Route contract tests for quickstart parse/build handlers
- Quickstart build integration tests against fixture corpus

## Placeholder config fields

Values still intentionally placeholder-based for integration wiring:

- `AI_GM_PROVIDER_NAME`
- `AI_GM_MODEL_VALUE`
- `IMAGE_PROVIDER_NAME`
- `IMAGE_MODEL_VALUE`
- `VOICE_PROVIDER_NAME`
- `VOICE_MODEL_VALUE`
- `CAMPAIGN_COVER_PLACEHOLDER_URL`
- `TOKEN_PLACEHOLDER_URL`

See `config/placeholders.json`.

## Optional AI env vars

- `NOTDND_AI_PROVIDER` (default: `placeholder`)
- `NOTDND_AI_ENDPOINT` (for `openai-compatible` provider)
- `NOTDND_AI_API_KEY`
- `NOTDND_AI_GM_MODEL`
- `NOTDND_AI_IMAGE_MODEL`
- `NOTDND_AI_VOICE_MODEL`
