import { type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { TurnRole } from '../../collab/aiThreads';
import { formatSmartDate, formatFullDate } from '../../lib/formatDate';
import { IconCopy, IconCheck, IconPencil } from './icons';
import type { TurnView } from './useTurns';

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
      {isStreaming && isLastTurn && <span className="ai-turn__cursor">▍</span>}
    </div>
  );
}

interface Props {
  turns: TurnView[];
  editFromIdx: number | null;
  lastUserTurnIdx: number;
  isStreamingShared: boolean;
  streaming: boolean;
  searchingActive: boolean;
  thinkingOpen: Record<number, boolean>;
  onToggleThinking: (index: number, open: boolean) => void;
  copiedIdx: number | null;
  onCopy: (content: string, index: number) => void;
  onStartEdit: () => void;
  error: string | null;
  turnsEndRef: RefObject<HTMLDivElement | null>;
}

/** Scrollable list of conversation turns (used by both inline cell and modal). */
export function AiTurnList({
  turns,
  editFromIdx,
  lastUserTurnIdx,
  isStreamingShared,
  streaming,
  searchingActive,
  thinkingOpen,
  onToggleThinking,
  copiedIdx,
  onCopy,
  onStartEdit,
  error,
  turnsEndRef,
}: Props) {
  const { t } = useTranslation();
  return (
    <div className="ai-cell__turns">
      {turns.length === 0 && (
        <div className="ai-cell__empty">{t('ai.empty')}</div>
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
                    <span className="ai-turn__role">{t('ai.you')}</span>
                    {isPendingReplace && (
                      <span className="ai-turn__replace-badge">{t('ai.willBeReplaced')}</span>
                    )}
                  </div>
                  {turn.images && turn.images.length > 0 && (
                    <div className="ai-turn__images">
                      {turn.images.map((src, ii) => (
                        <img key={ii} src={src} alt="" className="ai-turn__image" />
                      ))}
                    </div>
                  )}
                  <TurnContent
                    role={turn.role}
                    content={turn.content}
                    isStreaming={isStreamingShared}
                    isLastTurn={isLastTurn}
                  />
                </div>
                <div className="ai-turn__actions">
                  {i === lastUserTurnIdx && !streaming && editFromIdx === null && (
                    <button
                      type="button"
                      className="ai-turn__action-btn"
                      onClick={onStartEdit}
                      title={t('ai.editMessage')}
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
                      🌐 {turn.searchSources ? t('ai.searched', { query: turn.searchQuery }) : t('ai.searching', { query: turn.searchQuery })}
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
                      (isStreamingShared && isLastTurn && !turn.content)
                        ? true
                        : (thinkingOpen[i] ?? true)
                    }
                    onToggle={(e) => {
                      if (!(isStreamingShared && isLastTurn && !turn.content)) {
                        onToggleThinking(i, (e.target as HTMLDetailsElement).open);
                      }
                    }}
                  >
                    <summary>
                      💭 {t('ai.thinking')}
                      {isStreamingShared && isLastTurn && !turn.content && (
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
                  isStreaming={isStreamingShared}
                  isLastTurn={isLastTurn}
                />
                <div className="ai-turn__actions">
                  {turn.content && !isPendingReplace && (
                    <button
                      type="button"
                      className="ai-turn__action-btn"
                      onClick={() => onCopy(turn.content, i)}
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
}
