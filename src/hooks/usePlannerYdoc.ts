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
    setIsReady(false);

    // Load from IndexedDB first, then merge server state on top.
    // The ydoc is only exposed once BOTH have been applied: handing out a
    // still-loading doc lets getWeeklyPlan create a fresh empty 'global' plan
    // that conflicts with (and can permanently shadow) the real one when the
    // loaded state merges in — this exact race wiped the planner data once.
    let cancelled = false;
    setup.persistence.whenSynced
      .then(() => applyServerState(PLANNER_DOC_ID, setup.ydoc))
      .catch(() => {}) // backend unreachable — IndexedDB state alone is still safe
      .then(() => {
        if (cancelled) return;
        setPlannerYdoc(setup.ydoc);
        setIsReady(true);
      });

    // The planner doc only had a debounced save before — edits made within the
    // debounce window before teardown were lost. Flush on teardown like the
    // notebook doc: an authenticated merge-save when the page is still alive
    // (hide), and a keepalive beacon as last resort on hard close (pagehide).
    const onHide = () => { if (document.visibilityState === 'hidden') syncer.flush(); };
    const onPageHide = () => syncer.flushBeacon();
    window.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);

    return () => {
      cancelled = true;
      window.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
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
