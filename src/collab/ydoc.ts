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
import { attachRoomToken } from '../lib/sharing';

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

/**
 * Cache name for someone else's document, opened through a share link. Kept in
 * its own namespace so a visited document never lands among your own — and so
 * clearing your storage on sign-out does not silently delete it either.
 */
export const sharedDbName = (docId: string, ownerId: string) =>
  `shared:${ownerId}:${docId}`;

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

/** A provider plus the handle that stops its token refresh. */
type TokenedProvider = WebsocketProvider & { releaseToken: () => void };

/**
 * A provider that waits for a ticket before opening a socket.
 *
 * `connect: false` matters: the relay refuses an upgrade without a valid room
 * token, and a provider created the normal way would immediately start a
 * reconnect loop against a 401 before the token request had even returned.
 */
export function createTokenedProvider(room: string, ydoc: Y.Doc, docId: string): TokenedProvider {
  const provider = new WebsocketProvider(WS_URL, room, ydoc, {
    connect: false,
  }) as TokenedProvider;
  provider.releaseToken = attachRoomToken(provider, docId);
  return provider;
}

export interface CollabSetup {
  ydoc: Y.Doc;
  persistence: IndexeddbPersistence;
  provider: WebsocketProvider;
  yXmlFragment: Y.XmlFragment;
  /** Stops the room-token refresh loop. Call before provider.destroy(). */
  releaseToken: () => void;
}

export interface CollabOptions {
  /** Whose cache this is. Scopes IndexedDB so two accounts never share one. */
  userId?: string;
  /**
   * Whose room to join. Differs from userId only when viewing someone else's
   * document through a share link — the content lives in the owner's room, and
   * the relay will only admit a token minted for that exact room.
   */
  ownerId?: string;
  /** Read someone else's document: cache under the shared namespace. */
  shared?: boolean;
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

export function createCollabSetup(docId: string, opts: CollabOptions = {}): CollabSetup {
  const { userId, ownerId = userId, shared = false } = opts;
  // gc: false — keep all tombstoned operations so Y.snapshot / time-travel works.
  const ydoc = new Y.Doc({ gc: false });
  const dbName = shared && ownerId ? sharedDbName(docId, ownerId) : collabDbName(docId, userId);
  const persistence = new IndexeddbPersistence(dbName, ydoc);
  const provider = createTokenedProvider(collabRoom(docId, ownerId), ydoc, docId);
  provider.awareness.setLocalStateField('user', randomUser());
  const yXmlFragment = ydoc.getXmlFragment(XML_FRAGMENT_NAME);
  return {
    ydoc,
    persistence,
    provider,
    yXmlFragment,
    releaseToken: provider.releaseToken,
  };
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
  releaseToken: () => void;
}

/**
 * Creates the global weekly-planner Y.Doc.
 * All weekly_planner_cells in every notebook document read/write here,
 * so planner data persists and syncs independently of any specific document.
 */
export function createPlannerSetup(userId?: string): PlannerSetup {
  const ydoc = new Y.Doc({ gc: false });
  const persistence = new IndexeddbPersistence(collabDbName(PLANNER_DOC_ID, userId), ydoc);
  const provider = createTokenedProvider(collabRoom(PLANNER_DOC_ID, userId), ydoc, PLANNER_DOC_ID);
  return { ydoc, persistence, provider, releaseToken: provider.releaseToken };
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
