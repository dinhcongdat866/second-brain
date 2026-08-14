import { useRef, useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type * as Y from 'yjs';
import type { EditorView } from 'prosemirror-view';

import { appendMarkdownCell, makeAppendAiCell, makeAppendWeeklyCell, makeAppendMoneyCell } from './commands';
import { BackgroundPicker } from './components/BackgroundPicker';
import { Button } from './components/Button';
import { Icon } from './components/Icon';
import { FloatingToolbar } from './components/FloatingToolbar';
import { Sidebar } from './components/Sidebar';
import { SlashMenu } from './components/SlashMenu';
import { SnapshotModal } from './components/SnapshotModal';
import { useDocRegistry, useGuestDocRegistry } from './hooks/useDocRegistry';
import { useMemory } from './hooks/useMemory';
import { useNotebookEditor } from './hooks/useNotebookEditor';
import { useAuthStore } from './stores/authStore';
import { GuestBanner } from './components/GuestBanner';
import { usePresence } from './hooks/usePresence';
import { exportDocToMarkdown, saveMarkdownFile } from './lib/exportMarkdown';
import { importMarkdownAsNewDoc } from './lib/importMarkdown';
import { useUIStore } from './stores/uiStore';
import { AiReportPage } from './components/AiReportPage';
import { useAnalyticsContext } from './hooks/useAnalyticsContext';
import { useClassificationSync } from './hooks/useClassificationSync';
import { useMoneySync } from './hooks/useMoneySync';
import { usePlannerYdoc } from './hooks/usePlannerYdoc';
import './styles/main.css';

// ---------------------------------------------------------------------------
// Editor width — user-set, persisted
// ---------------------------------------------------------------------------

const EDITOR_WIDTH_KEY = 'editorWidth';
/** Comfortable measure for prose; the width the editor has always had. */
const DEFAULT_EDITOR_WIDTH = 960;
/** Below this, prose is cramped and the weekly grid folds to two per row anyway. */
const MIN_EDITOR_WIDTH = 520;

function readStoredEditorWidth(): number {
  try {
    const stored = Number(localStorage.getItem(EDITOR_WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= MIN_EDITOR_WIDTH) return stored;
  } catch { /* private mode — fall through to the default */ }
  return DEFAULT_EDITOR_WIDTH;
}

/**
 * The rare actions, one click behind a "…" — import and export.
 *
 * Frequency should decide prominence. These two were sitting in the header as
 * full-width text buttons next to controls used every session, which is how a
 * toolbar ends up looking crowded without being useful.
 */
function OverflowMenu({
  onImport,
  onExport,
  exportDisabled,
}: {
  onImport: () => void;
  onExport: () => void | Promise<void>;
  exportDisabled: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="overflow-menu" ref={ref}>
      <Button variant="icon" onClick={() => setOpen((v) => !v)} title={t('app.more')}>
        <Icon name="more" />
      </Button>
      {open && (
        <div className="overflow-menu__panel" role="menu">
          <button
            type="button"
            className="overflow-menu__item"
            role="menuitem"
            onClick={() => { setOpen(false); onImport(); }}
          >
            <Icon name="import" size={15} />
            {t('app.import')}
          </button>
          <button
            type="button"
            className="overflow-menu__item"
            role="menuitem"
            disabled={exportDisabled}
            onClick={() => { setOpen(false); void onExport(); }}
          >
            <Icon name="export" size={15} />
            {t('app.export')}
          </button>
        </div>
      )}
    </div>
  );
}

function CellAdder({
  view,
  ydoc,
  isGuest,
}: {
  view: EditorView | null;
  ydoc: Y.Doc | null;
  /** Guests have no money tier at all, so the lens over it has nothing to show. */
  isGuest: boolean;
}) {
  const { t } = useTranslation();
  if (!view || !ydoc) return null;
  return (
    <div className="cell-adder">
      <Button
        variant="ghost"
        onClick={() => { appendMarkdownCell(view.state, view.dispatch.bind(view)); view.focus(); }}
      >
        {t('cellAdder.markdown')}
      </Button>
      <Button
        variant="ghost"
        onClick={() => { makeAppendAiCell(ydoc)(view.state, view.dispatch.bind(view)); view.focus(); }}
      >
        {t('cellAdder.ai')}
      </Button>
      <Button
        variant="ghost"
        onClick={() => { makeAppendWeeklyCell(ydoc)(view.state, view.dispatch.bind(view)); view.focus(); }}
      >
        {t('cellAdder.weekly')}
      </Button>
      {!isGuest && (
        <Button
          variant="ghost"
          onClick={() => { makeAppendMoneyCell(ydoc)(view.state, view.dispatch.bind(view)); view.focus(); }}
        >
          {t('cellAdder.money')}
        </Button>
      )}
    </div>
  );
}

function App() {
  const { t } = useTranslation();
  const editorRef = useRef<HTMLDivElement>(null);
  const { status: authStatus, user } = useAuthStore();
  const isGuest = authStatus === 'guest';
  const userId = user?.id;
  const authRegistry = useDocRegistry(userId);
  const guestRegistry = useGuestDocRegistry();
  const registry = isGuest ? guestRegistry : authRegistry;
  const { getMemoryContext, appendMemory } = useMemory(isGuest ? undefined : userId);
  const { getAnalyticsContext } = useAnalyticsContext(!isGuest);
  const { ydoc: plannerYdoc, isReady: plannerReady, handle: plannerHandle } = usePlannerYdoc(userId, isGuest);
  const { view, ydoc, providerRef } = useNotebookEditor(editorRef, registry.activeDocId, isGuest, userId, getMemoryContext, appendMemory, getAnalyticsContext, plannerHandle);
  const peers = usePresence(providerRef);
  useClassificationSync(plannerYdoc, !isGuest, plannerReady);
  useMoneySync(plannerYdoc, !isGuest, plannerReady);
  const [showHistory, setShowHistory] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [editorHidden, setEditorHidden] = useState(false);
  const [resizing, setResizing] = useState(false);
  // Persisted, unlike the sidebar: this is a per-person reading preference, and
  // having to widen the editor again on every load would make it not worth using.
  const [editorWidth, setEditorWidth] = useState(readStoredEditorWidth);
  const mainRef = useRef<HTMLElement>(null);
  const saveStatus = useUIStore((s) => s.saveStatus);

  const startSidebarResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    setResizing(true);

    const onMove = (ev: MouseEvent) => {
      const next = Math.max(150, Math.min(500, startWidth + ev.clientX - startX));
      setSidebarWidth(next);
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [sidebarWidth]);

  /**
   * Drag either edge of the editor to set its width.
   *
   * `side` is which edge was grabbed. The wrap is centred, so growing it by one
   * pixel moves each edge by half — the delta is doubled so the edge stays under
   * the cursor instead of lagging behind it at half speed.
   *
   * The upper bound is the space actually available right now, measured from the
   * main column, so a wide editor can never be dragged out past the window or
   * under the sidebar.
   */
  const startEditorResize = useCallback((side: 'left' | 'right') => (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = editorWidth;
    const available = (mainRef.current?.clientWidth ?? window.innerWidth) - 32;
    setResizing(true);

    const onMove = (ev: MouseEvent) => {
      const delta = (ev.clientX - startX) * (side === 'right' ? 2 : -2);
      setEditorWidth(Math.max(MIN_EDITOR_WIDTH, Math.min(available, startWidth + delta)));
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [editorWidth]);

  /** Double-click a handle to go back to the default reading width. */
  const resetEditorWidth = useCallback(() => setEditorWidth(DEFAULT_EDITOR_WIDTH), []);

  useEffect(() => {
    try { localStorage.setItem(EDITOR_WIDTH_KEY, String(editorWidth)); } catch { /* private mode */ }
  }, [editorWidth]);

  // Reset editor visibility when switching documents.
  useEffect(() => { setEditorHidden(false); }, [registry.activeDocId]);

  // Bump updatedAt in the registry whenever the active doc's content changes.
  useEffect(() => {
    if (!ydoc) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handler = () => {
      clearTimeout(timer);
      timer = setTimeout(() => registry.touchDoc(registry.activeDocId), 2000);
    };
    ydoc.on('update', handler);
    return () => {
      ydoc.off('update', handler);
      clearTimeout(timer);
    };
  }, [ydoc, registry.activeDocId]); // registry.touchDoc is stable (useCallback)

  const activeDoc = registry.docs.find((d) => d.id === registry.activeDocId);
  const activeDocName = activeDoc?.name ?? '';
  const activeDocBg = activeDoc?.bgImage;

  return (
    <div className="app">
      {isGuest && <GuestBanner />}
      <header className="app-header">
        <Button
          variant="icon"
          onClick={() => setSidebarOpen((v) => !v)}
          title={t('app.toggleSidebar')}
        >
          <Icon name="menu" />
        </Button>
        <h1>{activeDocName}</h1>
        {saveStatus !== 'idle' && (
          <span className={`save-status save-status--${saveStatus}`}>
            {saveStatus === 'pending' ? 'Saving...' : 'Saved'}
          </span>
        )}
        {/*
          One button language: every control here is an icon of the same size
          and treatment, so the row reads as a set. Import and export moved into
          the overflow menu — they are used a few times a month and were taking
          the most expensive space on screen.
        */}
        <div className="app-header__tools">
          <Button
            variant="icon"
            onClick={() => setShowHistory(true)}
            title={t('app.viewHistory')}
          >
            <Icon name="history" />
          </Button>
          {!isGuest && (
            <Button
              variant="icon"
              onClick={() => setShowAnalytics(true)}
              title={t('app.analytics')}
            >
              <Icon name="chart" />
            </Button>
          )}
          <BackgroundPicker
            docId={registry.activeDocId}
            currentBg={activeDocBg}
            onApply={(url) => registry.setBgImage(registry.activeDocId, url)}
          />
          {activeDocBg && (
            <Button
              variant="icon"
              onClick={() => setEditorHidden((v) => !v)}
              title={editorHidden ? t('app.showEditor') : t('app.hideEditor')}
            >
              <Icon name={editorHidden ? 'eyeOff' : 'eye'} />
            </Button>
          )}
          <span className="app-header__divider" aria-hidden="true" />
          <OverflowMenu
            onImport={() => importMarkdownAsNewDoc(registry.importDoc)}
            onExport={async () => {
              if (!view || !ydoc) return;
              const content = exportDocToMarkdown(view.state.doc, ydoc, activeDocName);
              await saveMarkdownFile(content, activeDocName);
            }}
            exportDisabled={!view || !ydoc}
          />
        </div>
      </header>

      <div className="app-body" style={resizing ? { cursor: 'col-resize', userSelect: 'none' } : undefined}>
        {sidebarOpen && (
          <>
            <Sidebar
              docs={registry.docs}
              activeId={registry.activeDocId}
              onSelect={registry.selectDoc}
              onCreate={registry.createNewDoc}
              onRename={registry.renameDoc}
              onDelete={registry.deleteDoc}
              onRestore={registry.restoreDoc}
              peers={peers}
              style={{ width: sidebarWidth }}
              onBeforeSignOut={'flushRegistry' in registry ? registry.flushRegistry : undefined}
            />
            <div
              className={`sidebar-resize-handle${resizing ? ' sidebar-resize-handle--dragging' : ''}`}
              onMouseDown={startSidebarResize}
            />
          </>
        )}
        <main
          ref={mainRef}
          className={`app-main${activeDocBg ? ' app-main--bg' : ''}`}
          style={activeDocBg ? { backgroundImage: `url(${activeDocBg})` } : undefined}
        >
          <div
            className={`notebook-wrap${editorHidden ? ' notebook-wrap--hidden' : ''}`}
            style={{ width: editorWidth, maxWidth: '100%' }}
          >
            <div
              className={`editor-resize-handle editor-resize-handle--left${resizing ? ' editor-resize-handle--dragging' : ''}`}
              onMouseDown={startEditorResize('left')}
              onDoubleClick={resetEditorWidth}
              title={t('app.resizeEditor')}
            />
            <div
              className={`editor-resize-handle editor-resize-handle--right${resizing ? ' editor-resize-handle--dragging' : ''}`}
              onMouseDown={startEditorResize('right')}
              onDoubleClick={resetEditorWidth}
              title={t('app.resizeEditor')}
            />
            {/* editorRef must stay mounted for the EditorView to attach; the
                loading overlay sits on top until the doc has synced + bound. */}
            <div ref={editorRef} className="notebook-editor" />
            {!view && (
              <div className="notebook-loading" role="status">
                <span className="notebook-loading__spinner" aria-hidden="true" />
                {t('app.loading')}
              </div>
            )}
            <CellAdder view={view} ydoc={ydoc} isGuest={isGuest} />
          </div>
          <SlashMenu view={view} />
          <FloatingToolbar view={view} />
        </main>
      </div>

      {showHistory && ydoc && view && (
        <SnapshotModal
          ydoc={ydoc}
          mainView={view}
          onClose={() => setShowHistory(false)}
        />
      )}
      {showAnalytics && (
        <AiReportPage onClose={() => setShowAnalytics(false)} />
      )}
    </div>
  );
}

export default App;
