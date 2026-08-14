/**
 * Everything the money cell shows, derived from the money log.
 *
 * All of it is computed on the client, from the Y.Doc, with no request. That is
 * not a shortcut — it falls out of the shape the log already has. Every entry
 * carries its own date, amount and category, and the whole log lives in one
 * top-level map, so a month, a category or a search is a filter over an array
 * that is already in memory. The backend's job stays what it was: run the
 * parser, which needs a model, and keep the SQL projection other devices read.
 *
 * The practical effect is that the numbers are there offline and there is no
 * spinner between changing the month and seeing it.
 *
 * Two rules hold throughout, and both exist because a wrong number you believe
 * is worse than no number:
 *
 *   - Balance corrections are excluded from every figure. A correction is
 *     bookkeeping; counting it as spending would mean fixing your wallet looks
 *     like a shopping trip.
 *   - Averages are medians. One 20 triệu laptop drags a mean for months, and
 *     the question these figures answer is "what is normal for me", which is
 *     exactly what a mean stops being able to say.
 */
import type { MoneyEntryData, MoodEntry } from '../collab/weeklyPlans';
import { MONEY_CAT } from './moneyTaxonomy';

// ---------------------------------------------------------------------------
// Category roles
// ---------------------------------------------------------------------------

/**
 * Obligations rather than daily choices: they land on a date someone else
 * picked, at an amount you already know.
 *
 * The split is the whole reason a projection can be trusted. Spending 6 triệu
 * in 14 days does not mean 12,9 triệu by month end, because rent was in those
 * 14 days and rent does not happen twice — multiplying the lot by two forecasts
 * a second rent. Fixed is counted once; only the variable part is extrapolated.
 */
export const FIXED_CATEGORIES: ReadonlySet<string> = new Set<string>([
  MONEY_CAT.HOUSING,
  MONEY_CAT.BILLS,
  MONEY_CAT.EDUCATION,
]);

/** Excluded from every statistic — see the file header. */
const EXCLUDED = new Set<string>([MONEY_CAT.ADJUSTMENT]);

/** A line with a known amount that says something about your money. */
function countable(e: MoneyEntryData): boolean {
  return e.amount !== null && e.amount !== 0 && !EXCLUDED.has(e.category);
}

const isSpend  = (e: MoneyEntryData) => countable(e) && e.amount! < 0;
const isIncome = (e: MoneyEntryData) => countable(e) && e.amount! > 0;

/** Spending as a positive number of đồng. */
const spent = (e: MoneyEntryData) => -e.amount!;

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** '2026-08-14' → '2026-08'. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/** '2026-08' + 1 → '2026-09'. Handles the year boundary. */
export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
}

/**
 * How many days of `month` have happened as of `today`.
 * 0 for a month that has not started — the caller uses that to refuse to
 * project, rather than dividing by zero and reporting Infinity.
 */
export function daysElapsedIn(month: string, today: string): number {
  const cur = monthOf(today);
  if (month < cur) return daysInMonth(month);
  if (month > cur) return 0;
  return Number(today.slice(8, 10));
}

