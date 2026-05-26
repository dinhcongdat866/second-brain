import { useEffect, useReducer, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { addTurn, type TurnRole, type YThread } from '../collab/aiThreads';
import { streamClaudeReply } from '../collab/claudeStream';
import { formatSmartDate, formatFullDate } from '../lib/formatDate';
import { upsertUserTurn, searchCells } from '../lib/backendSync';

// ---------------------------------------------------------------------------
// Icons (inline SVG — no external dependency)
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

// ---------------------------------------------------------------------------
// useTurns — re-render on any Yjs change in the thread
// ---------------------------------------------------------------------------

function useTurns(thread: YThread) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const handler = () => bump();
    thread.observeDeep(handler);
    return () => thread.unobserveDeep(handler);
  }, [thread]);
  return thread.toArray().map((turn) => ({
    role: turn.get('role') as TurnRole,
    content: (turn.get('content') as Y.Text).toString(),
    createdAt: (turn.get('created_at') as string) ?? '',
  }));
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
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  // Edit mode: index in thread from which turns will be replaced on next submit.
  // Thread is NOT modified yet — cancel leaves everything intact.
  const [editFromIdx, setEditFromIdx] = useState<number | null>(null);

  // Two-step delete confirmation: first click → pendingDelete, second → onDelete.
  const [pendingDelete, setPendingDelete] = useState(false);
  useEffect(() => {
    if (!pendingDelete) return;
    const t = setTimeout(() => setPendingDelete(false), 3000);
    return () => clearTimeout(t);
  }, [pendingDelete]);

  const inputRef = useRef<HTMLInputElement>(null);

  // Streaming → done: briefly flag `finishing` for the final aurora gust.
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

  const submit = () => {
    const text = prompt.trim();
    if (!text || streaming) return;
    setError(null);

    // In edit mode: delete the overwritten turns first, then proceed normally.
    if (editFromIdx !== null) {
      const deleteCount = thread.length - editFromIdx;
      if (deleteCount > 0) thread.delete(editFromIdx, deleteCount);
      setEditFromIdx(null);
    }

    addTurn(thread, 'user', text);
    upsertUserTurn(cellId, docId, text);
    const assistant = addTurn(thread, 'assistant');
    const yText = assistant.get('content') as Y.Text;
    setPrompt('');
    setStreaming(true);

    const history = thread
      .toArray()
      .slice(0, -1)
      .map((t) => ({
        role: t.get('role') as TurnRole,
        content: (t.get('content') as Y.Text).toString(),
      }));

    // Fetch semantically related notes, then stream. Fire in parallel with
    // no await on search so UI feels instant — search result arrives fast
    // enough before the first token anyway.
    searchCells(text, 3).then((results) => {
      const ragContext = results
        .filter((r) => r.score > 0.3)
        .map((r) => r.content)
        .join('\n\n');

      streamClaudeReply(
        getLocalContext(),
        getDocContext(),
        history,
        yText,
        () => setStreaming(false),
        (err) => {
          setStreaming(false);
          setError(err.message);
        },
        ragContext,
      );
    });
  };

  // Start editing the last user turn without immediately modifying the thread.
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
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(text.length, text.length);
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

  // Index of last user turn (for the edit button)
  let lastUserTurnIdx = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'user') { lastUserTurnIdx = i; break; }
  }

  const previewText =
    turns.length > 0 ? turns[0].content.slice(0, 60) : 'Chưa có hội thoại';

  return (
    <div
      className={
        'ai-cell__inner' +
        (streaming ? ' is-streaming' : '') +
        (finishing ? ' is-finishing' : '') +
        (minimized ? ' is-minimized' : '')
      }
    >
      {/* ── Header ── */}
      <div className="ai-cell__header">
        <span className="ai-cell__badge">✦ AI</span>
        {minimized && (
          <span className="ai-cell__preview">{previewText}</span>
        )}
        <div className="ai-cell__header-actions">
          <button
            type="button"
            className="ai-cell__icon-btn"
            onClick={() => { setMinimized((v) => !v); setPendingDelete(false); }}
            title={minimized ? 'Mở rộng' : 'Thu gọn'}
          >
            {minimized ? '▶' : '▼'}
          </button>

          {/* Two-step delete confirmation */}
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
      </div>

      {/* ── Body ── */}
      {!minimized && (
        <>
          <div className="ai-cell__turns">
            {turns.length === 0 && (
              <div className="ai-cell__empty">Hỏi AI về nội dung phía trên…</div>
            )}

            {turns.map((turn, i) => {
              // Turns at or after editFromIdx are "pending replacement"
              const isPendingReplace =
                editFromIdx !== null && i >= editFromIdx;

              return (
                <div
                  key={i}
                  className={
                    `ai-turn ai-turn--${turn.role}` +
                    (isPendingReplace ? ' ai-turn--pending-replace' : '')
                  }
                >
                  <div className="ai-turn__meta">
                    <span className="ai-turn__role">
                      {turn.role === 'user' ? 'Bạn' : 'AI'}
                    </span>
                    {turn.createdAt && (
                      <span
                        className="ai-turn__time"
                        title={formatFullDate(turn.createdAt)}
                      >
                        {formatSmartDate(turn.createdAt)}
                      </span>
                    )}
                    {isPendingReplace && (
                      <span className="ai-turn__replace-badge">sẽ bị thay</span>
                    )}
                  </div>

                  <div className="ai-turn__content">
                    {turn.content}
                    {turn.role === 'assistant' &&
                      turn.content === '' &&
                      streaming && (
                        <span className="ai-turn__cursor">▍</span>
                      )}
                  </div>

                  {/* Action buttons */}
                  <div className="ai-turn__actions">
                    {turn.role === 'assistant' && turn.content && !isPendingReplace && (
                      <button
                        type="button"
                        className="ai-turn__action-btn"
                        onClick={() => copyTurn(turn.content, i)}
                        title="Copy"
                      >
                        {copiedIdx === i ? <IconCheck /> : <IconCopy />}
                      </button>
                    )}
                    {turn.role === 'user' &&
                      i === lastUserTurnIdx &&
                      !streaming &&
                      editFromIdx === null && (
                        <button
                          type="button"
                          className="ai-turn__action-btn"
                          onClick={startEdit}
                          title="Sửa tin nhắn này"
                        >
                          <IconPencil />
                        </button>
                      )}
                  </div>
                </div>
              );
            })}

            {error && <div className="ai-cell__error">{error}</div>}
          </div>

          {/* ── Input ── */}
          <div className="ai-cell__input">
            <input
              ref={inputRef}
              type="text"
              value={prompt}
              placeholder={editFromIdx !== null ? 'Sửa và gửi lại…' : 'Nhập prompt cho AI…'}
              disabled={streaming}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); submit(); }
                if (e.key === 'Escape' && editFromIdx !== null) { e.preventDefault(); cancelEdit(); }
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
            <button
              type="button"
              onClick={submit}
              disabled={streaming || prompt.trim() === ''}
            >
              {editFromIdx !== null ? 'Gửi lại' : 'Gửi'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
