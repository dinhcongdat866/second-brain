import { useState, useEffect, useRef, useCallback, type KeyboardEvent } from 'react';
import type * as Y from 'yjs';
import {
  DAY_KEYS,
  DAY_LABELS,
  type DayKey,
  type AllDays,
  addTodo,
  toggleTodo,
  deleteTodo,
  formatTodoText,
  clearTodoStyle,
  readAllDays,
  weekRangeLabel,
  todayDayKey,
  setWeekStart,
  shiftWeek,
} from '../collab/weeklyPlans';
import {
  weeklyOpen,
  weeklyClose,
  renderStyleMarkers,
  type StyleKind,
} from '../lib/toolbarStyles';
import { SelectionToolbarShell } from '../components/SelectionToolbarShell';

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
}

function WeeklySelectionToolbar({ containerRef, plan }: WeeklySelectionToolbarProps) {
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
    formatTodoText(plan, day, todoId, start, end, open, close);
    savedFormatRef.current = null;
    window.getSelection()?.removeAllRanges();
    setFlyout(null);
    setToolbarPos(null);
  }, [plan]);

  const applyStyle = useCallback((kind: StyleKind, value: string | null) => {
    if (!savedFormatRef.current) return;
    const { todoId, day, start, end } = savedFormatRef.current;
    // Strip any existing marker of this kind first so re-applying replaces it
    // instead of nesting {c=..}{c=..} (which the renderer can't parse).
    clearTodoStyle(plan, day, todoId, start, end, kind);
    if (value) formatTodoText(plan, day, todoId, start, end, weeklyOpen(kind, value), weeklyClose(kind));
    savedFormatRef.current = null;
    window.getSelection()?.removeAllRanges();
    setFlyout(null);
    setToolbarPos(null);
  }, [plan]);

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
    formatTodoText(plan, day, todoId, start, end, '[', `](${href})`);
    linkModeRef.current = false;
    setLinkMode(false);
    setLinkUrl('');
    savedLink.current = null;
    setLinkPos(null);
    setToolbarPos(null);
  }, [plan, linkUrl]);

  const cancelLink = useCallback(() => {
    linkModeRef.current = false;
    setLinkMode(false);
    setLinkUrl('');
    savedLink.current = null;
    setLinkPos(null);
    setToolbarPos(null);
  }, []);

  const displayPos = linkMode ? linkPos : toolbarPos;
  if (!displayPos) return null;

  const MARK_PAIRS = {
    strong: ['**', '**'], em: ['_', '_'], strikethrough: ['~~', '~~'], code: ['`', '`'],
  } as const;

  return (
    <SelectionToolbarShell
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
// Day column
// ---------------------------------------------------------------------------

interface DayColumnProps {
  day: DayKey;
  todos: AllDays[DayKey];
  isToday: boolean;
  plan: Y.Map<unknown>;
}

function DayColumn({ day, todos, isToday, plan }: DayColumnProps) {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter' && input.trim()) {
      addTodo(plan, day, input);
      setInput('');
    }
  };

  return (
    <div className={`weekly-day${isToday ? ' weekly-day--today' : ''}`}>
      <div className="weekly-day__header">{DAY_LABELS[day]}</div>
      <div className="weekly-day__todos">
        {todos.map((todo) => (
          <div key={todo.id} className="weekly-todo">
            <input
              type="checkbox"
              className="weekly-todo__check"
              checked={todo.done}
              onChange={() => toggleTodo(plan, day, todo.id)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <span
              data-todo-id={todo.id}
              data-day={day}
              className={`weekly-todo__text${todo.done ? ' weekly-todo__text--done' : ''}`}
              dangerouslySetInnerHTML={{ __html: renderMd(todo.text) }}
            />
            <button
              type="button"
              className="weekly-todo__del"
              onClick={() => deleteTodo(plan, day, todo.id)}
              title="Delete"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <input
        ref={inputRef}
        className="weekly-day__input"
        placeholder="Add…"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

interface Props {
  plan: Y.Map<unknown>;
  onDelete: () => void;
}

export function WeeklyPlannerCell({ plan, onDelete }: Props) {
  const [days, setDays] = useState<AllDays>(() => readAllDays(plan));
  const [weekStart, setWeekStartState] = useState<string>(() => plan.get('weekStart') as string);
  const [editingWeek, setEditingWeek] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const todayKey = todayDayKey(weekStart);

  useEffect(() => {
    const handler = () => {
      setDays(readAllDays(plan));
      setWeekStartState(plan.get('weekStart') as string);
    };
    plan.observeDeep(handler);
    return () => plan.unobserveDeep(handler);
  }, [plan]);

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
            title="Tuần trước"
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
              title="Đổi tuần"
            >
              📅 {weekRangeLabel(weekStart)}
            </button>
          )}
          <button
            type="button"
            className="weekly-cell__weekbtn"
            onClick={() => shiftWeek(plan, 1)}
            title="Tuần sau"
          >
            ›
          </button>
        </div>
        <button
          type="button"
          className="weekly-cell__delete"
          onClick={onDelete}
          title="Delete cell"
        >
          ×
        </button>
      </div>
      <div className="weekly-cell__grid">
        {DAY_KEYS.map((day) => (
          <DayColumn
            key={day}
            day={day}
            todos={days[day]}
            isToday={todayKey === day}
            plan={plan}
          />
        ))}
      </div>
      <WeeklySelectionToolbar containerRef={containerRef} plan={plan} />
    </div>
  );
}
