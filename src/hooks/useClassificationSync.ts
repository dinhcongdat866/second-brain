/**
 * On app load, scans recent weekly planner todos, diffs them against stored
 * classifications in the DB, and sends only new/changed todos to
 * POST /analytics/classify (max 50 per batch, Haiku).
 *
 * Dirty-check logic:
 *   - todo not in DB → classify
 *   - todo text changed since last classification → re-classify
 *   - todo text unchanged → skip (free)
 *
 * Results are written back onto the todo in Yjs, which is what lets the money
 * cell correlate spending against what you were doing that day without a
 * request.
 *
 * Runs once when ydoc becomes available. Auth users only; guests skip entirely.
 */
import { useCallback, useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { WEEKLY_PLANS_KEY, DAY_KEYS, getMondayOf } from '../collab/weeklyPlans';
import { getApiKey } from '../lib/apiKey';
import { LLM_TIMEOUT_MS } from '../lib/config';
import { apiFetch } from '../lib/http';

const WEEKS_TO_SCAN = 4; // current + 3 previous weeks
const BATCH_SIZE    = 50;  // backend max per request

/**
 * Strip inline formatting markup before sending to the classifier — Claude sees
 * it as garbage and falls back to "Chores" for everything.
 */
function stripMarkup(raw: string): string {
  return raw
    .replace(/\{[a-z]=[^}]*\}/g, '')    // opening tags: {c=#rrggbb}, {b=#rrggbb}, …
    .replace(/\{\/[a-z]\}/g, '')          // closing tags: {/c}, {/b}, …
    .replace(/\*\*(.+?)\*\*/gs, '$1')    // **bold**
    .replace(/~~(.+?)~~/gs, '$1')         // ~~strikethrough~~
    .replace(/\*(.+?)\*/gs, '$1')         // *italic*
    .replace(/_(.+?)_/gs, '$1')           // _italic_
    .trim();
}


/** The wire shape POST /analytics/classify accepts. */
interface TodoItem {
  todo_id: string;
  week_start: string;
  text: string;
}

/** The wire fields, plus what the Y.Doc believes and a handle to write back. */
interface LocalTodo extends TodoItem {
  categories: string[];
  node: Y.Map<unknown>;
}

/** Same set, order-insensitive — the classifier does not promise an order. */
function sameCategories(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((c) => set.has(c));
}

/** Must stay in sync with TAXONOMY_VERSION in backend/app/routers/analytics.py */
const CURRENT_TAXONOMY_VERSION = 3;

interface ClassifyRecord {
  todo_id: string;
  categories: string[];
  todo_text: string | null;
  taxonomy_version: number | null;
}

