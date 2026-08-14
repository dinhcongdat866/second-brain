import type { Node as PMNode } from 'prosemirror-model';
import type * as Y from 'yjs';
import {
  WEEKLY_PLANS_KEY,
  readMoneyAll,
  readTodoCategoriesByDate,
  readWallets,
  serializeWeeklyForAI,
  walletBalance,
} from '../collab/weeklyPlans';
import {
  categoryBreakdown,
  categoryNorms,
  forecastMonth,
  formatDongCompact,
  ledgerFrom,
  monthOf,
  monthTotals,
  spendByTodoCategory,
  todayIso,
} from './moneyStats';
import { MONEY_CAT } from './moneyTaxonomy';

/**
 * Tier 1 — local context: text from the N markdown cells immediately before
 * the given ai_cell. Small and on-point; always included.
 */
export function extractLocalContext(doc: PMNode, aiCellId: string, cellsBefore = 1): string {
  const cells: PMNode[] = [];
  doc.forEach((cell) => { cells.push(cell); });

  const aiIdx = cells.findIndex(
    (c) => c.type.name === 'ai_cell' && c.attrs.id === aiCellId,
  );
  if (aiIdx === -1) return '';

  return cells
    .slice(Math.max(0, aiIdx - cellsBefore), aiIdx)
    .filter((c) => c.type.name === 'markdown_cell')
    .map((c) => c.textContent.trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Tier 2 — doc context: all markdown cells in the current doc, truncated to
 * avoid unbounded growth as the notebook accumulates months of entries.
 */
export function extractDocContext(doc: PMNode, maxChars = 1500): string {
  const lines: string[] = [];
  doc.forEach((cell) => {
    if (cell.type.name !== 'markdown_cell') return;
    cell.forEach((block) => {
      const text = block.textContent.trim();
      if (text) lines.push(text);
    });
  });
  const full = lines.join('\n\n');
  return full.length > maxChars ? full.slice(0, maxChars) + '\n…(truncated)' : full;
}

/**
 * Weekly planner context: serialize up to `maxWeeks` most-recent non-empty
 * weeks from all planner cells in the global planner Y.Doc.
 * Data is not filtered by the current document — the planner is global.
 */
export function extractWeeklyContext(plannerYdoc: Y.Doc, maxWeeks = 4): string {
  const plans = plannerYdoc.getMap<Y.Map<unknown>>(WEEKLY_PLANS_KEY);
  const parts: string[] = [];
  plans.forEach((plan) => {
    const serialized = serializeWeeklyForAI(plan, maxWeeks);
    if (serialized) parts.push(serialized);
  });
  return parts.join('\n\n');
}

/**
 * Money context: the figures the money cell shows, as text the model can read.
 *
 * A summary rather than the raw lines. A year of entries is thousands of them,
 * and pasting the lot would spend the context window on the part the client has
 * already worked out — the totals, the split, the pace. What goes in is what a
 * person would say if asked how the month is going.
 *
 * Category names go through as the stored identifiers ('Food & Drink'), not the
 * localised labels: they are identifiers everywhere else in the system, and a
 * model reasoning about them should see the same strings the database stores.
 * The raw lines that do go in keep their original Vietnamese, because that is
 * user data and normalising it would throw away the detail worth asking about.
 */
export function extractMoneyContext(plannerYdoc: Y.Doc, maxLines = 30): string {
  const all = readMoneyAll(plannerYdoc);
  if (all.length === 0) return '';

  const today = monthOf(todayIso());
  const prev = (() => {
    const [y, m] = today.split('-').map(Number);
    const d = new Date(y, m - 2, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();

  const lines: string[] = ['MONEY (đồng; amounts are exact, totals are computed locally):'];

  for (const month of [today, prev]) {
    const totals = monthTotals(all, month);
    if (totals.entries === 0) continue;
    lines.push(
      `  ${month}: in ${totals.in}, out ${totals.out}, net ${totals.net}` +
        (totals.unknown > 0 ? ` (${totals.unknown} lines still have no amount)` : ''),
    );
    const cats = categoryBreakdown(all, month, categoryNorms(all, todayIso()));
    for (const c of cats.slice(0, 8)) {
      const normal = c.normal !== null && c.normalMonths >= 2 ? `, usually ${c.normal}` : '';
      lines.push(`    ${c.category}: ${c.total} (${c.count} lines${normal})`);
    }
  }

  const forecast = forecastMonth(all, today, todayIso());
  if (forecast) {
    lines.push(
      `  Pace: ${forecast.spentSoFar} spent over ${forecast.daysElapsed}/${forecast.daysInMonth} days` +
        ` — fixed ${forecast.fixedSoFar}, variable ${forecast.variableSoFar}` +
        ` (${Math.round(forecast.variablePerDay)}/day). Projected ${forecast.projected}.`,
    );
  }

  const wallets = readWallets(plannerYdoc);
  if (wallets.length > 0) {
    const parts = wallets.map((w, i) => `${w.name} ${walletBalance(all, w.id, i === 0)}`);
    lines.push(`  Wallets: ${parts.join(', ')}`);
  }

  // Days on which each kind of task appeared, and what those days cost. NOT
  // money attributed to a task — a day holds several tasks and one pile of
  // money — so the label says "days with", and the model should repeat that.
  const byTask = spendByTodoCategory(all, readTodoCategoriesByDate(plannerYdoc));
  if (byTask.length > 0) {
    const parts = byTask
      .slice(0, 6)
      .map((c) => `${c.category} ${c.medianSpend} (${c.days}d)`);
    lines.push(`  Median spend on days with each kind of task: ${parts.join(', ')}`);
  }

  const debts = ledgerFrom(all, todayIso());
  if (debts.length > 0) {
    const parts = debts.map((d) =>
      d.balance > 0
        ? `owes ${d.counterparty} ${d.balance} (${d.ageDays}d)`
        : `${d.counterparty} owes ${-d.balance} (${d.ageDays}d)`,
    );
    lines.push(`  Debts: ${parts.join('; ')}`);
  }

  // A tail of the actual lines, because the summary cannot answer "what did I
  // buy" and that is most of what anyone asks. Verbatim, corrections excluded.
  const recent = all
    .filter((e) => e.category !== MONEY_CAT.ADJUSTMENT)
    .slice(-maxLines);
  if (recent.length > 0) {
    lines.push('  Recent lines:');
    for (const e of recent) {
      const amount = e.amount === null ? '?' : formatDongCompact(e.amount);
      lines.push(`    ${e.date} ${e.text} → ${amount}`);
    }
  }

  return lines.join('\n');
}
