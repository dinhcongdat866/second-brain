import { useEffect, useRef, useState } from 'react';
import type { DocMeta } from '../lib/docRegistry';

// ---------------------------------------------------------------------------
// Date grouping helpers
// ---------------------------------------------------------------------------

function getGroupLabel(isoStr: string): string {
  const date = new Date(isoStr);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const docDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((todayStart.getTime() - docDay.getTime()) / 86_400_000);

  if (diffDays === 0) return 'Hôm nay';
  if (diffDays === 1) return 'Hôm qua';
  if (diffDays <= 7) return `${diffDays} ngày trước`;
  if (diffDays <= 30) return '30 ngày qua';
  return date.toLocaleDateString('vi-VN', { month: 'long', year: 'numeric' });
}

function getGroupTooltip(isoStr: string): string {
  return new Date(isoStr).toLocaleDateString('vi-VN', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

interface DocGroup {
  label: string;
  tooltip: string;
  docs: DocMeta[];
}

function groupDocsByDate(docs: DocMeta[]): DocGroup[] {
  const map = new Map<string, DocMeta[]>();
  for (const doc of docs) {
    const label = getGroupLabel(doc.updatedAt);
    if (!map.has(label)) map.set(label, []);
    map.get(label)!.push(doc);
  }
  return Array.from(map.entries()).map(([label, groupDocs]) => ({
    label,
    tooltip: getGroupTooltip(groupDocs[0].updatedAt),
    docs: groupDocs,
  }));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  docs: DocMeta[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onRestore: (meta: DocMeta) => void;
  style?: React.CSSProperties;
}

export function Sidebar({
  docs,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onRestore,
  style,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [recentlyDeleted, setRecentlyDeleted] = useState<DocMeta | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const groups = groupDocsByDate(docs);

  const renderDocItem = (doc: DocMeta) => (
    <div
      key={doc.id}
      className={
        `sidebar__item` +
        (doc.id === activeId ? ' sidebar__item--active' : '') +
        (confirmDeleteId === doc.id ? ' sidebar__item--confirming' : '')
      }
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
  );

  return (
    <aside className="sidebar" style={style}>
      <div className="sidebar__header">
        <span className="sidebar__title">Documents</span>
      </div>

      <nav className="sidebar__list">
        {groups.map(({ label, tooltip, docs: groupDocs }) => (
          <div key={label} className="sidebar__group">
            <div className="sidebar__group-label" title={tooltip}>
              {label}
            </div>
            {groupDocs.map(renderDocItem)}
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
