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
import type { Awareness } from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';

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
import {
  createCollabSetup,
  createGuestDocSetup,
  seedFromContent,
  seedIfEmpty,
  seedGuestDoc,
  wireSaveStatus,
} from '../collab/ydoc';
import { runMigrations } from '../collab/schemaMigrations';
import { addTurn, getThread, sweepOrphanThreads } from '../collab/aiThreads';
import { sweepOrphanWeeklyPlans } from '../collab/weeklyPlans';
import { consumePendingImport } from '../lib/importState';
import { createDocSyncer, createYjsSyncer, applyServerState } from '../lib/backendSync';

type ProseMirrorMapping = ReturnType<typeof initProseMirrorDoc>['mapping'];

function createPlugins(
  yXmlFragment: Y.XmlFragment,
  mapping: ProseMirrorMapping,
  awareness: Awareness | WebsocketProvider['awareness'],
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

// ---------------------------------------------------------------------------
// Shared editor-binding logic (used by both auth and guest paths)
// ---------------------------------------------------------------------------

function bindEditor(
  container: HTMLDivElement,
  yXmlFragment: Y.XmlFragment,
  awareness: Awareness | WebsocketProvider['awareness'],
  doc: Y.Doc,
  activeDocId: string,
  setView: (v: EditorView | null) => void,
  setYdoc: (d: Y.Doc | null) => void,
  isGuest: boolean,
  getMemoryContext: () => string,
  appendMemory: (bullets: string[], meta: { sourceCellId: string; sourceDocId: string }) => void,
  getAnalyticsContext: () => string,
  plannerYdoc: Y.Doc | null,
): (() => void) | undefined {
  sweepOrphanThreads(doc, yXmlFragment);
  sweepOrphanWeeklyPlans(doc, yXmlFragment);
  runMigrations(doc);
  bindYDoc(doc);
  setYdoc(doc);

  let unwireSave: (() => void) | undefined;
  let stopSnapshot: (() => void) | undefined;
  let stopSyncer: (() => void) | undefined;
  let detachLifecycle: (() => void) | undefined;

  if (!isGuest) {
    unwireSave = wireSaveStatus(doc);
    stopSnapshot = startAutoSnapshot(doc);
    const syncer = createYjsSyncer(activeDocId, doc);
    stopSyncer = syncer.stop;
    // On hide, the page is still alive (tab switch / app background) — do a full
    // authenticated merge-save. This is the reliable durable path on iOS, where
    // pagehide/beforeunload are flaky. The keepalive beacon below is only a
    // last-ditch redundancy for an abrupt desktop tab-close.
    const onHide = () => { if (document.visibilityState === 'hidden') syncer.flush(); };
    const onVisible = () => { if (document.visibilityState === 'visible') applyServerState(activeDocId, doc).catch(() => {}); };
    const onPageHide = () => syncer.flushBeacon();
    window.addEventListener('visibilitychange', onHide);
    window.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);
    detachLifecycle = () => {
      window.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
    };
  }

  let v: EditorView | undefined;
  try {
    const { doc: pmDoc, mapping } = initProseMirrorDoc(yXmlFragment, notebookSchema);
    const state = EditorState.create({
      schema: notebookSchema,
      doc: pmDoc,
      plugins: createPlugins(yXmlFragment, mapping, awareness, activeDocId),
    });
    const syncDoc = isGuest ? () => {} : createDocSyncer(activeDocId);
    v = new EditorView(container, {
      state,
      nodeViews: {
        markdown_cell: (node, view, getPos) => new MarkdownCellView(node, view, getPos),
        ai_cell: (node, view, getPos) => new AiCellView(node, view, getPos, doc, activeDocId, getMemoryContext, appendMemory, getAnalyticsContext, plannerYdoc),
        weekly_planner_cell: (node, view, getPos) => new WeeklyCellView(node, view, getPos, plannerYdoc),
      },
      handleDOMEvents: {
        click(_view, event) {
          const anchor = (event.target as HTMLElement).closest('a');
          if (anchor?.href) { event.preventDefault(); window.open(anchor.href, '_blank', 'noopener,noreferrer'); return true; }
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
    console.error('[useNotebookEditor] Schema bind error — data preserved in Yjs.', err);
  }

  return () => {
    unwireSave?.();
    stopSnapshot?.();
    stopSyncer?.();
    detachLifecycle?.();
    v?.destroy();
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useNotebookEditor(
  editorRef: React.RefObject<HTMLDivElement | null>,
  activeDocId: string,
  isGuest = false,
  userId?: string,
  getMemoryContext: () => string = () => '',
  appendMemory: (bullets: string[], meta: { sourceCellId: string; sourceDocId: string }) => void = () => {},
  getAnalyticsContext: () => string = () => '',
  plannerYdoc: Y.Doc | null = null,
) {
  const [view, setView] = useState<EditorView | null>(null);
  const [ydoc, setYdoc] = useState<Y.Doc | null>(null);
  const providerRef = useRef<WebsocketProvider | null>(null);

  useEffect(() => {
    if (!editorRef.current) return;

    // ── Guest path ── no IndexedDB, no WebSocket, no Neon sync
    if (isGuest) {
      const { ydoc: doc, yXmlFragment, awareness } = createGuestDocSetup();
      let cancelled = false;
      let cleanup: (() => void) | undefined;

      // Seed immediately (no async waiting needed)
      Promise.resolve().then(() => {
        if (cancelled) return;
        const pendingImport = consumePendingImport();
        if (pendingImport) {
          seedFromContent(doc, yXmlFragment, pendingImport.pmDoc);
        } else {
          seedGuestDoc(doc, yXmlFragment);
        }
        cleanup = bindEditor(
          editorRef.current!,
          yXmlFragment,
          awareness,
          doc,
          activeDocId,
          setView,
          setYdoc,
          true,
          getMemoryContext,
          appendMemory,
          getAnalyticsContext,
          plannerYdoc,
        );
      });

      return () => {
        cancelled = true;
        cleanup?.();
        awareness.destroy();
        doc.destroy();
        setView(null);
        setYdoc(null);
      };
    }

    // ── Authenticated path ── full persistence + Neon sync
    const { ydoc: doc, persistence, provider, yXmlFragment } = createCollabSetup(activeDocId, userId);
    providerRef.current = provider;
    let editorCleanup: (() => void) | undefined;
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
              for (const { role, content } of turns) addTurn(thread, role, content);
            }
          });
        }
      } else {
        const hadServerState = await applyServerState(activeDocId, doc);
        if (cancelled) return;
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

      editorCleanup = bindEditor(
        editorRef.current!,
        yXmlFragment,
        provider.awareness,
        doc,
        activeDocId,
        setView,
        setYdoc,
        false,
        getMemoryContext,
        appendMemory,
        getAnalyticsContext,
        plannerYdoc,
      );
    });

    return () => {
      cancelled = true;
      editorCleanup?.();
      provider.destroy();
      persistence.destroy();
      doc.destroy();
      providerRef.current = null;
      setView(null);
      setYdoc(null);
    };
  // plannerYdoc in deps: re-bind editor once the global planner Y.Doc is ready.
  // It stays null until the planner's IndexedDB + server state are fully loaded
  // (see usePlannerYdoc); weekly cells render a loading placeholder until then.
  }, [activeDocId, isGuest, userId, plannerYdoc]); // editorRef is stable

  return { view, ydoc, providerRef };
}
