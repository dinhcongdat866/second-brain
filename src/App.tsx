import { useEffect, useRef, useState } from 'react';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { baseKeymap, chainCommands, toggleMark } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import {
  ySyncPlugin,
  yCursorPlugin,
  yUndoPlugin,
  undo,
  redo,
  initProseMirrorDoc,
} from 'y-prosemirror';
import type * as Y from 'yjs';
import type { WebsocketProvider } from 'y-websocket';

type ProseMirrorMapping = ReturnType<typeof initProseMirrorDoc>['mapping'];
type Awareness = WebsocketProvider['awareness'];

import { notebookSchema } from './schema';
import {
  insertHardBreak,
  insertMarkdownCell,
  setHeading,
  setParagraph,
  toggleBlockquote,
  insertHorizontalRule,
  exitBlockquoteOnBackspace,
  preventJoinIntoBlockquote,
  exitToParagraph,
  smartSelectAll,
  deleteEmptyCell,
  convertEmptyHeadingToParagraph,
  appendMarkdownCell,
  makeAppendAiCell,
} from './commands';
import { ensureCellPlugin } from './plugins/ensureCellPlugin';
import { slashMenuPlugin } from './plugins/slashMenuPlugin';
import { placeholderPlugin } from './plugins/placeholderPlugin';
import { bindYDoc } from './plugins/slashOptions';
import { transformPastedHTML, pasteNormPlugin } from './clipboard';
import { SlashMenu } from './components/SlashMenu';
import { SnapshotModal } from './components/SnapshotModal';
import { startAutoSnapshot } from './collab/snapshots';
import { AiCellView } from './nodeViews/aiCellView';
import { MarkdownCellView } from './nodeViews/markdownCellView';
import { useUIStore } from './stores/uiStore';
import {
  createCollabSetup,
  seedIfEmpty,
  wireSaveStatus,
} from './collab/ydoc';
import './App.css';

function createPlugins(
  yXmlFragment: Y.XmlFragment,
  mapping: ProseMirrorMapping,
  awareness: Awareness,
) {
  return [
    // ySyncPlugin binds the doc to the CRDT; yUndoPlugin replaces
    // prosemirror-history (undo only spans local CRDT changes).
    ySyncPlugin(yXmlFragment, { mapping }),
    // yCursorPlugin renders remote carets/selections from awareness.
    yCursorPlugin(awareness),
    yUndoPlugin(),
    // Slash menu BEFORE other keymaps — it needs first shot at arrow/enter
    slashMenuPlugin,
    keymap({
      // Undo/redo — y-prosemirror's, backed by yUndoPlugin
      'Mod-z': undo,
      'Mod-y': redo,
      'Shift-Mod-z': redo,

      // Marks
      'Mod-b': toggleMark(notebookSchema.marks.strong),
      'Mod-i': toggleMark(notebookSchema.marks.em),
      'Mod-e': toggleMark(notebookSchema.marks.code),

      // Enter behavior: hard_break, never split blocks.
      // New cells created via slash command / keymap, not Enter.
      'Enter': insertHardBreak,
      'Shift-Enter': insertHardBreak,

      // Mod-Enter: exit blockquote/heading → new paragraph below
      'Mod-Enter': exitToParagraph,

      // Backspace chain:
      //   1. exitBlockquoteOnBackspace — lift out if at start of empty quote paragraph
      //   2. preventJoinIntoBlockquote — block joining a paragraph INTO a previous quote
      //   3. (fall through to baseKeymap for default delete/join)
      'Backspace': chainCommands(
        convertEmptyHeadingToParagraph,
        deleteEmptyCell,
        exitBlockquoteOnBackspace,
        preventJoinIntoBlockquote,
      ),

      // Smart select-all: cell content first, then full doc on second press
      'Mod-a': smartSelectAll,

      // Insert cells
      'Mod-Alt-m': insertMarkdownCell,

      // Block transforms (inside markdown_cell)
      'Mod-Alt-1': setHeading(1),
      'Mod-Alt-2': setHeading(2),
      'Mod-Alt-3': setHeading(3),
      'Mod-Alt-0': setParagraph,
      'Mod-Alt-q': toggleBlockquote,
      'Mod-Alt-d': insertHorizontalRule,
    }),
    keymap(baseKeymap),
    ensureCellPlugin,
    placeholderPlugin,
    pasteNormPlugin,
  ];
}

