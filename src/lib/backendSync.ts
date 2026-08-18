import * as Y from 'yjs';
import type { Node as PMNode } from 'prosemirror-model';
import {
  BACKEND_URL,
  EMBED_DEBOUNCE_MS,
  STATE_FETCH_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
  YJS_SAVE_DEBOUNCE_MS,
} from './config';
import { apiFetch, HttpError } from './http';
import { getCachedToken } from './authToken';

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
  upsertCell({ cell_id: cellId, doc_id: docId, content }).catch(() => {});
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
 * Backoff schedule between document-read retries. The first request of a
 * session can hit a cold production stack (Fly machine waking → 502 without
 * CORS headers, Neon compute resume, backend JWKS fetch), so a single attempt
 * silently loses server state. Each attempt is capped by
 * STATE_FETCH_TIMEOUT_MS, so the worst case is bounded (~4 × 8 s + 7 s of
 * backoff) — and it no longer blocks first paint, since the editor binds from
 * the IndexedDB cache and merges whatever this returns afterwards.
 */
const FETCH_STATE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Only transient failures are worth retrying: network/CORS errors (fetch
 * rejects with TypeError), timeouts (AbortError) and 5xx / 408 / 429. Other
 * 4xx (401, 403, 400…) are deterministic — the same request fails the same
 * way, so retrying only burns time for no benefit.
 */
function isRetryableFetchError(err: unknown): boolean {
  if (err instanceof HttpError) {
    return err.status >= 500 || err.status === 408 || err.status === 429;
  }
  return true;
}

/**
 * Run a document read with the retry ladder above.
 * Returns null if the doc has never been saved (404 — a definitive answer, no
 * retry), on a deterministic 4xx, or if the backend stayed unreachable
 * through all retries.
 */
async function readWithRetry<T>(
  label: string,
  path: string,
  parse: (res: Response) => Promise<T>,
): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await parse(await apiFetch(path, { timeoutMs: STATE_FETCH_TIMEOUT_MS }));
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      if (!isRetryableFetchError(err) || attempt >= FETCH_STATE_RETRY_DELAYS_MS.length) {
        console.warn(`[backendSync] ${label} gave up (attempt ${attempt + 1}):`, err);
        return null;
      }
      await sleep(FETCH_STATE_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/**
 * Split the framed body returned by GET /sync into individual Yjs updates.
 * Frame layout is [4-byte big-endian length][bytes], repeated.
 */
export function parseSyncFrames(buf: ArrayBuffer): Uint8Array[] {
  const view = new DataView(buf);
  const out: Uint8Array[] = [];
  let off = 0;
  while (off + 4 <= buf.byteLength) {
    const len = view.getUint32(off);
    off += 4;
    if (len === 0 || off + len > buf.byteLength) break; // truncated — stop, keep what parsed
    out.push(new Uint8Array(buf, off, len));
    off += len;
  }
  return out;
}

/** What the server holds for a doc: its updates, plus how far we consumed. */
export interface DocSync {
  updates: Uint8Array[];
  /** Highest delta id merged — passed back on a snapshot write. */
  maxUpdateId: number;
}

/**
 * Fetch the snapshot + every delta appended since, from GET /sync.
 * Retries and times out per readWithRetry; null on 404 or after giving up.
 */
export function fetchDocSync(docId: string): Promise<DocSync | null> {
  return readWithRetry(
    `fetchDocSync(${docId})`,
    `/documents/${encodeURIComponent(docId)}/sync`,
    async (res) => ({
      updates: parseSyncFrames(await res.arrayBuffer()),
      maxUpdateId: Number(res.headers.get('X-Max-Update-Id') ?? 0) || 0,
    }),
  );
}

/**
 * Fetch server state and merge it into the given Y.Doc via CRDT applyUpdate.
 * Uses NEON_SYNC_ORIGIN so listeners can skip re-saving remote-only updates.
 * Returns true if server had a state to apply, false if first-time or unreachable.
 *
 * Also records how far this doc has consumed the delta log, so a later snapshot
 * write only collapses rows it actually merged.
 */
export async function applyServerState(docId: string, ydoc: Y.Doc): Promise<boolean> {
  const sync = await fetchDocSync(docId);
  if (!sync || sync.updates.length === 0) return false;
  ydoc.transact(() => {
    for (const update of sync.updates) Y.applyUpdate(ydoc, update, NEON_SYNC_ORIGIN);
  }, NEON_SYNC_ORIGIN);
  mergedUpTo.set(docId, Math.max(mergedUpTo.get(docId) ?? 0, sync.maxUpdateId));
  return true;
}

/**
 * Highest delta id merged per doc. Module-level because the syncer, the
 * loading path and the teardown beacon all need the same number, and they
 * live in different components.
 */
const mergedUpTo = new Map<string, number>();

/**
 * Append one delta — the hot path, run a few seconds after you stop typing.
 *
 * Nothing is read and nothing is overwritten, so this cannot lose a concurrent
 * save, and the body is proportional to what you just typed rather than to the
 * whole document (which only grows, since gc is disabled for time-travel).
 */
export async function appendDocUpdate(docId: string, update: Uint8Array): Promise<void> {
  await apiFetch(`/documents/${encodeURIComponent(docId)}/updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Blob([new Uint8Array(update)]),
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
}

/**
 * Write a full snapshot, collapsing the deltas it contains — the cold path,
 * run when the tab is hidden or a document is deleted, not on every edit.
 *
 * Still a read-merge-write: it re-reads immediately before writing so the
 * snapshot can never be older than what the server holds, and it collapses
 * only up to the id returned by that same read. The window between read and
 * write is unchanged, but it now opens seconds-apart-on-hide instead of every
 * four seconds of typing.
 */
export async function saveDocState(docId: string, ydoc: Y.Doc): Promise<void> {
  const remote = await fetchDocSync(docId);
  if (remote) {
    ydoc.transact(() => {
      for (const update of remote.updates) Y.applyUpdate(ydoc, update, NEON_SYNC_ORIGIN);
    }, NEON_SYNC_ORIGIN);
  }
  const upTo = Math.max(mergedUpTo.get(docId) ?? 0, remote?.maxUpdateId ?? 0);
  mergedUpTo.set(docId, upTo);
  const state = Y.encodeStateAsUpdate(ydoc);
  await apiFetch(
    `/documents/${encodeURIComponent(docId)}/state?up_to=${upTo}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Blob([new Uint8Array(state)]),
      timeoutMs: UPLOAD_TIMEOUT_MS,
    },
  );
}

