/**
 * SnapshotModal — time-travel UI for the notebook.
 *
 * Left panel : list of snapshots (newest first) + "Take snapshot" button.
 * Right panel: read-only ProseMirror preview of the selected snapshot.
 * Footer     : Restore button (replaces doc content with snapshot state).
 *
 * Restore works by computing the snapshot PM doc, then dispatching a single
 * PM transaction that replaces all current content. ySyncPlugin forwards it
 * to the XmlFragment → synced to all peers via WebSocket like any edit.
 * aiThreads are NOT restored (only the document structure is restored).
 */

import { useEffect, useReducer, useRef, useState } from 'react';
import * as Y from 'yjs';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Slice } from 'prosemirror-model';
import { initProseMirrorDoc } from 'y-prosemirror';
import type { EditorView as MainView } from 'prosemirror-view';

import { notebookSchema } from '../schema';
import { XML_FRAGMENT_NAME } from '../collab/ydoc';
import {
  listSnapshots,
  takeSnapshot,
  deleteSnapshot,
  getSnapshotEncoded,
  type SnapshotMeta,
} from '../collab/snapshots';

interface Props {
  ydoc: Y.Doc;
  mainView: MainView;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Preview hook — mounts a read-only EditorView into a div ref
// ---------------------------------------------------------------------------

function usePreviewView(
  containerRef: React.RefObject<HTMLDivElement | null>,
  ydoc: Y.Doc,
  selectedId: string | null,
) {
  useEffect(() => {
    if (!containerRef.current || !selectedId) return;

    const encoded = getSnapshotEncoded(ydoc, selectedId);
    if (!encoded) return;

    const snapshot = Y.decodeSnapshot(encoded);
    const snapDoc = Y.createDocFromSnapshot(ydoc, snapshot);
    const snapFrag = snapDoc.getXmlFragment(XML_FRAGMENT_NAME);
    const { doc } = initProseMirrorDoc(snapFrag, notebookSchema);
    snapDoc.destroy(); // PM doc is a plain JS object — safe to destroy the Yjs source

    const view = new EditorView(containerRef.current, {
      state: EditorState.create({ schema: notebookSchema, doc }),
      editable: () => false,
      // Suppress all dispatches — preview is purely display.
      dispatchTransaction: () => {},
    });

    return () => view.destroy();
  }, [ydoc, selectedId, containerRef]);
}

// ---------------------------------------------------------------------------
// Restore helper
// ---------------------------------------------------------------------------

function restoreSnapshot(
  ydoc: Y.Doc,
  mainView: MainView,
  id: string,
): boolean {
  const encoded = getSnapshotEncoded(ydoc, id);
  if (!encoded) return false;

  const snapshot = Y.decodeSnapshot(encoded);
  const snapDoc = Y.createDocFromSnapshot(ydoc, snapshot);
  const snapFrag = snapDoc.getXmlFragment(XML_FRAGMENT_NAME);
  const { doc: snapPmDoc } = initProseMirrorDoc(snapFrag, notebookSchema);
  snapDoc.destroy();

  // Replace the entire doc content with the snapshot's content.
  // This is a regular PM transaction — ySyncPlugin will forward it to
  // the XmlFragment and WebSocket, so all peers receive the restore.
  const tr = mainView.state.tr.replace(
    0,
    mainView.state.doc.content.size,
    new Slice(snapPmDoc.content, 0, 0),
  );
  mainView.dispatch(tr);
  return true;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SnapshotModal({ ydoc, mainView, onClose }: Props) {
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>(() =>
    listSnapshots(ydoc),
  );
  const [selectedId, setSelectedId] = useState<string | null>(
    () => listSnapshots(ydoc)[0]?.id ?? null,
  );
  // Force re-render when Y.Map changes (peer takes a snapshot, etc.)
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const previewRef = useRef<HTMLDivElement>(null);
  usePreviewView(previewRef, ydoc, selectedId);

  // Keep snapshot list in sync with Y.Map (local + remote changes)
  useEffect(() => {
    const refresh = () => {
      const next = listSnapshots(ydoc);
      setSnapshots(next);
      bump();
    };
    const map = ydoc.getMap(SNAPSHOTS_KEY_LOCAL);
    map.observe(refresh);
    return () => map.unobserve(refresh);
  }, [ydoc]);

  const handleTake = () => {
    const id = takeSnapshot(ydoc);
    setSelectedId(id);
  };

  const handleRestore = () => {
    if (!selectedId) return;
    const ok = restoreSnapshot(ydoc, mainView, selectedId);
    if (ok) onClose();
  };

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    deleteSnapshot(ydoc, id);
    if (selectedId === id) {
      const remaining = listSnapshots(ydoc).filter((s) => s.id !== id);
      setSelectedId(remaining[0]?.id ?? null);
    }
  };

  return (
    <div className="snap-overlay" onMouseDown={onClose}>
      <div className="snap-modal" onMouseDown={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="snap-modal__header">
          <span className="snap-modal__title">History</span>
          <button className="snap-modal__close" onClick={onClose} title="Close">✕</button>
        </div>

        {/* Body — two columns */}
        <div className="snap-modal__body">

          {/* Left: snapshot list */}
          <div className="snap-list">
            <button className="snap-take-btn" onClick={handleTake}>
              + Take snapshot
            </button>

            {snapshots.length === 0 ? (
              <p className="snap-empty">
                No snapshots yet.<br />
                Snapshots are taken automatically every 5 minutes of activity.
              </p>
            ) : (
              snapshots.map((s) => (
                <div
                  key={s.id}
                  className={`snap-item ${selectedId === s.id ? 'snap-item--selected' : ''}`}
                  onClick={() => setSelectedId(s.id)}
                >
                  <span className="snap-item__label">{s.label}</span>
                  <button
                    className="snap-item__del"
                    onClick={(e) => handleDelete(e, s.id)}
                    title="Delete snapshot"
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Right: read-only preview */}
          <div className="snap-preview">
            {selectedId ? (
              <div
                ref={previewRef}
                className="snap-preview__editor notebook-editor"
              />
            ) : (
              <div className="snap-preview__empty">
                Select a snapshot to preview
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="snap-modal__footer">
          <button className="snap-btn snap-btn--ghost" onClick={onClose}>
            Close
          </button>
          <button
            className="snap-btn snap-btn--primary"
            onClick={handleRestore}
            disabled={!selectedId}
          >
            Restore this version
          </button>
        </div>

      </div>
    </div>
  );
}

// Re-export key so the useEffect above can reference it without a circular import
const SNAPSHOTS_KEY_LOCAL = 'snapshots';
