import { useCallback, useEffect, useState } from 'react';
import * as Y from 'yjs';
import { createPlannerSetup, PLANNER_DOC_ID } from '../collab/ydoc';
import {
  createPlannerHandle,
  type PlannerHandle,
  type PlannerHandleController,
} from '../collab/plannerHandle';
import { SHARED_PLAN_ID, WEEKLY_PLANS_KEY } from '../collab/weeklyPlans';
import { createYjsSyncer, applyServerState } from '../lib/backendSync';

export interface PlannerYdocResult {
  ydoc: Y.Doc | null;
  /** True once IndexedDB + server state have been applied — safe to read todos. */
  isReady: boolean;
  /** Stable reference for node views; see collab/plannerHandle. */
  handle: PlannerHandle;
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

  // useState (not useRef) so the handle is created once and read during render
  // without tripping the "no refs during render" rule.
  const [handle] = useState<PlannerHandleController>(createPlannerHandle);

  /** Hand the doc to node views (handle) and to React consumers (state). */
  const publish = useCallback((ydoc: Y.Doc | null) => {
    handle.set(ydoc);
    setPlannerYdoc(ydoc);
  }, [handle]);

  useEffect(() => {
    if (isGuest) {
      const ydoc = new Y.Doc();
      publish(ydoc);
      setIsReady(true);
      return () => {
        publish(null);
        ydoc.destroy();
        setIsReady(false);
      };
    }

    const setup = createPlannerSetup(userId);
    const syncer = createYjsSyncer(PLANNER_DOC_ID, setup.ydoc);
    setIsReady(false);

    let cancelled = false;
    setup.persistence.whenSynced
      .then(() => {
        if (cancelled) return undefined;
        // Cache-first: once IndexedDB holds the shared plan, hand the doc out
        // immediately so planner cells render from cache instead of waiting on
        // the network. The server merge lands on top and WeeklyPlannerCell
        // re-resolves the plan instance.
        //
        // With an empty cache we must wait: getWeeklyPlan would create a fresh
        // empty 'global' plan that can win the Y.Map conflict against the
        // server's copy and permanently shadow it — the race that wiped the
        // planner data once.
        const plans = setup.ydoc.getMap<Y.Map<unknown>>(WEEKLY_PLANS_KEY);
        if (plans.has(SHARED_PLAN_ID)) publish(setup.ydoc);
        return applyServerState(PLANNER_DOC_ID, setup.ydoc);
      })
      .catch(() => {}) // backend unreachable — IndexedDB state alone is still safe
      .then(() => {
        if (cancelled) return;
        publish(setup.ydoc);
        setIsReady(true);
      });

    // The planner doc only had a debounced save before — edits made within the
    // debounce window before teardown were lost. Flush on teardown like the
    // notebook doc: an authenticated merge-save when the page is still alive
    // (hide), and a keepalive beacon as last resort on hard close (pagehide).
    const onHide = () => { if (document.visibilityState === 'hidden') syncer.flush(); };
    const onPageHide = () => syncer.flushBeacon();
    // Late re-sync (mirrors the notebook doc's onVisible handler): if the
    // initial fetch failed despite retries, or another device edited while the
    // tab was hidden, merge fresh server state on tab-visible / network-online.
    // The merge is tagged NEON_SYNC_ORIGIN, so the syncer won't re-save it.
    const onRefetch = () => {
      if (document.visibilityState !== 'visible') return;
      applyServerState(PLANNER_DOC_ID, setup.ydoc).catch(() => {});
    };
    window.addEventListener('visibilitychange', onHide);
    window.addEventListener('visibilitychange', onRefetch);
    window.addEventListener('online', onRefetch);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);

    return () => {
      cancelled = true;
      window.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('visibilitychange', onRefetch);
      window.removeEventListener('online', onRefetch);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
      syncer.stop();
      setup.provider.destroy();
      setup.persistence.destroy();
      publish(null);
      setup.ydoc.destroy();
      setIsReady(false);
    };
  }, [userId, isGuest, publish]);

  return { ydoc: plannerYdoc, isReady, handle };
}
