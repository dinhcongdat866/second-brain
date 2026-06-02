/**
 * Cross-client document registry.
 *
 * The document list used to live in localStorage (per-device) — so a new doc
 * created on one browser/device never appeared on another. It now lives in a
 * dedicated Y.Doc (room `notebook-__registry__`), synced via WebSocket and made
 * durable in Neon (yjs_documents row `doc_id = __registry__`), exactly like a
 * normal notebook doc. IndexedDB is just an offline cache.
 *
 * Shape: ydoc.getMap('docs') = Map<id, Y.Map{ name, createdAt, updatedAt }>.
 *
 * `activeDocId` deliberately stays in localStorage — which doc you're viewing
 * is a per-device UI concern, not shared state.
 */

import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';
import { collabRoom, collabDbName } from './ydoc';
import { applyServerState } from '../lib/backendSync';
import { WS_URL } from '../lib/config';

/** doc_id / room suffix for the registry's own Y.Doc. */
export const REGISTRY_DOC_ID = '__registry__';
/** Key of the docs map inside the registry Y.Doc. */
export const REGISTRY_DOCS_KEY = 'docs';

/** Legacy per-device registry — read once to migrate into the shared Y.Doc. */
const LEGACY_REGISTRY_KEY = 'doc-registry';

export interface DocMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

type DocsMap = Y.Map<Y.Map<unknown>>;

export interface RegistrySetup {
  ydoc: Y.Doc;
  persistence: IndexeddbPersistence;
  provider: WebsocketProvider;
  docsMap: DocsMap;
  /** Resolves after local IndexedDB load + Neon server-state merge. */
  whenReady: Promise<void>;
}

export function createRegistrySetup(): RegistrySetup {
  const ydoc = new Y.Doc();
  const persistence = new IndexeddbPersistence(collabDbName(REGISTRY_DOC_ID), ydoc);
  const provider = new WebsocketProvider(WS_URL, collabRoom(REGISTRY_DOC_ID), ydoc);
  const docsMap = ydoc.getMap<Y.Map<unknown>>(REGISTRY_DOCS_KEY);

  const whenReady = persistence.whenSynced.then(async () => {
    await applyServerState(REGISTRY_DOC_ID, ydoc);
  });

  return { ydoc, persistence, provider, docsMap, whenReady };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function readDocs(docsMap: DocsMap): DocMeta[] {
  const out: DocMeta[] = [];
  docsMap.forEach((entry, id) => {
    out.push({
      id,
      name: (entry.get('name') as string) ?? 'Untitled',
      createdAt: (entry.get('createdAt') as string) ?? '',
      updatedAt: (entry.get('updatedAt') as string) ?? '',
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Writes (each one Yjs update → synced + persisted)
// ---------------------------------------------------------------------------

function writeMeta(docsMap: DocsMap, meta: DocMeta): void {
  const entry = new Y.Map<unknown>();
  entry.set('name', meta.name);
  entry.set('createdAt', meta.createdAt);
  entry.set('updatedAt', meta.updatedAt);
  docsMap.set(meta.id, entry);
}

export function createDoc(docsMap: DocsMap, name: string): DocMeta {
  const now = new Date().toISOString();
  const meta: DocMeta = { id: crypto.randomUUID(), name, createdAt: now, updatedAt: now };
  writeMeta(docsMap, meta);
  return meta;
}

export function renameDoc(docsMap: DocsMap, id: string, name: string): void {
  const entry = docsMap.get(id);
  if (!entry) return;
  entry.set('name', name);
  entry.set('updatedAt', new Date().toISOString());
}

export function deleteDoc(docsMap: DocsMap, id: string): void {
  docsMap.delete(id);
}

/** Re-insert a previously deleted doc (undo). No-op if already present. */
export function restoreDoc(docsMap: DocsMap, meta: DocMeta): void {
  if (!docsMap.has(meta.id)) writeMeta(docsMap, meta);
}

export function touchDoc(docsMap: DocsMap, id: string): void {
  const entry = docsMap.get(id);
  if (!entry) return;
  entry.set('updatedAt', new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Bootstrap + migration (run once, after whenReady, only if registry is empty)
// ---------------------------------------------------------------------------

function readLegacyLocal(): DocMeta[] {
  try {
    const raw = localStorage.getItem(LEGACY_REGISTRY_KEY);
    if (raw) return JSON.parse(raw) as DocMeta[];
  } catch {
    /* ignore malformed */
  }
  return [];
}

/**
 * Ensure the shared registry has at least one doc. If empty, migrate the old
 * localStorage list (so existing users keep their docs), else seed a default
 * "Journal" doc that maps to the pre-existing `notebook:default` store.
 * Idempotent: does nothing once the registry has entries.
 */
export function bootstrapRegistry(docsMap: DocsMap): void {
  if (docsMap.size > 0) return;

  const legacy = readLegacyLocal();
  const now = new Date().toISOString();
  const seed: DocMeta[] =
    legacy.length > 0
      ? legacy
      : [{ id: 'default', name: 'Journal', createdAt: now, updatedAt: now }];

  docsMap.doc?.transact(() => {
    for (const meta of seed) writeMeta(docsMap, meta);
  });
}

/** Optimistic first-paint list from the legacy store (avoids an empty sidebar). */
export function optimisticDocs(): DocMeta[] {
  const legacy = readLegacyLocal();
  if (legacy.length > 0) return legacy;
  const now = new Date().toISOString();
  return [{ id: 'default', name: 'Journal', createdAt: now, updatedAt: now }];
}
