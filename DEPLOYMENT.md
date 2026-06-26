# NOTDND Deployment Runbook

This app needs a long-running Node process with WebSocket support and persistent disk.

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