/**
 * Best-effort persist on hard page teardown (pagehide / tab close).
 *
 * Uses `fetch(..., { keepalive: true })` rather than `navigator.sendBeacon`:
 * the save endpoint requires `Authorization: Bearer <jwt>`, and sendBeacon
 * cannot set request headers — so a beacon save always 401'd and silently lost
 * the write. keepalive fetch survives teardown AND carries the auth header.
 *
 * The token is read synchronously from the cached mirror (getCachedToken) since
 * a dying page can't await supabase.auth.getSession().
 *
 * It appends rather than snapshots, for two reasons: a dying page cannot re-read
 * the server first, so an overwrite here could replace a newer snapshot; and the
 * body is only the unsent delta, which comfortably fits the ~64 KB cap browsers
 * put on keepalive bodies (the old full-state version silently exceeded it on
 * large docs).
 */
export function saveDocStateBeacon(docId: string, update: Uint8Array): void {
  const token = getCachedToken();
  if (!token) return; // no valid session — the endpoint would 401 anyway
  const url = `${BACKEND_URL}/documents/${encodeURIComponent(docId)}/updates`;
  const blob = new Blob([new Uint8Array(update)], { type: 'application/octet-stream' });
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      Authorization: `Bearer ${token}`,
    },
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

/**
 * Fire-and-forget DELETE using a pre-captured token.
 * Used for cleanup that may run after sign-out, so we can't rely on
 * supabase.auth.getSession() returning a valid session at call time.
 */
function deleteWithToken(path: string, token?: string | null): void {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  fetch(`${BACKEND_URL}${path}`, { method: 'DELETE', headers }).catch(() => {});
}

/** Delete the persisted Yjs state (call when a doc is permanently deleted). */
export function deleteDocState(docId: string, token?: string | null): void {
  deleteWithToken(`/documents/${encodeURIComponent(docId)}/state`, token);
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
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    const { id } = (await res.json()) as { id: string };
    return `${BACKEND_URL}/images/${id}`;
  } catch {
    return null;
  }
}

/**
 * Delete one uploaded image, given the URL `uploadImage` returned.
 *
 * Call this when an attachment is discarded before it ever lands in a
 * document — otherwise the row survives until the whole document is deleted.
 * The id is the last path segment, which is safe because this module is also
 * what built the URL.
 */
