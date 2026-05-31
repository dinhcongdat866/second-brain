import { createPortal } from 'react-dom';
import { useEffect, useReducer, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import * as Y from 'yjs';
import { addTurn, type TurnRole, type YThread } from '../collab/aiThreads';
import {
  streamClaudeReply,
  type UsageStats,
  type ModelConfig,
  DEFAULT_MODEL_CONFIG,
  MODELS,
} from '../collab/claudeStream';
import { compressHistory } from '../collab/historyCompressor';
import { formatSmartDate, formatFullDate } from '../lib/formatDate';
import { upsertUserTurn, searchCells, logUsage } from '../lib/backendSync';

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function IconCopy() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function IconPencil() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  );
}

function IconMaximize() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

function IconMinimize() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="10" y1="14" x2="3" y2="21" />
      <line x1="21" y1="3" x2="14" y2="10" />
    </svg>
  );
}

function IconSend() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 10 4 15 9 20" />
      <path d="M20 4v7a4 4 0 0 1-4 4H4" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// useTurns
// ---------------------------------------------------------------------------

function useTurns(thread: YThread) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const handler = () => bump();
    thread.observeDeep(handler);
    return () => thread.unobserveDeep(handler);
  }, [thread]);
  return thread.toArray().map((turn) => {
    const thinkingYText = turn.get('thinking') as Y.Text | undefined;
    const rawSources = turn.get('search_sources') as string | undefined;
    return {
      role: turn.get('role') as TurnRole,
      content: (turn.get('content') as Y.Text).toString(),
      createdAt: (turn.get('created_at') as string) ?? '',
      tokensIn: turn.get('tokens_in') as number | undefined,
      tokensOut: turn.get('tokens_out') as number | undefined,
      costUsd: turn.get('cost_usd') as number | undefined,
      thinking: thinkingYText ? thinkingYText.toString() : undefined,
      searchQuery: (turn.get('search_query') as string | undefined) ?? undefined,
      searchSources: rawSources ? (JSON.parse(rawSources) as { url: string; title: string }[]) : undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// TurnContent — plain text for user, markdown for assistant
// ---------------------------------------------------------------------------

function TurnContent({
  role,
  content,
  isStreaming,
  isLastTurn,
}: {
  role: TurnRole;
  content: string;
  isStreaming: boolean;
  isLastTurn: boolean;
}) {
  if (role === 'user') {
    return <div className="ai-turn__content">{content}</div>;
  }

  return (
    <div className="ai-turn__content ai-turn__md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      {isStreaming && isLastTurn && (
        <span className="ai-turn__cursor">▍</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AiCell
// ---------------------------------------------------------------------------

export function AiCell({
  thread,
  getLocalContext,
  getDocContext,
  onDelete,
  cellId,
  docId,
}: {
  thread: YThread;
  getLocalContext: () => string;
  getDocContext: () => string;
  onDelete: () => void;
  cellId: string;
  docId: string;
}) {
  const turns = useTurns(thread);
  const [prompt, setPrompt] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const [editFromIdx, setEditFromIdx] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState(false);
  useEffect(() => {
    if (!pendingDelete) return;
    const t = setTimeout(() => setPendingDelete(false), 3000);
    return () => clearTimeout(t);
  }, [pendingDelete]);

  // Close maximize with Escape
  useEffect(() => {
    if (!maximized) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setMaximized(false); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [maximized]);

  const [sessionCost, setSessionCost] = useState(0);
  const [modelConfig, setModelConfig] = useState<ModelConfig>(DEFAULT_MODEL_CONFIG);
  const [configOpen, setConfigOpen] = useState(false);
  const [panelAnchor, setPanelAnchor] = useState<{ top: number; left: number } | null>(null);
  const [searchingActive, setSearchingActive] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState<Record<number, boolean>>({});

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modalInputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const configPanelRef = useRef<HTMLDivElement>(null);
  const configBtnRef = useRef<HTMLButtonElement>(null);
  const modalConfigBtnRef = useRef<HTMLButtonElement>(null);
  const activeConfigBtnRef = useRef<HTMLButtonElement | null>(null);
  const turnsEndRef = useRef<HTMLDivElement>(null);

  const openConfigFrom = (btnRef: React.RefObject<HTMLButtonElement>) => {
    activeConfigBtnRef.current = btnRef.current;
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) setPanelAnchor({ top: rect.bottom + 4, left: rect.left });
    setConfigOpen(true);
  };

  // Close config panel on outside click
  useEffect(() => {
    if (!configOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        !configPanelRef.current?.contains(e.target as Node) &&
        !configBtnRef.current?.contains(e.target as Node) &&
        !modalConfigBtnRef.current?.contains(e.target as Node)
      ) {
        setConfigOpen(false);
        setPanelAnchor(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [configOpen]);

  // Keep portal panel anchored when page scrolls
  useEffect(() => {
    if (!configOpen) return;
    const update = () => {
      const rect = activeConfigBtnRef.current?.getBoundingClientRect();
      if (rect) setPanelAnchor({ top: rect.bottom + 4, left: rect.left });
    };
    window.addEventListener('scroll', update, true);
    return () => window.removeEventListener('scroll', update, true);
  }, [configOpen]);

  // Scroll last turn into view when new turn added or streaming starts
  useEffect(() => {
    turnsEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [turns.length, streaming]);
  const [finishing, setFinishing] = useState(false);
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (wasStreamingRef.current && !streaming) {
      setFinishing(true);
      const t = setTimeout(() => setFinishing(false), 1000);
      wasStreamingRef.current = streaming;
      return () => clearTimeout(t);
    }
    wasStreamingRef.current = streaming;
  }, [streaming]);

  // Auto-grow textarea
  const growTextarea = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

  const submit = () => {
    const text = prompt.trim();
    if (!text || streaming) return;
    setError(null);

    if (editFromIdx !== null) {
      const deleteCount = thread.length - editFromIdx;
      if (deleteCount > 0) thread.delete(editFromIdx, deleteCount);
      setEditFromIdx(null);
    }

    addTurn(thread, 'user', text);
    upsertUserTurn(cellId, docId, text);
    const assistant = addTurn(thread, 'assistant');
    const yText = assistant.get('content') as Y.Text;

    // Thinking Y.Text — created before stream so peers see it immediately.
    const thinkingEnabled = modelConfig.thinking && modelConfig.model !== 'claude-haiku-4-5-20251001';
    let thinkingText: Y.Text | undefined;
    if (thinkingEnabled) {
      thinkingText = new Y.Text();
      assistant.set('thinking', thinkingText);
    }
    setPrompt('');
    setSearchingActive(false);
    if (inputRef.current) inputRef.current.style.height = 'auto';
    if (modalInputRef.current) modalInputRef.current.style.height = 'auto';
    setStreaming(true);

    const history = thread
      .toArray()
      .slice(0, -1)
      .map((t) => ({
        role: t.get('role') as TurnRole,
        content: (t.get('content') as Y.Text).toString(),
      }));

    const ac = new AbortController();
    abortRef.current = ac;

    searchCells(text, 3)
      .then(async (results) => {
        if (ac.signal.aborted) return;
        const ragContext = results
          .filter((r) => r.score > 0.3)
          .map((r) => r.content)
          .join('\n\n');

        const compressed = await compressHistory(history, ac.signal);
        if (ac.signal.aborted) return;

        return streamClaudeReply(
          getLocalContext(),
          getDocContext(),
          compressed,
          yText,
          (usage: UsageStats) => {
            assistant.set('created_at', new Date().toISOString());
            if (usage.inputTokens > 0) {
              assistant.set('tokens_in', usage.inputTokens);
              assistant.set('tokens_out', usage.outputTokens);
              assistant.set('cost_usd', usage.costUsd);
              logUsage(docId, cellId, usage);
            }
            setSessionCost((prev) => prev + usage.costUsd);
            abortRef.current = null;
            setStreaming(false);
          },
          (err) => {
            abortRef.current = null;
            setStreaming(false);
            setError(err.message);
          },
          {
            ragContext,
            signal: ac.signal,
            config: modelConfig,
            thinkingTarget: thinkingText,
            onSearching: (q) => {
              assistant.set('search_query', q);
              setSearchingActive(true);
            },
            onSearchResults: (sources) => {
              assistant.set('search_sources', JSON.stringify(sources));
              setSearchingActive(false);
            },
          },
        );
      })
      .catch((err: unknown) => {
        abortRef.current = null;
        setStreaming(false);
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const startEdit = () => {
    if (streaming) return;
    const arr = thread.toArray();
    let lastUserIdx = -1;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].get('role') === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx === -1) return;
    const text = (arr[lastUserIdx].get('content') as Y.Text).toString();
    setEditFromIdx(lastUserIdx);
    setPrompt(text);
    setError(null);
    requestAnimationFrame(() => {
      const ref = maximized ? modalInputRef.current : inputRef.current;
      ref?.focus();
      ref?.setSelectionRange(text.length, text.length);
    });
  };

  const cancelEdit = () => {
    setEditFromIdx(null);
    setPrompt('');
    setError(null);
  };

  const copyTurn = (content: string, idx: number) => {
    navigator.clipboard.writeText(content).then(() => {
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1500);
    });
  };

  let lastUserTurnIdx = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'user') { lastUserTurnIdx = i; break; }
  }

  const previewText =
    turns.length > 0 ? turns[0].content.slice(0, 60) : 'Chưa có hội thoại';

  // ---------------------------------------------------------------------------
  // Shared render pieces
  // ---------------------------------------------------------------------------

  const renderTurns = () => (
    <div className="ai-cell__turns">
      {turns.length === 0 && (
        <div className="ai-cell__empty">Hỏi AI về nội dung phía trên…</div>
      )}

      {turns.map((turn, i) => {
        const isPendingReplace = editFromIdx !== null && i >= editFromIdx;
        const isLastTurn = i === turns.length - 1;

        return (
          <div
            key={i}
            className={
              `ai-turn ai-turn--${turn.role}` +
              (isPendingReplace ? ' ai-turn--pending-replace' : '')
            }
          >
            {turn.role === 'user' ? (
              // User: bubble wraps label + content only; actions sit below
              <>
                <div className="ai-turn__bubble">
                  <div className="ai-turn__meta">
                    <span className="ai-turn__role">Bạn</span>
                    {isPendingReplace && (
                      <span className="ai-turn__replace-badge">sẽ bị thay</span>
                    )}
                  </div>
                  <TurnContent
                    role={turn.role}
                    content={turn.content}
                    isStreaming={streaming}
                    isLastTurn={isLastTurn}
                  />
                </div>
                <div className="ai-turn__actions">
                  {i === lastUserTurnIdx && !streaming && editFromIdx === null && (
                    <button
                      type="button"
                      className="ai-turn__action-btn"
                      onClick={startEdit}
                      title="Sửa tin nhắn này"
                    >
                      <IconPencil />
                    </button>
                  )}
                  {turn.createdAt && (
                    <span className="ai-turn__time" title={formatFullDate(turn.createdAt)}>
                      {formatSmartDate(turn.createdAt)}
                    </span>
                  )}
                </div>
              </>
            ) : (
              // Assistant: no bubble, actions inline below content
              <>
                {turn.searchQuery && (
                  <details className="ai-turn__search">
                    <summary className={'ai-turn__search-summary' + (isLastTurn && searchingActive ? ' is-active' : '')}>
                      🌐 {turn.searchSources ? `Đã tìm: "${turn.searchQuery}"` : `Đang tìm: "${turn.searchQuery}"…`}
                    </summary>
                    {turn.searchSources && (
                      <div className="ai-cell__search-sources">
                        {turn.searchSources.map((s, si) => (
                          <a
                            key={si}
                            href={s.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ai-cell__search-source"
                            title={s.url}
                          >
                            <span className="ai-cell__search-source-num">{si + 1}</span>
                            <span className="ai-cell__search-source-title">{s.title}</span>
                          </a>
                        ))}
                      </div>
                    )}
                  </details>
                )}
                {turn.thinking && (
                  <details
                    className="ai-turn__thinking"
                    open={
                      (streaming && isLastTurn && !turn.content)
                        ? true
                        : (thinkingOpen[i] ?? true)
                    }
                    onToggle={(e) => {
                      if (!(streaming && isLastTurn && !turn.content)) {
                        setThinkingOpen((prev) => ({ ...prev, [i]: (e.target as HTMLDetailsElement).open }));
                      }
                    }}
                  >
                    <summary>
                      💭 Suy nghĩ
                      {streaming && isLastTurn && !turn.content && (
                        <span className="ai-turn__cursor" style={{ marginLeft: 4 }}>▍</span>
                      )}
                    </summary>
                    <div className="ai-turn__thinking-content">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.thinking}</ReactMarkdown>
                    </div>
                  </details>
                )}
                <TurnContent
                  role={turn.role}
                  content={turn.content}
                  isStreaming={streaming}
                  isLastTurn={isLastTurn}
                />
                <div className="ai-turn__actions">
                  {turn.content && !isPendingReplace && (
                    <button
                      type="button"
                      className="ai-turn__action-btn"
                      onClick={() => copyTurn(turn.content, i)}
                      title="Copy"
                    >
                      {copiedIdx === i ? <IconCheck /> : <IconCopy />}
                    </button>
                  )}
                  {turn.tokensIn !== undefined && (
                    <span
                      className="ai-turn__usage-cost"
                      title={`${turn.tokensIn.toLocaleString()} input · ${(turn.tokensOut ?? 0).toLocaleString()} output`}
                    >
                      💸 ${(turn.costUsd ?? 0).toFixed(4)}
                    </span>
                  )}
                  {turn.createdAt && (
                    <span className="ai-turn__time" title={formatFullDate(turn.createdAt)}>
                      {formatSmartDate(turn.createdAt)}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        );
      })}

      {error && <div className="ai-cell__error">{error}</div>}
      <div ref={turnsEndRef} />
    </div>
  );

  const renderInput = (ref: React.RefObject<HTMLTextAreaElement | null>) => (
    <div className="ai-cell__input">
      <textarea
        ref={ref}
        rows={1}
        value={prompt}
        placeholder={editFromIdx !== null ? 'Sửa và gửi lại…' : 'Nhập prompt cho AI…'}
        disabled={streaming}
        onChange={(e) => {
          setPrompt(e.target.value);
          growTextarea(e.target);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
          if (e.key === 'Escape' && editFromIdx !== null) {
            e.preventDefault();
            cancelEdit();
          }
        }}
      />
      {editFromIdx !== null && (
        <button
          type="button"
          className="ai-cell__cancel-btn"
          onClick={cancelEdit}
          title="Huỷ chỉnh sửa (Esc)"
        >
          Huỷ
        </button>
      )}
      {streaming ? (
        <button
          type="button"
          className="ai-cell__stop-btn"
          onClick={() => abortRef.current?.abort()}
          title="Dừng stream"
        >
          ■ Dừng
        </button>
      ) : editFromIdx !== null ? (
        <button type="button" onClick={submit} disabled={prompt.trim() === ''}>
          Gửi lại
        </button>
      ) : (
        <button
          type="button"
          className="ai-cell__send-btn"
          onClick={submit}
          disabled={prompt.trim() === ''}
          title="Gửi (Enter)"
        >
          <IconSend />
        </button>
      )}
    </div>
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <>
      <div
        className={
          'ai-cell__inner' +
          (streaming ? ' is-streaming' : '') +
          (finishing ? ' is-finishing' : '') +
          (minimized ? ' is-minimized' : '')
        }
      >
        {/* Header */}
        <div className="ai-cell__header">
          {/* Left: badge + session cost */}
          <span className="ai-cell__badge">✦ AI</span>
          {sessionCost > 0 && (
            <span className="ai-cell__session-cost" title="Tổng chi phí session này">
              💸 ${sessionCost.toFixed(4)}
            </span>
          )}
          {minimized && (
            <span className="ai-cell__preview">{previewText}</span>
          )}

          {/* Right group: config button + actions */}
          <div className="ai-cell__header-right">
            <button
              ref={configBtnRef}
              type="button"
              className="ai-cell__config-btn"
              onClick={() => {
                if (configOpen) { setConfigOpen(false); setPanelAnchor(null); }
                else openConfigFrom(configBtnRef);
              }}
            >
              {MODELS.find((m) => m.id === modelConfig.model)?.label ?? 'Sonnet'}
              {modelConfig.thinking ? ' · Think' : ''}
              {modelConfig.webSearch ? ' · 🌐' : ''}
              {' ▾'}
            </button>

          <div className="ai-cell__header-actions">
            <button
              type="button"
              className="ai-cell__icon-btn"
              onClick={() => setMaximized(true)}
              title="Xem toàn màn hình"
            >
              <IconMaximize />
            </button>

            <button
              type="button"
              className="ai-cell__icon-btn"
              onClick={() => { setMinimized((v) => !v); setPendingDelete(false); }}
              title={minimized ? 'Mở rộng' : 'Thu gọn'}
            >
              {minimized ? '▶' : '▼'}
            </button>

            {pendingDelete ? (
              <>
                <span className="ai-cell__del-label">Xoá?</span>
                <button
                  type="button"
                  className="ai-cell__icon-btn ai-cell__delete--confirm"
                  onClick={onDelete}
                  title="Xác nhận xoá"
                >
                  ✓
                </button>
                <button
                  type="button"
                  className="ai-cell__icon-btn"
                  onClick={() => setPendingDelete(false)}
                  title="Huỷ"
                >
                  ✗
                </button>
              </>
            ) : (
              <button
                type="button"
                className="ai-cell__icon-btn ai-cell__delete"
                onClick={() => setPendingDelete(true)}
                title="Xoá AI cell (Ctrl+Z để khôi phục)"
              >
                ✕
              </button>
            )}
          </div>
          </div>{/* end header-right */}
        </div>

        {/* Body */}
        {!minimized && (
          <>
            {renderTurns()}
            {renderInput(inputRef)}
          </>
        )}
      </div>

      {/* Config panel — portal to escape overflow:hidden stacking context */}
      {configOpen && panelAnchor && createPortal(
        <div
          ref={configPanelRef}
          className="ai-cell__config-panel"
          style={{ top: panelAnchor.top, left: panelAnchor.left }}
        >
          <div className="ai-cell__config-section">
            <span className="ai-cell__config-heading">Model</span>
            {MODELS.map((m) => (
              <button
                key={m.id}
                type="button"
                className={'ai-cell__config-option' + (modelConfig.model === m.id ? ' is-active' : '')}
                onClick={() => {
                  setModelConfig((c) => ({
                    ...c,
                    model: m.id,
                    thinking: m.supportsThinking ? c.thinking : false,
                  }));
                  setConfigOpen(false);
                  setPanelAnchor(null);
                }}
              >
                <span>{m.label}</span>
                <span className="ai-cell__config-desc">{m.desc}</span>
              </button>
            ))}
          </div>

          <div className="ai-cell__config-divider" />

          <div className="ai-cell__config-section">
            <span className="ai-cell__config-heading">Tính năng</span>
            <label className={
              'ai-cell__config-toggle' +
              (MODELS.find((m) => m.id === modelConfig.model)?.supportsThinking ? '' : ' is-disabled')
            }>
              <input
                type="checkbox"
                checked={modelConfig.thinking}
                disabled={!MODELS.find((m) => m.id === modelConfig.model)?.supportsThinking}
                onChange={(e) => setModelConfig((c) => ({ ...c, thinking: e.target.checked }))}
              />
              💭 Extended Thinking
            </label>
            <label className="ai-cell__config-toggle">
              <input
                type="checkbox"
                checked={modelConfig.webSearch}
                onChange={(e) => setModelConfig((c) => ({ ...c, webSearch: e.target.checked }))}
              />
              🌐 Web Search
            </label>
          </div>
        </div>,
        document.body,
      )}

      {/* Maximize modal */}
      {maximized && createPortal(
        <div
          className="ai-cell__modal-overlay"
          onClick={() => setMaximized(false)}
        >
          <div
            className={
              'ai-cell__modal' +
              (streaming ? ' is-streaming' : '') +
              (finishing ? ' is-finishing' : '')
            }
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ai-cell__modal-header">
              <span className="ai-cell__badge">✦ AI</span>
              <div className="ai-cell__header-right">
                <button
                  ref={modalConfigBtnRef}
                  type="button"
                  className="ai-cell__config-btn"
                  onClick={() => {
                    if (configOpen) { setConfigOpen(false); setPanelAnchor(null); }
                    else openConfigFrom(modalConfigBtnRef);
                  }}
                >
                  {MODELS.find((m) => m.id === modelConfig.model)?.label ?? 'Sonnet'}
                  {modelConfig.thinking ? ' · Think' : ''}
                  {modelConfig.webSearch ? ' · 🌐' : ''}
                  {' ▾'}
                </button>
                <button
                  type="button"
                  className="ai-cell__icon-btn"
                  onClick={() => setMaximized(false)}
                  title="Thu nhỏ (Esc)"
                >
                  <IconMinimize />
                </button>
              </div>
            </div>
            <div className="ai-cell__modal-body">
              {renderTurns()}
            </div>
            {renderInput(modalInputRef)}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