/** A month whose last day is behind us — the only kind safe to average over. */
function isComplete(month: string, today: string): boolean {
  return month < monthOf(today);
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** Middle value; average of the middle two for an even count. 0 for empty. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Vietnamese short form, the way the amounts were typed in the first place:
 * 300k, 6tr, 3tr8, 1,2 tỷ. Long-hand '3.800.000' is precise and unreadable in a
 * list of twelve, which is what these figures are read in.
 */
export function formatDongCompact(amount: number): string {
  const sign = amount < 0 ? '−' : '';
  const abs = Math.abs(amount);
  if (abs >= 1_000_000_000) {
    const n = abs / 1_000_000_000;
    return `${sign}${n.toFixed(1).replace('.', ',').replace(',0', '')} tỷ`;
  }
  if (abs >= 1_000_000) {
    const whole = Math.floor(abs / 1_000_000);
    const tenth = Math.round((abs % 1_000_000) / 100_000);
    // 3.950.000 rounds its tenth to 10 — carry it rather than printing "3tr10".
    if (tenth >= 10) return `${sign}${whole + 1}tr`;
    return tenth === 0 ? `${sign}${whole}tr` : `${sign}${whole}tr${tenth}`;
  }
  if (abs >= 1_000) {
    const k = Math.round(abs / 1_000);
    return k >= 1_000 ? `${sign}1tr` : `${sign}${k}k`;
  }
  return `${sign}${abs}`;
}

/**
 * The inverse of formatDongCompact: read '5tr', '4tr5', '300k', '3.800.000'.
 *
 * Hand-written, and no model involved. Vietnamese money shorthand is a small
 * closed grammar — four multipliers and one compound form — so a parser for it
 * fits in twenty lines and answers instantly. The model earns its keep on free
 * prose like "cà phê với anh Tuấn 85k", where the amount is one part of a
 * sentence; it has no business being asked what "5tr" means.
 *
 * Returns null for anything it cannot read, so a caller can refuse rather than
 * guess — the same rule the parser follows for amounts.
 */
export function parseDongShorthand(input: string): number | null {
  const raw = normalizeVi(input).trim().replace(/\s+/g, '');
  if (!raw) return null;
  const negative = raw.startsWith('-');
  const body = negative ? raw.slice(1) : raw;

  const m = /^(\d+(?:[.,]\d+)*)(ty|trieu|tr|cu|nghin|ng|k|lit|xi)?(\d+)?$/.exec(body);
  if (!m) return null;
  const [, headRaw, unit, tailRaw] = m;

  const MULTIPLIER: Record<string, number> = {
    ty: 1_000_000_000,
    trieu: 1_000_000, tr: 1_000_000, cu: 1_000_000,
    nghin: 1_000, ng: 1_000, k: 1_000,
    lit: 100_000, xi: 100_000,
  };

  if (!unit) {
    // No unit: '.' and ',' are thousands separators here, not decimal points —
    // '3.800.000' is how the number is written, and nobody logs 3.8 đồng.
    if (tailRaw) return null;
    const digits = headRaw.replace(/[.,]/g, '');
    const n = Number(digits);
    return Number.isFinite(n) ? (negative ? -n : n) : null;
  }

  const mult = MULTIPLIER[unit];
  const head = Number(headRaw.replace(',', '.').replace(/\.(?=\d{3}\b)/g, ''));
  if (!Number.isFinite(head)) return null;

  // '4tr5' — the trailing group is a fraction of the unit, not a second number.
  const tail = tailRaw ? Number(tailRaw) / 10 ** tailRaw.length : 0;
  const value = Math.round((head + tail) * mult);
  return negative ? -value : value;
}

// ---------------------------------------------------------------------------
// Month totals
// ---------------------------------------------------------------------------

export interface MonthTotals {
  month: string;
  /** Positive đồng spent. */
  out: number;
  /** Positive đồng received. */
  in: number;
  /** in − out. Negative means the month cost more than it brought. */
  net: number;
  entries: number;
  /** Lines still waiting on the parser, or parsed with no amount found. */
  unknown: number;
}

export function entriesInMonth(all: MoneyEntryData[], month: string): MoneyEntryData[] {
  return all.filter((e) => monthOf(e.date) === month);
}

export function monthTotals(all: MoneyEntryData[], month: string): MonthTotals {
  const rows = entriesInMonth(all, month);
  let out = 0;
  let inc = 0;
  let unknown = 0;
  for (const e of rows) {
    if (EXCLUDED.has(e.category)) continue;
    if (e.amount === null) { unknown++; continue; }
    if (e.amount < 0) out += -e.amount;
    else inc += e.amount;
  }
  return { month, out, in: inc, net: inc - out, entries: rows.length, unknown };
}

/** Every month that has at least one entry, oldest first. */
export function monthsWithData(all: MoneyEntryData[]): string[] {
  return [...new Set(all.map((e) => monthOf(e.date)))].sort();
}

// ---------------------------------------------------------------------------
// Category breakdown — the plain lines, plus what normal looks like
// ---------------------------------------------------------------------------

export interface CategoryTotal {
  category: string;
  /** Positive đồng spent in the month. */
  total: number;
  count: number;
  /** Share of the month's spending, 0–1. */
  share: number;
  /** Median for this category across complete past months, or null. */
  normal: number | null;
  /** How many past months that median rests on — 1 is not a habit. */
  normalMonths: number;
}

export interface Norm { median: number; months: number }

/**
 * What each category usually costs, per month, over complete months only.
 *
 * Months where a category does not appear are left out rather than counted as
 * zero. Tuition happens twice a year; folding in ten zeroes would report the
 * normal as 0 and then flag every real payment as extraordinary, which tells
 * you nothing you did not already know. The number this gives instead is "when
 * this does happen, it is usually about this much".
 */
export function categoryNorms(all: MoneyEntryData[], today: string): Map<string, Norm> {
  const perMonth = new Map<string, Map<string, number>>();
  for (const e of all) {
    if (!isSpend(e)) continue;
    const m = monthOf(e.date);
    if (!isComplete(m, today)) continue;
    let bucket = perMonth.get(e.category);
    if (!bucket) { bucket = new Map(); perMonth.set(e.category, bucket); }
    bucket.set(m, (bucket.get(m) ?? 0) + spent(e));
  }
  const out = new Map<string, Norm>();
  for (const [category, bucket] of perMonth) {
    const values = [...bucket.values()];
    out.set(category, { median: median(values), months: values.length });
  }
  return out;
}

/** Spending by category for one month, biggest first. */
export function categoryBreakdown(
  all: MoneyEntryData[],
  month: string,
  norms: Map<string, Norm>,
): CategoryTotal[] {
  const totals = new Map<string, { total: number; count: number }>();
  for (const e of entriesInMonth(all, month)) {
    if (!isSpend(e)) continue;
    const key = e.category || MONEY_CAT.OTHER;
    const cur = totals.get(key) ?? { total: 0, count: 0 };
    cur.total += spent(e);
    cur.count += 1;
    totals.set(key, cur);
  }
  const grand = [...totals.values()].reduce((s, v) => s + v.total, 0);
  return [...totals.entries()]
    .map(([category, v]) => {
      const norm = norms.get(category);
      return {
        category,
        total: v.total,
        count: v.count,
        share: grand > 0 ? v.total / grand : 0,
        normal: norm ? norm.median : null,
        normalMonths: norm ? norm.months : 0,
      };
    })
    .sort((a, b) => b.total - a.total);
}

// ---------------------------------------------------------------------------
// Pace — the honest version of "how much will this month cost"
// ---------------------------------------------------------------------------

export interface MonthForecast {
  month: string;
  daysInMonth: number;
  daysElapsed: number;
  daysLeft: number;
  /** Spent so far on the fixed categories. */
  fixedSoFar: number;
  /** Spent so far on everything else. */
  variableSoFar: number;
  spentSoFar: number;
  /** Variable spending per day so far — the only rate worth extrapolating. */
  variablePerDay: number;
  /**
   * Fixed spending the whole month is expected to carry: what has already
   * landed, or the usual amount if it has not landed yet, whichever is larger.
   * Rent paid on the 5th must not be doubled; rent not yet paid on the 25th
   * must not be ignored.
   */
  expectedFixed: number;
  /** expectedFixed + variablePerDay × daysInMonth. */
  projected: number;
}

export function forecastMonth(
  all: MoneyEntryData[],
  month: string,
  today: string,
): MonthForecast | null {
  const daysElapsed = daysElapsedIn(month, today);
  if (daysElapsed === 0) return null;

  const total = daysInMonth(month);
  let fixedSoFar = 0;
  let variableSoFar = 0;
  for (const e of entriesInMonth(all, month)) {
    if (!isSpend(e)) continue;
    if (FIXED_CATEGORIES.has(e.category)) fixedSoFar += spent(e);
    else variableSoFar += spent(e);
  }

  const usualFixed = median(monthlyFixedTotals(all, today));
  const expectedFixed = Math.max(fixedSoFar, usualFixed);
  const variablePerDay = variableSoFar / daysElapsed;

  return {
    month,
    daysInMonth: total,
    daysElapsed,
    daysLeft: Math.max(0, total - daysElapsed),
    fixedSoFar,
    variableSoFar,
    spentSoFar: fixedSoFar + variableSoFar,
    variablePerDay,
    expectedFixed,
    projected: Math.round(expectedFixed + variablePerDay * total),
  };
}

/** Fixed-category total for each complete month, for the medians above. */
function monthlyFixedTotals(all: MoneyEntryData[], today: string): number[] {
  return monthlySplit(all, today).map((m) => m.fixed);
}

function monthlySplit(
  all: MoneyEntryData[],
  today: string,
): Array<{ month: string; fixed: number; variable: number }> {
  const byMonth = new Map<string, { fixed: number; variable: number }>();
  for (const e of all) {
    if (!isSpend(e)) continue;
    const m = monthOf(e.date);
    if (!isComplete(m, today)) continue;
    const cur = byMonth.get(m) ?? { fixed: 0, variable: 0 };
    if (FIXED_CATEGORIES.has(e.category)) cur.fixed += spent(e);
    else cur.variable += spent(e);
    byMonth.set(m, cur);
  }
  return [...byMonth.entries()].map(([month, v]) => ({ month, ...v }));
}

export interface NextMonthEstimate {
  month: string;
  fixed: number;
  variable: number;
  total: number;
  /** Complete months behind the estimate. 0 means it leans on this month alone. */
  basedOnMonths: number;
}

/**
 * What next month is likely to cost.
 *
 * Prefers the median of complete months, and falls back to this month's pace
 * when there are none — which is the honest answer in the first weeks of use,
 * as long as the caller says so. `basedOnMonths` is there for exactly that.
 */
export function estimateNextMonth(
  all: MoneyEntryData[],
  month: string,
  today: string,
): NextMonthEstimate | null {
  const split = monthlySplit(all, today);
  const next = addMonths(month, 1);

  if (split.length > 0) {
    const fixed = median(split.map((m) => m.fixed));
    const variable = median(split.map((m) => m.variable));
    return { month: next, fixed, variable, total: fixed + variable, basedOnMonths: split.length };
  }

  const f = forecastMonth(all, month, today);
  if (!f) return null;
  const variable = Math.round(f.variablePerDay * daysInMonth(next));
  return {
    month: next,
    fixed: f.expectedFixed,
    variable,
    total: f.expectedFixed + variable,
    basedOnMonths: 0,
  };
}

export interface Allowance {
  /** Đồng left to spend freely, after setting aside fixed costs still to come. */
  remaining: number;
  daysLeft: number;
  /** remaining ÷ daysLeft. Negative when the budget is already gone. */
  perDay: number;
  over: boolean;
}

/**
 * The number you can act on standing at a counter.
 *
 * Fixed costs that have not landed yet are subtracted up front — rent due on
 * the 28th is not money you may spend on the 20th, and an allowance that
 * pretends otherwise is worse than none.
 */
export function allowance(forecast: MonthForecast, budget: number): Allowance | null {
  if (budget <= 0) return null;
  const fixedStillDue = Math.max(0, forecast.expectedFixed - forecast.fixedSoFar);
  const remaining = budget - forecast.spentSoFar - fixedStillDue;
  const daysLeft = Math.max(1, forecast.daysLeft);
  return {
    remaining,
    daysLeft: forecast.daysLeft,
    perDay: Math.round(remaining / daysLeft),
    over: remaining < 0,
  };
}

// ---------------------------------------------------------------------------
// Recurring charges
// ---------------------------------------------------------------------------

/**
 * Strip everything that varies between two instances of the same charge —
 * diacritics, digits, money units — so "netflix 260k" in June and July collapse
 * to the same key.
 */
function recurringKey(text: string): string {
  return normalizeVi(text)
    .replace(/\d+([.,]\d+)?\s*(k|ng|nghin|tr|trieu|cu|ty|lit|xi)?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface RecurringHit {
  label: string;
  /** Positive đồng, the typical amount. */
  amount: number;
  count: number;
  lastDate: string;
  avgGapDays: number;
  category: string;
  /** Days since the last one — how overdue the next is. */
  daysSinceLast: number;
}

function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

/**
 * Charges that keep coming back at roughly the same amount, roughly a month
 * apart. Forgotten subscriptions are real money, and they are invisible in a
 * category breakdown because they hide inside a bigger bucket.
 *
 * Deliberately strict — three sightings, amounts within a fifth of each other,
 * gaps between 20 and 40 days. A loose rule that also flags "cà phê" every
 * month is a list nobody reads twice.
 */
export function detectRecurring(all: MoneyEntryData[], today: string): RecurringHit[] {
  const groups = new Map<string, MoneyEntryData[]>();
  for (const e of all) {
    if (!isSpend(e)) continue;
    const key = recurringKey(e.text);
    if (key.length < 2) continue;
    const bucket = groups.get(key);
    if (bucket) bucket.push(e);
    else groups.set(key, [e]);
  }

  const out: RecurringHit[] = [];
  for (const rows of groups.values()) {
    if (rows.length < 3) continue;
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));

    const amounts = sorted.map(spent);
    const typical = median(amounts);
    if (typical === 0) continue;
    if (amounts.some((a) => Math.abs(a - typical) > typical * 0.2)) continue;

    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(dayNumber(sorted[i].date) - dayNumber(sorted[i - 1].date));
    }
    const gap = median(gaps);
    if (gap < 20 || gap > 40) continue;

    const last = sorted[sorted.length - 1];
    out.push({
      label: last.text,
      amount: typical,
      count: sorted.length,
      lastDate: last.date,
      avgGapDays: gap,
      category: last.category,
      daysSinceLast: dayNumber(today) - dayNumber(last.date),
    });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

// ---------------------------------------------------------------------------
// Unusual days
// ---------------------------------------------------------------------------

export interface DayAnomaly {
  date: string;
  /** Positive đồng spent that day. */
  total: number;
  /** How many times a normal day this was. */
  ratio: number;
  /** The single biggest line, which is usually the explanation. */
  biggest: string;
}

/** Positive đồng spent per day, across everything. */
export function dailySpend(all: MoneyEntryData[]): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const e of all) {
    if (!isSpend(e)) continue;
    byDay.set(e.date, (byDay.get(e.date) ?? 0) + spent(e));
  }
  return byDay;
}

