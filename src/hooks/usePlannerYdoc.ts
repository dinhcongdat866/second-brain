import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { createPlannerSetup, PLANNER_DOC_ID } from '../collab/ydoc';
import { createYjsSyncer, applyServerState } from '../lib/backendSync';

/**
 * Creates and manages the global weekly-planner Y.Doc.
 *
 * All weekly_planner_cells across every notebook document share this single
 * Y.Doc, so planner data is not tied to any specific document and persists
 * when you switch documents or create new ones.
 *
 * Guests get an in-memory-only Y.Doc (no IndexedDB / WebSocket).
 */
export function usePlannerYdoc(userId: string | undefined, isGuest: boolean): Y.Doc | null {
  const [plannerYdoc, setPlannerYdoc] = useState<Y.Doc | null>(null);

  useEffect(() => {
    if (isGuest) {
      const ydoc = new Y.Doc();
      setPlannerYdoc(ydoc);
      return () => {
        ydoc.destroy();
        setPlannerYdoc(null);
      };
    }

    const setup = createPlannerSetup(userId);
    const syncer = createYjsSyncer(PLANNER_DOC_ID, setup.ydoc);
    setPlannerYdoc(setup.ydoc);

    // Load from IndexedDB first, then merge server state on top.
    setup.persistence.whenSynced
      .then(() => applyServerState(PLANNER_DOC_ID, setup.ydoc))
      .catch(() => {});

    return () => {
      syncer.stop();
      setup.provider.destroy();
      setup.persistence.destroy();
      setup.ydoc.destroy();
      setPlannerYdoc(null);
    };
  }, [userId, isGuest]);

  return plannerYdoc;
}
