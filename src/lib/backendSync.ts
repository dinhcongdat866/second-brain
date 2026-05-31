import * as Y from 'yjs';
import type { Node as PMNode } from 'prosemirror-model';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8000';

interface CellPayload {
  cell_id: string;
  doc_id: string;
  content: string;
}

function extractMarkdownCells(doc: PMNode, docId: string): CellPayload[] {
  const cells: CellPayload[] = [];
  doc.forEach((cell) => {
    if (cell.type.name !== 'markdown_cell') return;
    const content = cell.textContent.trim();
    if (!content) return;
    cells.push({ cell_id: cell.attrs.id as string, doc_id: docId, content });
  });
  return cells;
}

async function upsertCell(payload: CellPayload): Promise<void> {
  await fetch(`${BACKEND_URL}/embeddings/upsert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** Embed a single user turn from an AI cell immediately (no debounce). */
export function upsertUserTurn(cellId: string, docId: string, text: string): void {
  const content = text.trim();
  if (!content) return;
  upsertCell({ cell_id: `${cellId}:u:${Date.now()}`, doc_id: docId, content }).catch(() => {});
}

export interface SearchResult {
  cell_id: string;
  doc_id: string;
  content: string;
  score: number;
}

/** Semantic search across all indexed cells. Returns empty array if backend unreachable. */
export async function searchCells(query: string, limit = 5): Promise<SearchResult[]> {
  try {
    const res = await fetch(
      `${BACKEND_URL}/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
    if (!res.ok) return [];
    return (await res.json()) as SearchResult[];
  } catch {
    return [];
  }
}

/**
 * Fetch the latest Yjs state for a doc from Neon.
 * Returns null if the doc has never been saved or the backend is unreachable.
 */
export async function fetchDocState(docId: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(
      `${BACKEND_URL}/documents/${encodeURIComponent(docId)}/state`,
    );
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Fetch server state and merge it into the given Y.Doc via CRDT applyUpdate.
 * Returns true if server had a state to apply, false if first-time or unreachable.
 */
export async function applyServerState(docId: string, ydoc: Y.Doc): Promise<boolean> {
  const state = await fetchDocState(docId);
  if (!state) return false;
  Y.applyUpdate(ydoc, state);
  return true;
}

/** Persist the full Yjs state to Neon (upsert). Silently ignores network errors. */
export async function saveDocState(docId: string, ydoc: Y.Doc): Promise<void> {
  const state = Y.encodeStateAsUpdate(ydoc);
  await fetch(`${BACKEND_URL}/documents/${encodeURIComponent(docId)}/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: state,
  });
}

/** Delete the persisted state from Neon (call when a doc is permanently deleted). */
export function deleteDocState(docId: string): void {
  fetch(`${BACKEND_URL}/documents/${encodeURIComponent(docId)}/state`, {
    method: 'DELETE',
  }).catch(() => {});
}

/**
 * Wire a debounced Yjs → Neon saver onto a Y.Doc.
 * Also exposes `flush()` for immediate save (use in beforeunload).
 */
export function createYjsSyncer(docId: string, ydoc: Y.Doc, debounceMs = 10_000) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const persist = () => saveDocState(docId, ydoc).catch(() => {});

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      persist();
    }, debounceMs);
  };

  ydoc.on('update', schedule);

  return {
    /** Flush immediately (clears pending debounce timer). */
    flush: () => {
      if (timer) { clearTimeout(timer); timer = null; }
      persist();
    },
    stop: () => {
      ydoc.off('update', schedule);
      if (timer) clearTimeout(timer);
    },
  };
}

/** Returns a debounced sync function. Call on every docChanged transaction. */
export function createDocSyncer(docId: string, debounceMs = 2000) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return function syncDoc(doc: PMNode): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const cells = extractMarkdownCells(doc, docId);
      for (const cell of cells) {
        upsertCell(cell).catch(() => {
          // backend unreachable during dev — silently ignore
        });
      }
    }, debounceMs);
  };
}