async function syncClassifications(ydoc: Y.Doc): Promise<void> {
  // Classification is billed to the user's own Anthropic key (the backend has
  // none). Without a key every batch would 400, so skip the scan entirely.
  const userApiKey = getApiKey();
  if (!userApiKey) return;

  // 1. Target weeks: current Monday + 3 previous Mondays
  const today = new Date();
  const targetWeeks = Array.from({ length: WEEKS_TO_SCAN }, (_, i) =>
    getMondayOf(new Date(today.getTime() - i * 7 * 86_400_000)),
  );

  // 2. Collect todos from Yjs, grouped by week_start
  const byWeek = new Map<string, LocalTodo[]>();
  const plans = ydoc.getMap<Y.Map<unknown>>(WEEKLY_PLANS_KEY);

  for (const [, plan] of plans) {
    const weeksMap = plan.get('weeks');
    if (!(weeksMap instanceof Y.Map)) continue;

    for (const weekStart of targetWeeks) {
      const weekData = (weeksMap as Y.Map<unknown>).get(weekStart);
      if (!(weekData instanceof Y.Map)) continue;

      for (const day of DAY_KEYS) {
        const dayList = weekData.get(day);
        if (!(dayList instanceof Y.Array)) continue;

        for (let j = 0; j < dayList.length; j++) {
          const todo = dayList.get(j) as Y.Map<unknown>;
          const id      = todo.get('id')   as string | undefined;
          const rawText = todo.get('text') as string | undefined;
          const text    = rawText ? stripMarkup(rawText) : '';
          if (!id || !text) continue;

          const cached = todo.get('categories');
          const bucket = byWeek.get(weekStart) ?? [];
          bucket.push({
            todo_id: id,
            week_start: weekStart,
            text,
            categories: Array.isArray(cached) ? (cached as string[]) : [],
            node: todo,
          });
          byWeek.set(weekStart, bucket);
        }
      }
    }
  }

  if (byWeek.size === 0) return;

  // 3. Fetch stored classifications per week, then split what needs the model
  //    from what the DB can already answer. A DB row can be current while the
  //    Y.Doc copy is not, and treating that as dirty would re-run the
  //    classifier on the user's own key for an answer Postgres already has.
  const dirty: LocalTodo[] = [];
  const canCopy: Array<{ todo: LocalTodo; categories: string[] }> = [];

  await Promise.all(
    Array.from(byWeek.entries()).map(async ([weekStart, todos]) => {
      const res = await apiFetch(`/analytics/classifications?week_start=${weekStart}`);
      const existing: ClassifyRecord[] = await res.json();

      // Map todo_id → stored record
      const storedMap = new Map(existing.map((r) => [r.todo_id, r]));

      for (const todo of todos) {
        const stored = storedMap.get(todo.todo_id);
        const stale =
          stored === undefined ||                                          // new todo
          stored.todo_text !== todo.text ||                               // text changed
          (stored.taxonomy_version ?? 0) < CURRENT_TAXONOMY_VERSION;     // old taxonomy
        if (stale) { dirty.push(todo); continue; }
        if (!sameCategories(todo.categories, stored.categories)) {
          canCopy.push({ todo, categories: stored.categories });
        }
      }
    }),
  );

  // Copy first: free, and one transaction so the planner re-renders once.
  if (canCopy.length > 0) {
    ydoc.transact(() => {
      for (const { todo, categories } of canCopy) todo.node.set('categories', categories);
    });
  }

  if (dirty.length === 0) return;

  // 4. Classify in batches, writing each back before starting the next so a
  //    later failure does not discard work already paid for.
  for (let i = 0; i < dirty.length; i += BATCH_SIZE) {
    const batch = dirty.slice(i, i + BATCH_SIZE);
    const res = await apiFetch('/analytics/classify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-api-key': userApiKey },
      // Only the wire fields: `node` is a Y.Map with no meaningful JSON form.
      body: JSON.stringify({
        todos: batch.map(({ todo_id, week_start, text }) => ({ todo_id, week_start, text })),
      }),
      timeoutMs: LLM_TIMEOUT_MS,
    });
    const { results } = (await res.json()) as { results: ClassifyRecord[] };
    const byId = new Map(results.map((r) => [r.todo_id, r.categories]));

    ydoc.transact(() => {
      for (const todo of batch) {
        const categories = byId.get(todo.todo_id);
        // A todo deleted while its batch was in flight leaves a detached Y.Map.
        // Writing to it would resurrect nothing and only risks an error.
        if (!categories || todo.node.doc === null) continue;
        todo.node.set('categories', categories);
      }
    });
  }
}

/** The sync pass, exposed for tests — same arrangement as syncMoneyForTest. */
export const syncClassificationsForTest = syncClassifications;

/**
 * @param ydoc     - the active Y.Doc (null while loading)
 * @param enabled  - false for guests; hook no-ops entirely
 * @param isReady  - true once IndexedDB + server state are loaded; prevents
 *                   running on an empty ydoc before todos have been applied
 * @returns `sync()` — call to manually re-trigger (e.g. from /ai-report Generate)
 */
export function useClassificationSync(
  ydoc: Y.Doc | null,
  enabled: boolean,
  isReady: boolean,
): { sync: () => void } {
  const runningRef = useRef(false);

  const sync = useCallback(() => {
    if (!ydoc || !enabled || runningRef.current) return;
    runningRef.current = true;
    syncClassifications(ydoc)
      .catch(() => { /* fail silently — analytics is a background feature */ })
      .finally(() => { runningRef.current = false; });
  }, [ydoc, enabled]);

  // Auto-run once after ydoc is fully loaded (IndexedDB + server state applied).
  useEffect(() => {
    if (ydoc && enabled && isReady) sync();
  }, [ydoc, enabled, isReady, sync]);

  return { sync };
}
