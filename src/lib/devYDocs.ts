/**
 * Dev-only Y.Doc inspector, reachable from the browser console as `__yd`.
 *
 * This app's data shape exists nowhere on disk: there is no schema file, only
 * `getMap('aiThreads')` / `getXmlFragment('prosemirror')` string keys scattered
 * across modules. Reading the source tells you far less than looking at a live
 * doc, so this exposes the four Y.Docs and a couple of helpers to walk them.
 *
 *   __yd.notebook / .planner / .registry / .memory   the live Y.Docs
 *   __yd.keys('notebook')          top-level keys actually present
 *   __yd.dump('notebook', 'aiThreads')   that key as plain JSON
 *   __yd.size()                    encoded byte size of each doc
 *
 * Every export is a no-op unless import.meta.env.DEV, so the bodies fold away
 * in a production build.
 */
import * as Y from 'yjs';

export type YDocKind = 'notebook' | 'planner' | 'registry' | 'memory';

interface Inspector {
  notebook: Y.Doc | null;
  planner: Y.Doc | null;
  registry: Y.Doc | null;
  memory: Y.Doc | null;
  keys(kind: YDocKind): string[];
  dump(kind: YDocKind, key: string): unknown;
  size(): void;
}

const KINDS: YDocKind[] = ['notebook', 'planner', 'registry', 'memory'];

function getInspector(): Inspector {
  const w = window as unknown as { __yd?: Inspector };
  if (w.__yd) return w.__yd;

  const inspector: Inspector = {
    notebook: null,
    planner: null,
    registry: null,
    memory: null,

    /**
     * Top-level shared types present in the doc. `doc.share` only lists keys
     * that have actually been touched, which is exactly what you want here —
     * it reflects the doc as it really is, not as the code might create it.
     */
    keys(kind) {
      const doc = inspector[kind];
      return doc ? [...doc.share.keys()] : [];
    },

    dump(kind, key) {
      const doc = inspector[kind];
      if (!doc) return null;
      const type = doc.share.get(key);
      if (!type) return null;
      // XmlFragment has no useful toJSON — its string form is the readable one.
      return type instanceof Y.XmlFragment ? type.toString() : type.toJSON();
    },

    size() {
      const rows = KINDS.map((kind) => {
        const doc = inspector[kind];
        return {
          doc: kind,
          KB: doc ? +(Y.encodeStateAsUpdate(doc).byteLength / 1024).toFixed(1) : null,
          keys: doc ? [...doc.share.keys()].join(', ') : '(not loaded)',
        };
      });
      console.table(rows);
      navigator.storage?.estimate?.().then((e) => {
        if (e.usage == null) return;
        console.info(`IndexedDB total: ${(e.usage / 1048576).toFixed(1)} MB`);
      });
    },
  };

  w.__yd = inspector;
  console.info(
    '%c__yd%c ready — try __yd.size() or __yd.keys("notebook")',
    'font-weight:bold',
    '',
  );
  return inspector;
}

/** Register (or clear, with null) one of the app's Y.Docs for console access. */
export function exposeYDoc(kind: YDocKind, ydoc: Y.Doc | null): void {
  if (!import.meta.env.DEV) return;
  getInspector()[kind] = ydoc;
}
