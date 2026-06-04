import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type YThread } from '../collab/aiThreads';
import {
  type ModelConfig,
  MODELS,
  isOllamaModel,
  ollamaModelName,
} from '../collab/claudeStream';
import { IconMaximize, IconMinimize } from './ai/icons';
import { detectEmotion } from './ai/detectEmotion';
import { useTurns } from './ai/useTurns';
import { useAiConfig } from './ai/useAiConfig';
import { useAiStream } from './ai/useAiStream';
import { AiConfigPanel } from './ai/AiConfigPanel';
import { AiInput } from './ai/AiInput';
import { AiTurnList } from './ai/AiTurnList';

/** Short label for the config button (model + enabled feature flags). */
function modelLabel(config: ModelConfig): string {
  const base = isOllamaModel(config.model)
    ? ollamaModelName(config.model)
    : (MODELS.find((m) => m.id === config.model)?.label ?? 'Sonnet');
  return base + (config.thinking ? ' · Think' : '') + (config.webSearch ? ' · 🌐' : '') + (config.contextScope === 'doc' ? ' · 📄' : '') + ' ▾';
}

export function AiCell({
  thread,
  getLocalContext,
  getDocContext,
  getMemoryContext,
  appendMemory,
  onDelete,
  cellId,
  docId,
}: {
  thread: YThread;
  getLocalContext: () => string;
  getDocContext: () => string;
  getMemoryContext: () => string;
  appendMemory: (bullets: string[], meta: { sourceCellId: string; sourceDocId: string }) => void;
  onDelete: () => void;
  cellId: string;
  docId: string;
}) {
  const { t } = useTranslation();
  const turns = useTurns(thread);
  const config = useAiConfig();
  const stream = useAiStream({
    thread,
    cellId,
    docId,
    getLocalContext,
    getDocContext,
    getMemoryContext,
    onMemoryExtracted: (bullets, srcCellId, srcDocId) =>
      appendMemory(bullets, { sourceCellId: srcCellId, sourceDocId: srcDocId }),
    modelConfig: config.modelConfig,
  });

  // Presentation state derived from the thread (Yjs) — so peers who didn't type
  // the prompt still see the running cost + streaming aurora. An assistant turn
  // is "streaming" while it has no created_at yet (set in onDone/onError).
  const sessionCost = turns.reduce((sum, t) => sum + (t.costUsd ?? 0), 0);
  const lastTurn = turns[turns.length - 1];
  const isStreamingShared =
    !!lastTurn && lastTurn.role === 'assistant' && !lastTurn.createdAt;

  // During streaming, detect emotion from current content once >50 chars are
  // available (avoids early false positives). Fall back to the last completed
  // turn so subsequent streams inherit the conversation's established tone.
  const lastAssistant = [...turns].reverse().find(t => t.role === 'assistant');
  const lastDoneAssistant = lastAssistant?.createdAt ? lastAssistant
    : [...turns].reverse().find(t => t.role === 'assistant' && t.createdAt);
  const emotionSource = (lastAssistant && lastAssistant.content.length > 50)
    ? lastAssistant.content
    : (lastDoneAssistant?.content ?? '');
  const emotion = detectEmotion(emotionSource);

  let lastUserTurnIdx = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'user') { lastUserTurnIdx = i; break; }
  }
  const previewText =
    turns.length > 0 ? turns[0].content.slice(0, 60) : t('ai.noConversation');

  // Local UI-only state (not shared).
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState<Record<number, boolean>>({});
  const [finishing, setFinishing] = useState(false);
  const turnsEndRef = useRef<HTMLDivElement>(null);
  const wasStreamingRef = useRef(false);

  // Auto-clear the delete confirmation after a few seconds.
  useEffect(() => {
    if (!pendingDelete) return;
    const t = setTimeout(() => setPendingDelete(false), 3000);
    return () => clearTimeout(t);
  }, [pendingDelete]);

  // Close maximize with Escape.
  useEffect(() => {
    if (!maximized) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setMaximized(false); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [maximized]);

  // Scroll the latest turn into view as turns arrive / streaming starts.
  useEffect(() => {
    turnsEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [turns.length, stream.streaming]);

  // Play the "final gust" finish animation when streaming ends.
  useEffect(() => {
    if (wasStreamingRef.current && !isStreamingShared) {
      setFinishing(true);
      const t = setTimeout(() => setFinishing(false), 1000);
      wasStreamingRef.current = isStreamingShared;
      return () => clearTimeout(t);
    }
    wasStreamingRef.current = isStreamingShared;
  }, [isStreamingShared]);

  const copyTurn = (content: string, idx: number) => {
    navigator.clipboard.writeText(content).then(() => {
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1500);
    });
  };

  const turnList = (
    <AiTurnList
      turns={turns}
      editFromIdx={stream.editFromIdx}
      lastUserTurnIdx={lastUserTurnIdx}
      isStreamingShared={isStreamingShared}
      streaming={stream.streaming}
      searchingActive={stream.searchingActive}
      thinkingOpen={thinkingOpen}
      onToggleThinking={(i, open) => setThinkingOpen((prev) => ({ ...prev, [i]: open }))}
      copiedIdx={copiedIdx}
      onCopy={copyTurn}
      onStartEdit={() => stream.beginEdit(maximized)}
      error={stream.error}
      turnsEndRef={turnsEndRef}
    />
  );

  const input = (ref: typeof stream.inputRef) => (
    <AiInput
      inputRef={ref}
      prompt={stream.prompt}
      setPrompt={stream.setPrompt}
      streaming={stream.streaming}
      editing={stream.editFromIdx !== null}
      pendingImages={stream.pendingImages}
      onAddImages={stream.addImages}
      onRemoveImage={stream.removeImage}
      onSubmit={stream.submit}
      onCancel={stream.cancelEdit}
      onAbort={stream.abort}
    />
  );

  return (
    <>
      <div
        className={
          'ai-cell__inner' +
          (isStreamingShared ? ' is-streaming' : '') +
          (finishing ? ' is-finishing' : '') +
          (minimized ? ' is-minimized' : '')
        }
        data-emotion={emotion}
      >
        {/* Header */}
        <div className="ai-cell__header">
          <span className="ai-cell__badge">✦ AI</span>
          {sessionCost > 0 && (
            <span className="ai-cell__session-cost" title={t('ai.sessionCost')}>
              💸 ${sessionCost.toFixed(4)}
            </span>
          )}
          {minimized && <span className="ai-cell__preview">{previewText}</span>}

          <div className="ai-cell__header-right">
            <button
              ref={config.btnRef}
              type="button"
              className="ai-cell__config-btn"
              onClick={() => config.toggleFrom(config.btnRef)}
            >
              {modelLabel(config.modelConfig)}
            </button>

            <div className="ai-cell__header-actions">
              <button
                type="button"
                className="ai-cell__icon-btn"
                onClick={() => setMaximized(true)}
                title={t('ai.maximize')}
              >
                <IconMaximize />
              </button>

              <button
                type="button"
                className="ai-cell__icon-btn"
                onClick={() => { setMinimized((v) => !v); setPendingDelete(false); }}
                title={minimized ? t('ai.expand') : t('ai.collapse')}
              >
                {minimized ? '▶' : '▼'}
              </button>

              {pendingDelete ? (
                <>
                  <span className="ai-cell__del-label">{t('ai.deleteShort')}</span>
                  <button
                    type="button"
                    className="ai-cell__icon-btn ai-cell__delete--confirm"
                    onClick={onDelete}
                    title={t('ai.confirmDelete')}
                  >
                    ✓
                  </button>
                  <button
                    type="button"
                    className="ai-cell__icon-btn"
                    onClick={() => setPendingDelete(false)}
                    title={t('ai.cancel')}
                  >
                    ✗
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="ai-cell__icon-btn ai-cell__delete"
                  onClick={() => setPendingDelete(true)}
                  title={t('ai.deleteCell')}
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Body */}
        {!minimized && (
          <>
            {turnList}
            {input(stream.inputRef)}
          </>
        )}
      </div>

      {config.configOpen && config.panelAnchor && (
        <AiConfigPanel
          modelConfig={config.modelConfig}
          setModelConfig={config.setModelConfig}
          ollamaModels={config.ollamaModels}
          panelRef={config.panelRef}
          anchor={config.panelAnchor}
          onClose={config.close}
        />
      )}

      {/* Maximize modal */}
      {maximized && createPortal(
        <div className="ai-cell__modal-overlay" onClick={() => setMaximized(false)}>
          <div
            className={
              'ai-cell__modal' +
              (isStreamingShared ? ' is-streaming' : '') +
              (finishing ? ' is-finishing' : '')
            }
            data-emotion={emotion}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ai-cell__modal-header">
              <span className="ai-cell__badge">✦ AI</span>
              <div className="ai-cell__header-right">
                <button
                  ref={config.modalBtnRef}
                  type="button"
                  className="ai-cell__config-btn"
                  onClick={() => config.toggleFrom(config.modalBtnRef)}
                >
                  {modelLabel(config.modelConfig)}
                </button>
                <button
                  type="button"
                  className="ai-cell__icon-btn"
                  onClick={() => setMaximized(false)}
                  title={t('ai.minimizeModal')}
                >
                  <IconMinimize />
                </button>
              </div>
            </div>
            <div className="ai-cell__modal-body">{turnList}</div>
            {input(stream.modalInputRef)}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
