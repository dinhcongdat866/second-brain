import { createPortal } from 'react-dom';
import { type Dispatch, type RefObject, type SetStateAction } from 'react';
import {
  type ModelConfig,
  type OllamaModel,
  MODELS,
  isOllamaModel,
} from '../../collab/claudeStream';
import type { PanelAnchor } from './useAiConfig';

interface Props {
  modelConfig: ModelConfig;
  setModelConfig: Dispatch<SetStateAction<ModelConfig>>;
  ollamaModels: OllamaModel[];
  panelRef: RefObject<HTMLDivElement | null>;
  anchor: PanelAnchor;
  /** Close the panel (also called after picking a model). */
  onClose: () => void;
}

/**
 * Model + feature picker, rendered into a portal so it escapes the AI cell's
 * `overflow: hidden` stacking context and floats over the page.
 */
export function AiConfigPanel({
  modelConfig,
  setModelConfig,
  ollamaModels,
  panelRef,
  anchor,
  onClose,
}: Props) {
  const activeModel = isOllamaModel(modelConfig.model)
    ? { supportsThinking: false, supportsWebSearch: false }
    : MODELS.find((m) => m.id === modelConfig.model);

  return createPortal(
    <div
      ref={panelRef}
      className="ai-cell__config-panel"
      style={{ top: anchor.top, left: anchor.left }}
    >
      <div className="ai-cell__config-section">
        <span className="ai-cell__config-heading">☁️ Anthropic</span>
        {MODELS.filter((m) => m.provider === 'anthropic').map((m) => (
          <button
            key={m.id}
            type="button"
            className={'ai-cell__config-option' + (modelConfig.model === m.id ? ' is-active' : '')}
            onClick={() => {
              setModelConfig((c) => ({
                ...c,
                model: m.id,
                thinking: m.supportsThinking ? c.thinking : false,
                webSearch: m.supportsWebSearch ? c.webSearch : false,
              }));
              onClose();
            }}
          >
            <span>{m.label}</span>
            <span className="ai-cell__config-desc">{m.desc}</span>
          </button>
        ))}
      </div>

      <div className="ai-cell__config-divider" />

      <div className="ai-cell__config-section">
        <span className="ai-cell__config-heading">🏠 Ollama local</span>
        {ollamaModels.length === 0 ? (
          <span className="ai-cell__config-desc" style={{ padding: '4px 8px', display: 'block' }}>
            Không tìm thấy model — hãy chạy Ollama
          </span>
        ) : ollamaModels.map((m) => (
          <button
            key={m.id}
            type="button"
            className={'ai-cell__config-option' + (modelConfig.model === m.id ? ' is-active' : '')}
            onClick={() => {
              setModelConfig((c) => ({
                ...c,
                model: m.id,
                thinking: false,
                webSearch: false,
              }));
              onClose();
            }}
          >
            <span>{m.name}</span>
            <span className="ai-cell__config-desc">{m.sizeGb} GB</span>
          </button>
        ))}
      </div>

      <div className="ai-cell__config-divider" />

      <div className="ai-cell__config-section">
        <span className="ai-cell__config-heading">Tính năng</span>
        <label className={'ai-cell__config-toggle' + (activeModel?.supportsThinking ? '' : ' is-disabled')}>
          <input
            type="checkbox"
            checked={modelConfig.thinking}
            disabled={!activeModel?.supportsThinking}
            onChange={(e) => setModelConfig((c) => ({ ...c, thinking: e.target.checked }))}
          />
          💭 Extended Thinking
        </label>
        <label className={'ai-cell__config-toggle' + (activeModel?.supportsWebSearch ? '' : ' is-disabled')}>
          <input
            type="checkbox"
            checked={modelConfig.webSearch}
            disabled={!activeModel?.supportsWebSearch}
            onChange={(e) => setModelConfig((c) => ({ ...c, webSearch: e.target.checked }))}
          />
          🌐 Web Search
        </label>
      </div>
    </div>,
    document.body,
  );
}
