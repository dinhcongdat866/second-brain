# Deployment

Three pieces:

| Piece | Host | Purpose |
|-------|------|---------|
| Frontend (Vite/React) | **Vercel** | the app UI (already auto-deploys on push to `main`) |
| Backend (FastAPI) | **Fly.io** | RAG embeddings, Neon Yjs persistence, **Claude reverse-proxy** (keeps the API key server-side) |
| Sync server (y-websocket) | **Fly.io** | real-time collab relay (in-memory; durability is handled by Neon via the backend) |

> The backend holds **no** Anthropic key. Every AI call — the `/anthropic`
> proxy, `/analytics/classify`, `/analytics/report-generate` — requires the
> caller's own key via the `x-user-api-key` header, so the operator is never
> billed for someone else's usage. The key is entered in the app's model
> settings panel and stored in that browser only; `VITE_ANTHROPIC_API_KEY` and
> the backend `ANTHROPIC_API_KEY` are both gone.

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
  ALLOWED_ORIGINS="https://<your-vercel-app>.vercel.app"
fly deploy
```
Note the URL: `https://<backend-app>.fly.dev`. Sanity check: `curl .../health` → `{"status":"ok"}`.

> First image build is large (~GB: torch + sentence-transformers, model baked
> into the image). The machine scales to zero when idle, so the first request
> after a quiet period pays a short cold-start.

## 2. Sync server → Fly.io

The relay is no longer the stock y-websocket binary: it verifies a room token
minted by the backend before admitting a connection, and enforces read-only
links at the protocol level. It **refuses to start** without `SYNC_JWT_SECRET`,
because a relay that is quietly open looks exactly like one that is working.

```bash
cd deploy/sync-server
fly launch --no-deploy            # reuse fly.toml; unique app name
fly secrets set SYNC_JWT_SECRET="<same long random string as the backend>"
fly deploy
```
URL: `https://<sync-app>.fly.dev` → clients use `wss://<sync-app>.fly.dev`.

> The backend needs the **same** value: `fly secrets set SYNC_JWT_SECRET="…"`
> in `backend/`. They are two halves of one signature — if they differ, every
> socket is refused and the app falls back to HTTP-only sync (documents still
> load and save; live collaboration stops).

Run its tests before deploying — they spawn the relay and drive real peers at
it: `cd deploy/sync-server && pnpm install && pnpm test`. See `documents/sharing.md`.

## 3. Frontend → Vercel env

In the Vercel project settings → Environment Variables:

| Key | Value |
|-----|-------|
| `VITE_BACKEND_URL` | `https://<backend-app>.fly.dev` |
| `VITE_WS_URL` | `wss://<sync-app>.fly.dev` |
| `VITE_ANTHROPIC_API_KEY` | **delete** — each user brings their own key in-app |

Redeploy the frontend (push to `main` or "Redeploy" in Vercel).

## 4. Verify

- Open the Vercel URL in two tabs/devices → edits + cursors sync in real time.
- Add an AI cell → response streams (proves the proxy works and your key is set).
- Editing from a second device → state persists (Neon `yjs_documents`).

## Notes / gotchas

- **CORS**: `ALLOWED_ORIGINS` (comma-separated) must include every frontend
  origin — add Vercel preview domains too if you use them. Update later with
  `fly secrets set ALLOWED_ORIGINS="https://a,https://b"` (triggers a redeploy).
- **AI key**: the backend has none. If AI cells, todo classification, or the
  analytics report return 400, the key is missing in the app's model settings
  panel — it is per-browser (localStorage), so a new device needs it re-entered.
- **Ollama** models won't work on the deployed frontend (they target
  `localhost:11434`); that's expected — Ollama is a local-only privacy option.
