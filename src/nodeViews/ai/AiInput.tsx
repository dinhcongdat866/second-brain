import { type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { IconSend } from './icons';

interface Props {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  prompt: string;
  setPrompt: (v: string) => void;
  streaming: boolean;
  editing: boolean;
  pendingImages: { id: string; dataUrl: string }[];
  onAddImages: (files: File[] | FileList) => void;
  onRemoveImage: (id: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onAbort: () => void;
}

function growTextarea(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

function imageFiles(list: FileList): File[] {
  return Array.from(list).filter((f) => f.type.startsWith('image/'));
}

/** Prompt input row: image attachments + auto-growing textarea + controls. */
export function AiInput({
  inputRef,
  prompt,
  setPrompt,
  streaming,
  editing,
  pendingImages,
  onAddImages,
  onRemoveImage,
  onSubmit,
  onCancel,
  onAbort,
}: Props) {
  const { t } = useTranslation();
  const canSubmit = prompt.trim() !== '' || pendingImages.length > 0;

  return (
    <div
      className="ai-cell__input-wrap"
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.items).some((i) => i.kind === 'file')) {
          e.preventDefault();
        }
      }}
      onDrop={(e) => {
        const files = imageFiles(e.dataTransfer.files);
        if (files.length) {
          e.preventDefault();
          onAddImages(files);
        }
      }}
    >
      {pendingImages.length > 0 && (
        <div className="ai-cell__attachments">
          {pendingImages.map((img) => (
            <div key={img.id} className="ai-cell__attachment">
              <img src={img.dataUrl} alt="" />
              <button
                type="button"
                className="ai-cell__attachment-del"
                onClick={() => onRemoveImage(img.id)}
                title={t('ai.removeImage')}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

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
          onPaste={(e) => {
            const files = imageFiles(e.clipboardData.files);
            if (files.length) {
              e.preventDefault();
              onAddImages(files);
            }
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
          <button type="button" onClick={onSubmit} disabled={!canSubmit}>
            {t('ai.resend')}
          </button>
        ) : (
          <button
            type="button"
            className="ai-cell__send-btn"
            onClick={onSubmit}
            disabled={!canSubmit}
            title={t('ai.send')}
          >
            <IconSend />
          </button>
        )}
      </div>
    </div>
  );
}
