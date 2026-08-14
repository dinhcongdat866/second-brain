import { useState, useEffect, useMemo, useRef, useCallback, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type * as Y from 'yjs';
import {
  DAY_KEYS,
  DAY_LABELS,
  SHARED_PLAN_ID,
  WEEKLY_PLANS_KEY,
  type DayKey,
  type AllDays,
  type TodoData,
  type MoodEntry,
  type MoneyEntryData,
  MONEY_LOG_KEY,
  addTodo,
  updateTodoText,
  addMoneyEntry,
  deleteMoneyEntry,
  readMoneyLog,
  moneyTotal,
  formatDong,
  getWeeklyPlan,
  toggleTodo,
  deleteTodo,
  formatTodoText,
  clearTodoStyle,
  readAllDays,
  readMoodLog,
  weekRangeLabel,
  todayDayKey,
  setWeekStart,
  shiftWeek,
  dayToDate,
  setMoodForDate,
} from '../collab/weeklyPlans';
import {
  weeklyOpen,
  weeklyClose,
  renderStyleMarkers,
  type StyleKind,
} from '../lib/toolbarStyles';
import { SelectionToolbarShell } from '../components/SelectionToolbarShell';
import { moneyCategoryLabel } from '../lib/moneyTaxonomy';
import { apiFetch } from '../lib/http';

// ---------------------------------------------------------------------------
// Inline markdown renderer — bold, italic, strikethrough, code, link + style
// markers ({c=…}/{b=…}/{s=…} → spans, validated in renderStyleMarkers)
//
// Output is injected via dangerouslySetInnerHTML, so every interpolation must
// be safe: text is HTML-escaped up front, and link hrefs are scheme-checked +
// attribute-escaped (blocking `javascript:` and `"`-breakout attribute
// injection). Bold/italic/etc. only wrap already-escaped text in tagless marks.
// ---------------------------------------------------------------------------

/** Allow http(s)/mailto and scheme-less (relative/anchor) URLs; block the rest. */
function safeHref(url: string): string | null {
  const trimmed = url.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null; // javascript:, data:, vbscript:, …
  return trimmed; // relative path / #anchor — no scheme
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Bold / italic / strikethrough / inline-code on already-escaped text. */
function inlineMarks(s: string): string {
  return s
    .replace(/\*\*(.*?)\*\*/gs, '<strong>$1</strong>')
    .replace(/_(.*?)_/gs, '<em>$1</em>')
    .replace(/~~(.*?)~~/gs, '<s>$1</s>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function renderMd(raw: string): string {
  const esc = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Pull links out to placeholders BEFORE running inline marks: this keeps mark
  // syntax inside URLs (e.g. `a_b`) intact and prevents the generated
  // `target="_blank"` from being mangled by the italic rule. The label is still
  // mark-rendered; placeholders are NUL-delimited so no mark regex touches them.
  const links: string[] = [];
  const withLinks = esc.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) => {
    const href = safeHref(url);
    const label = inlineMarks(text);
    // Unsafe URL → drop the link, keep the (already-escaped) label.
    const html = href
      ? `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : label;
    links.push(html);
    return `@@@${links.length - 1}@@@`;
  });

  const withMd = inlineMarks(withLinks)
    .replace(/@@@(\d+)@@@/g, (_m, i: string) => links[Number(i)]);
  return renderStyleMarkers(withMd);
}

type WeeklyFlyout = 'text' | 'bg' | 'size' | null;

// ---------------------------------------------------------------------------
// Native-selection toolbar for weekly cell
// ---------------------------------------------------------------------------

interface FormatContext {
  todoId: string;
  day: DayKey;
  /** Selection bounds as offsets within the todo's rendered (visible) text. */
  start: number;
  end: number;
}

/** Visible-character offset of (node, offset) within `span`'s rendered text. */
function visibleOffsetWithin(span: Element, node: Node, offset: number): number {
  const r = document.createRange();
  r.selectNodeContents(span);
  try {
    r.setEnd(node, offset);
  } catch {
    return (span.textContent ?? '').length;
  }
  return r.toString().length;
}

interface WeeklySelectionToolbarProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  plan: Y.Map<unknown>;
  weekStart: string;
}

function WeeklySelectionToolbar({ containerRef, plan, weekStart }: WeeklySelectionToolbarProps) {
  const [toolbarPos, setToolbarPos] = useState<{ left: number; top: number } | null>(null);
  const [flyout, setFlyout] = useState<WeeklyFlyout>(null);
  const [linkMode, setLinkMode] = useState(false);
  // Position frozen when link mode opens — kept in state (not a ref) so it
  // can be read during render without violating the rules of hooks.
  const [linkPos, setLinkPos] = useState<{ left: number; top: number } | null>(null);
  const [linkUrl, setLinkUrl] = useState('');
  const savedLink = useRef<FormatContext | null>(null);
  // Saved at selection time so button clicks don't need a live window.getSelection()
  const savedFormatRef = useRef<FormatContext | null>(null);
  const linkModeRef = useRef(false);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Ref for the toolbar element itself — used for click-outside detection.
  const toolbarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onSelectionChange = () => {
      if (linkModeRef.current) return;
      clearTimeout(showTimer.current);
      setFlyout(null);
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !sel.toString()) {
        setToolbarPos(null);
        savedFormatRef.current = null;
        return;
      }
      const range = sel.getRangeAt(0);
      if (!containerRef.current?.contains(range.commonAncestorContainer)) {
        setToolbarPos(null);
        savedFormatRef.current = null;
        return;
      }
      const node = range.startContainer;
      const span = (node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element)
        ?.closest('[data-todo-id]');
      if (!span) {
        setToolbarPos(null);
        savedFormatRef.current = null;
        return;
      }
      const a = visibleOffsetWithin(span, range.startContainer, range.startOffset);
      const b = visibleOffsetWithin(span, range.endContainer, range.endOffset);
      savedFormatRef.current = {
        todoId: span.getAttribute('data-todo-id')!,
        day: span.getAttribute('data-day')! as DayKey,
        start: Math.min(a, b),
        end: Math.max(a, b),
      };
      const rect = range.getBoundingClientRect();
      showTimer.current = setTimeout(() => {
        setToolbarPos({ left: (rect.left + rect.right) / 2, top: rect.top });
      }, 220);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      clearTimeout(showTimer.current);
    };
  }, [containerRef]);

  useEffect(() => {
    if (linkMode) linkInputRef.current?.focus();
  }, [linkMode]);

  useEffect(() => () => clearTimeout(showTimer.current), []);

  const applyFormat = useCallback((open: string, close: string) => {
    if (!savedFormatRef.current) return;
    const { todoId, day, start, end } = savedFormatRef.current;
    formatTodoText(plan, weekStart, day, todoId, start, end, open, close);
    savedFormatRef.current = null;
    window.getSelection()?.removeAllRanges();
    setFlyout(null);
    setToolbarPos(null);
  }, [plan, weekStart]);

  const applyStyle = useCallback((kind: StyleKind, value: string | null) => {
    if (!savedFormatRef.current) return;
    const { todoId, day, start, end } = savedFormatRef.current;
    // Strip any existing marker of this kind first so re-applying replaces it
    // instead of nesting {c=..}{c=..} (which the renderer can't parse).
    clearTodoStyle(plan, weekStart, day, todoId, start, end, kind);
    if (value) formatTodoText(plan, weekStart, day, todoId, start, end, weeklyOpen(kind, value), weeklyClose(kind));
    savedFormatRef.current = null;
    window.getSelection()?.removeAllRanges();
    setFlyout(null);
    setToolbarPos(null);
  }, [plan, weekStart]);

  const enterLinkMode = useCallback(() => {
    if (!savedFormatRef.current || !toolbarPos) return;
    savedLink.current = { ...savedFormatRef.current };
    setLinkPos(toolbarPos);
    linkModeRef.current = true;
    setLinkMode(true);
  }, [toolbarPos]);

  const applyLink = useCallback(() => {
    if (!savedLink.current) return;
    const raw = linkUrl.trim();
    if (!raw) return;
    const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const { todoId, day, start, end } = savedLink.current;
    formatTodoText(plan, weekStart, day, todoId, start, end, '[', `](${href})`);
    linkModeRef.current = false;
    setLinkMode(false);
    setLinkUrl('');
    savedLink.current = null;
    setLinkPos(null);
    setToolbarPos(null);
  }, [plan, weekStart, linkUrl]);

  const cancelLink = useCallback(() => {
    linkModeRef.current = false;
    setLinkMode(false);
    setLinkUrl('');
    savedLink.current = null;
    setLinkPos(null);
    setToolbarPos(null);
  }, []);

  // Click outside the toolbar while link-input is open → cancel.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!linkModeRef.current) return;
      if (toolbarRef.current?.contains(e.target as Node)) return;
      cancelLink();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [cancelLink]);

  // Ctrl+B / Ctrl+I when text is selected inside the weekly cell.
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (!savedFormatRef.current) return;
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey) return;
      const pairs: Record<string, [string, string]> = { b: ['**', '**'], i: ['_', '_'] };
      const pair = pairs[e.key.toLowerCase()];
      if (pair) { e.preventDefault(); applyFormat(pair[0], pair[1]); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [applyFormat]);

  const displayPos = linkMode ? linkPos : toolbarPos;
  if (!displayPos) return null;

  const MARK_PAIRS = {
    strong: ['**', '**'], em: ['_', '_'], strikethrough: ['~~', '~~'], code: ['`', '`'],
  } as const;

  return (
    <SelectionToolbarShell
      containerRef={toolbarRef}
      pos={displayPos}
      flyout={flyout}
      setFlyout={setFlyout}
      linkMode={linkMode}
      linkUrl={linkUrl}
      linkInputRef={linkInputRef}
      onLinkChange={setLinkUrl}
      onLinkApply={applyLink}
      onLinkCancel={cancelLink}
      onLinkTrigger={enterLinkMode}
      onMark={(name) => { const [o, c] = MARK_PAIRS[name]; applyFormat(o, c); }}
      onStyle={applyStyle}
    />
  );
}
// ---------------------------------------------------------------------------
// Mood picker
// ---------------------------------------------------------------------------

const MOOD_EMOJIS: Record<number, string> = { 1: '😴', 2: '😞', 3: '😐', 4: '🙂', 5: '🔥' };

interface MoodPickerProps {
  date: string;
  entry: MoodEntry | null;
  plan: Y.Map<unknown>;
}

function MoodPicker({ date, entry, plan }: MoodPickerProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [note, setNote] = useState(entry?.note ?? '');
  const btnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close on outside click (popover is in portal, so check both refs)
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const inBtn     = btnRef.current?.contains(target);
      const inPopover = popoverRef.current?.contains(target);
      if (!inBtn && !inPopover) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Sync note if entry changes externally
  useEffect(() => { setNote(entry?.note ?? ''); }, [entry?.note]);

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      // Anchor to bottom-right of the button, fixed to viewport
      setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setOpen((o) => !o);
  };

  /**
   * Mirror mood to backend SQL (fire-and-forget).
   * Yjs is source of truth for UI; SQL is the analytics store for range queries.
   * The backend upserts by (user_id, date) — the id field is used only on insert.
   */
  const syncMood = useCallback((energy: MoodEntry['energy'], noteText: string | undefined) => {
    void apiFetch('/analytics/mood', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: crypto.randomUUID(),
        date,
        energy,
        note: noteText ?? null,
      }),
    }).catch(() => { /* offline — Yjs copy survives; will sync next time */ });
  }, [date]);

  const handleSelect = useCallback((score: MoodEntry['energy']) => {
    const noteText = note.trim() || undefined;
    setMoodForDate(plan, date, score, noteText);
    syncMood(score, noteText);
    setOpen(false);
  }, [plan, date, note, syncMood]);

  const popover = open && pos && createPortal(
    <div
      ref={popoverRef}
      className="mood-picker__popover"
      style={{ top: pos.top, right: pos.right }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mood-picker__emojis">
        {([1, 2, 3, 4, 5] as const).map((score) => (
          <button
            key={score}
            type="button"
            className={`mood-picker__emoji-btn${entry?.energy === score ? ' mood-picker__emoji-btn--active' : ''}`}
            onClick={() => handleSelect(score)}
            title={`${score}/5`}
          >
            {MOOD_EMOJIS[score]}
          </button>
        ))}
      </div>
      <input
        className="mood-picker__note"
        placeholder="Note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && entry) {
            const noteText = note.trim() || undefined;
            setMoodForDate(plan, date, entry.energy, noteText);
            syncMood(entry.energy, noteText);
            setOpen(false);
          }
          if (e.key === 'Escape') setOpen(false);
        }}
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
  );

  return (
    <div className="mood-picker">
      <button
        ref={btnRef}
        type="button"
        className={`mood-picker__icon${entry ? ' mood-picker__icon--set' : ''}`}
        onClick={handleToggle}
        title={entry ? `Mood: ${entry.energy}/5${entry.note ? ` — ${entry.note}` : ''}` : 'Log mood'}
      >
        {entry ? MOOD_EMOJIS[entry.energy] : '○'}
      </button>
      {popover}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Day column
// ---------------------------------------------------------------------------

interface MoneyRowProps {
  entry: MoneyEntryData;
  onDelete: () => void;
}

/**
 * One money line. Three visual states, and the distinction matters:
 *   - never parsed yet (parsedFrom === null) → the text, and "reading…"
 *   - parsed, no amount found                → amber warning, NO number shown
 *   - parsed with an amount                  → signed amount, red or green
 *
 * The middle state is the point. A parser that guesses gives you a figure you
 * will believe, so when the model finds no amount the line keeps the raw text
 * and says so, rather than falling back to zero.
 */
function MoneyRow({ entry, onDelete }: MoneyRowProps) {
  const { t } = useTranslation();
  const pending = entry.parsedFrom !== entry.text;
  const flagged = !pending && entry.amount === null;
  // `entry.category` is the stored identifier ('Food & Drink'); what the user
  // reads comes from the locale file.
  const category = entry.category ? moneyCategoryLabel(t, entry.category) : undefined;

  return (
    <div className={`weekly-money${flagged ? ' weekly-money--flagged' : ''}`}>
      <span className="weekly-money__label" title={category}>
        {entry.text}
      </span>
      {pending ? (
        <span className="weekly-money__pending">{t('weekly.parsing')}</span>
      ) : flagged ? (
        <span className="weekly-money__warn" title={t('weekly.needsAmountHint')}>
          ⚠ {t('weekly.needsAmount')}
        </span>
      ) : (
        <span
          className={`weekly-money__amount weekly-money__amount--${entry.amount! < 0 ? 'out' : 'in'}`}
        >
          {formatDong(entry.amount!)}
        </span>
      )}
      <button type="button" className="weekly-money__del" onClick={onDelete} title="Delete">
        ×
      </button>
    </div>
  );
}

interface DayColumnProps {
  day: DayKey;
  date: string;
  todos: AllDays[DayKey];
  /** null = money tier off for this session (guest — see WeeklyPlannerCell). */
  money: MoneyEntryData[] | null;
  isToday: boolean;
  ydoc: Y.Doc;
  plan: Y.Map<unknown>;
  weekStart: string;
  moodEntry: MoodEntry | null;
}

function DayColumn({ day, date, todos, money, isToday, ydoc, plan, weekStart, moodEntry }: DayColumnProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [moneyInput, setMoneyInput] = useState('');
  // Which todo is open for editing, and the uncommitted draft of its raw text.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);

  /** Grow the box to fit its content, so no part of a long todo is hidden. */
  const fitToContent = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

  useEffect(() => {
    if (!editingId) return;
    const el = editRef.current;
    if (!el) return;
    fitToContent(el);
    el.focus();
    // Caret at the end rather than selecting everything: a full selection means
    // the next keystroke wipes the todo, which is alarming when the point was
    // to fix one word.
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editingId]);

  const startEdit = (todo: TodoData) => {
    // The raw source, not the rendered HTML: what you edit is what is stored,
    // markers and all, which is the same string formatTodoText works on.
    setDraft(todo.text);
    setEditingId(todo.id);
  };

  const commitEdit = () => {
    if (editingId) updateTodoText(plan, weekStart, day, editingId, draft);
    setEditingId(null);
  };

  const handleEditKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    // Enter saves rather than inserting a newline: a todo is one line of text,
    // and the renderer has no notion of a line break inside one.
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(); return; }
    // Escape drops the draft; blur saves. This is the only way out that discards.
    if (e.key === 'Escape') setEditingId(null);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter' && input.trim()) {
      addTodo(plan, weekStart, day, input);
      setInput('');
    }
  };

  const handleMoneyKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter' && moneyInput.trim()) {
      // The line lands in Yjs immediately and renders as pending; useMoneySync
      // notices and fills in the numbers. Typing never waits on the network.
      addMoneyEntry(ydoc, date, moneyInput);
      setMoneyInput('');
    }
  };

  const handleMoneyDelete = useCallback((id: string) => {
    deleteMoneyEntry(ydoc, id);
    // Drop the SQL projection too, or the entry keeps counting toward monthly
    // totals and the debt ledger after it has left the document.
    void apiFetch(`/money/entries/${encodeURIComponent(id)}`, { method: 'DELETE' })
      .catch(() => { /* offline — a later parse of the surviving lines is still correct */ });
  }, [ydoc]);

  // Recomputed every render, never stored: two devices each adding to a saved
  // total would be permanently wrong with no way to tell afterwards.
  const total = moneyTotal(money ?? []);
  const known = (money ?? []).filter((e) => e.amount !== null).length;
  // A day whose lines are all still pending would otherwise total "+0", which
  // reads as "spent nothing today" — a confident wrong number, the exact thing
  // the flagged state exists to avoid. Show nothing until something is known,
  // and mark the figure as partial while any line is still unaccounted for.
  const totalIsPartial = known < (money?.length ?? 0);

  // Weekends read differently at a glance, so the shape of the week is visible
  // without reading a single label.
  const isWeekend = day === 'sat' || day === 'sun';

  return (
    <div
      className={
        `weekly-day${isToday ? ' weekly-day--today' : ''}${isWeekend ? ' weekly-day--weekend' : ''}`
      }
    >
      <div className="weekly-day__header">
        <span>{DAY_LABELS[day]}</span>
        <MoodPicker date={date} entry={moodEntry} plan={plan} />
      </div>
      <div className="weekly-day__todos">
        {todos.map((todo) => (
          <div key={todo.id} className="weekly-todo">
            <input
              type="checkbox"
              className="weekly-todo__check"
              checked={todo.done}
              onChange={() => toggleTodo(plan, weekStart, day, todo.id)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            {editingId === todo.id ? (
              // A textarea, not an input: it grows to fit, so a long todo is
              // fully visible while being edited instead of scrolling inside a
              // one-line box.
              <textarea
                ref={editRef}
                rows={1}
                className="weekly-todo__edit"
                value={draft}
                onChange={(e) => { setDraft(e.target.value); fitToContent(e.target); }}
                onKeyDown={handleEditKeyDown}
                onBlur={commitEdit}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                data-todo-id={todo.id}
                data-day={day}
                className={`weekly-todo__text${todo.done ? ' weekly-todo__text--done' : ''}`}
                dangerouslySetInnerHTML={{ __html: renderMd(todo.text) }}
              />
            )}
            {editingId !== todo.id && (
              <button
                type="button"
                className="weekly-todo__act"
                // A visible button, not a double-click: a hidden gesture is one
                // nobody discovers, and here it also competes with the click
                // people use to select text for the formatting toolbar.
                // onMouseDown, so the button wins before the span's selection.
                onMouseDown={(e) => { e.preventDefault(); startEdit(todo); }}
                title={t('weekly.editTodo')}
              >
                ✎
              </button>
            )}
            <button
              type="button"
              className="weekly-todo__act weekly-todo__del"
              onClick={() => deleteTodo(plan, weekStart, day, todo.id)}
              title={t('weekly.deleteTodo')}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <input
        ref={inputRef}
        className="weekly-day__input"
        placeholder={t('weekly.add')}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
      />
      {money !== null && (
      <div className="weekly-day__money">
        {money.map((entry) => (
          <MoneyRow key={entry.id} entry={entry} onDelete={() => handleMoneyDelete(entry.id)} />
        ))}
        {known > 0 && (
          <div
            className="weekly-money__total"
            title={totalIsPartial ? t('weekly.partialTotal') : undefined}
          >
            <span>{t('weekly.dayTotal')}</span>
            <span className={`weekly-money__amount--${total < 0 ? 'out' : 'in'}`}>
              {formatDong(total)}{totalIsPartial ? '…' : ''}
            </span>
          </div>
        )}
        <input
          className="weekly-day__input weekly-day__input--money"
          placeholder={t('weekly.addMoney')}
          value={moneyInput}
          onChange={(e) => setMoneyInput(e.target.value)}
          onKeyDown={handleMoneyKeyDown}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Debt ledger
// ---------------------------------------------------------------------------

interface LedgerRow {
  counterparty: string;
  borrowed: number;
  repaid: number;
  balance: number;
}

/**
 * Per-person balance, always fetched — never accumulated client-side.
 *
 * `signature` changes only when a debt-bearing line changes, so editing todos
 * (by far the more common planner activity) never triggers a refetch.
 * Settled people are dropped by the backend, so an empty result renders nothing
 * rather than a row of zeroes.
 */
function DebtLedger({ signature }: { signature: string }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<LedgerRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/money/ledger')
      .then((res) => res.json())
      .then((data: LedgerRow[]) => { if (!cancelled) setRows(data); })
      .catch(() => { /* guest or offline — panel stays hidden */ });
    return () => { cancelled = true; };
  }, [signature]);

  if (rows.length === 0) return null;

  return (
    <div className="weekly-ledger">
      <div className="weekly-ledger__title">{t('weekly.ledger')}</div>
      {rows.map((row) => (
        <div key={row.counterparty} className="weekly-ledger__row">
          <span className="weekly-ledger__who">{row.counterparty}</span>
          <span className="weekly-ledger__detail">
            {`${row.borrowed.toLocaleString('vi-VN')} ${t('weekly.ledgerBorrowed')} · ${row.repaid.toLocaleString('vi-VN')} ${t('weekly.ledgerRepaid')}`}
          </span>
          <span
            className={`weekly-ledger__balance weekly-ledger__balance--${row.balance > 0 ? 'owe' : 'owed'}`}
          >
            {row.balance > 0
              ? row.balance.toLocaleString('vi-VN')
              : `${t('weekly.ledgerOwed')} ${Math.abs(row.balance).toLocaleString('vi-VN')}`}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

interface Props {
  ydoc: Y.Doc;
  onDelete: () => void;
  /**
   * Guests have no backend session, so useMoneySync is disabled for them and no
   * line would ever be parsed. The whole money tier is hidden rather than shown
   * inert: an input that only ever produces lines stuck on "reading…", with no
   * amount, no day total and no ledger, is worse than not offering it.
   */
  isGuest: boolean;
}

export function WeeklyPlannerCell({ ydoc, onDelete, isGuest }: Props) {
  const { t } = useTranslation();
  // All planner cells render the one shared plan inside the planner Y.Doc.
  const [plan, setPlan] = useState<Y.Map<unknown>>(() => getWeeklyPlan(ydoc, SHARED_PLAN_ID));
  const [weekStart, setWeekStartState] = useState<string>(() => plan.get('weekStart') as string);
  const [days, setDays] = useState<AllDays>(() => readAllDays(plan, plan.get('weekStart') as string));
  const [moodLog, setMoodLog] = useState<Record<string, MoodEntry>>(() => readMoodLog(plan));
  const [moneyLog, setMoneyLog] = useState<Record<string, MoneyEntryData[]>>(() => readMoneyLog(ydoc));
  const [editingWeek, setEditingWeek] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const todayKey = todayDayKey(weekStart);

  // A late server merge can replace the shared entry wholesale (Y.Map
  // same-key conflict — e.g. this client created a fresh plan while offline and
  // the server's copy won the merge). The losing instance goes dead and stops
  // emitting events, so watch the top-level plans map and re-resolve to always
  // hold the live instance.
  useEffect(() => {
    const plans = ydoc.getMap<Y.Map<unknown>>(WEEKLY_PLANS_KEY);
    const handler = () => {
      const current = plans.get(SHARED_PLAN_ID);
      if (current && current !== plan) setPlan(current);
    };
    plans.observe(handler);
    return () => plans.unobserve(handler);
  }, [ydoc, plan]);

  useEffect(() => {
    const handler = () => {
      const ws = plan.get('weekStart') as string;
      setWeekStartState(ws);
      setDays(readAllDays(plan, ws));
      setMoodLog(readMoodLog(plan));
    };
    plan.observeDeep(handler);
    // Re-read immediately: `plan` may have just been swapped to the live
    // instance (see the re-resolve effect above), or changed before subscribing.
    handler();
    return () => plan.unobserveDeep(handler);
  }, [plan]);

  // Money lives in its own top-level map, not under the plan, so it needs its
  // own subscription — and gets one that todo edits never wake.
  useEffect(() => {
    const entries = ydoc.getMap(MONEY_LOG_KEY);
    const handler = () => setMoneyLog(readMoneyLog(ydoc));
    entries.observeDeep(handler);
    handler();
    return () => entries.unobserveDeep(handler);
  }, [ydoc]);

  // Only debt-bearing lines can move a ledger balance, so the panel refetches
  // when one of those changes and stays quiet through ordinary edits.
  const ledgerSignature = useMemo(
    () => Object.values(moneyLog)
      .flat()
      .filter((e) => e.debtDelta !== 0)
      .map((e) => `${e.id}:${e.debtDelta}:${e.counterparty ?? ''}`)
      .join('|'),
    [moneyLog],
  );

  // When the date field opens, focus it and try to pop the native picker
  // (visible input → showPicker is reliable; falls back to plain focus).
  useEffect(() => {
    if (!editingWeek) return;
    const el = dateRef.current;
    if (!el) return;
    el.focus();
    try { el.showPicker?.(); } catch { /* unsupported — input is still usable */ }
  }, [editingWeek]);

  return (
    <div className="weekly-cell" ref={containerRef}>
      <div className="weekly-cell__header">
        <div className="weekly-cell__weeknav">
          <button
            type="button"
            className="weekly-cell__weekbtn"
            onClick={() => shiftWeek(plan, -1)}
            title={t('weekly.prevWeek')}
          >
            ‹
          </button>
          {editingWeek ? (
            <input
              ref={dateRef}
              type="date"
              className="weekly-cell__dateedit"
              value={weekStart}
              onChange={(e) => {
                if (e.target.value) setWeekStart(plan, e.target.value);
                setEditingWeek(false);
              }}
              onBlur={() => setEditingWeek(false)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' || e.key === 'Enter') setEditingWeek(false);
              }}
            />
          ) : (
            <button
              type="button"
              className="weekly-cell__title"
              onClick={() => setEditingWeek(true)}
              title={t('weekly.changeWeek')}
            >
              📅 {weekRangeLabel(weekStart)}
            </button>
          )}
          <button
            type="button"
            className="weekly-cell__weekbtn"
            onClick={() => shiftWeek(plan, 1)}
            title={t('weekly.nextWeek')}
          >
            ›
          </button>
        </div>
        <button
          type="button"
          className="weekly-cell__delete"
          onClick={onDelete}
          title={t('weekly.deleteCell')}
        >
          ×
        </button>
      </div>
      <div className="weekly-cell__grid">
        {DAY_KEYS.map((day) => {
          const date = dayToDate(weekStart, day);
          return (
            <DayColumn
              key={day}
              day={day}
              date={date}
              todos={days[day]}
              money={isGuest ? null : (moneyLog[date] ?? [])}
              isToday={todayKey === day}
              ydoc={ydoc}
              plan={plan}
              weekStart={weekStart}
              moodEntry={moodLog[date] ?? null}
            />
          );
        })}
      </div>
      {!isGuest && <DebtLedger signature={ledgerSignature} />}
      <WeeklySelectionToolbar containerRef={containerRef} plan={plan} weekStart={weekStart} />
    </div>
  );
}
