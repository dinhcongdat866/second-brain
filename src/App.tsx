import { useRef, useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type * as Y from 'yjs';
import type { EditorView } from 'prosemirror-view';

import { appendMarkdownCell, makeAppendAiCell, makeAppendWeeklyCell } from './commands';
import { BackgroundPicker } from './components/BackgroundPicker';
import { Button } from './components/Button';
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
import { usePlannerYdoc } from './hooks/usePlannerYdoc';
import './styles/main.css';

function CellAdder({
  view,
  ydoc,
}: {
  view: EditorView | null;
  ydoc: Y.Doc | null;
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
  const plannerYdoc = usePlannerYdoc(userId, isGuest);
  const { view, ydoc, providerRef } = useNotebookEditor(editorRef, registry.activeDocId, isGuest, userId, getMemoryContext, appendMemory, getAnalyticsContext, plannerYdoc);
  const peers = usePresence(providerRef);
  useClassificationSync(plannerYdoc, !isGuest);
  const [showHistory, setShowHistory] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [editorHidden, setEditorHidden] = useState(false);
  const [resizing, setResizing] = useState(false);
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
          ☰
        </Button>
        <h1>{activeDocName}</h1>
        {saveStatus !== 'idle' && (
          <span className={`save-status save-status--${saveStatus}`}>
            {saveStatus === 'pending' ? 'Saving...' : 'Saved'}
          </span>
        )}
        <Button
          variant="secondary"
          style={{ marginLeft: 'auto' }}
          onClick={() => setShowHistory(true)}
          title={t('app.viewHistory')}
        >
          {t('app.history')}
        </Button>
        {!isGuest && (
          <Button
            variant="secondary"
            onClick={() => setShowAnalytics(true)}
            title="Personal analytics report"
          >
            📊
          </Button>
        )}
        <Button
          variant="secondary"
          onClick={() => importMarkdownAsNewDoc(registry.importDoc)}
          title={t('app.importTitle')}
        >
          {t('app.import')}
        </Button>
        <Button
          variant="secondary"
          disabled={!view || !ydoc}
          onClick={async () => {
            if (!view || !ydoc) return;
            const content = exportDocToMarkdown(view.state.doc, ydoc, activeDocName);
            await saveMarkdownFile(content, activeDocName);
          }}
          title={t('app.exportTitle')}
        >
          {t('app.export')}
        </Button>
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
            {editorHidden ? '◻' : '▣'}
          </Button>
        )}
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
          className={`app-main${activeDocBg ? ' app-main--bg' : ''}`}
          style={activeDocBg ? { backgroundImage: `url(${activeDocBg})` } : undefined}
        >
          <div className={`notebook-wrap${editorHidden ? ' notebook-wrap--hidden' : ''}`}>
            {/* editorRef must stay mounted for the EditorView to attach; the
                loading overlay sits on top until the doc has synced + bound. */}
            <div ref={editorRef} className="notebook-editor" />
            {!view && (
              <div className="notebook-loading" role="status">
                <span className="notebook-loading__spinner" aria-hidden="true" />
                {t('app.loading')}
              </div>
            )}
            <CellAdder view={view} ydoc={ydoc} />
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
