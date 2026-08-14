import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type * as Y from 'yjs';
import {
  DAY_KEYS,
  DAY_LABELS,
  MONEY_LOG_KEY,
  MONEY_SETTINGS_KEY,
  MOOD_EMOJIS,
  SHARED_PLAN_ID,
  WALLETS_KEY,
  WEEKLY_PLANS_KEY,
  correctWalletBalance,
  createWallet,
  deleteWallet,
  readMonthlyBudget,
  readMoneyAll,
  readMoodLog,
  readTodoCategoriesByDate,
  readWallets,
  renameWallet,
  setMonthlyBudget,
  walletBalance,
  type MoneyEntryData,
  type MoodEntry,
  type WalletData,
} from '../collab/weeklyPlans';
import {
  addMonths,
  allowance,
  anomalies,
  categoryBreakdown,
  categoryNorms,
  detectRecurring,
  estimateNextMonth,
  forecastMonth,
  formatDongCompact,
  ledgerFrom,
  monthOf,
  monthTotals,
  monthsWithData,
  parseDongShorthand,
  searchEntries,
  spendByMood,
  spendByTodoCategory,
  spendByWeekday,
  todayIso,
} from '../lib/moneyStats';
import { moneyCategoryLabel } from '../lib/moneyTaxonomy';
import { categoryLabel } from '../lib/taxonomy';
import {
  readActiveWalletId,
  resolveActiveWalletId,
  subscribeActiveWallet,
  writeActiveWalletId,
} from '../lib/activeWallet';

// ---------------------------------------------------------------------------
// Section open/closed state
// ---------------------------------------------------------------------------

const SECTIONS_KEY = 'moneyCellSections';

type SectionId =
  | 'wallets' | 'categories' | 'pace' | 'unusual'
  | 'recurring' | 'ledger' | 'rhythm' | 'search';

/**
 * Everything except the two long tails starts open.
 *
 * A lens with nine collapsed headers is a filing cabinet, not an answer. The
 * ones left shut are the two you consult rather than read — the rhythm figures
 * and the search box.
 */
const DEFAULT_SECTIONS: Record<SectionId, boolean> = {
  wallets: true, categories: true, pace: true, unusual: true,
  recurring: true, ledger: true, rhythm: false, search: false,
};

function readSections(): Record<SectionId, boolean> {
  try {
    const raw = localStorage.getItem(SECTIONS_KEY);
    if (raw) return { ...DEFAULT_SECTIONS, ...(JSON.parse(raw) as Partial<Record<SectionId, boolean>>) };
  } catch { /* private mode or corrupt value — fall through to the defaults */ }
  return DEFAULT_SECTIONS;
}

interface SectionProps {
  id: SectionId;
  title: string;
  /** Small figure in the header, so a shut section still says how much is in it. */
  badge?: string;
  open: boolean;
  onToggle: (id: SectionId) => void;
  children: React.ReactNode;
}

