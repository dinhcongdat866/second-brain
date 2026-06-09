import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { createPlannerSetup, PLANNER_DOC_ID } from '../collab/ydoc';
import { createYjsSyncer, applyServerState } from '../lib/backendSync';

export interface PlannerYdocResult {
  ydoc: Y.Doc | null;
  /** True once IndexedDB + server state have been applied — safe to read todos. */
  isReady: boolean;
}

/**
 * Creates and manages the global weekly-planner Y.Doc.
 *
 * All weekly_planner_cells across every notebook document share this single
 * Y.Doc, so planner data is not tied to any specific document and persists
 * when you switch documents or create new ones.
 *
 * Guests get an in-memory-only Y.Doc (no IndexedDB / WebSocket).
 * `isReady` is true immediately for guests (nothing to load).
 */
export function usePlannerYdoc(userId: string | undefined, isGuest: boolean): PlannerYdocResult {
  const [plannerYdoc, setPlannerYdoc] = useState<Y.Doc | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (isGuest) {
      const ydoc = new Y.Doc();
      setPlannerYdoc(ydoc);
      setIsReady(true);
      return () => {
        ydoc.destroy();
        setPlannerYdoc(null);
        setIsReady(false);
      };
    }

    const setup = createPlannerSetup(userId);
    const syncer = createYjsSyncer(PLANNER_DOC_ID, setup.ydoc);
    setPlannerYdoc(setup.ydoc);
    setIsReady(false);

    // Load from IndexedDB first, then merge server state on top.
    // Only mark ready after both complete so consumers read a fully-loaded doc.
    setup.persistence.whenSynced
      .then(() => applyServerState(PLANNER_DOC_ID, setup.ydoc))
      .then(() => setIsReady(true))
      .catch(() => setIsReady(true)); // still mark ready on error so UI isn't stuck

    return () => {
      syncer.stop();
      setup.provider.destroy();
      setup.persistence.destroy();
      setup.ydoc.destroy();
      setPlannerYdoc(null);
      setIsReady(false);
    };
  }, [userId, isGuest]);

  return { ydoc: plannerYdoc, isReady };
}
