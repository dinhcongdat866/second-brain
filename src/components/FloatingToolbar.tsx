import { useState, useEffect, useRef, useCallback } from 'react';
import type { EditorView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
import { toggleMark } from 'prosemirror-commands';
import { notebookSchema } from '../schema';
import { subscribeToSelection } from '../plugins/selectionPlugin';
import { ColorPalette, SizePicker } from './ToolbarPickers';
import { TEXT_COLORS, BG_COLORS, FONT_SIZES } from '../lib/toolbarStyles';

// Atom NodeView containers — clicks here won't update PM selection.
const ATOM_CELL_SELECTOR = '.weekly-cell-wrapper, .ai-cell';

const PROTECTED = new Set(['ai_cell', 'weekly_planner_cell']);

type Flyout = 'text' | 'bg' | 'size' | null;
interface ActiveStyles { color: string | null; bg: string | null; size: string | null; }

/** Reads the attr value of a mark covering the current selection (or null). */
function getMarkAttr(view: EditorView, markName: string, attrKey: string): string | null {
  const markType = notebookSchema.marks[markName];
  if (!markType) return null;
  const { from, to } = view.state.selection;
  let val: string | null = null;
  view.state.doc.nodesBetween(from, to, (node) => {
    const m = node.marks.find((mk) => mk.type === markType);
    if (m) val = m.attrs[attrKey] as string;
  });
  return val;
}

function isMarkActive(view: EditorView, markName: string): boolean {
  const markType = notebookSchema.marks[markName];
  if (!markType) return false;
  const { from, $from, to, empty } = view.state.selection;
  if (empty) return !!markType.isInSet(view.state.storedMarks || $from.marks());
  return view.state.doc.rangeHasMark(from, to, markType);
}

function getExistingHref(view: EditorView): string {
  const { from, to } = view.state.selection;
  let href = '';
  view.state.doc.nodesBetween(from, to, (node) => {
    const m = node.marks.find((mk) => mk.type.name === 'link');
    if (m) href = m.attrs.href as string;
  });
  return href;
}

export function FloatingToolbar({ view }: { view: EditorView | null }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [activeMarks, setActiveMarks] = useState<Set<string>>(new Set());
  const [activeStyles, setActiveStyles] = useState<ActiveStyles>({ color: null, bg: null, size: null });
  const [flyout, setFlyout] = useState<Flyout>(null);
  const [linkMode, setLinkMode] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const linkInputRef = useRef<HTMLInputElement>(null);
  const linkModeRef = useRef(false);
  const savedRange = useRef<{ from: number; to: number } | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // Once the user clicks away, suppress re-showing until a fresh in-editor
  // selection. PM keeps the old (non-empty) selection when the click lands
  // outside editable text, so without this the next view update re-opens it.
  const dismissedRef = useRef(false);

  const exitLinkMode = useCallback(() => {
    linkModeRef.current = false;
    setLinkMode(false);
    setLinkUrl('');
    savedRange.current = null;
    setFlyout(null);
    setPos(null);
  }, []);

  const enterLinkMode = useCallback((v: EditorView) => {
    savedRange.current = { from: v.state.selection.from, to: v.state.selection.to };
    setLinkUrl(getExistingHref(v));
    linkModeRef.current = true;
    setFlyout(null);
    setLinkMode(true);
  }, []);

  // Any mousedown outside the toolbar dismisses it. A mousedown inside
  // editable text re-arms it (a new selection may follow); anything else
  // (atom cells, app chrome, outside the editor) hides it until then.
  useEffect(() => {
    if (!view) return;
    const handle = (e: MouseEvent) => {
      // Click inside the toolbar itself — don't hide.
      if (toolbarRef.current?.contains(e.target as Node)) return;

      const target = e.target as Element;
      const inEditableText =
        view.dom.contains(target) && !target.closest?.(ATOM_CELL_SELECTOR);

      if (inEditableText) {
        // Fresh selection may begin here — let PM's selection update decide.
        dismissedRef.current = false;
        return;
      }

      clearTimeout(showTimer.current);
      dismissedRef.current = true;
      setFlyout(null);
      setPos(null);
      exitLinkMode();
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [view, exitLinkMode]);

  useEffect(() => {
    if (!view) return;
    return subscribeToSelection((v) => {
      const { selection } = v.state;

      if (!(selection instanceof TextSelection) || selection.empty) {
        if (!linkModeRef.current) {
          clearTimeout(showTimer.current);
          setFlyout(null);
          setPos(null);
        }
        return;
      }

      // Dismissed by an outside click — stay hidden until a fresh selection.
      if (dismissedRef.current) {
        clearTimeout(showTimer.current);
        return;
      }

      // Hide inside atom cells.
      const { $from } = selection;
      for (let d = $from.depth; d >= 0; d--) {
        if (PROTECTED.has($from.node(d).type.name)) {
          clearTimeout(showTimer.current);
          setPos(null);
          return;
        }
      }

      const startCoords = v.coordsAtPos(selection.from);
      const endCoords   = v.coordsAtPos(selection.to);
      const left = (startCoords.left + endCoords.right) / 2;
      const top  = startCoords.top;

      const marks = new Set<string>();
      for (const name of ['strong', 'em', 'strikethrough', 'code', 'link']) {
        if (isMarkActive(v, name)) marks.add(name);
      }
      const styles: ActiveStyles = {
        color: getMarkAttr(v, 'text_color', 'color'),
        bg: getMarkAttr(v, 'bg_color', 'color'),
        size: getMarkAttr(v, 'font_size', 'size'),
      };

      clearTimeout(showTimer.current);
      showTimer.current = setTimeout(() => {
        setPos({ left, top });
        setActiveMarks(marks);
        setActiveStyles(styles);
      }, 220);
    });
  }, [view]);

  useEffect(() => {
    if (linkMode) linkInputRef.current?.focus();
  }, [linkMode]);

  useEffect(() => () => clearTimeout(showTimer.current), []);

  const applyMark = useCallback((markName: string) => {
    if (!view) return;
    const markType = notebookSchema.marks[markName];
    if (!markType) return;
    toggleMark(markType)(view.state, view.dispatch);
    view.focus();
  }, [view]);

  // Set/replace (or clear, when attrs is null) an attribute-carrying style mark
  // over the current selection.
  const applyStyleMark = useCallback((markName: string, attrs: Record<string, string> | null) => {
    if (!view) return;
    const markType = notebookSchema.marks[markName];
    if (!markType) return;
    const { from, to, empty } = view.state.selection;
    if (empty) return;
    const tr = view.state.tr.removeMark(from, to, markType);
    if (attrs) tr.addMark(from, to, markType.create(attrs));
    view.dispatch(tr);
    setFlyout(null);
    view.focus();
  }, [view]);

  const applyLink = useCallback(() => {
    if (!view) return;
    const raw = linkUrl.trim();
    if (!raw) return;
    const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const range = savedRange.current ?? { from: view.state.selection.from, to: view.state.selection.to };
    const markType = notebookSchema.marks.link;
    view.dispatch(view.state.tr.addMark(range.from, range.to, markType.create({ href })));
    exitLinkMode();
    view.focus();
  }, [view, linkUrl, exitLinkMode]);

  if (!view || !pos) return null;

  return (
    <div
      ref={toolbarRef}
      className="floating-toolbar"
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {linkMode ? (
        <div className="ftb__link-row">
          <input
            ref={linkInputRef}
            className="ftb__link-input"
            placeholder="https://..."
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
              if (e.key === 'Escape') { e.preventDefault(); exitLinkMode(); view.focus(); }
            }}
          />
          <button className="ftb__btn" onMouseDown={(e) => e.preventDefault()} onClick={applyLink} title="Apply">↵</button>
        </div>
      ) : (
        <>
          <button className={`ftb__btn${activeMarks.has('strong') ? ' ftb__btn--on' : ''}`} onClick={() => applyMark('strong')} title="Bold (Ctrl+B)"><b>B</b></button>
          <button className={`ftb__btn${activeMarks.has('em') ? ' ftb__btn--on' : ''}`} onClick={() => applyMark('em')} title="Italic (Ctrl+I)"><i>I</i></button>
          <button className={`ftb__btn${activeMarks.has('strikethrough') ? ' ftb__btn--on' : ''}`} onClick={() => applyMark('strikethrough')} title="Strikethrough"><s>S</s></button>
          <button className={`ftb__btn${activeMarks.has('code') ? ' ftb__btn--on' : ''}`} onClick={() => applyMark('code')} title="Inline code (Ctrl+E)"><code>{`</>`}</code></button>
          <div className="ftb__sep" />
          <button
            className={`ftb__btn${activeMarks.has('link') ? ' ftb__btn--on' : ''}`}
            onClick={() => activeMarks.has('link') ? applyMark('link') : enterLinkMode(view)}
            title="Link"
          >⌖</button>
          <div className="ftb__sep" />
          <button
            className={`ftb__btn${flyout === 'text' ? ' ftb__btn--on' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setFlyout((f) => (f === 'text' ? null : 'text'))}
            title="Text color"
          ><span className="ftb__ico" style={{ borderBottom: `2px solid ${activeStyles.color ?? 'currentColor'}` }}>A</span></button>
          <button
            className={`ftb__btn${flyout === 'bg' ? ' ftb__btn--on' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setFlyout((f) => (f === 'bg' ? null : 'bg'))}
            title="Highlight"
          ><span className="ftb__ico" style={{ background: activeStyles.bg ?? undefined, borderRadius: 2, padding: '0 2px' }}>A</span></button>
          <button
            className={`ftb__btn${flyout === 'size' ? ' ftb__btn--on' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setFlyout((f) => (f === 'size' ? null : 'size'))}
            title="Font size"
          >A↕</button>

          {flyout === 'text' && (
            <ColorPalette swatches={TEXT_COLORS} active={activeStyles.color} onPick={(v) => applyStyleMark('text_color', v ? { color: v } : null)} />
          )}
          {flyout === 'bg' && (
            <ColorPalette swatches={BG_COLORS} active={activeStyles.bg} onPick={(v) => applyStyleMark('bg_color', v ? { color: v } : null)} />
          )}
          {flyout === 'size' && (
            <SizePicker swatches={FONT_SIZES} active={activeStyles.size} onPick={(v) => applyStyleMark('font_size', v ? { size: v } : null)} />
          )}
        </>
      )}
    </div>
  );
}
