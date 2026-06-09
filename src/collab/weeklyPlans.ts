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
// Migration from flat format → per-week nested format
// Old: Y.Map { weekStart, mon..sun: Y.Array<YTodo> }
// New: Y.Map { weekStart, weeks: Y.Map<weekStart, Y.Map { mon..sun: Y.Array<YTodo> }> }
// ---------------------------------------------------------------------------

function migrateIfNeeded(ydoc: Y.Doc, plan: Y.Map<unknown>): void {
  if (plan.get('weeks') instanceof Y.Map) return;
  const weekStart = plan.get('weekStart') as string;
  ydoc.transact(() => {
    const weeksMap = new Y.Map<unknown>();
    const weekData = new Y.Map<unknown>();
    for (const day of DAY_KEYS) {
      const oldList = plan.get(day) as YDayList | undefined;
      const newList = new Y.Array<YTodo>();
      if (oldList instanceof Y.Array) {
        for (let i = 0; i < oldList.length; i++) {
          const old = oldList.get(i);
          const t: YTodo = new Y.Map();
          t.set('id',   old.get('id')   as string);
          t.set('text', old.get('text') as string);
          t.set('done', old.get('done') as boolean);
          newList.push([t]);
        }
      }
      weekData.set(day, newList);
      plan.delete(day);
    }
    weeksMap.set(weekStart, weekData);
    plan.set('weeks', weeksMap);
  });
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
    plan.set('weeks', new Y.Map<unknown>());
    plans.set(cellId, plan);
  } else {
    migrateIfNeeded(ydoc, plan);
  }
  return plan;
}

