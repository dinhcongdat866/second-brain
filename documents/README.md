# Documentation

Technical docs for Second Brain. Each is meant to be read in ~5–10 minutes and answer
*"what is this part, why does it exist, and where does the code live?"*

## Reading order

1. **[architecture.md](architecture.md)** — the system as a whole. Start here.
2. **[editor-prosemirror.md](editor-prosemirror.md)** — the ProseMirror editor: schema, NodeViews, commands, plugins.
3. **[collaboration-yjs.md](collaboration-yjs.md)** — Yjs CRDTs: sync, offline, snapshots, the AI/planner side-data.
4. **[ai.md](ai.md)** — the AI pipeline: streaming, RAG, vision, providers.
5. **[backend.md](backend.md)** — FastAPI: persistence, RAG, Claude reverse-proxy, image store.
6. **[deployment.md](deployment.md)** — how it ships (Vercel + Fly.io).

## The one-paragraph mental model

The **Yjs `Y.Doc` is the source of truth**, not the DOM and not React. ProseMirror renders it
and turns edits into Yjs updates; React renders UI around it. Yjs syncs peer-to-peer over a
WebSocket relay and is persisted as binary state to Neon Postgres. Some data lives *outside*
the ProseMirror document (AI conversations, weekly-planner todos, snapshots) in separate Yjs
maps. The backend adds search (pgvector RAG), durable storage, an image store, and a reverse
proxy that keeps the Anthropic key server-side. Everything is offline-first: edits land in
IndexedDB immediately and reconcile when the network returns.