function CellAdder({
  view,
  ydoc,
}: {
  view: EditorView | null;
  ydoc: Y.Doc | null;
}) {
  if (!view || !ydoc) return null;

  const addMarkdown = () => {
    appendMarkdownCell(view.state, view.dispatch.bind(view));
    view.focus();
  };

  const addAi = () => {
    makeAppendAiCell(ydoc)(view.state, view.dispatch.bind(view));
    view.focus();
  };

  return (
    <div className="cell-adder">
      <button type="button" className="cell-adder__btn" onClick={addMarkdown}>
        + Markdown
      </button>
      <button type="button" className="cell-adder__btn" onClick={addAi}>
        + AI Cell
      </button>
    </div>
  );
}

function App() {
  const editorRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<EditorView | null>(null);
  // ydoc stored in state so JSX can read it without touching a ref during render.
  // ydocRef is kept only for the snapshot modal (imperative API, not render).
  const [ydoc, setYdoc] = useState<Y.Doc | null>(null);
  const ydocRef = useRef<Y.Doc | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const saveStatus = useUIStore((s) => s.saveStatus);

  useEffect(() => {
    if (!editorRef.current) return;

    const {
      ydoc: doc_ydoc,
      persistence,
      provider,
      yXmlFragment,
    } = createCollabSetup();
    let v: EditorView | undefined;
    let unwireSaveStatus: (() => void) | undefined;
    let stopAutoSnapshot: (() => void) | undefined;
    let cancelled = false;

    // Bind after the LOCAL store loads — don't wait for the network, so the
    // editor works offline. Remote updates merge in once the socket connects.
    persistence.whenSynced.then(() => {
      // StrictMode runs cleanup before the promise resolves — bail out if so
      if (cancelled) return;

      seedIfEmpty(doc_ydoc, yXmlFragment);
      bindYDoc(doc_ydoc);
      ydocRef.current = doc_ydoc;
      setYdoc(doc_ydoc);
      unwireSaveStatus = wireSaveStatus(doc_ydoc);
      stopAutoSnapshot = startAutoSnapshot(doc_ydoc);

      const { doc, mapping } = initProseMirrorDoc(yXmlFragment, notebookSchema);
      const state = EditorState.create({
        schema: notebookSchema,
        doc,
        plugins: createPlugins(yXmlFragment, mapping, provider.awareness),
      });

      v = new EditorView(editorRef.current!, {
        state,
        nodeViews: {
          markdown_cell: (node, view, getPos) =>
            new MarkdownCellView(node, view, getPos),
          ai_cell: (node, view, getPos) =>
            new AiCellView(node, view, getPos, doc_ydoc),
        },
        transformPastedHTML,
        dispatchTransaction(transaction) {
          const newState = v!.state.apply(transaction);
          v!.updateState(newState);
        },
      });

      setView(v);
    });

    return () => {
      cancelled = true;
      unwireSaveStatus?.();
      stopAutoSnapshot?.();
      v?.destroy();
      provider.destroy();
      persistence.destroy();
      doc_ydoc.destroy();
      setView(null);
      setYdoc(null);
    };
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Second Brain</h1>
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
      </header>
      <main className="app-main">
        <div className="notebook-wrap">
          <div ref={editorRef} className="notebook-editor" />
          <CellAdder view={view} ydoc={ydoc} />
        </div>
        <SlashMenu view={view} />
      </main>
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
