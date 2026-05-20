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
} from './commands';
import { ensureCellPlugin } from './plugins/ensureCellPlugin';
import { slashMenuPlugin } from './plugins/slashMenuPlugin';
import { placeholderPlugin } from './plugins/placeholderPlugin';
import { SlashMenu } from './components/SlashMenu';
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
  ];
}

function App() {
  const editorRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const saveStatus = useUIStore((s) => s.saveStatus);

  useEffect(() => {
    if (!editorRef.current) return;

    const { ydoc, persistence, provider, yXmlFragment } = createCollabSetup();
    let v: EditorView | undefined;
    let unwireSaveStatus: (() => void) | undefined;
    let cancelled = false;

    // Bind after the LOCAL store loads — don't wait for the network, so the
    // editor works offline. Remote updates merge in once the socket connects.
    persistence.whenSynced.then(() => {
      // StrictMode runs cleanup before the promise resolves — bail out if so
      if (cancelled) return;

      seedIfEmpty(ydoc, yXmlFragment);
      unwireSaveStatus = wireSaveStatus(ydoc);

      const { doc, mapping } = initProseMirrorDoc(yXmlFragment, notebookSchema);
      const state = EditorState.create({
        schema: notebookSchema,
        doc,
        plugins: createPlugins(yXmlFragment, mapping, provider.awareness),
      });

      v = new EditorView(editorRef.current!, {
        state,
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
      v?.destroy();
      provider.destroy();
      persistence.destroy();
      ydoc.destroy();
      setView(null);
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
      </header>
      <main className="app-main">
        <div ref={editorRef} className="notebook-editor" />
        <SlashMenu view={view} />
      </main>
    </div>
  );
}

export default App;
