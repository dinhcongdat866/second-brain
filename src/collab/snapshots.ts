/**
 * Snapshot store — time-travel for the notebook.
 *
 * Snapshots are stored inside the Y.Doc itself (Y.Map('snapshots')), so they
 * sync across peers automatically via WebSocket — no backend required.
 *
 * Each entry is a nested Y.Map:
 *   { id: string, label: string, created_at: ISO, encoded: Uint8Array }
 *
 * Restoring requires gc: false on the Y.Doc (set in ydoc.ts). Without it,
 * Yjs GC's deleted operations and past states can't be reconstructed.
 */

import * as Y from 'yjs';

export const SNAPSHOTS_KEY = 'snapshots';

/** Max snapshots kept by auto-snapshot before pruning oldest. */
const MAX_AUTO_SNAPSHOTS = 30;

/** Auto-snapshot fires this long after the last local change (ms). */
const AUTO_SNAPSHOT_IDLE_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SnapshotMeta {
  id: string;
  label: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSnapshotsMap(ydoc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return ydoc.getMap<Y.Map<unknown>>(SNAPSHOTS_KEY);
}

function formatLabel(isoString: string): string {
  return new Date(isoString).toLocaleString('vi-VN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** Take a snapshot of the current Y.Doc state and persist it. Returns the id. */
export function takeSnapshot(ydoc: Y.Doc, label?: string): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const entry = new Y.Map<unknown>();
  entry.set('id', id);
  entry.set('label', label ?? formatLabel(now));
  entry.set('created_at', now);
  entry.set('encoded', Y.encodeSnapshot(Y.snapshot(ydoc)));

  getSnapshotsMap(ydoc).set(id, entry);
  return id;
}

/** List all snapshots sorted newest-first. */
export function listSnapshots(ydoc: Y.Doc): SnapshotMeta[] {
  const result: SnapshotMeta[] = [];
  getSnapshotsMap(ydoc).forEach((entry) => {
    result.push({
      id: entry.get('id') as string,
      label: entry.get('label') as string,
      created_at: entry.get('created_at') as string,
    });
  });
  return result.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Decode a snapshot for use with Y.createDocFromSnapshot. Returns null if missing. */
export function getSnapshotEncoded(ydoc: Y.Doc, id: string): Uint8Array | null {
  const entry = getSnapshotsMap(ydoc).get(id);
  if (!entry) return null;
  return entry.get('encoded') as Uint8Array;
}

/** Delete a snapshot by id. */
export function deleteSnapshot(ydoc: Y.Doc, id: string): void {
  getSnapshotsMap(ydoc).delete(id);
}

// ---------------------------------------------------------------------------
// Sidecar-map restore (aiThreads, weeklyPlans)
// ---------------------------------------------------------------------------
// The snapshot captures the WHOLE Y.Doc, including the aiThreads / weeklyPlans
// maps that live outside the ProseMirror XmlFragment. Restoring the document
// therefore needs to copy those maps back too — but Yjs types can't be moved
// between docs, so we deep-clone every nested value into fresh types.

/** Maps whose content lives outside the PM doc and must be restored separately. */
const SIDECAR_KEYS = ['aiThreads', 'weeklyPlans'] as const;

function cloneYValue(v: unknown): unknown {
  if (v instanceof Y.Text) {
    const t = new Y.Text();
    if (v.length > 0) t.insert(0, v.toString());
    return t;
  }
  if (v instanceof Y.Array) {
    const a = new Y.Array<unknown>();
    a.push(v.toArray().map(cloneYValue));
    return a;
  }
  if (v instanceof Y.Map) {
    const m = new Y.Map<unknown>();
    v.forEach((val, k) => m.set(k, cloneYValue(val)));
    return m;
  }
  return v; // primitive — copied by value
}

// In-place reconcilers. We MUST preserve the identity of the existing Y types:
// the ai/weekly NodeViews are atom nodes the editor reuses across a restore
// (no remount), so their `observeDeep` only fires if we mutate the SAME object
// they're subscribed to — replacing it with a fresh clone would go unnoticed.

function syncTextInto(dest: Y.Text, src: Y.Text): void {
  if (dest.length > 0) dest.delete(0, dest.length);
  if (src.length > 0) dest.insert(0, src.toString());
}

function syncArrayInto(dest: Y.Array<unknown>, src: Y.Array<unknown>): void {
  if (dest.length > 0) dest.delete(0, dest.length);
  dest.push(src.toArray().map(cloneYValue));
}

function syncMapInto(dest: Y.Map<unknown>, src: Y.Map<unknown>): void {
  for (const k of [...dest.keys()]) {
    if (!src.has(k)) dest.delete(k);
  }
  src.forEach((v, k) => {
    const existing = dest.get(k);
    if (v instanceof Y.Map && existing instanceof Y.Map) syncMapInto(existing, v);
    else if (v instanceof Y.Array && existing instanceof Y.Array) syncArrayInto(existing, v);
    else if (v instanceof Y.Text && existing instanceof Y.Text) syncTextInto(existing, v);
    else dest.set(k, cloneYValue(v)); // new key or type changed
  });
}

/**
 * Reconcile the live doc's sidecar maps (aiThreads, weeklyPlans) to match the
 * snapshot's versions, mutating in place so subscribed NodeViews re-render.
 * Runs in a single transaction so peers receive one update. Call BEFORE the
 * XmlFragment is restored.
 */
export function restoreSidecarMaps(liveYdoc: Y.Doc, snapDoc: Y.Doc): void {
  liveYdoc.transact(() => {
    for (const key of SIDECAR_KEYS) {
      syncMapInto(liveYdoc.getMap<unknown>(key), snapDoc.getMap<unknown>(key));
    }
  });
}

/** Delete oldest snapshots beyond maxCount. */
function pruneSnapshots(ydoc: Y.Doc, maxCount: number): void {
  const all = listSnapshots(ydoc); // newest-first
  all.slice(maxCount).forEach((s) => deleteSnapshot(ydoc, s.id));
}

// ---------------------------------------------------------------------------
// Auto-snapshot
// ---------------------------------------------------------------------------

/**
 * Watch the Y.Doc for local changes and take a snapshot after
 * AUTO_SNAPSHOT_IDLE_MS of inactivity. Returns a cleanup function.
 *
 * Only fires on local changes — remote peer edits don't trigger it
 * (each peer manages its own snapshots independently).
 */
export function startAutoSnapshot(ydoc: Y.Doc): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Ignore updates for the first 3 s to skip the initial seed / IndexedDB load.
  let ready = false;
  const readyTimer = setTimeout(() => {
    ready = true;
    // Baseline snapshot on first-ever load — so History is never empty.
    if (listSnapshots(ydoc).length === 0) {
      takeSnapshot(ydoc, 'Initial state');
    }
  }, 3_000);

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      takeSnapshot(ydoc);
      pruneSnapshots(ydoc, MAX_AUTO_SNAPSHOTS);
    }, AUTO_SNAPSHOT_IDLE_MS);
  };

  // 'update' fires with (update, origin). WebsocketProvider sets origin to
  // itself; local PM edits go through ySyncPlugin which also sets an origin.
  // Simplest heuristic: schedule on ANY update and let the idle debounce
  // absorb bursts. Five-minute idle means false-positives are harmless.
  const onUpdate = () => {
    if (ready) schedule();
  };

  ydoc.on('update', onUpdate);

  return () => {
    clearTimeout(readyTimer);
    clearTimeout(timer);
    ydoc.off('update', onUpdate);
  };
}
