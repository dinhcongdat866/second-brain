import { useRef, useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type * as Y from 'yjs';
import type { EditorView } from 'prosemirror-view';

import { appendMarkdownCell, makeAppendAiCell, makeAppendWeeklyCell } from './commands';
import { FloatingToolbar } from './components/FloatingToolbar';
import { LanguageSwitcher } from './components/LanguageSwitcher';
import { Sidebar } from './components/Sidebar';
import { SlashMenu } from './components/SlashMenu';
import { SnapshotModal } from './components/SnapshotModal';
import { useDocRegistry } from './hooks/useDocRegistry';
import { useNotebookEditor } from './hooks/useNotebookEditor';
import { exportDocToMarkdown, saveMarkdownFile } from './lib/exportMarkdown';
import { importMarkdownAsNewDoc } from './lib/importMarkdown';
import { useUIStore } from './stores/uiStore';
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
      <button
        type="button"
        className="cell-adder__btn"
        onClick={() => {
          appendMarkdownCell(view.state, view.dispatch.bind(view));
          view.focus();
        }}
      >
        {t('cellAdder.markdown')}
      </button>
      <button
        type="button"
        className="cell-adder__btn"
        onClick={() => {
          makeAppendAiCell(ydoc)(view.state, view.dispatch.bind(view));
          view.focus();
        }}
      >
        {t('cellAdder.ai')}
      </button>
      <button
        type="button"
        className="cell-adder__btn"
        onClick={() => {
          makeAppendWeeklyCell(ydoc)(view.state, view.dispatch.bind(view));
          view.focus();
        }}
      >
        {t('cellAdder.weekly')}
      </button>
    </div>
  );
}

function App() {
  const { t } = useTranslation();
  const editorRef = useRef<HTMLDivElement>(null);
  const registry = useDocRegistry();
  const { view, ydoc } = useNotebookEditor(editorRef, registry.activeDocId);
  const [showHistory, setShowHistory] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(220);
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

  const activeDocName =
    registry.docs.find((d) => d.id === registry.activeDocId)?.name ?? '';

  return (
    <div className="app">
      <header className="app-header">
        <button
          className="header-sidebar-toggle"
          onClick={() => setSidebarOpen((v) => !v)}
          title={t('app.toggleSidebar')}
        >
          ☰
        </button>
        <h1>{activeDocName}</h1>
        {saveStatus !== 'idle' && (
          <span className={`save-status save-status--${saveStatus}`}>
            {saveStatus === 'pending' ? 'Saving...' : 'Saved'}
          </span>
        )}
        <LanguageSwitcher />
        <button
          className="header-history-btn"
          onClick={() => setShowHistory(true)}
          title={t('app.viewHistory')}
        >
          {t('app.history')}
        </button>
        <button
          className="header-export-btn"
          onClick={() => importMarkdownAsNewDoc(registry.importDoc)}
          title={t('app.importTitle')}
        >
          {t('app.import')}
        </button>
        <button
          className="header-export-btn"
          disabled={!view || !ydoc}
          onClick={async () => {
            if (!view || !ydoc) return;
            const content = exportDocToMarkdown(
              view.state.doc,
              ydoc,
              activeDocName,
            );
            await saveMarkdownFile(content, activeDocName);
          }}
          title={t('app.exportTitle')}
        >
          {t('app.export')}
        </button>
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
              style={{ width: sidebarWidth }}
            />
            <div
              className={`sidebar-resize-handle${resizing ? ' sidebar-resize-handle--dragging' : ''}`}
              onMouseDown={startSidebarResize}
            />
          </>
        )}
        <main className="app-main">
          <div className="notebook-wrap">
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
    </div>
  );
}

export default App;
