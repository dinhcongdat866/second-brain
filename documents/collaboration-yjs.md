# Collaboration (Yjs)

How real-time, offline-first collaboration works. Yjs is the **source of truth**; everything
else (ProseMirror, React, the backend) is a view or a sync target.

## The Y.Doc

One `Y.Doc` per notebook document, created with `gc: false`:

```
Y.Doc (gc: false)
├── XmlFragment 'prosemirror'   ← the editor document (mirrored to PM by ySyncPlugin)
├── Map 'aiThreads'             ← Map<cellId, Y.Array<turn>>   (AI conversations)
├── Map 'weeklyPlans'           ← Map<cellId, Y.Map{ weekStart, mon…sun }>
├── Map 'snapshots'             ← Map<id, Y.Map{ encoded: Uint8Array, … }>
└── Map 'meta'                  ← { schemaVersion }
```

`gc: false` keeps deleted operations (tombstones) so `Y.snapshot` can reconstruct past states
for time-travel. The trade-off — the doc only grows — is acceptable for a personal notebook
and is why **images live in the backend, not the doc** (see [architecture.md](architecture.md)).

## Setup & init — `collab/ydoc.ts`, `hooks/useNotebookEditor.ts`

Per document switch:

1. `new Y.Doc({ gc: false })` + `IndexeddbPersistence` + `WebsocketProvider`.
2. `await persistence.whenSynced` — load local IndexedDB **first** (offline-first; we don't
   wait for the network).
3. `applyServerState` — pull the binary Yjs state from Neon and `Y.applyUpdate` (idempotent
   CRDT merge).
4. `seedIfEmpty` — if brand new, seed one cell.
5. `runMigrations` — bring old docs up to the current schema version.
6. Build the `EditorView` with `ySyncPlugin` (PM ⇆ XmlFragment), `yCursorPlugin` (remote
   cursors via awareness), `yUndoPlugin` (Yjs-aware undo), and the rest.

## Sync & save

- **Real-time**: `WebsocketProvider` broadcasts updates to peers in the same room. Awareness
  carries each peer's cursor + a random color/name (no auth yet).
- **Offline**: `IndexeddbPersistence` writes every update locally; edits work with no network.
- **Durable**: a debounced syncer POSTs the binary Yjs state to Neon, with a `sendBeacon` flush
  on `pagehide` / `visibilitychange` (mobile-Safari-safe).

Priority of truth: **Neon → IndexedDB → WS in-memory**.

## Undo/redo

Uses `undo`/`redo` from `y-prosemirror` (not `prosemirror-history`). Yjs-aware undo only undoes
*your* changes, never a remote peer's.

## Snapshots / time-travel — `collab/snapshots.ts`

Each snapshot is `Y.encodeSnapshot(Y.snapshot(ydoc))` stored in the `snapshots` map (so it
syncs for free). Restore uses `Y.createDocFromSnapshot` to rebuild the doc at that point, then
replaces the live `XmlFragment`. The sidecar maps (`aiThreads`, `weeklyPlans`) are **reconciled
in place** (`restoreSidecarMaps`) — mutating the existing Yjs objects so subscribed NodeViews
re-render live, rather than swapping them out.

## The cross-client document list — `collab/registry.ts`

The list of documents is itself a **dedicated `Y.Doc`** (room `notebook-__registry__`,
persisted to Neon), so creating a doc on one device shows up on another. Only `activeDocId`
(which doc you're viewing) stays in `localStorage` — that's a per-device concern.

## A subtle race (and the fix)

Creating an `ai_cell` must write the PM node **and** create its thread in `aiThreads` in **one**
Yjs update. If they were two updates, a peer could receive the node first, mount the NodeView,
create its own empty thread, and then collide with the incoming thread — silently dropping
messages. `makeInsertAiCell` wraps both in a single `ydoc.transact()`. This class of bug is why
convergence tests exist.

## Convergence tests — `src/collab/__tests__/convergence.test.ts`

11 tests that fork 2–3 `Y.Doc` "peers" from a seed, apply concurrent edits, then assert the
docs converge byte-identically: XmlFragment concurrent inserts, delete-vs-edit, 3-peer merge,
aiThreads concurrent turns, Y.Text streaming, cross-cell isolation, and `seedIfEmpty`
idempotency. Run with `pnpm test`.
