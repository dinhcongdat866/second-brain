import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  type ModelConfig,
  type OllamaModel,
  DEFAULT_MODEL_CONFIG,
  fetchOllamaModels,
} from '../../collab/claudeStream';

export interface PanelAnchor {
  top: number;
  left: number;
}

/**
 * Owns the model-config popover state for an AI cell: selected model, locally
 * discovered Ollama models, and the portal anchor that follows whichever button
 * opened it (inline header or modal header). Handles outside-click close and
 * re-anchoring on scroll.
 */
export function useAiConfig() {
  const [modelConfig, setModelConfig] = useState<ModelConfig>(DEFAULT_MODEL_CONFIG);
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
  const [configOpen, setConfigOpen] = useState(false);
  const [panelAnchor, setPanelAnchor] = useState<PanelAnchor | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const modalBtnRef = useRef<HTMLButtonElement>(null);
  const activeBtnRef = useRef<HTMLButtonElement | null>(null);

  const close = () => {
    setConfigOpen(false);
    setPanelAnchor(null);
  };

  const openFrom = (ref: RefObject<HTMLButtonElement | null>) => {
    activeBtnRef.current = ref.current;
    const rect = ref.current?.getBoundingClientRect();
    if (rect) setPanelAnchor({ top: rect.bottom + 4, left: rect.left });
    setConfigOpen(true);
  };

  /** Toggle the panel relative to the given button. */
  const toggleFrom = (ref: RefObject<HTMLButtonElement | null>) => {
    if (configOpen) close();
    else openFrom(ref);
  };

  // Discover locally installed Ollama models once on mount.
  useEffect(() => {
    fetchOllamaModels().then(setOllamaModels).catch(() => {});
  }, []);

  // Close on outside click (ignore clicks on either trigger button or the panel).
  useEffect(() => {
    if (!configOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        !panelRef.current?.contains(e.target as Node) &&
        !btnRef.current?.contains(e.target as Node) &&
        !modalBtnRef.current?.contains(e.target as Node)
      ) {
        close();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [configOpen]);

  // Keep the portal anchored to its trigger when the page scrolls.
  useEffect(() => {
    if (!configOpen) return;
    const update = () => {
      const rect = activeBtnRef.current?.getBoundingClientRect();
      if (rect) setPanelAnchor({ top: rect.bottom + 4, left: rect.left });
    };
    window.addEventListener('scroll', update, true);
    return () => window.removeEventListener('scroll', update, true);
  }, [configOpen]);

  return {
    modelConfig,
    setModelConfig,
    ollamaModels,
    configOpen,
    panelAnchor,
    panelRef,
    btnRef,
    modalBtnRef,
    toggleFrom,
    close,
  };
}
