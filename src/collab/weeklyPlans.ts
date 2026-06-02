import * as Y from 'yjs';
import { STYLE_OPEN_RE, STYLE_CLOSE_RE, type StyleKind } from '../lib/toolbarStyles';

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

/** Snap an arbitrary 'YYYY-MM-DD' date to the Monday of its week and store it. */
export function setWeekStart(plan: Y.Map<unknown>, dateStr: string): void {
  const [y, mo, d] = dateStr.split('-').map(Number);
  plan.set('weekStart', getMondayOf(new Date(y, mo - 1, d)));
}

/** Shift the plan's week by `deltaWeeks` (±). Stays normalized to Monday. */
export function shiftWeek(plan: Y.Map<unknown>, deltaWeeks: number): void {
  const cur = plan.get('weekStart') as string;
  const [y, mo, d] = cur.split('-').map(Number);
  plan.set('weekStart', getMondayOf(new Date(y, mo - 1, d + deltaWeeks * 7)));
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

/**
 * Maps every *visible* (rendered) character index to its index in the raw
 * markdown source. Marker characters (`**`, `_`, `~~`, `` ` ``, and link
 * `[...](...)` syntax) contribute no visible character and are skipped, so a
 * selection made against rendered text can be located in the stored source.
 * Mirrors the constructs handled by renderMd.
 */
function visibleToRawMap(raw: string): number[] {
  const map: number[] = [];
  const linkRe = /^\[([^\]]+)\]\(([^)]+)\)/;
  let i = 0;
  while (i < raw.length) {
    const m = linkRe.exec(raw.slice(i));
    if (m) {
      const textStart = i + 1; // skip '['
      for (let k = 0; k < m[1].length; k++) map.push(textStart + k);
      i += m[0].length;
      continue;
    }
    // Style markers `{c=...}` / `{/c}` contribute no visible char.
    const rest = raw.slice(i);
    const styleOpen = STYLE_OPEN_RE.exec(rest);
    if (styleOpen) { i += styleOpen[0].length; continue; }
    const styleClose = STYLE_CLOSE_RE.exec(rest);
    if (styleClose) { i += styleClose[0].length; continue; }
    if (raw.startsWith('**', i) || raw.startsWith('~~', i)) { i += 2; continue; }
    if (raw[i] === '_' || raw[i] === '`') { i += 1; continue; }
    map.push(i);
    i += 1;
  }
  return map;
}

/**
 * Wraps the rendered-text selection [visStart, visEnd) of a todo with the
 * given markers. Offsets are positions in the *visible* text; they are mapped
 * back to raw-source positions so wrapping works even when the todo already
 * contains markdown (each visible char maps to exactly one raw char).
 */
export function formatTodoText(
  plan: Y.Map<unknown>,
  day: DayKey,
  todoId: string,
  visStart: number,
  visEnd: number,
  open: string,
  close: string,
): void {
  const list = getDayList(plan, day);
  if (!list) return;
  for (let i = 0; i < list.length; i++) {
    const todo = list.get(i);
    if (todo.get('id') !== todoId) continue;
    const text = todo.get('text') as string;
    const map = visibleToRawMap(text);
    if (visStart < 0 || visEnd > map.length || visStart >= visEnd) return;
    const rawStart = map[visStart];
    const rawEnd = map[visEnd - 1] + 1;
    todo.set(
      'text',
      text.slice(0, rawStart) + open + text.slice(rawStart, rawEnd) + close + text.slice(rawEnd),
    );
    return;
  }
}

const KIND_CHAR: Record<StyleKind, string> = { color: 'c', bg: 'b', size: 's' };

/**
 * Removes the style markers of `kind` enclosing the rendered-text selection —
 * strips the nearest `{x=...}` opener before the selection and its matching
 * `{/x}` closer after it. Best-effort: handles the common "select a styled run
 * and reset it" case.
 */
export function clearTodoStyle(
  plan: Y.Map<unknown>,
  day: DayKey,
  todoId: string,
  visStart: number,
  visEnd: number,
  kind: StyleKind,
): void {
  const list = getDayList(plan, day);
  if (!list) return;
  const ch = KIND_CHAR[kind];
  for (let i = 0; i < list.length; i++) {
    const todo = list.get(i);
    if (todo.get('id') !== todoId) continue;
    const text = todo.get('text') as string;
    const map = visibleToRawMap(text);
    if (visStart < 0 || visEnd > map.length || visStart >= visEnd) return;
    const rawStart = map[visStart];
    const rawEnd = map[visEnd - 1] + 1;

    const before = text.slice(0, rawStart);
    const middle = text.slice(rawStart, rawEnd);
    const after = text.slice(rawEnd);

    // Nearest opener `{ch=...}` in `before`.
    const openRe = new RegExp(`\\{${ch}=[^}]+\\}`, 'g');
    let open: RegExpExecArray | null = null;
    for (let m = openRe.exec(before); m; m = openRe.exec(before)) open = m;
    const closeTok = `{/${ch}}`;
    const closeIdx = after.indexOf(closeTok);
    if (!open || closeIdx === -1) return; // nothing enclosing — no-op

    todo.set(
      'text',
      before.slice(0, open.index) +
        before.slice(open.index + open[0].length) +
        middle +
        after.slice(0, closeIdx) +
        after.slice(closeIdx + closeTok.length),
    );
    return;
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