/**
 * Days that cost several times a normal day.
 *
 * This is the alternative to a budget, and it is better precisely because it
 * needs no setup. A budget asks for a number in advance that nobody sets
 * honestly; "this day cost three times your usual" is derived from what you
 * already did and is true whether or not you ever configure anything.
 */
export function anomalies(
  all: MoneyEntryData[],
  month: string,
  threshold = 2.5,
): DayAnomaly[] {
  const byDay = dailySpend(all);
  const baseline = median([...byDay.values()]);
  if (baseline <= 0) return [];

  const out: DayAnomaly[] = [];
  for (const [date, total] of byDay) {
    if (monthOf(date) !== month) continue;
    const ratio = total / baseline;
    if (ratio < threshold) continue;
    const biggest = all
      .filter((e) => e.date === date && isSpend(e))
      .sort((a, b) => spent(b) - spent(a))[0];
    out.push({ date, total, ratio, biggest: biggest?.text ?? '' });
  }
  return out.sort((a, b) => b.total - a.total);
}

// ---------------------------------------------------------------------------
// Search over the raw text
// ---------------------------------------------------------------------------

/** Lowercase and drop diacritics, so "ca phe" finds "cà phê" and "Đi" finds "di". */
export function normalizeVi(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd');
}

export interface SearchResult {
  matches: MoneyEntryData[];
  /** Positive đồng spent across the matches. */
  spent: number;
  received: number;
}

