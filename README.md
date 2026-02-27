# Notdnd

Notdnd is a unified tabletop platform scaffold combining:

- Roll20-style VTT controls (grid map, tokens, initiative)
- D&D Beyond-style content flows (campaign, books, character vault, compendium)
- AI GM orchestration with provider adapters (GM/image/voice)
- Homebrew ingest and one-click campaign bootstrapping

## Roadmap

### Completed

- Auth, sessions, campaign roles, and versioned state sync
- Server-authoritative realtime with presence, cursors, and resource locks
- Homebrew ingest from files and URLs with parse diagnostics
- Quickstart generation for campaigns, scenes, encounters, journals, maps, and starter options
- Human GM and Agent GM runtime modes
- Filesystem-backed GM memory docs with smart keyword retrieval
- Provider/model selection for `local`, `ChatGPT`, `Grok`, `Gemini`, and placeholders
- Live verification stack:
  - unit/integration tests
  - localhost smoke automation
  - browser E2E automation

### In Progress

- Deepening the homebrew-to-ready-campaign pipeline so books produce richer scene and encounter packages
- Hardening browser E2E and CI around the new quickstart/GM runtime surfaces

### Next

1. CI artifact reporting for smoke/E2E failures
2. Real asset upload and scene background management beyond placeholder URLs
3. Full character-sheet progression and inventory/spell/action systems
4. Richer GM assist outputs using provider-specific structured prompting
5. Deployment packaging for a persistent hosted environment

## Completed platform scope in this repo

- Backend API server (`Node.js` built-ins, no framework dependency)
- Runtime datastore (`server/db/notdnd.db.json`) with SQL blueprint references
- Authentication and sessions (register/login/me/logout)
- Campaign role permissions (`owner`, `gm`, `editor`, `player`, `viewer`)
- Campaign member management (invite/add by role)
- Versioned state writes with conflict detection (`VERSION_CONFLICT`)
- Realtime collaboration via WebSockets (campaign room change events)
- AI adapter layer with providers:
  - `placeholder`
  - `local`
  - `chatgpt`
  - `grok`
  - `gemini`
- End-to-end **5-minute campaign quickstart**:
  - Upload homebrew files (`.md`, `.txt`, `.json`)
  - Parse entities + indexes + confidence diagnostics + review gate
  - Generate campaign package (books, characters, scenes, maps, encounters, journals, tokens, initiative, chat)
  - Launch directly to VTT tab
- Gameplay mechanics:
  - Dice expression engine (`2d20kh1+5`, checks, attack+damage resolution)
  - Campaign journal/handouts with visibility controls
  - Fog-of-war reveal toggles on map cells
- GM runtime:
  - Human GM assist mode
  - Agent GM mode
  - Markdown campaign memory docs
  - Keyword-based memory retrieval
- Homebrew URL import:
  - Fetch and parse remote markdown/txt/json source URLs directly
- CI workflow, smoke automation, browser E2E, backup and restore scripts

## Run

```bash
npm run dev
```

Open `http://127.0.0.1:4173`.

Default bootstrap account:

- `demo@notdnd.local`
- `demo1234`

Configure different bootstrap credentials with:

- `NOTDND_BOOTSTRAP_EMAIL`
- `NOTDND_BOOTSTRAP_PASSWORD`
- `NOTDND_BOOTSTRAP_DISPLAY_NAME`

## Key folders

- `server/index.js`: HTTP + API + static hosting + websocket upgrade
- `server/db/repository.js`: runtime persistence, auth/session logic, permissions, operations
- `server/db/schema.sql`: normalized SQL schema blueprint
- `server/db/seed.sql`: SQL seed blueprint
- `server/realtime/wsHub.js`: websocket room and broadcast hub
- `server/homebrew/parser.js`: homebrew parser + confidence diagnostics
- `server/homebrew/homebrew.schema.json`: canonical homebrew schema contract
- `server/campaign/quickstart.js`: campaign package generator blueprint
- `server/rules/engine.js`: dice/check/attack rules engine
- `server/homebrew/urlImport.js`: remote URL fetch/import guardrails
- `server/gm/memoryStore.js`: markdown campaign memory docs + keyword retrieval
- `server/gm/prompting.js`: GM assist and agent prompt composition
- `src/state/store.js`: optimistic state + version-aware backend sync
- `src/api/client.js`: auth/token-aware API client
- `src/realtime/client.js`: auth-token websocket client
- `scripts/smoke.mjs`: live localhost API/realtime smoke suite
- `scripts/e2e.mjs`: browser-level end-to-end suite
- `tests/fixtures/homebrew/*`: parser/build fixture corpus

## API surface

Public:

- `GET /api/health`
- `POST /api/auth/register`
- `POST /api/auth/login`

Authenticated:

- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/state`
- `POST /api/ops` with `{ op, payload, expectedVersion }`
- `GET /api/campaign/members?campaignId=...`
- `POST /api/campaign/members` with `{ campaignId, email, role }`
- `GET /api/ai/providers`
- `POST /api/ai/generate`
- `POST /api/quickstart/parse` with `{ files[] }`
- `POST /api/quickstart/build` with `{ campaignName, setting, players[], files[] }` or `{ ... , parsed }`
- `POST /api/homebrew/import-url` with `{ url }`
- `GET /api/gm/memory?campaignId=...`
- `POST /api/gm/memory` with `{ campaignId, docKey, content }`
- `POST /api/gm/memory/search` with `{ campaignId, query, docKey?, limit? }`
- `POST /api/gm/respond`
- `GET /api/metrics` (admin only)

Realtime:

- `WS /ws?campaignId=<id>&token=<sessionToken>`

## Canonical homebrew JSON contract

Use `server/homebrew/homebrew.schema.json`:

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
npm run smoke
npm run e2e
```

This runs:

- Syntax checks across `src/`, `server/`, and `tests/`
- Fixture-driven parser tests
- Schema contract tests
- Route contract tests for quickstart parse/build handlers
- Fixture-driven quickstart build integration tests
- Auth/permissions/version conflict tests
- Rules engine tests
- Gameplay operation tests (rolls/journal/fog permissions)
- URL import validation/fetch tests
- Localhost smoke verification for auth, GM runtime, quickstart, and realtime
- Browser E2E verification for GM runtime, quickstart launch, and cross-user presence

## Ops and deployment

Backup and restore datastore:

```bash
npm run backup
npm run restore -- backups/notdnd_db_YYYYMMDD_HHMMSS.json
```

Container runtime:

```bash
docker compose up --build
```

CI:

- `.github/workflows/ci.yml` runs:
  - `npm run verify`
  - `npm run smoke`
  - `npm run e2e`

## Optional AI env vars

- `NOTDND_AI_PROVIDER`
- `OPENAI_API_KEY`
- `XAI_API_KEY`
- `GEMINI_API_KEY`
- `NOTDND_CHATGPT_ENDPOINT`
- `NOTDND_GROK_ENDPOINT`
- `NOTDND_GEMINI_ENDPOINT`
- `NOTDND_CHATGPT_GM_MODEL`
- `NOTDND_GROK_GM_MODEL`
- `NOTDND_GEMINI_GM_MODEL`