export function deleteImage(imageUrl: string): void {
  const id = imageUrl.split('/').pop();
  if (!id) return;
  apiFetch(`/images/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
}

/**
 * Drop the SQL projection of a money line that has left the document.
 *
 * Fire-and-forget: the Y.Doc is the source of truth, so a failure here only
 * leaves a stale row, which the next sync pass will try again to remove.
 */
export function deleteMoneyEntryRow(entryId: string): void {
  apiFetch(`/money/entries/${encodeURIComponent(entryId)}`, { method: 'DELETE' })
    .catch(() => { /* offline — retried on a later pass */ });
}

/** Remove all images belonging to a deleted document. */
export function deleteDocImages(docId: string, token?: string | null): void {
  deleteWithToken(`/images/by-doc/${encodeURIComponent(docId)}`, token);
}

/**
 * Wire a debounced Yjs → Neon saver onto a Y.Doc.
 *
 * Two paths, deliberately different:
 *   - the debounced one appends a delta — small, frequent, cannot overwrite;
 *   - `flush()` writes a full snapshot — large, rare, and collapses the deltas
 *     it contains so the log does not grow without bound.
 *
 * `sentSV` is the state vector of everything already handed to the server, so
 * each delta carries only what changed since. Updates arriving with
 * NEON_SYNC_ORIGIN came *from* the server, so they advance `sentSV` without
 * scheduling anything — otherwise the client would echo remote work back.
 */
export function createYjsSyncer(docId: string, ydoc: Y.Doc, debounceMs = YJS_SAVE_DEBOUNCE_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sentSV: Uint8Array | undefined;
  let dirty = false;
  let appendsSinceSnapshot = 0;

  /** Bytes the server has not seen yet, or null when there is nothing to send. */
  const pendingDelta = (): Uint8Array | null => {
    if (!dirty) return null;
    return Y.encodeStateAsUpdate(ydoc, sentSV);
  };

  const markSent = () => {
    sentSV = Y.encodeStateVector(ydoc);
    dirty = false;
    appendsSinceSnapshot = 0;
  };

  const persist = async () => {
    const delta = pendingDelta();
    if (!delta) return;
    // Capture before awaiting: edits made during the request must stay dirty.
    const sv = Y.encodeStateVector(ydoc);
    await appendDocUpdate(docId, delta);
    sentSV = sv;
    dirty = false;
    appendsSinceSnapshot++;
  };

  const schedule = (_update: Uint8Array, origin: unknown) => {
    if (origin === NEON_SYNC_ORIGIN) {
      // Already on the server by definition — record it as sent, don't echo it.
      sentSV = Y.encodeStateVector(ydoc);
      return;
    }
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      persist().catch(() => {});
    }, debounceMs);
  };

  ydoc.on('update', schedule);

  return {
    /**
     * Snapshot immediately (clears pending debounce timer). Used when the tab
     * is hidden and when a document is deleted — the rare, durable path that
     * also compacts the delta log.
     *
     * OWNER ONLY. The endpoint behind it replaces the stored document, so it
     * refuses anyone editing through a share link; use flushAppend there.
     *
     * Does nothing when nothing has happened since the last snapshot. `dirty`
     * alone is not that test: the debounce clears it after every append, so an
     * hour of typing can end with `dirty === false` and a delta log that badly
     * wants collapsing. Counting appends covers both — and it is what stops a
     * tab switch from re-uploading a megabytes-long document that did not
     * change, on every hide, forever.
     */
    flush: () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!dirty && appendsSinceSnapshot === 0) return;
      saveDocState(docId, ydoc).then(markSent).catch(() => {});
    },
    /**
     * Send what has not been sent, as an append. Same durability as the
     * debounced path, just now instead of in four seconds, and without the
     * power to overwrite anything — which is why it is what a visitor editing
     * through a link uses when the tab goes away.
     */
    flushAppend: () => {
      if (timer) { clearTimeout(timer); timer = null; }
      persist().catch(() => {});
    },
    /**
     * Last-ditch flush on hard teardown (pagehide). Appends the unsent delta
     * via a keepalive request — an append can't clobber, and the delta is small
     * enough to survive the browser's keepalive body cap.
     */
    flushBeacon: () => {
      if (timer) { clearTimeout(timer); timer = null; }
      const delta = pendingDelta();
      if (delta) saveDocStateBeacon(docId, delta);
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
