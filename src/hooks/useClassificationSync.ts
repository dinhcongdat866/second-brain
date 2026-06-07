/**
 * On app load, scans the last 4 weeks of weekly planner todos, diffs them
 * against stored classifications in the DB, and sends only new/changed todos
 * to POST /analytics/classify (max 50 per batch, Haiku).
 *
 * Dirty-check logic:
 *   - todo not in DB → classify
 *   - todo text changed since last classification → re-classify
 *   - todo text unchanged → skip (free)
 *
 * Runs once when ydoc becomes available. Auth users only; guests skip entirely.
 */
import { useCallback, useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { WEEKLY_PLANS_KEY, DAY_KEYS } from '../collab/weeklyPlans';
import { apiFetch } from '../lib/http';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEEKS_TO_SCAN = 4;   // current + 3 previous weeks
const BATCH_SIZE    = 50;  // backend max per request

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip inline formatting markup from weekly planner todo text before
 * sending to the classifier.
 *
 * Weekly planner stores raw strings that may contain:
 *   - Color marks:      {c=#rrggbb}text{/c}
 *   - Bold markdown:    **text**
 *   - Strikethrough:    ~~text~~
 *   - Italic markdown:  _text_ or *text*
 *
 * Claude sees the markup as garbage → falls back to "Chores" for everything.
 */
function stripMarkup(raw: string): string {
  return raw
    .replace(/\{c=[^}]*\}/g, '')   // opening color tag  {c=#rrggbb}
    .replace(/\{\/c\}/g, '')        // closing color tag  {/c}
    .replace(/\*\*(.+?)\*\*/g, '$1') // **bold**
    .replace(/~~(.+?)~~/g, '$1')    // ~~strikethrough~~
    .replace(/\*(.+?)\*/g, '$1')    // *italic*
    .replace(/_(.+?)_/g, '$1')      // _italic_
    .trim();
}

/** Monday of the week containing `date`, as 'YYYY-MM-DD'. */
function mondayOf(date: Date): string {
  const d = new Date(date);
  const day = d.getDay();          // 0 = Sunday
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().slice(0, 10);
}

interface TodoItem {
  todo_id: string;
  week_start: string;
  text: string;
}

interface ClassifyRecord {
  todo_id: string;
  categories: string[];
  todo_text: string | null;
}

// ---------------------------------------------------------------------------
// Core sync logic (runs outside React)
// ---------------------------------------------------------------------------

async function syncClassifications(ydoc: Y.Doc): Promise<void> {
  // 1. Target weeks: current Monday + 3 previous Mondays
  const today = new Date();
  const targetWeeks = Array.from({ length: WEEKS_TO_SCAN }, (_, i) =>
    mondayOf(new Date(today.getTime() - i * 7 * 86_400_000)),
  );

  // 2. Collect todos from Yjs, grouped by week_start
  const byWeek = new Map<string, TodoItem[]>();
  const plans = ydoc.getMap<Y.Map<unknown>>(WEEKLY_PLANS_KEY);

  for (const [, plan] of plans) {
    const weeksMap = plan.get('weeks');
    if (!(weeksMap instanceof Y.Map)) continue;

    for (const weekStart of targetWeeks) {
      const weekData = weeksMap.get(weekStart);
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

          const bucket = byWeek.get(weekStart) ?? [];
          bucket.push({ todo_id: id, week_start: weekStart, text });
          byWeek.set(weekStart, bucket);
        }
      }
    }
  }

  if (byWeek.size === 0) return;

  // 3. Fetch stored classifications per week, build dirty list
  const dirty: TodoItem[] = [];

  await Promise.all(
    Array.from(byWeek.entries()).map(async ([weekStart, todos]) => {
      const res = await apiFetch(`/analytics/classifications?week_start=${weekStart}`);
      const existing: ClassifyRecord[] = await res.json();

      // Map todo_id → stored text snapshot
      const storedText = new Map(
        existing.map((r) => [r.todo_id, r.todo_text ?? '']),
      );

      for (const todo of todos) {
        const stored = storedText.get(todo.todo_id);
        // New todo (not in DB) or text has changed since last classification
        if (stored === undefined || stored !== todo.text) {
          dirty.push(todo);
        }
      }
    }),
  );

  if (dirty.length === 0) return;

  // 4. Classify in batches of BATCH_SIZE (backend limit: 50)
  for (let i = 0; i < dirty.length; i += BATCH_SIZE) {
    const batch = dirty.slice(i, i + BATCH_SIZE);
    await apiFetch('/analytics/classify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ todos: batch }),
    });
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * @param ydoc  - the active Y.Doc (null while loading)
 * @param enabled - false for guests; hook no-ops entirely
 * @returns `sync()` — call to manually re-trigger (e.g. from /ai-report Generate)
 */
export function useClassificationSync(
  ydoc: Y.Doc | null,
  enabled: boolean,
): { sync: () => void } {
  const runningRef = useRef(false);

  const sync = useCallback(() => {
    if (!ydoc || !enabled || runningRef.current) return;
    runningRef.current = true;
    syncClassifications(ydoc)
      .catch(() => { /* fail silently — analytics is a background feature */ })
      .finally(() => { runningRef.current = false; });
  }, [ydoc, enabled]);

  // Auto-run once when ydoc first becomes available
  useEffect(() => {
    if (ydoc && enabled) sync();
  }, [ydoc, enabled, sync]);

  return { sync };
}
