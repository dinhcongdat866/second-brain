import { useRef, useState, useCallback } from 'react';
import type * as Y from 'yjs';
import type { EditorView } from 'prosemirror-view';

import { appendMarkdownCell, makeAppendAiCell, makeAppendWeeklyCell } from './commands';
import { FloatingToolbar } from './components/FloatingToolbar';
import { Sidebar } from './components/Sidebar';
import { SlashMenu } from './components/SlashMenu';
import { SnapshotModal } from './components/SnapshotModal';
import { useDocRegistry } from './hooks/useDocRegistry';
import { useNotebookEditor } from './hooks/useNotebookEditor';
import { exportDocToMarkdown, saveMarkdownFile } from './lib/exportMarkdown';
import { importMarkdownAsNewDoc } from './lib/importMarkdown';
import { useUIStore } from './stores/uiStore';
import './App.css';

function CellAdder({
  view,
  ydoc,
}: {
  view: EditorView | null;
  ydoc: Y.Doc | null;
}) {
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
        + Markdown
      </button>
      <button
        type="button"
        className="cell-adder__btn"
        onClick={() => {
          makeAppendAiCell(ydoc)(view.state, view.dispatch.bind(view));
          view.focus();
        }}
      >
        + AI Cell
      </button>
      <button
        type="button"
        className="cell-adder__btn"
        onClick={() => {
          makeAppendWeeklyCell(ydoc)(view.state, view.dispatch.bind(view));
          view.focus();
        }}
      >
        + Weekly
      </button>
    </div>
  );
}

function App() {
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

  const activeDocName =
    registry.docs.find((d) => d.id === registry.activeDocId)?.name ?? '';

  return (
    <div className="app">
      <header className="app-header">
        <button
          className="header-sidebar-toggle"
          onClick={() => setSidebarOpen((v) => !v)}
          title={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
        >
          ☰
        </button>
        <h1>{activeDocName}</h1>
        {saveStatus !== 'idle' && (
          <span className={`save-status save-status--${saveStatus}`}>
            {saveStatus === 'pending' ? 'Saving...' : 'Saved'}
          </span>
        )}
        <button
          className="header-history-btn"
          onClick={() => setShowHistory(true)}
          title="View history"
        >
          History
        </button>
        <button
          className="header-export-btn"
          onClick={() => importMarkdownAsNewDoc(registry.importDoc)}
          title="Import a Markdown file as a new document"
        >
          Import .md
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
          title="Export as Markdown"
        >
          Export .md
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
            <div ref={editorRef} className="notebook-editor" />
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
