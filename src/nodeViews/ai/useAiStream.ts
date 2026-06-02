import { useRef, useState } from 'react';
import * as Y from 'yjs';
import { addTurn, type TurnRole, type YThread } from '../../collab/aiThreads';
import {
  streamClaudeReply,
  type UsageStats,
  type ModelConfig,
} from '../../collab/claudeStream';
import { compressHistory } from '../../collab/historyCompressor';
import { upsertUserTurn, searchCells, logUsage } from '../../lib/backendSync';

interface Args {
  thread: YThread;
  cellId: string;
  docId: string;
  getLocalContext: () => string;
  getDocContext: () => string;
  modelConfig: ModelConfig;
}

/**
 * The AI cell's request pipeline + the prompt/edit state it drives. Owns:
 *   - prompt text and the "editing turn N" mode,
 *   - the streaming + error flags and the AbortController,
 *   - submit(): persist the user turn, gather context (RAG + compressed
 *     history), then stream the assistant reply into the turn's Y.Text.
 *
 * Streaming/cost are read elsewhere from the turns themselves (Yjs); this hook
 * only tracks the local interaction state (input enabled, stop button, errors).
 */
export function useAiStream({
  thread,
  cellId,
  docId,
  getLocalContext,
  getDocContext,
  modelConfig,
}: Args) {
  const [prompt, setPrompt] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editFromIdx, setEditFromIdx] = useState<number | null>(null);
  const [searchingActive, setSearchingActive] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modalInputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

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

        const compressed = await compressHistory(history, ac.signal, modelConfig);
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
            abortRef.current = null;
            setStreaming(false);
          },
          (err) => {
            // Stamp created_at so the streaming aurora resolves for all viewers
            // (isStreamingShared keys off a missing timestamp).
            if (!assistant.get('created_at')) {
              assistant.set('created_at', new Date().toISOString());
            }
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
        if (!assistant.get('created_at')) {
          assistant.set('created_at', new Date().toISOString());
        }
        abortRef.current = null;
        setStreaming(false);
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  /** Load the last user turn back into the input for editing. */
  const beginEdit = (maximized: boolean) => {
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

  const abort = () => abortRef.current?.abort();

  return {
    prompt,
    setPrompt,
    streaming,
    error,
    setError,
    editFromIdx,
    searchingActive,
    inputRef,
    modalInputRef,
    submit,
    beginEdit,
    cancelEdit,
    abort,
  };
}