/** Get or create the data bucket for a specific week. */
function getWeekData(plan: Y.Map<unknown>, weekStart: string): Y.Map<unknown> {
  const weeksMap = plan.get('weeks') as Y.Map<unknown>;
  let weekData = weeksMap.get(weekStart) as Y.Map<unknown> | undefined;
  if (!weekData) {
    weekData = new Y.Map<unknown>();
    for (const day of DAY_KEYS) {
      weekData.set(day, new Y.Array<YTodo>());
    }
    weeksMap.set(weekStart, weekData);
  }
  return weekData;
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

export function getDayList(plan: Y.Map<unknown>, weekStart: string, day: DayKey): YDayList {
  return getWeekData(plan, weekStart).get(day) as YDayList;
}

export function readAllDays(plan: Y.Map<unknown>, weekStart: string): AllDays {
  const weekData = getWeekData(plan, weekStart);
  const result = {} as AllDays;
  for (const day of DAY_KEYS) {
    const list = weekData.get(day) as YDayList | undefined;
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

export function addTodo(plan: Y.Map<unknown>, weekStart: string, day: DayKey, text: string): void {
  const list = getDayList(plan, weekStart, day);
  if (!list) return;
  const todo: YTodo = new Y.Map();
  todo.set('id',   crypto.randomUUID());
  todo.set('text', text.trim());
  todo.set('done', false);
  list.push([todo]);
}

export function toggleTodo(plan: Y.Map<unknown>, weekStart: string, day: DayKey, todoId: string): void {
  const list = getDayList(plan, weekStart, day);
  if (!list) return;
  for (let i = 0; i < list.length; i++) {
    const todo = list.get(i);
    if (todo.get('id') === todoId) {
      todo.set('done', !todo.get('done'));
      return;
    }
  }
}

export function deleteTodo(plan: Y.Map<unknown>, weekStart: string, day: DayKey, todoId: string): void {
  const list = getDayList(plan, weekStart, day);
  if (!list) return;
  for (let i = 0; i < list.length; i++) {
    if (list.get(i).get('id') === todoId) {
      list.delete(i, 1);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Text formatting helpers
// ---------------------------------------------------------------------------

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
  weekStart: string,
  day: DayKey,
  todoId: string,
  visStart: number,
  visEnd: number,
  open: string,
  close: string,
): void {
  const list = getDayList(plan, weekStart, day);
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
  weekStart: string,
  day: DayKey,
  todoId: string,
  visStart: number,
  visEnd: number,
  kind: StyleKind,
): void {
  const list = getDayList(plan, weekStart, day);
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

    // Collect all opener and closer positions for this kind.
    const openPat = new RegExp(`\\{${ch}=[^}]+\\}`, 'g');
    const closePat = new RegExp(`\\{\\/${ch}\\}`, 'g');
    const openers: Array<[number, number]> = [];
    const closers: Array<[number, number]> = [];
    let m: RegExpExecArray | null;

    openPat.lastIndex = 0;
    while ((m = openPat.exec(text)) !== null) openers.push([m.index, m.index + m[0].length]);
    closePat.lastIndex = 0;
    while ((m = closePat.exec(text)) !== null) closers.push([m.index, m.index + m[0].length]);

    // Pair each opener with the first closer that follows it (greedy, left-to-right).
    const usedClosers = new Set<number>();
    const pairs: Array<[number, number, number, number]> = []; // [openStart, openEnd, closeStart, closeEnd]
    for (const [os, oe] of openers) {
      for (let j = 0; j < closers.length; j++) {
        if (usedClosers.has(j)) continue;
        const [cs, ce] = closers[j];
        if (cs >= oe) { usedClosers.add(j); pairs.push([os, oe, cs, ce]); break; }
      }
    }

    // A span overlaps the selection if its opener starts before rawEnd AND
    // its closer ends after rawStart — this catches all three cases:
    //   (a) span fully inside selection, (b) span fully enclosing selection,
    //   (c) span partially overlapping from either side.
    const toRemove: Array<[number, number]> = [];
    for (const [os, oe, cs, ce] of pairs) {
      if (os < rawEnd && ce > rawStart) toRemove.push([os, oe], [cs, ce]);
    }

    if (toRemove.length === 0) return;

    // Remove right-to-left so earlier positions stay valid.
    toRemove.sort((a, b) => b[0] - a[0]);
    let result = text;
    for (const [s, e] of toRemove) result = result.slice(0, s) + result.slice(e);
    todo.set('text', result);
    return;
  }
}

// ---------------------------------------------------------------------------
// AI serialization — recent non-empty weeks, newest first
// ---------------------------------------------------------------------------

/** Strip style markers ({c=…}/{/c} etc.) from todo text before injecting into AI context. */
function stripStyleMarkers(text: string): string {
  return text.replace(/\{[^}]*\}/g, '');
}

const MOOD_EMOJIS: Record<number, string> = { 1: '😴', 2: '😞', 3: '😐', 4: '🙂', 5: '🔥' };

/**
 * Serialize up to `maxWeeks` most-recent non-empty weeks from this plan.
 * Each day line includes the mood score when logged, e.g.:
 *   Mon [mood: 🙂 4]:
 *     [x] Feature build
 *     [ ] Code review
 *   Tue [no mood]:
 *     [ ] Blog draft
 *
 * Returns an empty string if the plan has no todos.
 */
export function serializeWeeklyForAI(plan: Y.Map<unknown>, maxWeeks = 4): string {
  const weeksMap = plan.get('weeks') as Y.Map<unknown> | undefined;
  if (!weeksMap || weeksMap.size === 0) return '';

  const entries: Array<{ weekStart: string; lines: string }> = [];

  weeksMap.forEach((weekData, weekStart) => {
    const wm = weekData as Y.Map<unknown>;
    const dayParts: string[] = [];
    for (const day of DAY_KEYS) {
      const list = wm.get(day) as YDayList | undefined;
      if (!list || list.length === 0) continue;

      const date = dayToDate(weekStart, day as DayKey);
      const mood = getMoodForDate(plan, date);
      const moodLabel = mood
        ? `[mood: ${MOOD_EMOJIS[mood.energy]} ${mood.energy}]`
        : '[no mood]';

      const todos = list.toArray().map(t => {
        const done = t.get('done') as boolean;
        const text = stripStyleMarkers(t.get('text') as string);
        return `    ${done ? '[x]' : '[ ]'} ${text}`;
      });
      dayParts.push(`  ${DAY_LABELS[day as DayKey]} ${moodLabel}:\n${todos.join('\n')}`);
    }
    if (dayParts.length > 0) {
      entries.push({ weekStart, lines: `${weekRangeLabel(weekStart)}:\n${dayParts.join('\n')}` });
    }
  });

  if (entries.length === 0) return '';
  entries.sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  return entries.slice(0, maxWeeks).map(e => e.lines).join('\n\n');
}

// ---------------------------------------------------------------------------
// Mood log — keyed by ISO date string ('YYYY-MM-DD')
// Stored as plan.get('moodLog') → Y.Map<date, Y.Map{energy, note?}>
// ---------------------------------------------------------------------------

export interface MoodEntry {
  energy: 1 | 2 | 3 | 4 | 5;
  note?: string;
}

const MOOD_LOG_KEY = 'moodLog';

/** Convert weekStart + DayKey → ISO date string for that column. */
export function dayToDate(weekStart: string, day: DayKey): string {
  const [y, mo, d] = weekStart.split('-').map(Number);
  const offset = DAY_KEYS.indexOf(day);
  const date = new Date(y, mo - 1, d + offset);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function getMoodForDate(plan: Y.Map<unknown>, date: string): MoodEntry | null {
  const moodLog = plan.get(MOOD_LOG_KEY) as Y.Map<unknown> | undefined;
  if (!moodLog) return null;
  const entry = moodLog.get(date) as Y.Map<unknown> | undefined;
  if (!entry) return null;
  return {
    energy: entry.get('energy') as MoodEntry['energy'],
    note:   (entry.get('note') as string | undefined) || undefined,
  };
}

export function setMoodForDate(
  plan: Y.Map<unknown>,
  date: string,
  energy: MoodEntry['energy'],
  note?: string,
): void {
  let moodLog = plan.get(MOOD_LOG_KEY) as Y.Map<unknown> | undefined;
  if (!moodLog) {
    moodLog = new Y.Map<unknown>();
    plan.set(MOOD_LOG_KEY, moodLog);
  }
  let entry = moodLog.get(date) as Y.Map<unknown> | undefined;
  if (!entry) {
    entry = new Y.Map<unknown>();
    moodLog.set(date, entry);
  }
  entry.set('energy', energy);
  if (note) { entry.set('note', note); } else { entry.delete('note'); }
}

/** Read all mood entries for a plan (for analytics). */
export function readMoodLog(plan: Y.Map<unknown>): Record<string, MoodEntry> {
  const result: Record<string, MoodEntry> = {};
  const moodLog = plan.get(MOOD_LOG_KEY) as Y.Map<unknown> | undefined;
  if (!moodLog) return result;
  moodLog.forEach((raw, date) => {
    const e = raw as Y.Map<unknown>;
    result[date] = {
      energy: e.get('energy') as MoodEntry['energy'],
      note:   (e.get('note') as string | undefined) || undefined,
    };
  });
  return result;
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