/**
 * Free-text search over what you actually typed.
 *
 * This is the one question a category can never answer. "Food & Drink" is a
 * bucket somebody else drew; "cà phê" is the thing you wanted to know about,
 * and it is recoverable only because the raw line is kept verbatim rather than
 * being thrown away once the parser has had its look.
 */
export function searchEntries(all: MoneyEntryData[], query: string): SearchResult {
  const q = normalizeVi(query.trim());
  if (!q) return { matches: [], spent: 0, received: 0 };
  const matches = all
    .filter((e) => normalizeVi(e.text).includes(q))
    .sort((a, b) => b.date.localeCompare(a.date));
  let out = 0;
  let inc = 0;
  for (const e of matches) {
    if (isSpend(e)) out += spent(e);
    else if (isIncome(e)) inc += e.amount!;
  }
  return { matches, spent: out, received: inc };
}

// ---------------------------------------------------------------------------
// Debt ledger, with time
// ---------------------------------------------------------------------------

export interface LedgerLine {
  counterparty: string;
  borrowed: number;
  repaid: number;
  /** Positive: you owe them. Negative: they owe you. */
  balance: number;
  firstDate: string;
  lastDate: string;
  /** Days since the first unsettled movement — how old this is. */
  ageDays: number;
}

/**
 * Per-person balance, summed from the entries.
 *
 * The same figures GET /money/ledger returns, plus the thing SQL was not asked
 * for and the panel needed most: how long it has been. "Tuấn owes 1 triệu" and
 * "Tuấn has owed 1 triệu since April" are different sentences, and only the
 * second one makes anybody do something.
 */
