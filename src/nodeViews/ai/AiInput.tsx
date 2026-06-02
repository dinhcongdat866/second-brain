import { type RefObject } from 'react';
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
  return (
    <div className="ai-cell__input">
      <textarea
        ref={inputRef}
        rows={1}
        value={prompt}
        placeholder={editing ? 'Sửa và gửi lại…' : 'Nhập prompt cho AI…'}
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
          title="Huỷ chỉnh sửa (Esc)"
        >
          Huỷ
        </button>
      )}
      {streaming ? (
        <button
          type="button"
          className="ai-cell__stop-btn"
          onClick={onAbort}
          title="Dừng stream"
        >
          ■ Dừng
        </button>
      ) : editing ? (
        <button type="button" onClick={onSubmit} disabled={prompt.trim() === ''}>
          Gửi lại
        </button>
      ) : (
        <button
          type="button"
          className="ai-cell__send-btn"
          onClick={onSubmit}
          disabled={prompt.trim() === ''}
          title="Gửi (Enter)"
        >
          <IconSend />
        </button>
      )}
    </div>
  );
}
