# Notdnd

Notdnd is a unified tabletop platform scaffold combining:

- Roll20-style VTT controls (grid map, tokens, initiative)
- D&D Beyond-style content flows (campaign, books, character vault, compendium)
- AI GM orchestration with provider adapters (GM/image/voice)
- Homebrew ingest and one-click campaign bootstrapping

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
  - `local-mock`
  - `openai-compatible` (env-driven endpoint)
- End-to-end **5-minute campaign quickstart**:
  - Upload homebrew files (`.md`, `.txt`, `.json`)
  - Parse entities + confidence diagnostics + review gate
  - Generate campaign package (books, characters, map, encounter, tokens, initiative, chat)
  - Launch directly to VTT tab
- CI workflow, Docker image/runtime, backup and restore scripts

## Run

```bash
npm run dev
```

Open `http://localhost:4173`.

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
- `src/state/store.js`: optimistic state + version-aware backend sync
- `src/api/client.js`: auth/token-aware API client
- `src/realtime/client.js`: auth-token websocket client
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
```

This runs:

- Syntax checks across `src/`, `server/`, and `tests/`
- Fixture-driven parser tests
- Schema contract tests
- Route contract tests for quickstart parse/build handlers
- Fixture-driven quickstart build integration tests
- Auth/permissions/version conflict tests

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

- `.github/workflows/ci.yml` runs `npm run verify` on push/PR.

## Optional AI env vars

- `NOTDND_AI_PROVIDER` (default: `placeholder`)
- `NOTDND_AI_ENDPOINT` (for `openai-compatible` provider)
- `NOTDND_AI_API_KEY`
- `NOTDND_AI_GM_MODEL`
- `NOTDND_AI_IMAGE_MODEL`
- `NOTDND_AI_VOICE_MODEL`
