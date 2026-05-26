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

import { notebookSchema } from '../schema';
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
} from '../commands';
import { ensureCellPlugin } from '../plugins/ensureCellPlugin';
import { slashMenuPlugin } from '../plugins/slashMenuPlugin';
import { placeholderPlugin } from '../plugins/placeholderPlugin';
import { bindYDoc } from '../plugins/slashOptions';
import { transformPastedHTML, pasteNormPlugin } from '../clipboard';
import { AiCellView } from '../nodeViews/aiCellView';
import { MarkdownCellView } from '../nodeViews/markdownCellView';
import { startAutoSnapshot } from '../collab/snapshots';
import { createCollabSetup, seedIfEmpty, wireSaveStatus } from '../collab/ydoc';
import { sweepOrphanThreads } from '../collab/aiThreads';

type ProseMirrorMapping = ReturnType<typeof initProseMirrorDoc>['mapping'];
type Awareness = WebsocketProvider['awareness'];

function createPlugins(
  yXmlFragment: Y.XmlFragment,
  mapping: ProseMirrorMapping,
  awareness: Awareness,
) {
  return [
    ySyncPlugin(yXmlFragment, { mapping }),
    yCursorPlugin(awareness),
    yUndoPlugin(),
    slashMenuPlugin,
    keymap({
      'Mod-z': undo,
      'Mod-y': redo,
      'Shift-Mod-z': redo,
      'Mod-b': toggleMark(notebookSchema.marks.strong),
      'Mod-i': toggleMark(notebookSchema.marks.em),
      'Mod-e': toggleMark(notebookSchema.marks.code),
      'Enter': insertHardBreak,
      'Shift-Enter': insertHardBreak,
      'Mod-Enter': exitToParagraph,
      'Backspace': chainCommands(
        convertEmptyHeadingToParagraph,
        deleteEmptyCell,
        exitBlockquoteOnBackspace,
        preventJoinIntoBlockquote,
      ),
      'Mod-a': smartSelectAll,
      'Mod-Alt-m': insertMarkdownCell,
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

export function useNotebookEditor(
  editorRef: React.RefObject<HTMLDivElement>,
  activeDocId: string,
) {
  const [view, setView] = useState<EditorView | null>(null);
  const [ydoc, setYdoc] = useState<Y.Doc | null>(null);

  useEffect(() => {
    if (!editorRef.current) return;

    const { ydoc: doc, persistence, provider, yXmlFragment } =
      createCollabSetup(activeDocId);
    let v: EditorView | undefined;
    let unwireSaveStatus: (() => void) | undefined;
    let stopAutoSnapshot: (() => void) | undefined;
    let cancelled = false;

    persistence.whenSynced.then(() => {
      if (cancelled) return;

      seedIfEmpty(doc, yXmlFragment);
      sweepOrphanThreads(doc, yXmlFragment);
      bindYDoc(doc);
      setYdoc(doc);
      unwireSaveStatus = wireSaveStatus(doc);
      stopAutoSnapshot = startAutoSnapshot(doc);

      const { doc: pmDoc, mapping } = initProseMirrorDoc(
        yXmlFragment,
        notebookSchema,
      );
      const state = EditorState.create({
        schema: notebookSchema,
        doc: pmDoc,
        plugins: createPlugins(yXmlFragment, mapping, provider.awareness),
      });

      v = new EditorView(editorRef.current!, {
        state,
        nodeViews: {
          markdown_cell: (node, view, getPos) =>
            new MarkdownCellView(node, view, getPos),
          ai_cell: (node, view, getPos) =>
            new AiCellView(node, view, getPos, doc),
        },
        transformPastedHTML,
        dispatchTransaction(tr) {
          const next = v!.state.apply(tr);
          v!.updateState(next);
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
      doc.destroy();
      setView(null);
      setYdoc(null);
    };
  }, [activeDocId]); // editorRef is stable (useRef), intentionally omitted

  return { view, ydoc };
}
