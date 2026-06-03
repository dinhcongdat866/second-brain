import * as Y from 'yjs';
import type { Node as PMNode } from 'prosemirror-model';
import { BACKEND_URL, EMBED_DEBOUNCE_MS, YJS_SAVE_DEBOUNCE_MS } from './config';
import { apiFetch } from './http';

/**
 * Transaction origin used when applying state fetched from Neon.
 * createYjsSyncer and wireSaveStatus filter this origin so that pulling
 * remote state never triggers a re-save or a false "Saving…" indicator.
 */
export const NEON_SYNC_ORIGIN = 'neon-sync';

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
  await apiFetch('/embeddings/upsert', {
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
    const res = await apiFetch(
      `/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
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
    const res = await apiFetch(
      `/documents/${encodeURIComponent(docId)}/state`,
    );
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Fetch server state and merge it into the given Y.Doc via CRDT applyUpdate.
 * Uses NEON_SYNC_ORIGIN so listeners can skip re-saving remote-only updates.
 * Returns true if server had a state to apply, false if first-time or unreachable.
 */
export async function applyServerState(docId: string, ydoc: Y.Doc): Promise<boolean> {
  const state = await fetchDocState(docId);
  if (!state) return false;
  Y.applyUpdate(ydoc, state, NEON_SYNC_ORIGIN);
  return true;
}

/**
 * Persist the Yjs state to Neon using a read-merge-write cycle.
 *
 * A plain overwrite causes data loss when two clients have diverged (e.g. DEV
 * opened a doc before PROD saved its content, seeded an empty cell, then
 * overwrote Neon with that empty state). By fetching the current server state
 * first and merging it (CRDT) before saving, the written blob always contains
 * the union of all known operations — safe even under concurrent saves.
 *
 * The merge is tagged NEON_SYNC_ORIGIN so createYjsSyncer does not treat it as
 * a local edit and re-schedule another save.
 */
export async function saveDocState(docId: string, ydoc: Y.Doc): Promise<void> {
  const remote = await fetchDocState(docId);
  if (remote) Y.applyUpdate(ydoc, remote, NEON_SYNC_ORIGIN);
  const state = Y.encodeStateAsUpdate(ydoc);
  await apiFetch(`/documents/${encodeURIComponent(docId)}/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Blob([new Uint8Array(state)]),
  });
}

/**
 * Persist via navigator.sendBeacon — survives page teardown (tab close, app
 * backgrounded). Use on pagehide/visibilitychange where a normal fetch may be
 * cancelled. iOS Safari does NOT reliably fire `beforeunload`, so this is the
 * critical path that keeps data durable before IndexedDB can be evicted.
 */
export function saveDocStateBeacon(docId: string, ydoc: Y.Doc): void {
  const state = Y.encodeStateAsUpdate(ydoc);
  const url = `${BACKEND_URL}/documents/${encodeURIComponent(docId)}/state`;
  const blob = new Blob([new Uint8Array(state)], { type: 'application/octet-stream' });
  if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(url, blob)) {
    return;
  }
  // Fallback: keepalive fetch (still allowed during unload in most browsers).
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: blob,
    keepalive: true,
  }).catch(() => {});
}

/** Fire-and-forget: log one AI response turn's token usage to Neon for analytics. */
export function logUsage(
  docId: string,
  cellId: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
  },
): void {
  apiFetch('/usage/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      doc_id: docId,
      cell_id: cellId,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_tokens: usage.cacheReadTokens,
      cache_creation_tokens: usage.cacheCreationTokens,
      cost_usd: usage.costUsd,
    }),
  }).catch(() => {});
}

/** Delete the persisted state from Neon (call when a doc is permanently deleted). */
export function deleteDocState(docId: string): void {
  apiFetch(`/documents/${encodeURIComponent(docId)}/state`, {
    method: 'DELETE',
  }).catch(() => {});
}

/**
 * Upload an image blob and return an absolute URL to it, or null on failure.
 * The document stores only this URL — never the image bytes (see models.Image).
 */
export async function uploadImage(blob: Blob, docId: string): Promise<string | null> {
  try {
    const res = await apiFetch(`/images?doc_id=${encodeURIComponent(docId)}`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'image/jpeg' },
      body: blob,
    });
    const { id } = (await res.json()) as { id: string };
    return `${BACKEND_URL}/images/${id}`;
  } catch {
    return null;
  }
}

/** Remove all images belonging to a deleted document. */
export function deleteDocImages(docId: string): void {
  apiFetch(`/images/by-doc/${encodeURIComponent(docId)}`, {
    method: 'DELETE',
  }).catch(() => {});
}

/**
 * Wire a debounced Yjs → Neon saver onto a Y.Doc.
 * Also exposes `flush()` for immediate save (use in beforeunload).
 */
export function createYjsSyncer(docId: string, ydoc: Y.Doc, debounceMs = YJS_SAVE_DEBOUNCE_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const persist = () => saveDocState(docId, ydoc).catch(() => {});

  const schedule = (_update: Uint8Array, origin: unknown) => {
    // Ignore updates that originated from pulling Neon state — they are already
    // persisted remotely and scheduling a re-save would create a pointless cycle.
    if (origin === NEON_SYNC_ORIGIN) return;
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
    /**
     * Flush via sendBeacon — for pagehide/visibilitychange (survives teardown).
     * sendBeacon is fire-and-forget so we skip the merge-read; the next normal
     * save will merge any concurrent remote writes.
     */
    flushBeacon: () => {
      if (timer) { clearTimeout(timer); timer = null; }
      saveDocStateBeacon(docId, ydoc);
    },
    stop: () => {
      ydoc.off('update', schedule);
      if (timer) clearTimeout(timer);
    },
  };
}

/** Returns a debounced sync function. Call on every docChanged transaction. */
export function createDocSyncer(docId: string, debounceMs = EMBED_DEBOUNCE_MS) {
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
