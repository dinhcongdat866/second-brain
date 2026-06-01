import * as Y from 'yjs';

export const WEEKLY_PLANS_KEY = 'weeklyPlans';

export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export const DAY_KEYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export const DAY_LABELS: Record<DayKey, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu',
  fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

export type YTodo = Y.Map<unknown>;
export type YDayList = Y.Array<YTodo>;

export interface TodoData {
  id: string;
  text: string;
  done: boolean;
}

export type AllDays = Record<DayKey, TodoData[]>;

// ---------------------------------------------------------------------------
// Week helpers
// ---------------------------------------------------------------------------

function getMondayOf(date: Date): string {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export function weekRangeLabel(weekStart: string): string {
  const [y, mo, d] = weekStart.split('-').map(Number);
  const start = new Date(y, mo - 1, d);
  const end   = new Date(y, mo - 1, d + 6);
  const fmt = (dt: Date) => `${dt.getDate()} ${MONTHS[dt.getMonth()]}`;
  return `${fmt(start)} – ${fmt(end)} ${end.getFullYear()}`;
}

/** Returns the DayKey for today relative to weekStart, or null if today is outside this week. */
export function todayDayKey(weekStart: string): DayKey | null {
  const [y, mo, d] = weekStart.split('-').map(Number);
  const monday = new Date(y, mo - 1, d);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const diff = Math.round((now.getTime() - monday.getTime()) / 86_400_000);
  return diff >= 0 && diff < 7 ? DAY_KEYS[diff] : null;
}

// ---------------------------------------------------------------------------
// Yjs CRUD
// ---------------------------------------------------------------------------

export function getWeeklyPlan(ydoc: Y.Doc, cellId: string): Y.Map<unknown> {
  const plans = ydoc.getMap<Y.Map<unknown>>(WEEKLY_PLANS_KEY);
  let plan = plans.get(cellId);
  if (!plan) {
    plan = new Y.Map<unknown>();
    plan.set('weekStart', getMondayOf(new Date()));
    for (const day of DAY_KEYS) {
      plan.set(day, new Y.Array<YTodo>());
    }
    plans.set(cellId, plan);
  }
  return plan;
}

export function getDayList(plan: Y.Map<unknown>, day: DayKey): YDayList {
  return plan.get(day) as YDayList;
}

export function readAllDays(plan: Y.Map<unknown>): AllDays {
  const result = {} as AllDays;
  for (const day of DAY_KEYS) {
    const list = plan.get(day) as YDayList | undefined;
    result[day] = list
      ? list.toArray().map(t => ({
          id:   t.get('id')   as string,
          text: t.get('text') as string,
          done: t.get('done') as boolean,
        }))
      : [];
  }
  return result;
}

export function addTodo(plan: Y.Map<unknown>, day: DayKey, text: string): void {
  const list = getDayList(plan, day);
  if (!list) return;
  const todo: YTodo = new Y.Map();
  todo.set('id',   crypto.randomUUID());
  todo.set('text', text.trim());
  todo.set('done', false);
  list.push([todo]);
}

export function toggleTodo(plan: Y.Map<unknown>, day: DayKey, todoId: string): void {
  const list = getDayList(plan, day);
  if (!list) return;
  for (let i = 0; i < list.length; i++) {
    const todo = list.get(i);
    if (todo.get('id') === todoId) {
      todo.set('done', !todo.get('done'));
      return;
    }
  }
}

export function deleteTodo(plan: Y.Map<unknown>, day: DayKey, todoId: string): void {
  const list = getDayList(plan, day);
  if (!list) return;
  for (let i = 0; i < list.length; i++) {
    if (list.get(i).get('id') === todoId) {
      list.delete(i, 1);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Orphan sweep (called at load time, mirrors sweepOrphanThreads)
// ---------------------------------------------------------------------------

export function sweepOrphanWeeklyPlans(ydoc: Y.Doc, yXmlFragment: Y.XmlFragment): void {
  const plans = ydoc.getMap<Y.Map<unknown>>(WEEKLY_PLANS_KEY);
  if (plans.size === 0) return;

  const liveCellIds = new Set<string>();
  for (const child of yXmlFragment.toArray()) {
    if (child instanceof Y.XmlElement && child.nodeName === 'weekly_planner_cell') {
      const id = child.getAttribute('id');
      if (id) liveCellIds.add(id);
    }
  }

  const orphans = [...plans.keys()].filter((id) => !liveCellIds.has(id));
  if (orphans.length === 0) return;

  ydoc.transact(() => {
    for (const id of orphans) plans.delete(id);
  });
}
