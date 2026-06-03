import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DocMeta } from '../collab/registry';
import i18n, { intlLocale } from '../i18n';

// ---------------------------------------------------------------------------
// Date grouping helpers
// ---------------------------------------------------------------------------

function getGroupLabel(isoStr: string): string {
  const date = new Date(isoStr);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const docDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((todayStart.getTime() - docDay.getTime()) / 86_400_000);

  if (diffDays === 0) return i18n.t('date.today');
  if (diffDays === 1) return i18n.t('date.yesterday');
  if (diffDays <= 7) return i18n.t('date.daysAgo', { count: diffDays });
  if (diffDays <= 30) return i18n.t('date.last30Days');
  return date.toLocaleDateString(intlLocale(), { month: 'long', year: 'numeric' });
}

function getGroupTooltip(isoStr: string): string {
  return new Date(isoStr).toLocaleDateString(intlLocale(), {
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

function formatExactTime(isoStr: string): string {
  return new Date(isoStr).toLocaleString(intlLocale(), {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function groupDocsByDate(docs: DocMeta[]): DocGroup[] {
  // Sort most-recently-updated first so groups and items appear in descending order.
  const sorted = [...docs].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  const map = new Map<string, DocMeta[]>();
  for (const doc of sorted) {
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
  const { t } = useTranslation();
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

  // F2 renames the currently active document.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'F2') return;
      const activeDoc = docs.find((d) => d.id === activeId);
      if (!activeDoc || editingId) return;
      e.preventDefault();
      setEditingId(activeDoc.id);
      setEditValue(activeDoc.name);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [docs, activeId, editingId]);

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
      title={editingId === doc.id ? undefined : formatExactTime(doc.updatedAt)}
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
            {t('sidebar.deleteConfirm', { name: doc.name })}
          </span>
          <span className="sidebar__del-confirm">
            <button
              className="sidebar__del-yes"
              onClick={(e) => commitDelete(doc, e)}
            >
              {t('sidebar.delete')}
            </button>
            <button
              className="sidebar__del-cancel"
              onClick={(e) => {
                e.stopPropagation();
                setConfirmDeleteId(null);
              }}
            >
              {t('sidebar.cancel')}
            </button>
          </span>
        </>
      ) : (
        <>
          <span className="sidebar__item-name">{doc.name}</span>
          <span className="sidebar__item-actions">
            <button
              className="sidebar__action-btn"
              title={t('sidebar.rename')}
              onClick={(e) => startRename(doc, e)}
            >
              ✎
            </button>
            {docs.length > 1 && (
              <button
                className="sidebar__action-btn sidebar__action-btn--delete"
                title={t('sidebar.delete')}
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
        <span className="sidebar__title">{t('sidebar.documents')}</span>
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
              {t('sidebar.deleted', { name: recentlyDeleted.name })}
            </span>
            <button className="sidebar__undo-btn" onClick={handleUndo}>
              {t('sidebar.undo')}
            </button>
          </div>
        )}
        <button className="sidebar__new-btn" onClick={onCreate}>
          {t('sidebar.newDocument')}
        </button>
      </div>
    </aside>
  );
}
