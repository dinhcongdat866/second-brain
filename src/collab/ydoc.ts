import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';
import { prosemirrorToYDoc } from 'y-prosemirror';
import type { Node as PMNode } from 'prosemirror-model';
import { createInitialDoc } from '../schema';
import { useUIStore } from '../stores/uiStore';

/**
 * XML fragment key inside the Y.Doc that ProseMirror binds to.
 * Must match the name passed to prosemirrorToYDoc when seeding.
 */
export const XML_FRAGMENT_NAME = 'prosemirror';

/** URL of the y-websocket sync server. Dev: `pnpm dev:ws` (ws://localhost:1234);
 *  prod: set VITE_WS_URL to the deployed relay (wss://<app>.fly.dev). */
export const WS_URL = (import.meta.env.VITE_WS_URL as string | undefined) ?? 'ws://localhost:1234';

/** IndexedDB key for a given doc. 'default' maps to the original store. */
export const collabDbName = (docId: string) => `notebook:${docId}`;

/**
 * Permanently remove the Yjs IndexedDB store for a document.
 * Call this only after the undo window has expired so a restore is still possible.
 */
export function deleteDocStorage(docId: string): void {
  indexedDB.deleteDatabase(collabDbName(docId));
}

/** WebSocket room for a given doc — each doc gets its own collab room. */
export const collabRoom = (docId: string) => `notebook-${docId}`;

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

export function createCollabSetup(docId: string): CollabSetup {
  // gc: false — keep all tombstoned operations so Y.snapshot / time-travel works.
  // The IndexedDB store grows slowly over time; acceptable for a personal notebook.
  const ydoc = new Y.Doc({ gc: false });
  const persistence = new IndexeddbPersistence(collabDbName(docId), ydoc);
  const provider = new WebsocketProvider(WS_URL, collabRoom(docId), ydoc);
  provider.awareness.setLocalStateField('user', randomUser());
  const yXmlFragment = ydoc.getXmlFragment(XML_FRAGMENT_NAME);
  return { ydoc, persistence, provider, yXmlFragment };
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

  const onUpdate = () => {
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
