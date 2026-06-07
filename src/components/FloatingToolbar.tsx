import { useState, useEffect, useRef, useCallback } from 'react';
import type { EditorView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
import { toggleMark } from 'prosemirror-commands';
import { notebookSchema } from '../schema';
import { subscribeToSelection } from '../plugins/selectionPlugin';
import { SelectionToolbarShell, type ActiveStyles, type ToolbarFlyout } from './SelectionToolbarShell';
import type { StyleKind } from '../lib/toolbarStyles';

// Atom NodeView containers — clicks here won't update PM selection.
const ATOM_CELL_SELECTOR = '.weekly-cell-wrapper, .ai-cell';

const PROTECTED = new Set(['ai_cell', 'weekly_planner_cell']);

const STYLE_MARK: Record<StyleKind, { mark: string; attr: string }> = {
  color: { mark: 'text_color', attr: 'color' },
  bg:    { mark: 'bg_color',   attr: 'color' },
  size:  { mark: 'font_size',  attr: 'size' },
};

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
  const [flyout, setFlyout] = useState<ToolbarFlyout>(null);
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

      // Defer all DOM-querying work into the debounce window so that rapid
      // drag-selection doesn't block the main thread with layout reflows.
      clearTimeout(showTimer.current);
      showTimer.current = setTimeout(() => {
        if (dismissedRef.current) return;
        const { selection: currentSel } = v.state;
        if (!(currentSel instanceof TextSelection) || currentSel.empty) return;

        const startCoords = v.coordsAtPos(currentSel.from);
        const endCoords   = v.coordsAtPos(currentSel.to);
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

  const applyStyle = useCallback((kind: StyleKind, value: string | null) => {
    const { mark, attr } = STYLE_MARK[kind];
    applyStyleMark(mark, value ? { [attr]: value } : null);
  }, [applyStyleMark]);

  if (!view || !pos) return null;

  return (
    <SelectionToolbarShell
      containerRef={toolbarRef}
      pos={pos}
      activeMarks={activeMarks}
      activeStyles={activeStyles}
      flyout={flyout}
      setFlyout={setFlyout}
      linkMode={linkMode}
      linkUrl={linkUrl}
      linkInputRef={linkInputRef}
      onLinkChange={setLinkUrl}
      onLinkApply={applyLink}
      onLinkCancel={() => { exitLinkMode(); view.focus(); }}
      onLinkTrigger={() => (activeMarks.has('link') ? applyMark('link') : enterLinkMode(view))}
      onMark={applyMark}
      onStyle={applyStyle}
    />
  );
}
