# Deployment

Three pieces:

| Piece | Host | Purpose |
|-------|------|---------|
| Frontend (Vite/React) | **Vercel** | the app UI (already auto-deploys on push to `main`) |
| Backend (FastAPI) | **Fly.io** | RAG embeddings, Neon Yjs persistence, **Claude reverse-proxy** (keeps the API key server-side) |
| Sync server (y-websocket) | **Fly.io** | real-time collab relay (in-memory; durability is handled by Neon via the backend) |

> The Anthropic key lives **only** on the backend now. The frontend calls
> `${VITE_BACKEND_URL}/anthropic`, which the backend proxies upstream with the
> real key injected. `VITE_ANTHROPIC_API_KEY` is no longer used by the frontend.

## Prerequisites

```bash
# install flyctl, then:
fly auth login
```
Have ready: Neon `DATABASE_URL`, your Anthropic API key, the Vercel production URL.

## 1. Backend → Fly.io

App names must be globally unique — change `app = "..."` in `backend/fly.toml`
if `second-brain-api` is taken, and pick a region near your Neon DB.

```bash
cd backend
fly launch --no-deploy            # reuse the existing fly.toml when prompted
fly secrets set \
  DATABASE_URL="postgresql://...neon...?sslmode=require" \
  ANTHROPIC_API_KEY="sk-ant-..." \
  ALLOWED_ORIGINS="https://<your-vercel-app>.vercel.app"
fly deploy
```
Note the URL: `https://<backend-app>.fly.dev`. Sanity check: `curl .../health` → `{"status":"ok"}`.

> First image build is large (~GB: torch + sentence-transformers, model baked
> into the image). The machine scales to zero when idle, so the first request
> after a quiet period pays a short cold-start.

## 2. Sync server → Fly.io

```bash
cd deploy/sync-server
fly launch --no-deploy            # reuse fly.toml; unique app name
fly deploy
```
URL: `https://<sync-app>.fly.dev` → clients use `wss://<sync-app>.fly.dev`.

## 3. Frontend → Vercel env

In the Vercel project settings → Environment Variables:

| Key | Value |
|-----|-------|
| `VITE_BACKEND_URL` | `https://<backend-app>.fly.dev` |
| `VITE_WS_URL` | `wss://<sync-app>.fly.dev` |
| `VITE_ANTHROPIC_API_KEY` | **delete** — no longer used (now server-side) |

Redeploy the frontend (push to `main` or "Redeploy" in Vercel).

## 4. Verify

- Open the Vercel URL in two tabs/devices → edits + cursors sync in real time.
- Add an AI cell → response streams (proves the proxy + key work in prod).
- Editing from a second device → state persists (Neon `yjs_documents`).

## Notes / gotchas

- **CORS**: `ALLOWED_ORIGINS` (comma-separated) must include every frontend
  origin — add Vercel preview domains too if you use them. Update later with
  `fly secrets set ALLOWED_ORIGINS="https://a,https://b"` (triggers a redeploy).
- **Local dev quirk**: this machine's shell has an empty `ANTHROPIC_API_KEY`
  env var that shadows `backend/.env` (pydantic prefers env vars). To run the
  backend locally, start it from a shell where `ANTHROPIC_API_KEY` is set to the
  real key. Does not affect Fly (the secret is set explicitly there).
- **Ollama** models won't work on the deployed frontend (they target
  `localhost:11434`); that's expected — Ollama is a local-only privacy option.