export function ledgerFrom(all: MoneyEntryData[], today: string): LedgerLine[] {
  const byPerson = new Map<string, LedgerLine>();
  for (const e of all) {
    if (!e.counterparty || e.debtDelta === 0) continue;
    const cur = byPerson.get(e.counterparty) ?? {
      counterparty: e.counterparty,
      borrowed: 0,
      repaid: 0,
      balance: 0,
      firstDate: e.date,
      lastDate: e.date,
      ageDays: 0,
    };
    if (e.debtDelta > 0) cur.borrowed += e.debtDelta;
    else cur.repaid += -e.debtDelta;
    cur.balance += e.debtDelta;
    if (e.date < cur.firstDate) cur.firstDate = e.date;
    if (e.date > cur.lastDate) cur.lastDate = e.date;
    byPerson.set(e.counterparty, cur);
  }
  return [...byPerson.values()]
    // Settled people disappear rather than sitting there as a row of zeroes.
    .filter((r) => r.balance !== 0)
    .map((r) => ({ ...r, ageDays: dayNumber(today) - dayNumber(r.firstDate) }))
    .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
}

// ---------------------------------------------------------------------------
// Rhythm — what your spending tracks, besides the calendar
// ---------------------------------------------------------------------------

export interface MoodSpend {
  energy: number;
  days: number;
  /** Median đồng spent on days logged at this energy. */
  medianSpend: number;
}

