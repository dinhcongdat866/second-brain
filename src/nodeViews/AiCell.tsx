import { useEffect, useReducer, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { addTurn, type TurnRole, type YThread } from '../collab/aiThreads';
import { streamClaudeReply } from '../collab/claudeStream';

/** Re-render whenever the thread (or any nested turn / Y.Text) changes. */
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
  }));
}

export function AiCell({
  thread,
  getDocContext,
  onDelete,
}: {
  thread: YThread;
  getDocContext: () => string;
  onDelete: () => void;
}) {
  const turns = useTurns(thread);
  const [prompt, setPrompt] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // On the streaming→done transition, briefly flag `finishing` so the wind
  // animation re-runs once at a faster duration — a final "gust" before
  // the cell settles back to plain white.
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
    addTurn(thread, 'user', text);
    const assistant = addTurn(thread, 'assistant');
    const yText = assistant.get('content') as Y.Text;
    setPrompt('');
    setStreaming(true);

    const history = thread
      .toArray()
      .slice(0, -1) // exclude the empty assistant turn we just added
      .map((t) => ({
        role: t.get('role') as TurnRole,
        content: (t.get('content') as Y.Text).toString(),
      }));

    streamClaudeReply(
      getDocContext(),
      history,
      yText,
      () => setStreaming(false),
      (err) => {
        setStreaming(false);
        setError(err.message);
      },
    );
  };

  return (
    <div
      className={
        'ai-cell__inner' +
        (streaming ? ' is-streaming' : '') +
        (finishing ? ' is-finishing' : '')
      }
    >
      <div className="ai-cell__header">
        <span className="ai-cell__badge">✨ AI</span>
        <button
          type="button"
          className="ai-cell__delete"
          onClick={onDelete}
          title="Xoá AI cell"
        >
          ✕
        </button>
      </div>

      <div className="ai-cell__turns">
        {turns.length === 0 && (
          <div className="ai-cell__empty">Hỏi AI về nội dung phía trên…</div>
        )}
        {turns.map((turn, i) => (
          <div key={i} className={`ai-turn ai-turn--${turn.role}`}>
            <span className="ai-turn__role">
              {turn.role === 'user' ? 'Bạn' : 'AI'}
            </span>
            <div className="ai-turn__content">
              {turn.content}
              {turn.role === 'assistant' &&
                turn.content === '' &&
                streaming && <span className="ai-turn__cursor">▍</span>}
            </div>
          </div>
        ))}
        {error && <div className="ai-cell__error">{error}</div>}
      </div>

      <div className="ai-cell__input">
        <input
          type="text"
          value={prompt}
          placeholder="Nhập prompt cho AI…"
          disabled={streaming}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="button"
          onClick={submit}
          disabled={streaming || prompt.trim() === ''}
        >
          Gửi
        </button>
      </div>
    </div>
  );
}
