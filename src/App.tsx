import { useEffect, useRef, useState } from 'react';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, redo, undo } from 'prosemirror-history';
import { baseKeymap, chainCommands, toggleMark } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';

import { notebookSchema, createInitialDoc } from './schema';
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
} from './commands';
import { ensureCellPlugin } from './plugins/ensureCellPlugin';
import { slashMenuPlugin } from './plugins/slashMenuPlugin';
import { SlashMenu } from './components/SlashMenu';
import './App.css';

function createPlugins() {
  return [
    history({ depth: 100, newGroupDelay: 300 }),
    // Slash menu BEFORE other keymaps — it needs first shot at arrow/enter
    slashMenuPlugin,
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

      // Mod-Enter: exit blockquote/heading → new paragraph below
      'Mod-Enter': exitToParagraph,

      // Backspace chain:
      //   1. exitBlockquoteOnBackspace — lift out if at start of empty quote paragraph
      //   2. preventJoinIntoBlockquote — block joining a paragraph INTO a previous quote
      //   3. (fall through to baseKeymap for default delete/join)
      'Backspace': chainCommands(
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
  ];
}

function App() {
  const editorRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<EditorView | null>(null);

  useEffect(() => {
    if (!editorRef.current) return;

    const state = EditorState.create({
      schema: notebookSchema,
      doc: createInitialDoc(),
      plugins: createPlugins(),
    });

    const v = new EditorView(editorRef.current, {
      state,
      dispatchTransaction(transaction) {
        const newState = v.state.apply(transaction);
        v.updateState(newState);
      },
    });

    setView(v);
    return () => {
      v.destroy();
      setView(null);
    };
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Second Brain</h1>
      </header>
      <main className="app-main">
        <div ref={editorRef} className="notebook-editor" />
        <SlashMenu view={view} />
      </main>
    </div>
  );
}

export default App;
