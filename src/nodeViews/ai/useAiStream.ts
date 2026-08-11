import { useRef, useState } from 'react';
import * as Y from 'yjs';
import { addTurn, type TurnRole, type YThread } from '../../collab/aiThreads';
import {
  streamClaudeReply,
  streamDemoReply,
  extractMemorableFacts,
  isOllamaModel,
  type UsageStats,
  type ModelConfig,
} from '../../collab/claudeStream';
import { compressHistory } from '../../collab/historyCompressor';
import { upsertUserTurn, searchCells, logUsage, uploadImage, deleteImage } from '../../lib/backendSync';
import { getApiKey } from '../../lib/apiKey';
import { dataUrlToBlob, resizeImageToDataUrl } from '../../lib/imageResize';

interface Args {
  thread: YThread;
  cellId: string;
  docId: string;
  getLocalContext: () => string;
  getDocContext: () => string;
  getMemoryContext: () => string;
  getAnalyticsContext: () => string;
  onMemoryExtracted?: (bullets: string[], cellId: string, docId: string) => void;
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
  getMemoryContext,
  getAnalyticsContext,
  onMemoryExtracted,
  modelConfig,
}: Args) {
  const [prompt, setPrompt] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editFromIdx, setEditFromIdx] = useState<number | null>(null);
  const [searchingActive, setSearchingActive] = useState(false);
  // `dataUrl` feeds the vision request and the local thumbnail; `url` is what
  // gets written to the Y.Doc once the upload lands (null while in flight or
  // if the upload failed).
  const [pendingImages, setPendingImages] = useState<
    { id: string; dataUrl: string; url: string | null }[]
  >([]);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modalInputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Image ids removed before their upload finished — deleted once it lands. */
  const discardedRef = useRef<Set<string>>(new Set());

  /**
   * Resize + queue image files to attach to the next prompt.
   *
   * The upload starts here rather than at submit time so the /images URL is
   * usually ready by the time the turn is written, and so submit() stays
   * synchronous. The thumbnail renders from the data URL immediately either way.
   */
  const addImages = async (files: File[] | FileList) => {
    const imgs = Array.from(files).filter((f) => f.type.startsWith('image/'));
    for (const file of imgs) {
      try {
        const dataUrl = await resizeImageToDataUrl(file);
        const id = crypto.randomUUID();
        setPendingImages((prev) => [...prev, { id, dataUrl, url: null }]);

        const blob = dataUrlToBlob(dataUrl);
        if (!blob) continue;
        uploadImage(blob, docId).then((url) => {
          if (!url) return; // upload failed — turn keeps the text, drops the image
          // Removed while the upload was still in flight: the image never made
          // it into the tray, so delete it now rather than leaving it orphaned.
          if (discardedRef.current.has(id)) {
            discardedRef.current.delete(id);
            deleteImage(url);
            return;
          }
          setPendingImages((prev) =>
            prev.map((p) => (p.id === id ? { ...p, url } : p)),
          );
        });
      } catch {
        /* skip unreadable image */
      }
    }
  };

  /**
   * Discard a queued image. Deletes the uploaded copy too — this is the one
   * moment we know for certain the image will never be referenced by a turn.
   * (Closing the tab mid-compose still leaks; that needs a server-side sweep.)
   */
  const removeImage = (id: string) => {
    const target = pendingImages.find((p) => p.id === id);
    if (target?.url) {
      deleteImage(target.url);
    } else if (target) {
      discardedRef.current.add(id); // upload still in flight — delete on arrival
    }
    setPendingImages((prev) => prev.filter((p) => p.id !== id));
  };

  const submit = () => {
    const text = prompt.trim();
    if ((!text && pendingImages.length === 0) || streaming) return;
    setError(null);

    if (editFromIdx !== null) {
      const deleteCount = thread.length - editFromIdx;
      if (deleteCount > 0) thread.delete(editFromIdx, deleteCount);
      setEditFromIdx(null);
    }

    // Two different things: base64 goes to the vision API (it needs the bytes),
    // /images URLs go into the Y.Doc. Storing base64 here would embed the image
    // in the document forever — gc:false never reclaims it, and every save
    // re-uploads the whole doc.
    const imageUrls = pendingImages.map((p) => p.dataUrl);
    const storedUrls = pendingImages.map((p) => p.url).filter((u): u is string => !!u);
    const userTurn = addTurn(thread, 'user', text);
    if (storedUrls.length > 0) userTurn.set('images', JSON.stringify(storedUrls));
    setPendingImages([]);
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

    const userApiKey = getApiKey();
    const isDemoMode = !userApiKey && !isOllamaModel(modelConfig.model);

    const finishTurn = (usage: UsageStats) => {
      assistant.set('created_at', new Date().toISOString());
      if (usage.inputTokens > 0) {
        assistant.set('tokens_in', usage.inputTokens);
        assistant.set('tokens_out', usage.outputTokens);
        assistant.set('cost_usd', usage.costUsd);
        // Anthropic usage is metered server-side by the /anthropic proxy (the
        // client number is display-only and can't be trusted for the DB).
        // Ollama doesn't go through the proxy, so log it from here (cost 0).
        if (isOllamaModel(modelConfig.model)) logUsage(docId, cellId, usage);
      }
      abortRef.current = null;
      setStreaming(false);

      // Fire-and-forget: extract memorable facts from this exchange.
      // Skipped for Ollama (no Anthropic API), demo mode, and short replies.
      if (onMemoryExtracted && !isDemoMode && !isOllamaModel(modelConfig.model)) {
        const assistantContent = (assistant.get('content') as Y.Text).toString();
        if (assistantContent.length > 50) {
          extractMemorableFacts(text, assistantContent, getMemoryContext(), userApiKey).then((bullets) => {
            if (bullets.length > 0) onMemoryExtracted(bullets, cellId, docId);
          });
        }
      }
    };

    if (isDemoMode) {
      streamDemoReply(yText, finishTurn, ac.signal).catch(() => {
        assistant.set('created_at', new Date().toISOString());
        abortRef.current = null;
        setStreaming(false);
      });
      return;
    }

    searchCells(text, 3)
      .then(async (results) => {
        if (ac.signal.aborted) return;
        const ragContext = results
          .filter((r) => r.score > 0.3)
          .map((r) => r.content)
          .join('\n\n');

        const compressed = await compressHistory(history, ac.signal, modelConfig, userApiKey);
        if (ac.signal.aborted) return;

        return streamClaudeReply(
          getLocalContext(),
          modelConfig.contextScope === 'doc' ? getDocContext() : '',
          compressed,
          yText,
          finishTurn,
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
            memoryContext: getMemoryContext(),
            analyticsContext: getAnalyticsContext(),
            signal: ac.signal,
            config: modelConfig,
            thinkingTarget: thinkingText,
            images: imageUrls,
            userApiKey,
            cellId,
            docId,
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
    pendingImages,
    addImages,
    removeImage,
    inputRef,
    modalInputRef,
    submit,
    beginEdit,
    cancelEdit,
    abort,
  };
}
