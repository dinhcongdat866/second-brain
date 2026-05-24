import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';
import { prosemirrorToYDoc } from 'y-prosemirror';
import { createInitialDoc } from '../schema';
import { useUIStore } from '../stores/uiStore';

/**
 * IndexedDB database name for the local CRDT store.
 * Distinct from the old idb-keyval store — no migration, fresh start.
 */
export const COLLAB_DB_NAME = 'notebook:default';

/**
 * XML fragment key inside the Y.Doc that ProseMirror binds to.
 * Must match the name passed to prosemirrorToYDoc when seeding.
 */
export const XML_FRAGMENT_NAME = 'prosemirror';

/** URL of the self-hosted y-websocket sync server (dev: `pnpm dev:ws`). */
export const WS_URL = 'ws://localhost:1234';

/** WebSocket room name — all clients in the same room sync the same doc. */
export const WS_ROOM = 'notebook-default';

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

export function createCollabSetup(): CollabSetup {
  // gc: false — keep all tombstoned operations so Y.snapshot / time-travel works.
  // The IndexedDB store grows slowly over time; acceptable for a personal notebook.
  const ydoc = new Y.Doc({ gc: false });
  const persistence = new IndexeddbPersistence(COLLAB_DB_NAME, ydoc);
  const provider = new WebsocketProvider(WS_URL, WS_ROOM, ydoc);
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
