import { useEffect, useReducer, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { addTurn, type TurnRole, type YThread } from '../collab/aiThreads';

// Stage 1: no real LLM yet. Stage 2 swaps this for a streamed Claude response.
const MOCK_REPLY =
  'Đây là phản hồi mẫu (mock). Stage 2 sẽ thay bằng Claude API thật — ' +
  'AI đọc context các cell phía trên rồi stream câu trả lời thật về đây.';

/**
 * Append `text` into `target` one character at a time — fakes token streaming.
 * Each insert is a Yjs op, so collaborators see the reply grow in real time.
 */
function mockStream(target: Y.Text, text: string, onDone: () => void): void {
  let i = 0;
  const tick = () => {
    if (i >= text.length) {
      onDone();
      return;
    }
    target.insert(target.length, text[i]);
    i += 1;
    setTimeout(tick, 18);
  };
  tick();
}

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
  onDelete,
}: {
  thread: YThread;
  onDelete: () => void;
}) {
  const turns = useTurns(thread);
  const [prompt, setPrompt] = useState('');
  const [streaming, setStreaming] = useState(false);
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
    addTurn(thread, 'user', text);
    const assistant = addTurn(thread, 'assistant');
    setPrompt('');
    setStreaming(true);
    mockStream(assistant.get('content') as Y.Text, MOCK_REPLY, () =>
      setStreaming(false),
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
