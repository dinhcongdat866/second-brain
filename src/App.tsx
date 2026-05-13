import { useEffect, useRef } from 'react';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, redo, undo } from 'prosemirror-history';
import { baseKeymap, toggleMark } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';

import { notebookSchema, createInitialDoc } from './schema';
import { insertHardBreak, insertMarkdownCell } from './commands';
import { ensureCellPlugin } from './plugins/ensureCellPlugin';
import './App.css';

function createPlugins() {
  return [
    history({ depth: 100, newGroupDelay: 300 }),
    keymap({
      // Undo/redo
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

      // Insert cells
      'Mod-Alt-m': insertMarkdownCell,
    }),
    keymap(baseKeymap),
    ensureCellPlugin,
  ];
}

function App() {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!editorRef.current) return;

    const state = EditorState.create({
      schema: notebookSchema,
      doc: createInitialDoc(),
      plugins: createPlugins(),
    });

    const view = new EditorView(editorRef.current, {
      state,
      dispatchTransaction(transaction) {
        const newState = view.state.apply(transaction);
        view.updateState(newState);
      },
    });

    viewRef.current = view;
    return () => view.destroy();
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Second Brain</h1>
      </header>
      <main className="app-main">
        <div ref={editorRef} className="notebook-editor" />
      </main>
    </div>
  );
}

export default App;
