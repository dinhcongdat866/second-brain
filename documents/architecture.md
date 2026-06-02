# Architecture

System overview of Second Brain — how the pieces fit and why.

## 1. The big idea

A notebook document is a tree of **cells**. Each cell is one of:

- `markdown_cell` — rich text (paragraphs, headings, quotes, dividers, images),
- `ai_cell` — a multi-turn AI conversation,
- `weekly_planner_cell` — a 7-column todo grid.

The document is edited with **ProseMirror** but **stored as a Yjs CRDT** (`Y.Doc`). Yjs — not
the DOM, not React state — is the **single source of truth**. This is what makes real-time
collaboration, offline editing, and time-travel possible without conflicts.

## 2. Layers

```
┌─────────────────────────────────────────────────────────────┐
│ React UI shell  (App, Sidebar, modals, toolbars, i18n)      │
│   └─ NodeViews: React components embedded inside PM cells    │
├─────────────────────────────────────────────────────────────┤
│ ProseMirror     (schema, commands, keymaps, plugins)        │
│   └─ ySyncPlugin keeps PM ⇆ Yjs in lock-step                │
├─────────────────────────────────────────────────────────────┤
│ Yjs CRDT  (Y.Doc — SOURCE OF TRUTH)                          │
│   ├─ XmlFragment 'prosemirror'  → the document tree          │
│   ├─ Map 'aiThreads'            → AI conversations           │
│   ├─ Map 'weeklyPlans'          → planner todos              │
│   └─ Map 'snapshots'            → time-travel history        │
├──────────────┬──────────────────────┬───────────────────────┤
│ IndexedDB    │ y-websocket relay     │ FastAPI backend       │
│ (offline)    │ (real-time, in-mem)   │ (durable + AI + RAG)  │
└──────────────┴──────────────────────┴────── Neon Postgres ───┘
```

- **React** is the UI shell. The interesting bit is **NodeViews**: a ProseMirror cell whose
  rendering is handed to a React component (the AI chat UI, the weekly grid, the markdown
  controls). This is the hardest integration boundary in the app — see
  [editor-prosemirror.md](editor-prosemirror.md).
- **ProseMirror** owns the editing model. Its schema enforces the `doc → cell → block`
  structure. The `ySyncPlugin` mirrors every PM transaction into Yjs and vice-versa.
- **Yjs** holds the truth. It persists locally to **IndexedDB** (offline cache), syncs in real
  time through a **y-websocket relay**, and is saved as binary state to **Neon Postgres** (the
  durable source of truth).
- **Backend (FastAPI)** adds what a CRDT can't: semantic search (pgvector RAG), durable
  document storage, an image store, usage analytics, and a **reverse proxy** to the Claude API
  so the key stays server-side.

## 3. Why Yjs is the source of truth

A naive collaborative editor syncs the DOM or a JSON blob and resolves conflicts with
"last-write-wins" — which silently loses data when two people edit at once. A **CRDT** merges
concurrent edits deterministically with no conflicts and no central authority. So:

- Two users typing in the same paragraph converge to the same result.
- You can edit offline; changes merge cleanly when you reconnect.
- History is reconstructable, enabling snapshots / time-travel.

Correctness here is invisible — "wrong" looks like data quietly drifting apart — so it's
verified by [convergence tests](../src/collab/__tests__/convergence.test.ts).

## 4. What lives outside the ProseMirror document

Not everything belongs in the editor tree. Three kinds of data live in their own Yjs maps,
keyed by cell id:

| Data | Map | Why separate |
|------|-----|--------------|
| AI conversations | `aiThreads` | Streaming appends a token per change; inside the PM doc that would churn the editor and pollute undo history. |
| Weekly todos | `weeklyPlans` | Avoids `prosemirror-tables` (a CRDT-merge minefield); a plain Yjs array per day is conflict-free for free. |
| Snapshots | `snapshots` | History is metadata about the doc, not content. |

These still sync and persist like everything else (they're in the same `Y.Doc`).

## 5. Persistence & durability

```
edit → Yjs update
        ├─ IndexedDB        (instant, offline cache, per device)
        ├─ y-websocket      (real-time to peers; in-memory, not durable)
        └─ Neon (debounced) (binary Yjs state; the durable source of truth)
```

- **Neon is the durable truth.** The WS relay is intentionally in-memory; restarting it loses
  nothing because Neon holds the state.
- Saves are debounced and also flushed on `pagehide` / `visibilitychange` via
  `navigator.sendBeacon`, because mobile Safari does not reliably fire `beforeunload` and can
  evict IndexedDB.
- **Images are never embedded in the Y.Doc.** Markdown images upload to the backend and the
  doc stores only a URL — the Y.Doc is loaded fully into memory and re-synced/re-saved on every
  edit, and with `gc:false` (needed for time-travel) nothing is ever pruned.

## 6. The AI pipeline (summary)

When you submit an AI prompt, the assistant reply is streamed token-by-token into a `Y.Text`.
Context comes from three tiers — nearby cells → the whole doc (truncated) → cross-document RAG
(pgvector) — and the request goes through the backend's `/anthropic` reverse-proxy. A local
**Ollama** provider is available for fully private inference. Details in [ai.md](ai.md).

## 7. Module map

```
src/
  schema.ts            the ProseMirror schema (nodes, marks, cell helpers)
  commands.ts          insert / transform / select commands (shared by keymaps + slash menu)
  hooks/
    useNotebookEditor  builds the EditorView, wires Yjs + plugins + NodeViews per document
    useDocRegistry     the cross-client document list (its own Y.Doc)
  collab/
    ydoc.ts            Y.Doc + IndexedDB + WebSocket setup, seeding
    registry.ts        shared Y.Doc holding the document list
    aiThreads.ts       AI conversation store
    weeklyPlans.ts     planner store
    snapshots.ts       time-travel
    claudeStream.ts    Anthropic/Ollama streaming + model config
    historyCompressor  summarize-and-slide for long AI threads
    schemaMigrations   versioned migrations so schema changes don't break old docs
  plugins/             slash menu, placeholder, selection, ensure-cell, image paste
  nodeViews/           AI cell, markdown cell, weekly cell (React inside PM)
  lib/                 config, http (apiFetch), backendSync, imageResize, markdown io
  components/          Sidebar, FloatingToolbar, SnapshotModal, LanguageSwitcher, …
  i18n/                react-i18next resources (en / vi)
  styles/              design tokens + per-component CSS
backend/app/           FastAPI routers, models, engine
```

## 8. Key decisions (and their rationale)

| Decision | Why |
|----------|-----|
| Raw ProseMirror, not Tiptap | Full schema control + a stronger portfolio signal. |
| Yjs as source of truth | Conflict-free collaboration + offline + time-travel. |
| `ai_cell` is an atom node, chat lives in Yjs maps | Streaming must not churn the PM doc or undo stack. |
| `gc:false` on the Y.Doc | Keep tombstones so snapshots can reconstruct the past. |
| Backend reverse-proxy for Claude | Keep the API key out of the browser bundle. |
| Images via backend URL (markdown) | Keep the Y.Doc small; base64 would bloat it permanently. |
| Design tokens + per-component CSS | One place for visual constants; navigable styles. |
