import { type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { IconSend } from './icons';

interface Props {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  prompt: string;
  setPrompt: (v: string) => void;
  streaming: boolean;
  editing: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  onAbort: () => void;
}

function growTextarea(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

/** Prompt input row: auto-growing textarea + send / stop / cancel controls. */
export function AiInput({
  inputRef,
  prompt,
  setPrompt,
  streaming,
  editing,
  onSubmit,
  onCancel,
  onAbort,
}: Props) {
  const { t } = useTranslation();
  return (
    <div className="ai-cell__input">
      <textarea
        ref={inputRef}
        rows={1}
        value={prompt}
        placeholder={editing ? t('ai.editPlaceholder') : t('ai.promptPlaceholder')}
        disabled={streaming}
        onChange={(e) => {
          setPrompt(e.target.value);
          growTextarea(e.target);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
          if (e.key === 'Escape' && editing) {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      {editing && (
        <button
          type="button"
          className="ai-cell__cancel-btn"
          onClick={onCancel}
          title={t('ai.cancelEdit')}
        >
          {t('ai.cancel')}
        </button>
      )}
      {streaming ? (
        <button
          type="button"
          className="ai-cell__stop-btn"
          onClick={onAbort}
          title={t('ai.stopStream')}
        >
          ■ {t('ai.stop')}
        </button>
      ) : editing ? (
        <button type="button" onClick={onSubmit} disabled={prompt.trim() === ''}>
          {t('ai.resend')}
        </button>
      ) : (
        <button
          type="button"
          className="ai-cell__send-btn"
          onClick={onSubmit}
          disabled={prompt.trim() === ''}
          title={t('ai.send')}
        >
          <IconSend />
        </button>
      )}
    </div>
  );
}
