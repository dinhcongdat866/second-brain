# Deployment

Three independently deployed pieces. A detailed runbook (commands, secrets) lives in
[`deploy/README.md`](../deploy/README.md); this is the mental model.

| Piece | Host | Deploys when… |
|-------|------|---------------|
| Frontend (Vite/React) | **Vercel** | **automatically** on push to `main` |
| Backend (FastAPI) | **Fly.io** | you run `fly deploy` (manual) |
| Sync relay (y-websocket) | **Fly.io** | you run `fly deploy` (manual) |

## Auto-deploy is a platform feature, not a git feature

A common surprise: pushing a commit does **not** redeploy everything. Auto-deploy happens
because **Vercel is connected to the GitHub repo** and watches it. **Fly.io does not watch the
repo** — `fly deploy` is an imperative CLI command that builds a Docker image and ships it. To
make Fly auto-deploy too, add a GitHub Action running `flyctl deploy` with a `FLY_API_TOKEN`
secret.

## Frontend → Vercel

Connected to the repo; every push to `main` triggers a build + deploy. Configure these
environment variables in the Vercel project:

```
VITE_BACKEND_URL = https://<backend-app>.fly.dev
VITE_WS_URL      = wss://<sync-app>.fly.dev
```

## Backend → Fly.io

`backend/Dockerfile` bakes the embedding model into the image (so cold starts don't download
it). Config in `backend/fly.toml`. Secrets (`fly secrets set`):

```
DATABASE_URL      Neon connection string
ANTHROPIC_API_KEY Claude key — lives ONLY here
ALLOWED_ORIGINS   the Vercel URL (CORS)
```

Deploy with `fly deploy` from `backend/`. New tables (e.g. `images`) are created automatically
on startup. Machines scale to zero when idle, so the first request after a quiet period pays a
short cold-start.

## Sync relay → Fly.io

`deploy/sync-server/` is the classic `y-websocket` server, **in-memory only** — durability is
handled by the backend persisting Yjs state to Neon, so the relay can restart without data
loss and needs no volume.

## The security boundary

The Anthropic API key never reaches the browser. The frontend calls
`${VITE_BACKEND_URL}/anthropic`, and the backend reverse-proxy injects the real key
server-side. A public frontend bundle therefore exposes nothing.
