import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';
import { collabRoom, collabDbName } from './ydoc';
import { applyServerState } from '../lib/backendSync';
import { WS_URL } from '../lib/config';

export const MEMORY_DOC_ID = '__memory__';

export interface MemorySetup {
  ydoc: Y.Doc;
  persistence: IndexeddbPersistence;
  provider: WebsocketProvider;
  whenReady: Promise<void>;
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
