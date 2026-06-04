import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';
import { collabRoom, collabDbName } from './ydoc';
import { applyServerState } from '../lib/backendSync';
import { WS_URL } from '../lib/config';

export const MEMORY_DOC_ID = '__memory__';
const MEMORY_LOG_KEY = 'memoryLog';

export interface MemorySetup {
  ydoc: Y.Doc;
  persistence: IndexeddbPersistence;
  provider: WebsocketProvider;
  whenReady: Promise<void>;
}

export interface MemoryLogEntry {
  id: string;
  createdAt: string;
  sourceCellId: string;
  sourceDocId: string;
  /** The bullet points that were appended, joined by newline. */
  content: string;
  /** ID of the markdown_cell that was inserted — used to delete it. */
  cellId: string;
}

export function createMemorySetup(userId?: string): MemorySetup {
  const ydoc = new Y.Doc({ gc: false });
  const persistence = new IndexeddbPersistence(collabDbName(MEMORY_DOC_ID, userId), ydoc);
  const provider = new WebsocketProvider(WS_URL, collabRoom(MEMORY_DOC_ID, userId), ydoc);

  const whenReady = persistence.whenSynced.then(async () => {
    await applyServerState(MEMORY_DOC_ID, ydoc);
  });

  return { ydoc, persistence, provider, whenReady };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Extract plain text from the Memory Y.Doc's ProseMirror XmlFragment. */
export function readMemoryText(ydoc: Y.Doc): string {
  const fragment = ydoc.getXmlFragment('prosemirror');
  const lines: string[] = [];

  for (const child of fragment.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    const text = extractElementText(child);
    if (text) lines.push(text);
  }

  return lines.join('\n\n').trim();
}

function extractElementText(el: Y.XmlElement): string {
  let text = '';
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) {
      text += child.toString();
    } else if (child instanceof Y.XmlElement) {
      text += extractElementText(child);
    }
  }
  return text.trim();
}

export function readMemoryLog(ydoc: Y.Doc): MemoryLogEntry[] {
  const log = ydoc.getArray<Y.Map<unknown>>(MEMORY_LOG_KEY);
  return log.toArray().map((entry) => ({
    id:           entry.get('id')           as string,
    createdAt:    entry.get('createdAt')    as string,
    sourceCellId: entry.get('sourceCellId') as string,
    sourceDocId:  entry.get('sourceDocId')  as string,
    content:      entry.get('content')      as string,
    cellId:       entry.get('cellId')       as string,
  })).reverse(); // newest first
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Append a batch of bullet strings as a new markdown_cell in Memory.
 * Returns the id of the inserted cell (stored in the log for deletion).
 */
export function appendToMemory(ydoc: Y.Doc, bullets: string[]): string {
  const fragment = ydoc.getXmlFragment('prosemirror');
  const cellId = crypto.randomUUID();
  const now = new Date().toISOString();

  ydoc.transact(() => {
    const cell = new Y.XmlElement('markdown_cell');
    cell.setAttribute('id', cellId);
    cell.setAttribute('created_at', now);
    cell.setAttribute('updated_at', now);

    bullets.forEach((bullet, i) => {
      const para = new Y.XmlElement('paragraph');
      const yText = new Y.XmlText(bullet);
      para.insert(0, [yText]);
      cell.insert(i, [para]);
    });

    fragment.insert(fragment.length, [cell]);
  });

  return cellId;
}

export function addMemoryLogEntry(ydoc: Y.Doc, entry: MemoryLogEntry): void {
  const log = ydoc.getArray<Y.Map<unknown>>(MEMORY_LOG_KEY);
  const map = new Y.Map<unknown>();
  map.set('id',           entry.id);
  map.set('createdAt',    entry.createdAt);
  map.set('sourceCellId', entry.sourceCellId);
  map.set('sourceDocId',  entry.sourceDocId);
  map.set('content',      entry.content);
  map.set('cellId',       entry.cellId);
  log.push([map]);
}

/** Remove a log entry and its corresponding cell from the Memory doc. */
export function deleteMemoryLogEntry(ydoc: Y.Doc, entryId: string): void {
  const log = ydoc.getArray<Y.Map<unknown>>(MEMORY_LOG_KEY);
  const fragment = ydoc.getXmlFragment('prosemirror');

  ydoc.transact(() => {
    // Find and remove log entry, capture cellId
    let cellId: string | undefined;
    for (let i = 0; i < log.length; i++) {
      if (log.get(i).get('id') === entryId) {
        cellId = log.get(i).get('cellId') as string;
        log.delete(i, 1);
        break;
      }
    }
    // Remove the corresponding cell from XmlFragment
    if (cellId) {
      const children = fragment.toArray();
      const idx = children.findIndex(
        (c) => c instanceof Y.XmlElement && c.getAttribute('id') === cellId,
      );
      if (idx !== -1) fragment.delete(idx, 1);
    }
  });
}