/**
 * Spending against the mood logged the same day.
 *
 * Nothing new is stored for this: moodLog is keyed by date and so is the money
 * log, so it is a join on a string. No dedicated money app can produce it,
 * because no dedicated money app is also the place you record how the day went.
 */
export function spendByMood(
  all: MoneyEntryData[],
  moodLog: Record<string, MoodEntry>,
): MoodSpend[] {
  const byEnergy = new Map<number, number[]>();
  const byDay = dailySpend(all);
  for (const [date, mood] of Object.entries(moodLog)) {
    const total = byDay.get(date);
    if (total === undefined) continue;
    const bucket = byEnergy.get(mood.energy);
    if (bucket) bucket.push(total);
    else byEnergy.set(mood.energy, [total]);
  }
  return [...byEnergy.entries()]
    .map(([energy, values]) => ({ energy, days: values.length, medianSpend: median(values) }))
    .sort((a, b) => a.energy - b.energy);
}

export interface TodoCategorySpend {
  category: string;
  /** Observed days that had at least one todo in this category. */
  days: number;
  /** Median đồng spent on those days. */
  medianSpend: number;
  /** medianSpend ÷ the median across all observed days. */
  ratio: number;
}

/**
 * Spending against what you were doing that day.
 *
 * **This is not attribution, and the wording has to keep saying so.** A day
 * holds several todos across several categories and one pile of money; nothing
 * ties a particular đồng to a particular task. What it answers is narrower and
 * still worth knowing: *days on which you did X cost this much*.
 *
 * Only days with at least one money line count. A day with no lines is not a
 * day you spent nothing, it is a day you did not write anything down, and
 * folding those in as zeroes would drag every category toward zero in exact
 * proportion to how lazy the logging was. A day that was logged and came to
 * nothing does count as zero, because that is a real observation.
 *
 * `minDays` exists because two days is a coincidence. Below it a category is
 * left out rather than shown with a number nobody should read.
 */
