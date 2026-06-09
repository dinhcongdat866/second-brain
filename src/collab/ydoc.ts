import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';
import { prosemirrorToYDoc } from 'y-prosemirror';
import type { Node as PMNode } from 'prosemirror-model';
import { createInitialDoc, createGuestDemoDoc } from '../schema';
import { useUIStore } from '../stores/uiStore';
import { WS_URL } from '../lib/config';
import { NEON_SYNC_ORIGIN } from '../lib/backendSync';

/**
 * XML fragment key inside the Y.Doc that ProseMirror binds to.
 * Must match the name passed to prosemirrorToYDoc when seeding.
 */
export const XML_FRAGMENT_NAME = 'prosemirror';

/**
 * IndexedDB key scoped by userId — prevents same-browser cross-user leakage.
 * On first login the scoped key is empty; data is fetched from Supabase instead.
 */
export const collabDbName = (docId: string, userId?: string) =>
  userId ? `notebook:${userId}:${docId}` : `notebook:${docId}`;

/** Permanently remove the Yjs IndexedDB store for a document. */
export function deleteDocStorage(docId: string, userId?: string): void {
  indexedDB.deleteDatabase(collabDbName(docId, userId));
}

/**
 * Clear all Yjs IndexedDB stores for a given user.
 * Call on sign-out so the next user starts fresh from the server.
 */
export async function clearUserStorage(userId: string): Promise<void> {
  try {
    const dbs = await indexedDB.databases();
    const prefix = `notebook:${userId}:`;
    await Promise.all(
      dbs
        .filter((db) => db.name?.startsWith(prefix))
        .map((db) => indexedDB.deleteDatabase(db.name!)),
    );
  } catch {
    // indexedDB.databases() not supported in all browsers — safe to ignore
  }
}

/**
 * WebSocket room for a given doc, scoped by userId so different users never
 * share a room and see each other's content.
 */
export const collabRoom = (docId: string, userId?: string) =>
  userId ? `notebook-${userId}-${docId}` : `notebook-${docId}`;

/** Cursor/selection colors handed out to peers via awareness. */
const CURSOR_COLORS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
];

/**
 * Per-session identity for presence. No auth yet — a random name + color is
 * enough for yCursorPlugin to label remote carets.
 */
function randomUser() {
  return {
    name: `User ${Math.floor(1000 + Math.random() * 9000)}`,
    color: CURSOR_COLORS[Math.floor(Math.random() * CURSOR_COLORS.length)],
  };
}

export interface CollabSetup {
  ydoc: Y.Doc;
  persistence: IndexeddbPersistence;
  provider: WebsocketProvider;
  yXmlFragment: Y.XmlFragment;
}

/**
 * Lightweight setup for guest mode: no IndexedDB, no WebSocket.
 * Data lives only in memory for the lifetime of the tab.
 */
export interface GuestDocSetup {
  ydoc: Y.Doc;
  yXmlFragment: Y.XmlFragment;
  /** Local-only awareness (no network sync). Required by yCursorPlugin. */
  awareness: Awareness;
}

export function createGuestDocSetup(): GuestDocSetup {
  const ydoc = new Y.Doc({ gc: false });
  const awareness = new Awareness(ydoc);
  awareness.setLocalStateField('user', randomUser());
  const yXmlFragment = ydoc.getXmlFragment(XML_FRAGMENT_NAME);
  return { ydoc, yXmlFragment, awareness };
}

export function createCollabSetup(docId: string, userId?: string): CollabSetup {
  // gc: false — keep all tombstoned operations so Y.snapshot / time-travel works.
  const ydoc = new Y.Doc({ gc: false });
  const persistence = new IndexeddbPersistence(collabDbName(docId, userId), ydoc);
  const provider = new WebsocketProvider(WS_URL, collabRoom(docId, userId), ydoc);
  provider.awareness.setLocalStateField('user', randomUser());
  const yXmlFragment = ydoc.getXmlFragment(XML_FRAGMENT_NAME);
  return { ydoc, persistence, provider, yXmlFragment };
}

// ---------------------------------------------------------------------------
// Global weekly-planner Y.Doc — shared across all notebook documents
// ---------------------------------------------------------------------------

/** Stable doc_id / room suffix for the global planner Y.Doc. */
export const PLANNER_DOC_ID = '__weekly-planner__';

export interface PlannerSetup {
  ydoc: Y.Doc;
  persistence: IndexeddbPersistence;
  provider: WebsocketProvider;
}

/**
 * Creates the global weekly-planner Y.Doc.
 * All weekly_planner_cells in every notebook document read/write here,
 * so planner data persists and syncs independently of any specific document.
 */
export function createPlannerSetup(userId?: string): PlannerSetup {
  const ydoc = new Y.Doc({ gc: false });
  const persistence = new IndexeddbPersistence(collabDbName(PLANNER_DOC_ID, userId), ydoc);
  const provider = new WebsocketProvider(WS_URL, collabRoom(PLANNER_DOC_ID, userId), ydoc);
  return { ydoc, persistence, provider };
}

/**
 * A brand-new Y.Doc has an empty fragment. ySyncPlugin would then render an
 * empty doc filled by the schema — producing a markdown_cell with a blank id.
 * Seed real initial content (proper UUID + timestamps) before binding.
 */
export function seedIfEmpty(ydoc: Y.Doc, yXmlFragment: Y.XmlFragment): void {
  if (yXmlFragment.length > 0) return;
  const seed = prosemirrorToYDoc(createInitialDoc(), XML_FRAGMENT_NAME);
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(seed));
  seed.destroy();
}

/**
 * Like seedIfEmpty but uses the guest demo document — a markdown welcome cell,
 * a weekly planner cell, and an AI cell — so first-time visitors immediately
 * see what the app can do.
 */
export function seedGuestDoc(ydoc: Y.Doc, yXmlFragment: Y.XmlFragment): void {
  if (yXmlFragment.length > 0) return;
  const seed = prosemirrorToYDoc(createGuestDemoDoc(), XML_FRAGMENT_NAME);
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(seed));
  seed.destroy();
}

/**
 * Seed a Y.Doc from an existing PM doc node (used when importing a file into
 * a brand-new document). Skips if the fragment already has content so it is
 * safe to call unconditionally after `whenSynced`.
 */
export function seedFromContent(
  ydoc: Y.Doc,
  yXmlFragment: Y.XmlFragment,
  pmDoc: PMNode,
): void {
  if (yXmlFragment.length > 0) return;
  const seed = prosemirrorToYDoc(pmDoc, XML_FRAGMENT_NAME);
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(seed));
  seed.destroy();
}

/**
 * y-indexeddb persists on every Y.Doc update with no per-write callback.
 * Mirror the old autosave indicator: pending on update, saved after a debounce.
 */
export function wireSaveStatus(ydoc: Y.Doc): () => void {
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const onUpdate = (_update: Uint8Array, origin: unknown) => {
    // Remote Neon pulls are already persisted — don't show a misleading indicator.
    if (origin === NEON_SYNC_ORIGIN) return;
    useUIStore.getState().setSaveStatus('pending');
    clearTimeout(pendingTimer);
    clearTimeout(idleTimer);
    pendingTimer = setTimeout(() => {
      useUIStore.getState().setSaveStatus('saved');
      idleTimer = setTimeout(() => {
        useUIStore.getState().setSaveStatus('idle');
      }, 2000);
    }, 500);
  };

  ydoc.on('update', onUpdate);
  return () => {
    ydoc.off('update', onUpdate);
    clearTimeout(pendingTimer);
    clearTimeout(idleTimer);
  };
}
