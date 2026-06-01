import { useState, useEffect, useRef, useCallback } from 'react';
import type { EditorView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
import { toggleMark } from 'prosemirror-commands';
import { notebookSchema } from '../schema';
import { subscribeToSelection } from '../plugins/selectionPlugin';

// Atom NodeView containers — clicks here won't update PM selection.
const ATOM_CELL_SELECTOR = '.weekly-cell-wrapper, .ai-cell';

const PROTECTED = new Set(['ai_cell', 'weekly_planner_cell']);

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
    setPos(null);
  }, []);

  const enterLinkMode = useCallback((v: EditorView) => {
    savedRange.current = { from: v.state.selection.from, to: v.state.selection.to };
    setLinkUrl(getExistingHref(v));
    linkModeRef.current = true;
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

      clearTimeout(showTimer.current);
      showTimer.current = setTimeout(() => {
        setPos({ left, top });
        setActiveMarks(marks);
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
        </>
      )}
    </div>
  );
}