function Section({ id, title, badge, open, onToggle, children }: SectionProps) {
  return (
    <section className="money-section">
      <button
        type="button"
        className="money-section__head"
        onClick={() => onToggle(id)}
        aria-expanded={open}
      >
        <span className="money-section__chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="money-section__title">{title}</span>
        {badge && <span className="money-section__badge">{badge}</span>}
      </button>
      {open && <div className="money-section__body">{children}</div>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Amount input — accepts the shorthand the log is written in
// ---------------------------------------------------------------------------

interface AmountInputProps {
  value: string;
  onChange: (v: string) => void;
  onCommit: (amount: number) => void;
  onCancel?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
}

/**
 * Takes '5tr', '4tr5', '300k' or '3.800.000' and shows what it read before you
 * commit. Typing a balance in full digits when every other field in this app
 * accepts shorthand would be a small, constant annoyance — and the shorthand
 * parser is local, so the echo appears as you type with nothing in between.
 */
function AmountInput({
  value, onChange, onCommit, onCancel, placeholder, autoFocus,
}: AmountInputProps) {
  const parsed = parseDongShorthand(value);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter' && parsed !== null) { e.preventDefault(); onCommit(parsed); }
    if (e.key === 'Escape') onCancel?.();
  };
  return (
    <span className="money-amount-input">
      <input
        className="money-input"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
      />
      {value.trim() !== '' && (
        <span className={`money-amount-input__echo${parsed === null ? ' money-amount-input__echo--bad' : ''}`}>
          {parsed === null ? '?' : formatDongCompact(parsed)}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------

interface WalletsProps {
  ydoc: Y.Doc;
  wallets: WalletData[];
  entries: MoneyEntryData[];
  activeId: string | null;
  onActivate: (id: string) => void;
}

function Wallets({ ydoc, wallets, entries, activeId, onActivate }: WalletsProps) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newIcon, setNewIcon] = useState('👛');
  const [newBalance, setNewBalance] = useState('');
  const [fixing, setFixing] = useState<string | null>(null);
  const [fixValue, setFixValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const defaultId = wallets[0]?.id ?? null;

  const submitNew = () => {
    const opening = parseDongShorthand(newBalance) ?? 0;
    createWallet(ydoc, newName || t('money.wallets.untitled'), newIcon || '👛', opening, t('money.wallets.openingLabel'));
    setAdding(false);
    setNewName('');
    setNewIcon('👛');
    setNewBalance('');
  };

  return (
    <div className="money-wallets">
      {wallets.length === 0 && (
        <p className="money-empty">{t('money.wallets.none')}</p>
      )}

      {wallets.map((w) => {
        const balance = walletBalance(entries, w.id, w.id === defaultId);
        const isActive = w.id === activeId;
        return (
          <div key={w.id} className={`money-wallet${isActive ? ' money-wallet--active' : ''}`}>
            <button
              type="button"
              className="money-wallet__pick"
              onClick={() => onActivate(w.id)}
              title={isActive ? t('money.wallets.isActive') : t('money.wallets.setActive')}
            >
              <span className="money-wallet__icon" aria-hidden="true">{w.icon}</span>
              <span className="money-wallet__name">{w.name}</span>
              {isActive && <span className="money-wallet__dot" title={t('money.wallets.isActive')}>●</span>}
            </button>

            {fixing === w.id ? (
              <AmountInput
                value={fixValue}
                onChange={setFixValue}
                autoFocus
                placeholder={t('money.wallets.fixPlaceholder')}
                onCancel={() => setFixing(null)}
                onCommit={(actual) => {
                  correctWalletBalance(ydoc, w.id, actual, balance, t('money.wallets.correctionLabel'));
                  setFixing(null);
                  setFixValue('');
                }}
              />
            ) : (
              <span
                className={`money-wallet__balance money-wallet__balance--${balance < 0 ? 'out' : 'in'}`}
                title={balance.toLocaleString('vi-VN')}
              >
                {formatDongCompact(balance)}
              </span>
            )}

            <div className="money-wallet__acts">
              <button
                type="button"
                className="money-icon-btn"
                title={t('money.wallets.fix')}
                onClick={() => { setFixing(w.id); setFixValue(''); }}
              >
                ⇄
              </button>
              <button
                type="button"
                className="money-icon-btn"
                title={t('money.wallets.rename')}
                onClick={() => {
                  const next = window.prompt(t('money.wallets.rename'), w.name);
                  if (next) renameWallet(ydoc, w.id, next);
                }}
              >
                ✎
              </button>
              {confirmDelete === w.id ? (
                <>
                  <button
                    type="button"
                    className="money-icon-btn money-icon-btn--danger"
                    title={t('money.wallets.confirmDelete')}
                    onClick={() => { deleteWallet(ydoc, w.id); setConfirmDelete(null); }}
                  >
                    ✓
                  </button>
                  <button type="button" className="money-icon-btn" onClick={() => setConfirmDelete(null)}>✗</button>
                </>
              ) : (
                <button
                  type="button"
                  className="money-icon-btn"
                  title={t('money.wallets.delete')}
                  onClick={() => setConfirmDelete(w.id)}
                >
                  ×
                </button>
              )}
            </div>
          </div>
        );
      })}

      {adding ? (
        <div className="money-wallet money-wallet--new">
          <input
            className="money-input money-input--icon"
            value={newIcon}
            maxLength={2}
            onChange={(e) => setNewIcon(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <input
            className="money-input"
            autoFocus
            placeholder={t('money.wallets.namePlaceholder')}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') submitNew(); if (e.key === 'Escape') setAdding(false); }}
          />
          <AmountInput
            value={newBalance}
            onChange={setNewBalance}
            placeholder={t('money.wallets.openingPlaceholder')}
            onCommit={submitNew}
            onCancel={() => setAdding(false)}
          />
          <button type="button" className="money-btn" onClick={submitNew}>{t('money.wallets.create')}</button>
          <button type="button" className="money-icon-btn" onClick={() => setAdding(false)}>×</button>
        </div>
      ) : (
        <button type="button" className="money-btn money-btn--ghost" onClick={() => setAdding(true)}>
          {t('money.wallets.add')}
        </button>
      )}

      <p className="money-note">{t('money.wallets.correctionNote')}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

interface Props {
  ydoc: Y.Doc;
  onDelete: () => void;
  isGuest: boolean;
}

export function MoneyCell({ ydoc, onDelete, isGuest }: Props) {
  const { t, i18n } = useTranslation();
  const today = todayIso();

  const [entries, setEntries] = useState<MoneyEntryData[]>(() => readMoneyAll(ydoc));
  const [wallets, setWallets] = useState<WalletData[]>(() => readWallets(ydoc));
  const [budget, setBudget] = useState<number>(() => readMonthlyBudget(ydoc));
  const [moodLog, setMoodLog] = useState<Record<string, MoodEntry>>({});
  const [todoCats, setTodoCats] = useState<Map<string, string[]>>(() => new Map());
  const [month, setMonth] = useState(() => monthOf(today));
  const [sections, setSections] = useState(readSections);
  const [query, setQuery] = useState('');
  const [budgetDraft, setBudgetDraft] = useState('');
  const [editingBudget, setEditingBudget] = useState(false);

  // Three separate subscriptions, because these are three separate top-level
  // maps. Watching only what changed keeps a todo edit in the planner from
  // recomputing a month of statistics.
  useEffect(() => {
    const map = ydoc.getMap(MONEY_LOG_KEY);
    const handler = () => setEntries(readMoneyAll(ydoc));
    map.observeDeep(handler);
    handler();
    return () => map.unobserveDeep(handler);
  }, [ydoc]);

  useEffect(() => {
    const map = ydoc.getMap(WALLETS_KEY);
    const handler = () => setWallets(readWallets(ydoc));
    map.observeDeep(handler);
    handler();
    return () => map.unobserveDeep(handler);
  }, [ydoc]);

  useEffect(() => {
    const map = ydoc.getMap(MONEY_SETTINGS_KEY);
    const handler = () => setBudget(readMonthlyBudget(ydoc));
    map.observe(handler);
    handler();
    return () => map.unobserve(handler);
  }, [ydoc]);

  // Mood lives inside the shared plan, so it is reached the same way the weekly
  // cell reaches it — and re-resolved on the top-level map for the same reason:
  // a late server merge can replace the plan instance wholesale.
  useEffect(() => {
    const plans = ydoc.getMap<Y.Map<unknown>>(WEEKLY_PLANS_KEY);
    let plan = plans.get(SHARED_PLAN_ID);
    const read = () => {
      if (!plan) return;
      setMoodLog(readMoodLog(plan));
      // Categories are cached onto the todos themselves by useClassificationSync,
      // so they arrive through this same subscription — no fetch, and the panel
      // fills in by itself the moment the classifier has caught up.
      setTodoCats(readTodoCategoriesByDate(ydoc));
    };
    const onPlans = () => {
      const current = plans.get(SHARED_PLAN_ID);
      if (current && current !== plan) {
        plan?.unobserveDeep(read);
        plan = current;
        plan.observeDeep(read);
      }
      read();
    };
    plans.observe(onPlans);
    plan?.observeDeep(read);
    read();
    return () => {
      plans.unobserve(onPlans);
      plan?.unobserveDeep(read);
    };
  }, [ydoc]);

  // Derived, not stored: the choice is one string in a store both this cell and
  // the planner's wallet chip subscribe to, and the fallback for a deleted
  // wallet is recomputed rather than written back.
  const storedWallet = useSyncExternalStore(subscribeActiveWallet, readActiveWalletId);
  const activeWallet = useMemo(
    () => resolveActiveWalletId(wallets.map((w) => w.id), storedWallet),
    [wallets, storedWallet],
  );

  const toggleSection = useCallback((id: SectionId) => {
    setSections((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }, []);

  const activate = useCallback((id: string) => writeActiveWalletId(id), []);

  // Every figure on the page, from one array already in memory. No request, and
  // therefore no spinner between clicking ‹ and reading the answer.
  const totals    = useMemo(() => monthTotals(entries, month), [entries, month]);
  const norms     = useMemo(() => categoryNorms(entries, today), [entries, today]);
  const cats      = useMemo(() => categoryBreakdown(entries, month, norms), [entries, month, norms]);
  const forecast  = useMemo(() => forecastMonth(entries, month, today), [entries, month, today]);
  const nextMonth = useMemo(() => estimateNextMonth(entries, month, today), [entries, month, today]);
  const budgetLeft = useMemo(
    () => (forecast && budget > 0 ? allowance(forecast, budget) : null),
    [forecast, budget],
  );
  const odd       = useMemo(() => anomalies(entries, month), [entries, month]);
  const recurring = useMemo(() => detectRecurring(entries, today), [entries, today]);
  const ledger    = useMemo(() => ledgerFrom(entries, today), [entries, today]);
  const byMood    = useMemo(() => spendByMood(entries, moodLog), [entries, moodLog]);
  const byTodoCat = useMemo(() => spendByTodoCategory(entries, todoCats), [entries, todoCats]);
  const byWeekday = useMemo(() => spendByWeekday(entries), [entries]);
  const found     = useMemo(() => searchEntries(entries, query), [entries, query]);
  const knownMonths = useMemo(() => monthsWithData(entries), [entries]);

  const monthLabel = useMemo(() => {
    const [y, m] = month.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(i18n.language, { month: 'long', year: 'numeric' });
  }, [month, i18n.language]);

  const dayLabel = useCallback((date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`, []);

  if (isGuest) {
    return (
      <div className="money-cell">
        <div className="money-cell__header">
          <span className="money-cell__kind">{t('money.kind')}</span>
          <button type="button" className="money-cell__delete" onClick={onDelete} title={t('money.deleteCell')}>×</button>
        </div>
        <p className="money-empty">{t('money.guestNote')}</p>
      </div>
    );
  }

  const hasAnything = entries.length > 0;

  return (
    <div className="money-cell">
      <div className="money-cell__header">
        <span className="money-cell__kind">{t('money.kind')}</span>
        <div className="money-cell__nav">
          <button
            type="button"
            className="money-cell__navbtn"
            onClick={() => setMonth((m) => addMonths(m, -1))}
            title={t('money.prevMonth')}
          >
            ‹
          </button>
          <span className="money-cell__month">{monthLabel}</span>
          <button
            type="button"
            className="money-cell__navbtn"
            onClick={() => setMonth((m) => addMonths(m, 1))}
            title={t('money.nextMonth')}
          >
            ›
          </button>
          {month !== monthOf(today) && (
            <button
              type="button"
              className="money-cell__today"
              onClick={() => setMonth(monthOf(today))}
            >
              {t('money.thisMonth')}
            </button>
          )}
        </div>
        <button type="button" className="money-cell__delete" onClick={onDelete} title={t('money.deleteCell')}>×</button>
      </div>

      {!hasAnything ? (
        <p className="money-empty">{t('money.noData')}</p>
      ) : (
        <>
          {/* Summary — three numbers, the whole month in one glance. */}
          <div className="money-summary">
            <div className="money-summary__item">
              <span className="money-summary__label">{t('money.in')}</span>
              <span className="money-summary__value money-summary__value--in" title={totals.in.toLocaleString('vi-VN')}>
                {formatDongCompact(totals.in)}
              </span>
            </div>
            <div className="money-summary__item">
              <span className="money-summary__label">{t('money.out')}</span>
              <span className="money-summary__value money-summary__value--out" title={totals.out.toLocaleString('vi-VN')}>
                {formatDongCompact(totals.out)}
              </span>
            </div>
            <div className="money-summary__item">
              <span className="money-summary__label">{t('money.net')}</span>
              <span
                className={`money-summary__value money-summary__value--${totals.net < 0 ? 'out' : 'in'}`}
                title={totals.net.toLocaleString('vi-VN')}
              >
                {formatDongCompact(totals.net)}
              </span>
            </div>
          </div>
          {totals.unknown > 0 && (
            // Same rule as the day total in the planner: say the figure is
            // incomplete rather than quietly reporting a smaller number.
            <p className="money-note money-note--warn">
              {t('money.pendingLines', { count: totals.unknown })}
            </p>
          )}

          <Section
            id="wallets" title={t('money.sectionWallets')} open={sections.wallets} onToggle={toggleSection}
            badge={wallets.length > 0
              ? formatDongCompact(wallets.reduce((s, w, i) => s + walletBalance(entries, w.id, i === 0), 0))
              : undefined}
          >
            <Wallets
              ydoc={ydoc}
              wallets={wallets}
              entries={entries}
              activeId={activeWallet}
              onActivate={activate}
            />
          </Section>

          <Section
            id="categories" title={t('money.sectionCategories')} open={sections.categories} onToggle={toggleSection}
            badge={cats.length > 0 ? String(cats.length) : undefined}
          >
            {cats.length === 0 ? (
              <p className="money-empty">{t('money.noSpending')}</p>
            ) : (
              <ul className="money-cats">
                {cats.map((c) => (
                  <li key={c.category} className="money-cat">
                    <span className="money-cat__name">{moneyCategoryLabel(t, c.category)}</span>
                    <span className="money-cat__bar" aria-hidden="true">
                      <span className="money-cat__fill" style={{ width: `${Math.round(c.share * 100)}%` }} />
                    </span>
                    <span className="money-cat__amount" title={c.total.toLocaleString('vi-VN')}>
                      {formatDongCompact(c.total)}
                    </span>
                    {/* One month is not a habit, so no comparison is offered
                        until there are two to take a median of. */}
                    {c.normal !== null && c.normalMonths >= 2 && (
                      <span
                        className={
                          'money-cat__normal' +
                          (c.total > c.normal * 1.3 ? ' money-cat__normal--high' : '')
                        }
                      >
                        {t('money.usually', { amount: formatDongCompact(c.normal) })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            id="pace" title={t('money.sectionPace')} open={sections.pace} onToggle={toggleSection}
            badge={forecast ? formatDongCompact(forecast.projected) : undefined}
          >
            {!forecast ? (
              <p className="money-empty">{t('money.futureMonth')}</p>
            ) : (
              <div className="money-pace">
                <div className="money-pace__row">
                  <span>{t('money.spentSoFar')}</span>
                  <span className="money-pace__num">{formatDongCompact(forecast.spentSoFar)}</span>
                  <span className="money-pace__aside">
                    {t('money.ofDays', { done: forecast.daysElapsed, total: forecast.daysInMonth })}
                  </span>
                </div>
                <div className="money-pace__row money-pace__row--sub">
                  <span>{t('money.fixed')}</span>
                  <span className="money-pace__num">{formatDongCompact(forecast.fixedSoFar)}</span>
                  <span className="money-pace__aside">{t('money.fixedHint')}</span>
                </div>
                <div className="money-pace__row money-pace__row--sub">
                  <span>{t('money.variable')}</span>
                  <span className="money-pace__num">{formatDongCompact(forecast.variableSoFar)}</span>
                  <span className="money-pace__aside">
                    {t('money.perDay', { amount: formatDongCompact(Math.round(forecast.variablePerDay)) })}
                  </span>
                </div>
                <div className="money-pace__row money-pace__row--strong">
                  <span>{t('money.projected')}</span>
                  <span className="money-pace__num">{formatDongCompact(forecast.projected)}</span>
                  <span className="money-pace__aside">{t('money.projectedHint')}</span>
                </div>
                {nextMonth && (
                  <div className="money-pace__row">
                    <span>{t('money.nextMonthEstimate')}</span>
                    <span className="money-pace__num">{formatDongCompact(nextMonth.total)}</span>
                    <span className="money-pace__aside">
                      {nextMonth.basedOnMonths > 0
                        ? t('money.basedOn', { count: nextMonth.basedOnMonths })
                        : t('money.basedOnThisMonth')}
                    </span>
                  </div>
                )}

                <div className="money-budget">
                  {editingBudget || budget === 0 ? (
                    <>
                      <span>{t('money.budget')}</span>
                      <AmountInput
                        value={budgetDraft}
                        onChange={setBudgetDraft}
                        placeholder={t('money.budgetPlaceholder')}
                        onCancel={() => { setEditingBudget(false); setBudgetDraft(''); }}
                        onCommit={(v) => {
                          setMonthlyBudget(ydoc, v);
                          setEditingBudget(false);
                          setBudgetDraft('');
                        }}
                      />
                    </>
                  ) : (
                    <>
                      <span>{t('money.budget')}</span>
                      <button
                        type="button"
                        className="money-budget__value"
                        onClick={() => { setEditingBudget(true); setBudgetDraft(''); }}
                      >
                        {formatDongCompact(budget)}
                      </button>
                      {budgetLeft && (
                        <span className={`money-budget__left${budgetLeft.over ? ' money-budget__left--over' : ''}`}>
                          {budgetLeft.over
                            ? t('money.overBudget', { amount: formatDongCompact(-budgetLeft.remaining) })
                            : t('money.allowance', {
                                remaining: formatDongCompact(budgetLeft.remaining),
                                days: budgetLeft.daysLeft,
                                perDay: formatDongCompact(budgetLeft.perDay),
                              })}
                        </span>
                      )}
                    </>
                  )}
                </div>
                {budget > 0 && budgetLeft && (
                  <p className="money-note">{t('money.allowanceNote')}</p>
                )}
              </div>
            )}
          </Section>

          <Section
            id="unusual" title={t('money.sectionUnusual')} open={sections.unusual} onToggle={toggleSection}
            badge={odd.length > 0 ? String(odd.length) : undefined}
          >
            {odd.length === 0 ? (
              <p className="money-empty">{t('money.nothingUnusual')}</p>
            ) : (
              <ul className="money-list">
                {odd.map((a) => (
                  <li key={a.date} className="money-list__row">
                    <span className="money-list__when">{dayLabel(a.date)}</span>
                    <span className="money-list__main">{a.biggest}</span>
                    <span className="money-list__aside">
                      {t('money.timesNormal', { ratio: a.ratio.toFixed(1).replace('.', ',') })}
                    </span>
                    <span className="money-list__amount" title={a.total.toLocaleString('vi-VN')}>
                      {formatDongCompact(a.total)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            id="recurring" title={t('money.sectionRecurring')} open={sections.recurring} onToggle={toggleSection}
            badge={recurring.length > 0
              ? formatDongCompact(recurring.reduce((s, r) => s + r.amount, 0))
              : undefined}
          >
            {recurring.length === 0 ? (
              <p className="money-empty">{t('money.noRecurring')}</p>
            ) : (
              <ul className="money-list">
                {recurring.map((r) => (
                  <li key={r.label + r.lastDate} className="money-list__row">
                    <span className="money-list__main">{r.label}</span>
                    <span className="money-list__aside">
                      {t('money.everyDays', { days: r.avgGapDays, count: r.count })}
                      {r.daysSinceLast > r.avgGapDays + 5 && ` · ${t('money.overdue')}`}
                    </span>
                    <span className="money-list__amount" title={r.amount.toLocaleString('vi-VN')}>
                      {formatDongCompact(r.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            id="ledger" title={t('money.sectionLedger')} open={sections.ledger} onToggle={toggleSection}
            badge={ledger.length > 0 ? String(ledger.length) : undefined}
          >
            {ledger.length === 0 ? (
              <p className="money-empty">{t('money.noDebts')}</p>
            ) : (
              <ul className="money-list">
                {ledger.map((l) => (
                  <li key={l.counterparty} className="money-list__row">
                    <span className="money-list__main">{l.counterparty}</span>
                    <span className="money-list__aside">{t('money.sinceDays', { days: l.ageDays })}</span>
                    <span
                      className={`money-list__amount money-list__amount--${l.balance > 0 ? 'out' : 'in'}`}
                      title={`${l.borrowed.toLocaleString('vi-VN')} / ${l.repaid.toLocaleString('vi-VN')}`}
                    >
                      {l.balance > 0
                        ? t('money.youOwe', { amount: formatDongCompact(l.balance) })
                        : t('money.theyOwe', { amount: formatDongCompact(-l.balance) })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section id="rhythm" title={t('money.sectionRhythm')} open={sections.rhythm} onToggle={toggleSection}>
            {byMood.length === 0 && byWeekday.length === 0 && byTodoCat.length === 0 ? (
              <p className="money-empty">{t('money.noRhythm')}</p>
            ) : (
              <>
                {byMood.length > 0 && (
                  <>
                    <p className="money-sub">{t('money.byMood')}</p>
                    <ul className="money-list">
                      {byMood.map((m) => (
                        <li key={m.energy} className="money-list__row">
                          <span className="money-list__main">{MOOD_EMOJIS[m.energy]} {m.energy}/5</span>
                          <span className="money-list__aside">{t('money.dayCount', { count: m.days })}</span>
                          <span className="money-list__amount">{formatDongCompact(m.medianSpend)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {byTodoCat.length > 0 && (
                  <>
                    <p className="money-sub">{t('money.byTodo')}</p>
                    <ul className="money-list">
                      {byTodoCat.map((c) => (
                        <li key={c.category} className="money-list__row">
                          <span className="money-list__main">{categoryLabel(t, c.category)}</span>
                          <span className="money-list__aside">
                            {t('money.dayCount', { count: c.days })}
                            {/* Only worth colouring when it is far enough from
                                your ordinary day to mean anything. */}
                            {(c.ratio >= 1.5 || c.ratio <= 0.67) &&
                              ` · ${t('money.timesNormal', { ratio: c.ratio.toFixed(1).replace('.', ',') })}`}
                          </span>
                          <span className="money-list__amount">{formatDongCompact(c.medianSpend)}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="money-note">{t('money.byTodoNote')}</p>
                  </>
                )}
                {byWeekday.length > 0 && (
                  <>
                    <p className="money-sub">{t('money.byWeekday')}</p>
                    <ul className="money-list">
                      {byWeekday.map((w) => (
                        <li key={w.day} className="money-list__row">
                          <span className="money-list__main">{DAY_LABELS[DAY_KEYS[w.day]]}</span>
                          <span className="money-list__aside">{t('money.dayCount', { count: w.days })}</span>
                          <span className="money-list__amount">{formatDongCompact(w.medianSpend)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <p className="money-note">{t('money.rhythmNote')}</p>
              </>
            )}
          </Section>

          <Section id="search" title={t('money.sectionSearch')} open={sections.search} onToggle={toggleSection}>
            <input
              className="money-input money-input--search"
              placeholder={t('money.searchPlaceholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            />
            {query.trim() !== '' && (
              found.matches.length === 0 ? (
                <p className="money-empty">{t('money.searchNone')}</p>
              ) : (
                <>
                  <p className="money-sub">
                    {t('money.searchSummary', {
                      count: found.matches.length,
                      spent: formatDongCompact(found.spent),
                    })}
                  </p>
                  <ul className="money-list">
                    {found.matches.slice(0, 40).map((e) => (
                      <li key={e.id} className="money-list__row">
                        <span className="money-list__when">{dayLabel(e.date)}</span>
                        <span className="money-list__main">{e.text}</span>
                        <span className="money-list__amount">
                          {e.amount === null ? '—' : formatDongCompact(e.amount)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {found.matches.length > 40 && (
                    <p className="money-note">{t('money.searchTruncated', { count: found.matches.length - 40 })}</p>
                  )}
                </>
              )
            )}
            <p className="money-note">{t('money.searchNote')}</p>
          </Section>

          {knownMonths.length > 1 && (
            <div className="money-months">
              {knownMonths.slice(-12).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`money-months__chip${m === month ? ' money-months__chip--on' : ''}`}
                  onClick={() => setMonth(m)}
                >
                  {m.slice(5)}/{m.slice(2, 4)}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
