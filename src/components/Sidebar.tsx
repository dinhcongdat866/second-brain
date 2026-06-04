import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DocMeta } from '../collab/registry';
import { MEMORY_DOC_ID } from '../collab/memory';
import type { MemoryLogEntry } from '../hooks/useMemory';
import type { Peer } from '../hooks/usePresence';
import { SUPPORTED_LANGS, type Lang } from '../i18n';
import i18n, { intlLocale } from '../i18n';
import { getApiKey, setApiKey, clearApiKey } from '../lib/apiKey';
import { useAuthStore } from '../stores/authStore';
import { Button } from './Button';

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
  peers?: Peer[];
  style?: React.CSSProperties;
  onBeforeSignOut?: () => void | Promise<void>;
  memoryLog?: MemoryLogEntry[];
  onDeleteMemoryEntry?: (id: string) => void;
}

const LANG_LABELS: Record<Lang, string> = { en: 'English', vi: 'Tiếng Việt' };

export function Sidebar({
  docs,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onRestore,
  peers = [],
  style,
  onBeforeSignOut,
  memoryLog = [],
  onDeleteMemoryEntry,
}: Props) {
  const { t, i18n: i18nInstance } = useTranslation();
  const currentLang = (i18nInstance.language?.startsWith('vi') ? 'vi' : 'en') as Lang;
  const { user, status: authStatus, signOut } = useAuthStore();

  const displayName = user?.user_metadata?.full_name as string | undefined
    ?? user?.email
    ?? t('sidebar.anonymousUser');
  const avatarLetter = (displayName[0] ?? '?').toUpperCase();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [recentlyDeleted, setRecentlyDeleted] = useState<DocMeta | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeySet, setApiKeySet] = useState(() => !!getApiKey());

  const inputRef = useRef<HTMLInputElement>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userBarRef = useRef<HTMLDivElement>(null);

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

  // Close user menu on outside click
  useEffect(() => {
    if (!userMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (!userBarRef.current?.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [userMenuOpen]);

  // F2 renames the currently active document
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
            <Button
              variant="danger"
              size="sm"
              onClick={(e) => commitDelete(doc, e)}
            >
              {t('sidebar.delete')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                setConfirmDeleteId(null);
              }}
            >
              {t('sidebar.cancel')}
            </Button>
          </span>
        </>
      ) : (
        <>
          <span className="sidebar__item-name">{doc.name}</span>
          <span className="sidebar__item-actions">
            <Button
              variant="icon"
              size="sm"
              title={t('sidebar.rename')}
              onClick={(e) => startRename(doc, e)}
            >
              ✎
            </Button>
            {docs.length > 1 && (
              <Button
                variant="icon"
                size="sm"
                className="nb-btn--icon-danger"
                title={t('sidebar.delete')}
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmDeleteId(doc.id);
                }}
              >
                ×
              </Button>
            )}
          </span>
        </>
      )}
    </div>
  );

  return (
    <aside className="sidebar" style={style}>
      {/* ── Brand header ── */}
      <div className="sidebar__brand">
        <span className="sidebar__brand-icon">✦</span>
        <span className="sidebar__brand-name">Second Brain</span>
        {peers.length > 0 && (
          <div className="sidebar__peers" aria-label={t('sidebar.activePeers', { count: peers.length })}>
            {peers.map((peer, i) => (
              <span
                key={i}
                className="sidebar__peer-avatar"
                style={{ background: peer.color }}
                title={peer.name}
              >
                {peer.name[0].toUpperCase()}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ── New document ── */}
      <div className="sidebar__new-doc">
        <Button variant="ghost" fullWidth onClick={onCreate}>
          {t('sidebar.newDocument')}
        </Button>
      </div>

      {/* ── Document list ── */}
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

      {/* ── Footer: undo + user bar ── */}
      <div className="sidebar__footer">
        {recentlyDeleted && (
          <div className="sidebar__undo-bar">
            <span className="sidebar__undo-label">
              {t('sidebar.deleted', { name: recentlyDeleted.name })}
            </span>
            <Button variant="primary" size="sm" onClick={handleUndo}>
              {t('sidebar.undo')}
            </Button>
          </div>
        )}

        {/* User bar */}
        <div className="sidebar__user-wrap" ref={userBarRef}>
          {userMenuOpen && (
            <div className="sidebar__user-menu">
              {/* Memory */}
              <div className="sidebar__user-menu-section">
                <div className="sidebar__memory-header">
                  <button
                    type="button"
                    className="sidebar__user-menu-item"
                    onClick={() => { onSelect(MEMORY_DOC_ID); setUserMenuOpen(false); }}
                  >
                    🧠 {t('sidebar.memory')}
                  </button>
                  {memoryLog.length > 0 && (
                    <span className="sidebar__memory-badge">{memoryLog.length}</span>
                  )}
                </div>
                {memoryLog.length > 0 && (
                  <div className="sidebar__memory-log">
                    {memoryLog.slice(0, 5).map((entry) => (
                      <div key={entry.id} className="sidebar__memory-entry">
                        <span className="sidebar__memory-entry-text">{entry.content}</span>
                        <button
                          type="button"
                          className="sidebar__memory-entry-del"
                          onClick={() => onDeleteMemoryEntry?.(entry.id)}
                          title={t('sidebar.memoryDelete')}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="sidebar__user-menu-divider" />

              {/* API Key section */}
              <div className="sidebar__user-menu-section">
                <span className="sidebar__user-menu-label">{t('ai.apiKey.heading')}</span>
                {apiKeySet ? (
                  <div className="sidebar__key-row">
                    <span className="sidebar__key-saved">{t('ai.apiKey.saved')}</span>
                    <button
                      type="button"
                      className="sidebar__key-action"
                      onClick={() => { clearApiKey(); setApiKeySet(false); setApiKeyInput(''); }}
                    >
                      {t('ai.apiKey.clear')}
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="sidebar__key-row">
                      <input
                        type="password"
                        className="sidebar__key-input"
                        placeholder="sk-ant-..."
                        value={apiKeyInput}
                        onChange={(e) => setApiKeyInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && apiKeyInput.trim()) {
                            setApiKey(apiKeyInput.trim());
                            setApiKeySet(true);
                            setApiKeyInput('');
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="sidebar__key-action"
                        disabled={!apiKeyInput.trim()}
                        onClick={() => {
                          if (!apiKeyInput.trim()) return;
                          setApiKey(apiKeyInput.trim());
                          setApiKeySet(true);
                          setApiKeyInput('');
                        }}
                      >
                        {t('ai.apiKey.save')}
                      </button>
                    </div>
                    <span className="sidebar__key-hint">{t('ai.apiKey.hint')}</span>
                  </>
                )}
              </div>

              <div className="sidebar__user-menu-divider" />

              {/* Sign out */}
              {authStatus === 'authenticated' && (
                <>
                  <div className="sidebar__user-menu-section">
                    <button
                      type="button"
                      className="sidebar__lang-btn"
                      onClick={async () => {
                        setUserMenuOpen(false);
                        await onBeforeSignOut?.();
                        signOut();
                      }}
                    >
                      {t('sidebar.signOut')}
                    </button>
                  </div>
                  <div className="sidebar__user-menu-divider" />
                </>
              )}

              {/* Language section */}
              <div className="sidebar__user-menu-section">
                <span className="sidebar__user-menu-label">{t('sidebar.language')}</span>
                <div className="sidebar__user-menu-langs">
                  {SUPPORTED_LANGS.map((lng) => (
                    <button
                      key={lng}
                      type="button"
                      className={'sidebar__lang-btn' + (currentLang === lng ? ' is-active' : '')}
                      onClick={() => { i18nInstance.changeLanguage(lng); setUserMenuOpen(false); }}
                    >
                      {LANG_LABELS[lng]}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <button
            type="button"
            className="sidebar__user-bar"
            onClick={() => setUserMenuOpen((v) => !v)}
          >
            <span className="sidebar__user-avatar">{avatarLetter}</span>
            <span className="sidebar__user-info">
              <span className="sidebar__user-name">{displayName}</span>
            </span>
          </button>
        </div>
      </div>
    </aside>
  );
}