export function spendByTodoCategory(
  entries: MoneyEntryData[],
  categoriesByDate: Map<string, string[]>,
  minDays = 3,
): TodoCategorySpend[] {
  const observed = new Set<string>();
  for (const e of entries) {
    if (countable(e)) observed.add(e.date);
  }
  if (observed.size === 0) return [];

  const byDay = dailySpend(entries);
  const spendOn = (date: string) => byDay.get(date) ?? 0;
  const baseline = median([...observed].map(spendOn));
  if (baseline <= 0) return [];

  const buckets = new Map<string, number[]>();
  for (const date of observed) {
    for (const category of categoriesByDate.get(date) ?? []) {
      const bucket = buckets.get(category);
      if (bucket) bucket.push(spendOn(date));
      else buckets.set(category, [spendOn(date)]);
    }
  }

  return [...buckets.entries()]
    .filter(([, values]) => values.length >= minDays)
    .map(([category, values]) => {
      const med = median(values);
      return { category, days: values.length, medianSpend: med, ratio: med / baseline };
    })
    .sort((a, b) => b.medianSpend - a.medianSpend);
}

export interface WeekdaySpend {
  /** 0 = Monday, matching DAY_KEYS. */
  day: number;
  days: number;
  medianSpend: number;
}

export function spendByWeekday(all: MoneyEntryData[]): WeekdaySpend[] {
  const byDay = dailySpend(all);
  const buckets = new Map<number, number[]>();
  for (const [date, total] of byDay) {
    const [y, m, d] = date.split('-').map(Number);
    // getDay() is 0 = Sunday; shift so Monday is 0 and the weekend is 5 and 6.
    const idx = (new Date(y, m - 1, d).getDay() + 6) % 7;
    const bucket = buckets.get(idx);
    if (bucket) bucket.push(total);
    else buckets.set(idx, [total]);
  }
  return [...buckets.entries()]
    .map(([day, values]) => ({ day, days: values.length, medianSpend: median(values) }))
    .sort((a, b) => a.day - b.day);
}
