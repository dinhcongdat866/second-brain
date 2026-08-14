import * as Y from 'yjs';
import { STYLE_OPEN_RE, STYLE_CLOSE_RE, type StyleKind } from '../lib/toolbarStyles';
import { MONEY_CAT } from '../lib/moneyTaxonomy';

export const WEEKLY_PLANS_KEY = 'weeklyPlans';

/**
 * Every weekly_planner_cell, in every document, renders this one shared plan
 * inside the planner Y.Doc — the cell is a view, not a data owner.
 */
export const SHARED_PLAN_ID = 'global';

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

export function getMondayOf(date: Date): string {
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

/**
 * Replace a todo's text.
 *
 * The stored string is raw source — it may carry `**bold**` and `{c=…}` style
 * markers — so an editor built on this shows and saves that source, which is
 * also what formatTodoText operates on. An empty result is ignored rather than
 * treated as a delete: losing a line to a stray Ctrl+A is not worth the
 * shortcut, and there is already an explicit × button.
 */
export function updateTodoText(
  plan: Y.Map<unknown>,
  weekStart: string,
  day: DayKey,
  todoId: string,
  text: string,
): void {
  const next = text.trim();
  if (!next) return;
  const list = getDayList(plan, weekStart, day);
  if (!list) return;
  for (let i = 0; i < list.length; i++) {
    const todo = list.get(i);
    if (todo.get('id') === todoId) {
      if (todo.get('text') !== next) todo.set('text', next);
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

/** One face per energy score. Shared so the planner, the AI serializer and the
 *  money cell cannot drift into showing three different faces for a 3. */
export const MOOD_EMOJIS: Record<number, string> = { 1: '😴', 2: '😞', 3: '😐', 4: '🙂', 5: '🔥' };

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
// Money log — a FLAT top-level map, keyed by entry id
//   ydoc.getMap('moneyLog') → Y.Map<entryId, Y.Map{…MoneyEntryData}>
// Each entry carries its own `date`; a day or a range is a filter, not a lookup.
//
// Two structural decisions, both about the same hazard.
//
// Top-level, not nested under the plan next to moodLog: a nested container has
// to be *created* by whoever writes first, and two offline devices each doing
// `plan.set('moneyLog', new Y.Map())` is a same-key conflict that discards one
// side's map wholesale — every line in it, not just the colliding one.
// Top-level types are resolved by name and never conflict, the same guarantee
// WEEKLY_PLANS_KEY already relies on.
//
// Flat, not Y.Map<date, Y.Array<entry>>: a per-date array is the same trap one
// level down. Keyed by entry id there is nothing to race — two devices never
// generate the same uuid, so concurrent writes are always distinct keys.
//
// Keyed by day rather than by week/day slot (via the `date` field) because
// money is a stream that happens to you, not something you place into Tuesday
// in advance — the same reason moodLog is keyed by date. It also means a date
// range is one filter instead of enumerating week keys the way WEEKS_TO_SCAN
// has to.
// ---------------------------------------------------------------------------

export interface MoneyEntryData {
  id: string;
  /** 'YYYY-MM-DD' — which day this line belongs to. */
  date: string;
  /** Exactly what the user typed — the source of truth; everything else is derived. */
  text: string;
  /**
   * Signed integer đồng: negative is money out, positive is money in.
   * null means the parser found no amount — never 0, which would read as a
   * real entry worth nothing.
   */
  amount: number | null;
  category: string;
  counterparty: string | null;
  /** Signed change in what this person is owed. 0 for ordinary entries. */
  debtDelta: number;
  status: 'ok' | 'needs_amount';
  /** Snapshot of `text` when parsed; drives the dirty-check in useMoneySync. */
  parsedFrom: string | null;
  /**
   * Which wallet this line moved money through, or null for lines written
   * before wallets existed (and for anyone who never made a second wallet).
   * null belongs to the default wallet — see walletBalance — so adding wallets
   * never had to rewrite a single existing entry.
   */
  walletId: string | null;
  /** Insertion order within a day — a flat map has no inherent order. */
  createdAt: number;
}

export const MONEY_LOG_KEY = 'moneyLog';

type YMoneyEntry = Y.Map<unknown>;

function moneyMap(ydoc: Y.Doc): Y.Map<YMoneyEntry> {
  return ydoc.getMap<YMoneyEntry>(MONEY_LOG_KEY);
}

function readMoneyEntry(entry: YMoneyEntry): MoneyEntryData {
  const amount = entry.get('amount');
  return {
    id:           entry.get('id') as string,
    date:         entry.get('date') as string,
    text:         entry.get('text') as string,
    amount:       typeof amount === 'number' ? amount : null,
    category:     (entry.get('category') as string | undefined) ?? '',
    counterparty: (entry.get('counterparty') as string | undefined) ?? null,
    debtDelta:    (entry.get('debtDelta') as number | undefined) ?? 0,
    status:       (entry.get('status') as MoneyEntryData['status'] | undefined) ?? 'needs_amount',
    parsedFrom:   (entry.get('parsedFrom') as string | undefined) ?? null,
    walletId:     (entry.get('walletId') as string | undefined) ?? null,
    createdAt:    (entry.get('createdAt') as number | undefined) ?? 0,
  };
}

const byCreatedAt = (a: MoneyEntryData, b: MoneyEntryData) => a.createdAt - b.createdAt;

/**
 * Append a raw line for a date. The entry starts unparsed — the UI shows the
 * text immediately and useMoneySync fills in the numbers afterwards, so typing
 * never waits on the network.
 * Returns the new entry's id (also the Postgres primary key).
 */
export function addMoneyEntry(
  ydoc: Y.Doc,
  date: string,
  text: string,
  walletId: string | null = null,
): string {
  const id = crypto.randomUUID();
  const entry: YMoneyEntry = new Y.Map();
  entry.set('id', id);
  entry.set('date', date);
  entry.set('text', text.trim());
  entry.set('amount', null);
  entry.set('category', '');
  entry.set('counterparty', null);
  entry.set('debtDelta', 0);
  entry.set('status', 'needs_amount');
  entry.set('parsedFrom', null);
  entry.set('walletId', walletId);
  entry.set('createdAt', Date.now());
  // A uuid key, so two devices adding at once write different keys and both
  // survive. This is the whole reason the map is flat.
  moneyMap(ydoc).set(id, entry);
  return id;
}

export function readMoneyForDate(ydoc: Y.Doc, date: string): MoneyEntryData[] {
  const out: MoneyEntryData[] = [];
  moneyMap(ydoc).forEach((entry) => {
    if (entry.get('date') === date) out.push(readMoneyEntry(entry));
  });
  return out.sort(byCreatedAt);
}

/** Every money entry, grouped by date (for the day grid, sync and analytics). */
export function readMoneyLog(ydoc: Y.Doc): Record<string, MoneyEntryData[]> {
  const result: Record<string, MoneyEntryData[]> = {};
  moneyMap(ydoc).forEach((raw) => {
    const entry = readMoneyEntry(raw);
    (result[entry.date] ??= []).push(entry);
  });
  for (const list of Object.values(result)) list.sort(byCreatedAt);
  return result;
}

/**
 * Write parse results back onto an entry, so the line renders correctly offline
 * on the next load without calling the model again.
 * Only the keys present in `patch` are touched — `amount: null` is a meaningful
 * value (flagged), not an absent one.
 */
export function updateMoneyEntry(
  ydoc: Y.Doc,
  id: string,
  patch: Partial<Omit<MoneyEntryData, 'id'>>,
): void {
  const entry = moneyMap(ydoc).get(id);
  if (!entry) return;
  for (const [key, value] of Object.entries(patch)) {
    entry.set(key, value);
  }
}

export function deleteMoneyEntry(ydoc: Y.Doc, id: string): void {
  moneyMap(ydoc).delete(id);
}

/**
 * Net movement for a set of entries. Always recomputed from the list — a stored
 * total is the one thing that cannot be repaired once two devices have both
 * added to it. Flagged entries contribute nothing rather than guessing a zero.
 */
export function moneyTotal(entries: MoneyEntryData[]): number {
  return entries.reduce((sum, e) => sum + (e.amount ?? 0), 0);
}

/** Every money entry as one flat list — the input every function in moneyStats takes. */
export function readMoneyAll(ydoc: Y.Doc): MoneyEntryData[] {
  const out: MoneyEntryData[] = [];
  moneyMap(ydoc).forEach((raw) => out.push(readMoneyEntry(raw)));
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);
}

/** '-85000' → '−85.000'. Uses the real minus sign so it lines up with '+'. */
export function formatDong(amount: number): string {
  const sign = amount < 0 ? '−' : '+';
  return `${sign}${Math.abs(amount).toLocaleString('vi-VN')}`;
}

// ---------------------------------------------------------------------------
// Wallets — a FLAT top-level map, keyed by wallet id
//   ydoc.getMap('moneyWallets') → Y.Map<walletId, Y.Map{…WalletData}>
//
// Same shape as moneyLog, for the same reason: a nested container would have to
// be created by whoever writes first, and two offline devices creating it is a
// same-key conflict that throws one side's whole map away.
//
// A wallet has NO stored balance. The balance is the sum of the entries that
// moved through it, recomputed every time — the one hard rule this feature has
// followed since the debt ledger, because a counter two devices both increment
// is wrong forever with no way to tell afterwards.
//
// Correcting a wallet therefore writes an *entry*, not a number: the difference
// between what the app thinks you have and what you actually have becomes a
// dated line like any other. You get the correction you asked for, the balance
// stays a pure sum, and the history says when it drifted and by how much.
// ---------------------------------------------------------------------------

export interface WalletData {
  id: string;
  name: string;
  /** One emoji, shown before the name. Purely decorative. */
  icon: string;
  /** Creation time doubles as sort order and picks the default wallet. */
  createdAt: number;
}

export const WALLETS_KEY = 'moneyWallets';

function walletMap(ydoc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return ydoc.getMap<Y.Map<unknown>>(WALLETS_KEY);
}

/** Wallets in creation order. The first one is the default — see walletBalance. */
export function readWallets(ydoc: Y.Doc): WalletData[] {
  const out: WalletData[] = [];
  walletMap(ydoc).forEach((w) => {
    out.push({
      id:        w.get('id') as string,
      name:      w.get('name') as string,
      icon:      (w.get('icon') as string | undefined) ?? '👛',
      createdAt: (w.get('createdAt') as number | undefined) ?? 0,
    });
  });
  return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/**
 * Write a correction line: an ordinary money entry that is born already parsed,
 * so useMoneySync never sends it to the model. It has an amount and a category
 * from the moment it exists; there is nothing for a parser to work out.
 */
function addAdjustmentEntry(
  ydoc: Y.Doc,
  walletId: string,
  amount: number,
  text: string,
  date: string,
): string {
  const id = crypto.randomUUID();
  const entry: YMoneyEntry = new Y.Map();
  entry.set('id', id);
  entry.set('date', date);
  entry.set('text', text);
  entry.set('amount', amount);
  entry.set('category', MONEY_CAT.ADJUSTMENT);
  entry.set('counterparty', null);
  entry.set('debtDelta', 0);
  entry.set('status', 'ok');
  // parsedFrom === text is what makes the dirty-check skip this line forever.
  entry.set('parsedFrom', text);
  entry.set('walletId', walletId);
  entry.set('createdAt', Date.now());
  moneyMap(ydoc).set(id, entry);
  return id;
}

function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
}

/**
 * Create a wallet. A non-zero opening balance is written as a correction entry
 * rather than stored on the wallet, so there is exactly one way a balance can
 * come about and exactly one thing to fix when it is wrong.
 */
export function createWallet(
  ydoc: Y.Doc,
  name: string,
  icon = '👛',
  openingBalance = 0,
  openingLabel = 'Opening balance',
): string {
  const id = crypto.randomUUID();
  ydoc.transact(() => {
    const w = new Y.Map<unknown>();
    w.set('id', id);
    w.set('name', name.trim() || 'Wallet');
    w.set('icon', icon);
    w.set('createdAt', Date.now());
    walletMap(ydoc).set(id, w);
    if (openingBalance !== 0) {
      addAdjustmentEntry(ydoc, id, openingBalance, openingLabel, todayIso());
    }
  });
  return id;
}

export function renameWallet(ydoc: Y.Doc, walletId: string, name: string, icon?: string): void {
  const w = walletMap(ydoc).get(walletId);
  if (!w) return;
  const next = name.trim();
  if (next) w.set('name', next);
  if (icon) w.set('icon', icon);
}

/**
 * Remove a wallet and hand its entries back to the default wallet.
 *
 * The lines are kept. They are real spending that really happened; only the
 * label for where the money sat has gone away. Detaching them (walletId → null)
 * rather than deleting them means the month totals do not silently drop.
 */
export function deleteWallet(ydoc: Y.Doc, walletId: string): void {
  ydoc.transact(() => {
    walletMap(ydoc).delete(walletId);
    moneyMap(ydoc).forEach((entry) => {
      if (entry.get('walletId') === walletId) entry.set('walletId', null);
    });
  });
}

export function moveEntryToWallet(ydoc: Y.Doc, entryId: string, walletId: string | null): void {
  moneyMap(ydoc).get(entryId)?.set('walletId', walletId);
}

/**
 * What this wallet holds: every amount that moved through it, added up.
 *
 * `isDefault` folds in the entries that name no wallet — everything logged
 * before wallets existed, and everything logged by someone who never made a
 * second one. Without it those lines would vanish from the wallet view the day
 * the feature shipped, which is a worse first impression than any migration.
 */
export function walletBalance(
  entries: MoneyEntryData[],
  walletId: string,
  isDefault: boolean,
): number {
  let sum = 0;
  for (const e of entries) {
    if (e.walletId === walletId || (isDefault && e.walletId === null)) sum += e.amount ?? 0;
  }
  return sum;
}

/**
 * Reconcile a wallet against reality: you say what is actually in it, and the
 * difference is written as a dated correction line.
 *
 * Returns the entry id, or null when nothing had drifted. `label` and `date`
 * come from the caller so the wording stays in the UI's language.
 */
// ---------------------------------------------------------------------------
// Money settings — one small top-level map of scalars
//
// Safe as a plain key/value map precisely because the values are scalars: two
// devices setting `monthlyBudget` is last-write-wins on a number, which loses a
// preference at worst. That is a different situation from the containers above,
// where the same conflict discards a whole map of entries.
// ---------------------------------------------------------------------------

export const MONEY_SETTINGS_KEY = 'moneySettings';

/** Monthly spending cap in đồng. 0 means "not set" — the UI then shows pace only. */
export function readMonthlyBudget(ydoc: Y.Doc): number {
  const v = ydoc.getMap<unknown>(MONEY_SETTINGS_KEY).get('monthlyBudget');
  return typeof v === 'number' && v > 0 ? v : 0;
}

export function setMonthlyBudget(ydoc: Y.Doc, amount: number): void {
  ydoc.getMap<unknown>(MONEY_SETTINGS_KEY).set('monthlyBudget', Math.max(0, Math.round(amount)));
}

export function correctWalletBalance(
  ydoc: Y.Doc,
  walletId: string,
  actualBalance: number,
  currentBalance: number,
  label: string,
  date = todayIso(),
): string | null {
  const delta = Math.round(actualBalance - currentBalance);
  if (delta === 0) return null;
  return addAdjustmentEntry(ydoc, walletId, delta, label, date);
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
