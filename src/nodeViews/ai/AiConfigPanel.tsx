import { createPortal } from 'react-dom';
import { type Dispatch, type RefObject, type SetStateAction, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type ModelConfig,
  type OllamaModel,
  MODELS,
  isOllamaModel,
} from '../../collab/claudeStream';
import { getApiKey, setApiKey, clearApiKey } from '../../lib/apiKey';
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
  const { t } = useTranslation();
  const [keyInput, setKeyInput] = useState('');
  const [keySet, setKeySet] = useState(() => !!getApiKey());
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
            <span className="ai-cell__config-desc">{t(`ai.modelDesc.${m.label.toLowerCase()}`)}</span>
          </button>
        ))}
      </div>

      <div className="ai-cell__config-divider" />

      <div className="ai-cell__config-section">
        <span className="ai-cell__config-heading">🏠 Ollama local</span>
        {ollamaModels.length === 0 ? (
          <span className="ai-cell__config-desc" style={{ padding: '4px 8px', display: 'block' }}>
            {t('ai.ollamaNotFound')}
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
        <span className="ai-cell__config-heading">{t('ai.features')}</span>
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
      <div className="ai-cell__config-divider" />

      <div className="ai-cell__config-section">
        <span className="ai-cell__config-heading">🔑 {t('ai.apiKey.heading')}</span>
        {keySet ? (
          <div className="ai-cell__config-key-row">
            <span className="ai-cell__config-desc ai-cell__config-key-saved">
              {t('ai.apiKey.saved')}
            </span>
            <button
              type="button"
              className="ai-cell__config-key-clear"
              onClick={() => { clearApiKey(); setKeySet(false); setKeyInput(''); }}
            >
              {t('ai.apiKey.clear')}
            </button>
          </div>
        ) : (
          <>
            <div className="ai-cell__config-key-row">
              <input
                type="password"
                className="ai-cell__config-key-input"
                placeholder="sk-ant-..."
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && keyInput.trim()) {
                    setApiKey(keyInput.trim());
                    setKeySet(true);
                    setKeyInput('');
                  }
                }}
              />
              <button
                type="button"
                className="ai-cell__config-key-save"
                disabled={!keyInput.trim()}
                onClick={() => {
                  if (!keyInput.trim()) return;
                  setApiKey(keyInput.trim());
                  setKeySet(true);
                  setKeyInput('');
                }}
              >
                {t('ai.apiKey.save')}
              </button>
            </div>
            <span className="ai-cell__config-desc" style={{ padding: '2px 8px 6px', display: 'block' }}>
              {t('ai.apiKey.hint')}
            </span>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
