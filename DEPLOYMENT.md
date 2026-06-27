# NOTDND Deployment Runbook

This app needs a long-running Node process with WebSocket support and persistent disk.

> ⚠️ **Persistent volume required.** All user data — accounts, sessions, solo
> runs, campaigns, waitlist — lives in a single SQLite file at `NOTDND_DB_PATH`
> (default `/data/notdnd.db` in production), alongside campaign memory under
> `NOTDND_MEMORY_ROOT`. On Fly.io/Railway the container filesystem is **ephemeral**:
> without a persistent volume mounted at `/data`, **every redeploy or machine
> restart wipes all user data.** Always mount a volume and point the DB + memory
> paths at it. On startup the server logs `[DB] SQLite database at: <path>` —
> confirm that path is on the mounted volume.

## Minimum env vars to run

The server boots with **no env vars** (mock AI + placeholder images). For a real
deploy you need at minimum: `OPENROUTER_API_KEY` (real GM text), `NOTDND_HOST=0.0.0.0`,
the host-provided `PORT`, and the three `/data` storage paths below so data persists.

## Required Runtime Env Vars

- `OPENROUTER_API_KEY`
- `NOTDND_GM_MODEL` (optional)
- `NOTDND_UTILITY_MODEL` (optional)
- `NOTDND_FALLBACK_MODEL` (optional)
- `NOTDND_HOST=0.0.0.0`
- `PORT=4173` (or host-provided port)
- `NOTDND_DB_PATH=/data/notdnd.db.json`
- `NOTDND_MEMORY_ROOT=/data/campaigns`
- `NOTDND_WAITLIST_PATH=/data/waitlist.json`
- `NOTDND_BOOTSTRAP_EMAIL` (recommended)
- `NOTDND_BOOTSTRAP_PASSWORD` (recommended)
- `NOTDND_BOOTSTRAP_DISPLAY_NAME` (recommended)

## Free GM Provider Options

GM narration uses an OpenAI-compatible chat-completions endpoint, configurable
via `NOTDND_LLM_BASE_URL` + `NOTDND_LLM_API_KEY` (the legacy `OPENROUTER_API_KEY`
is still honored as a fallback key). Swap to any compatible provider without
code changes — set the base URL, the key, and a model name the provider accepts
(via `NOTDND_GM_MODEL`). The vanity `HTTP-Referer` / `X-Title` headers are
OpenRouter attribution and are harmless to other providers.

### Gemini AI Studio — recommended (1500 requests/day free, no credit card)

- Get a key: https://aistudio.google.com/apikey
- `NOTDND_LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`
- `NOTDND_LLM_API_KEY=<your AI Studio key>`
- `NOTDND_GM_MODEL=gemini-2.0-flash` (or `gemini-2.5-flash`)

### Groq — backup (very fast, generous free tier)

- Get a key: https://console.groq.com/keys
- `NOTDND_LLM_BASE_URL=https://api.groq.com/openai/v1/chat/completions`
- `NOTDND_LLM_API_KEY=<your Groq key>`
- `NOTDND_GM_MODEL=llama-3.3-70b-versatile`

### OpenRouter — default (broadest model selection)

- Get a key: https://openrouter.ai/keys
- Leave `NOTDND_LLM_BASE_URL` unset (defaults to OpenRouter) and set
  `NOTDND_LLM_API_KEY` (or `OPENROUTER_API_KEY`).

## Option A: Fly.io (persistent, recommended)

1. Install and authenticate:

```bash
curl -L https://fly.io/install.sh | sh
flyctl auth login
```

2. Create app (only once). Edit `fly.toml` `app` value if needed:

```bash
flyctl apps create notdnd-soliddark
```

3. Create persistent volume:

```bash
flyctl volumes create notdnd_data --region iad --size 5
```

4. Set secrets:

```bash
flyctl secrets set \
  OPENROUTER_API_KEY=... \
  NOTDND_BOOTSTRAP_EMAIL=... \
  NOTDND_BOOTSTRAP_PASSWORD=... \
  NOTDND_BOOTSTRAP_DISPLAY_NAME=...
```

5. Deploy:

```bash
flyctl deploy
```

6. Verify:

```bash
curl -sS https://notdnd-soliddark.fly.dev/api/health
```

7. DNS:

- Point `play.notdnd.com` CNAME to `notdnd-soliddark.fly.dev`.
- Keep landing page at `soliddark.net/notdnd`, and add/update a CTA link to `https://play.notdnd.com`.

## Option B: Railway

1. Create project and deploy Docker image from this repo.
2. Add a persistent volume mounted at `/data`.
3. Set env vars from "Required Runtime Env Vars".
4. Ensure health check path is `/api/health`.
5. Add custom domain `play.notdnd.com` to the service.

`railway.json` is included for default Docker + healthcheck behavior.

## Post-Deploy Validation

1. `GET /api/health` returns 200.
2. Register/login works.
3. `POST /api/onboarding/start` returns `campaignId` + opening narration.
4. WebSocket connects at `/ws?campaignId=...&token=...`.
5. `/notdnd` landing page loads.
6. Waitlist form writes to `/data/waitlist.json`.
