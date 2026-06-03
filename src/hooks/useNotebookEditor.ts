import { useEffect, useState } from 'react';
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
  guardProtectedCells,
} from '../commands';
import { ensureCellPlugin } from '../plugins/ensureCellPlugin';
import { selectionPlugin } from '../plugins/selectionPlugin';
import { slashMenuPlugin } from '../plugins/slashMenuPlugin';
import { placeholderPlugin } from '../plugins/placeholderPlugin';
import { bindYDoc } from '../plugins/slashOptions';
import { transformPastedHTML, pasteNormPlugin } from '../clipboard';
import { imagePastePlugin } from '../plugins/imagePastePlugin';
import { AiCellView } from '../nodeViews/aiCellView';
import { MarkdownCellView } from '../nodeViews/markdownCellView';
import { WeeklyCellView } from '../nodeViews/weeklyCellView';
import { startAutoSnapshot } from '../collab/snapshots';
import { createCollabSetup, seedFromContent, seedIfEmpty, wireSaveStatus } from '../collab/ydoc';
import { runMigrations } from '../collab/schemaMigrations';
import { addTurn, getThread, sweepOrphanThreads } from '../collab/aiThreads';
import { sweepOrphanWeeklyPlans } from '../collab/weeklyPlans';
import { consumePendingImport } from '../lib/importState';
import { createDocSyncer, createYjsSyncer, applyServerState } from '../lib/backendSync';

type ProseMirrorMapping = ReturnType<typeof initProseMirrorDoc>['mapping'];
type Awareness = WebsocketProvider['awareness'];

function createPlugins(
  yXmlFragment: Y.XmlFragment,
  mapping: ProseMirrorMapping,
  awareness: Awareness,
  docId: string,
) {
  return [
    ySyncPlugin(yXmlFragment, { mapping }),
    yCursorPlugin(awareness),
    yUndoPlugin(),
    imagePastePlugin(() => docId),
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
        guardProtectedCells,
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
    selectionPlugin,
    placeholderPlugin,
    pasteNormPlugin,
  ];
}

export function useNotebookEditor(
  editorRef: React.RefObject<HTMLDivElement | null>,
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
    let stopYjsSyncer: (() => void) | undefined;
    let detachLifecycle: (() => void) | undefined;
    let cancelled = false;

    persistence.whenSynced.then(async () => {
      if (cancelled) return;

      const pendingImport = consumePendingImport();
      if (pendingImport) {
        seedFromContent(doc, yXmlFragment, pendingImport.pmDoc);
        if (pendingImport.threads.length > 0) {
          doc.transact(() => {
            for (const { cellId, turns } of pendingImport.threads) {
              const thread = getThread(doc, cellId);
              for (const { role, content } of turns) {
                addTurn(thread, role, content);
              }
            }
          });
        }
      } else {
        // Merge server state first so seedIfEmpty sees the real content.
        const hadServerState = await applyServerState(activeDocId, doc);
        if (cancelled) return;

        // If the HTTP backend had no saved state (brand-new doc or unreachable),
        // the WS provider may still be mid-sync with live content from another tab.
        // Wait briefly for it so we don't seed a blank cell that then conflicts
        // with the real content arriving over WebSocket.
        if (!hadServerState && !provider.synced) {
          await new Promise<void>((resolve) => {
            const onSync = (isSynced: boolean) => {
              if (!isSynced) return;
              provider.off('sync', onSync);
              resolve();
            };
            provider.on('sync', onSync);
            setTimeout(() => { provider.off('sync', onSync); resolve(); }, 2000);
          });
          if (cancelled) return;
        }

        seedIfEmpty(doc, yXmlFragment);
      }
      sweepOrphanThreads(doc, yXmlFragment);
      sweepOrphanWeeklyPlans(doc, yXmlFragment);
      runMigrations(doc); // bring old docs up to the current schema before binding
      bindYDoc(doc);
      setYdoc(doc);
      unwireSaveStatus = wireSaveStatus(doc);
      stopAutoSnapshot = startAutoSnapshot(doc);

      const yjsSyncer = createYjsSyncer(activeDocId, doc);
      stopYjsSyncer = yjsSyncer.stop;
      // Flush to Neon on every teardown signal. iOS Safari is unreliable with
      // `beforeunload`, so `pagehide` + `visibilitychange→hidden` are the real
      // safety net; sendBeacon survives the teardown. This keeps the server
      // copy current before IndexedDB can be evicted.
      const onHide = () => {
        if (document.visibilityState === 'hidden') yjsSyncer.flushBeacon();
      };
      const onPageHide = () => yjsSyncer.flushBeacon();
      window.addEventListener('visibilitychange', onHide);
      window.addEventListener('pagehide', onPageHide);
      window.addEventListener('beforeunload', onPageHide);
      detachLifecycle = () => {
        window.removeEventListener('visibilitychange', onHide);
        window.removeEventListener('pagehide', onPageHide);
        window.removeEventListener('beforeunload', onPageHide);
      };

      // Binding can throw if the stored content doesn't fit the current schema
      // (an unhandled incompatible change). Never let that discard data: the
      // Yjs doc stays intact (recoverable / exportable); we just surface the
      // failure instead of silently rendering blank. The real fix for any such
      // case is a registered migration (see collab/schemaMigrations).
      try {
        const { doc: pmDoc, mapping } = initProseMirrorDoc(
          yXmlFragment,
          notebookSchema,
        );
        const state = EditorState.create({
          schema: notebookSchema,
          doc: pmDoc,
          plugins: createPlugins(yXmlFragment, mapping, provider.awareness, activeDocId),
        });

        const syncDoc = createDocSyncer(activeDocId);

        v = new EditorView(editorRef.current!, {
          state,
          nodeViews: {
            markdown_cell: (node, view, getPos) =>
              new MarkdownCellView(node, view, getPos),
            ai_cell: (node, view, getPos) =>
              new AiCellView(node, view, getPos, doc, activeDocId),
            weekly_planner_cell: (node, view, getPos) =>
              new WeeklyCellView(node, view, getPos, doc),
          },
          handleDOMEvents: {
            click(_view, event) {
              const anchor = (event.target as HTMLElement).closest('a');
              if (anchor?.href) {
                event.preventDefault();
                window.open(anchor.href, '_blank', 'noopener,noreferrer');
                return true;
              }
              return false;
            },
          },
          transformPastedHTML,
          dispatchTransaction(tr) {
            const next = v!.state.apply(tr);
            v!.updateState(next);
            if (tr.docChanged) syncDoc(next.doc);
          },
        });

        setView(v);
      } catch (err) {
        console.error(
          `[useNotebookEditor] Failed to bind doc "${activeDocId}" to the ` +
            `current schema. Data is preserved in Yjs (export to recover). ` +
            `An incompatible schema change needs a migration in ` +
            `collab/schemaMigrations.`,
          err,
        );
      }
    });

    return () => {
      cancelled = true;
      unwireSaveStatus?.();
      stopAutoSnapshot?.();
      stopYjsSyncer?.();
      detachLifecycle?.();
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
