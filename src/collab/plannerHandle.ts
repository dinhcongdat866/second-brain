import type * as Y from 'yjs';

/**
 * Stable indirection to the global weekly-planner Y.Doc.
 *
 * The planner loads asynchronously (IndexedDB → Neon), but the notebook editor
 * must not wait for it. Passing the Y.Doc itself down as a value made its
 * identity change the moment it landed, which re-ran the editor effect and tore
 * the whole EditorView down mid-load — the loading overlay came back and the
 * document re-fetched from scratch. Node views take this handle instead: a
 * reference that never changes, plus a subscription for the moment the doc
 * becomes available.
 */
export interface PlannerHandle {
  /** The planner doc, or null while it is still loading. */
  get(): Y.Doc | null;
  /** Notified when the doc lands. Returns an unsubscribe function. */
  subscribe(listener: (ydoc: Y.Doc) => void): () => void;
}

/** A handle whose doc never arrives — default for callers without a planner. */
export const nullPlannerHandle: PlannerHandle = {
  get: () => null,
  subscribe: () => () => {},
};

/** Write side of a PlannerHandle — held by usePlannerYdoc, never handed out. */
export interface PlannerHandleController extends PlannerHandle {
  set(ydoc: Y.Doc | null): void;
}

export function createPlannerHandle(): PlannerHandleController {
  let doc: Y.Doc | null = null;
  const listeners = new Set<(ydoc: Y.Doc) => void>();

  return {
    get: () => doc,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(next) {
      doc = next;
      if (!next) return;
      // Copy: a listener may unsubscribe itself while being notified.
      for (const listener of [...listeners]) listener(next);
    },
  };
}
