# Backend (FastAPI)

The backend does what a browser-side CRDT can't: durable storage, semantic search, an image
store, usage analytics, and keeping the Anthropic key off the client.

## Stack

FastAPI · SQLAlchemy (async) · asyncpg · **Neon Postgres** + **pgvector** · sentence-transformers.
Tables are created on startup via `Base.metadata.create_all` (no Alembic).

```
backend/app/
  main.py              app, CORS, router registration, startup migrations
  config.py            pydantic settings (DATABASE_URL, ANTHROPIC_API_KEY, ALLOWED_ORIGINS)
  db/
    engine.py          async engine + session
    models.py          ORM models
    migrations.py      CREATE EXTENSION vector + create_all
  embeddings.py        sentence-transformers (all-MiniLM-L6-v2), lazy-loaded
  routers/
    ai.py              reverse-proxy → api.anthropic.com
    embeddings.py      POST /embeddings/upsert
    search.py          GET  /search?q=
    documents.py       GET/POST/DELETE /documents/{id}/state   (binary Yjs state)
    usage.py           POST /usage/log
    images.py          POST/GET /images, DELETE /images/by-doc
```

## Routers

| Endpoint | Purpose |
|----------|---------|
| `…/anthropic/*` | **Reverse-proxy** to Claude. Forwards the request verbatim, injects `x-api-key` server-side, passes SSE/gzip through. The frontend SDK points its `baseURL` here with a dummy key. |
| `POST /embeddings/upsert` | Embed a cell's text and upsert into `cell_embeddings`. |
| `GET /search?q=` | Cosine-similarity search over embeddings (RAG tier 3). |
| `GET/POST/DELETE /documents/{id}/state` | The durable binary Yjs state per document. |
| `POST /usage/log` | Per-turn token/cost analytics. |
| `POST /images` · `GET /images/{id}` | Store / serve image blobs (markdown images). |

## Database

```sql
yjs_documents   (doc_id PK, state BYTEA, updated_at)          -- durable Yjs state
cell_embeddings (id PK, doc_id, content, embedding vector(384), updated_at)
usage_log       (id PK, doc_id, cell_id, tokens…, cost_usd, created_at)
images          (id PK, doc_id, content_type, data BYTEA, created_at)
```

`doc_id = '__registry__'` in `yjs_documents` stores the shared document-list Y.Doc.

## RAG search

```sql
SELECT cell_id, doc_id, content, 1 - (embedding <=> :q) AS score
FROM cell_embeddings
ORDER BY embedding <=> :q
LIMIT :n;
```

Results below score `0.3` are dropped (Python side). Embeddings: `all-MiniLM-L6-v2`, 384-dim,
CPU-friendly, lazy-loaded once per process.

## Frontend → backend sync triggers — `src/lib/backendSync.ts`

| Event | Action | Timing |
|-------|--------|--------|
| Type in a markdown cell | `POST /embeddings/upsert` | debounce 2s |
| Submit an AI prompt | `POST /embeddings/upsert` (user turn) | immediate |
| AI turn done | `POST /usage/log` | per turn |
| Yjs doc changes | `POST /documents/{id}/state` | debounce 4s |
| Tab hidden / closed | flush state via `sendBeacon` | immediate |
| Paste image in markdown | `POST /images` → URL | per image |
| Delete a document | `DELETE` state + images | after the undo window |

## Analytics & classification

See **[analytics-classification.md](analytics-classification.md)** for the full flow.

Additional tables not listed above:

```sql
todo_classifications (todo_id PK, user_id, week_start, todo_text, categories JSONB, taxonomy_version, classified_at)
mood_logs            (id PK, user_id, date, energy INT 1–5, note)
```

Additional endpoints:

| Endpoint | Purpose | Response shape |
|----------|---------|----------------|
| `POST /analytics/classify` | Batch-classify todos via Haiku (max 50). Upserts into `todo_classifications`. | `{ results: [{ todo_id, categories: string[] }] }` |
| `GET /analytics/classifications?week_start=` | Stored classifications for one week — used by frontend dirty-check. | `[{ todo_id, categories: string[], todo_text, taxonomy_version }]` |
| `GET /analytics/report-data?from_date=&to_date=` | SQL aggregates: category breakdown + mood timeline. | `{ categoryBreakdown: [{ category, count, pct, trend }], moodTimeline: [{ date, energy\|null, note\|null }] }` |
| `POST /analytics/report-generate` | AI narrative + prediction from pre-computed aggregates (Haiku). Frontend passes SQL results; AI only does qualitative interpretation. | `{ narrative, prediction: { text, confidence: "low"\|"medium"\|"high", reasoning }, proactiveQuestions: string[] }` |
| `PUT /analytics/mood` | Upsert a daily mood entry (frontend-supplied UUID as PK). | `{ id, date, energy, note }` |
| `GET /analytics/mood?from_date=&to_date=` | Fetch mood logs for a date range (inclusive). | `[{ id, date, energy, note }]` |
| `DELETE /analytics/mood/{date}` | Remove a mood entry. | `204 No Content` |

## Why images are a separate table (not in the Y.Doc)

The Y.Doc is loaded fully into memory and re-synced/re-saved on every edit, and with `gc:false`
nothing is ever pruned — so embedding image bytes there would bloat it permanently. As `images`
rows the document stores only a short URL; images are served on demand with an immutable
`Cache-Control` header (the id never changes), so browsers cache them and lazy-load.
