import { useEffect, useRef, useState } from 'react';
import type { DocMeta } from '../lib/docRegistry';

interface Props {
  docs: DocMeta[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onRestore: (meta: DocMeta) => void;
}

export function Sidebar({
  docs,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onRestore,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [recentlyDeleted, setRecentlyDeleted] = useState<DocMeta | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Defer focus to after the dblclick event chain completes — otherwise the
  // browser blurs the input before the user sees it.
  useEffect(() => {
    if (!editingId) return;
    const timer = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 10);
    return () => clearTimeout(timer);
  }, [editingId]);

  useEffect(
    () => () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    },
    [],
  );

  const startRename = (doc: DocMeta, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDeleteId(null);
    setEditingId(doc.id);
    setEditValue(doc.name);
  };

  const commitRename = () => {
    if (editingId && editValue.trim()) onRename(editingId, editValue.trim());
    setEditingId(null);
  };

  const handleRenameKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitRename();
    if (e.key === 'Escape') setEditingId(null);
  };

  const commitDelete = (doc: DocMeta, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDeleteId(null);
    onDelete(doc.id);
    setRecentlyDeleted(doc);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => setRecentlyDeleted(null), 5000);
  };

  const handleUndo = () => {
    if (!recentlyDeleted) return;
    onRestore(recentlyDeleted);
    setRecentlyDeleted(null);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar__header">
        <span className="sidebar__title">Documents</span>
      </div>

      <nav className="sidebar__list">
        {docs.map((doc) => (
          <div
            key={doc.id}
            className={`sidebar__item${doc.id === activeId ? ' sidebar__item--active' : ''}${confirmDeleteId === doc.id ? ' sidebar__item--confirming' : ''}`}
            onClick={() => {
              if (editingId === doc.id || confirmDeleteId === doc.id) return;
              if (doc.id !== activeId) onSelect(doc.id);
            }}
            onDoubleClick={(e) => startRename(doc, e)}
            title={editingId === doc.id ? undefined : doc.name}
          >
            {editingId === doc.id ? (
              <input
                ref={inputRef}
                className="sidebar__rename-input"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={handleRenameKey}
                onClick={(e) => e.stopPropagation()}
              />
            ) : confirmDeleteId === doc.id ? (
              <>
                <span className="sidebar__item-name sidebar__item-name--muted">
                  Delete "{doc.name}"?
                </span>
                <span className="sidebar__del-confirm">
                  <button
                    className="sidebar__del-yes"
                    onClick={(e) => commitDelete(doc, e)}
                  >
                    Delete
                  </button>
                  <button
                    className="sidebar__del-cancel"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDeleteId(null);
                    }}
                  >
                    Cancel
                  </button>
                </span>
              </>
            ) : (
              <>
                <span className="sidebar__item-name">{doc.name}</span>
                <span className="sidebar__item-actions">
                  <button
                    className="sidebar__action-btn"
                    title="Rename (or double-click)"
                    onClick={(e) => startRename(doc, e)}
                  >
                    ✎
                  </button>
                  {docs.length > 1 && (
                    <button
                      className="sidebar__action-btn sidebar__action-btn--delete"
                      title="Delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDeleteId(doc.id);
                      }}
                    >
                      ×
                    </button>
                  )}
                </span>
              </>
            )}
          </div>
        ))}
      </nav>

      <div className="sidebar__footer">
        {recentlyDeleted && (
          <div className="sidebar__undo-bar">
            <span className="sidebar__undo-label">
              Deleted "{recentlyDeleted.name}"
            </span>
            <button className="sidebar__undo-btn" onClick={handleUndo}>
              Undo
            </button>
          </div>
        )}
        <button className="sidebar__new-btn" onClick={onCreate}>
          + New document
        </button>
      </div>
    </aside>
  );
}
