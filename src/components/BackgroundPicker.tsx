import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { uploadImage } from '../lib/backendSync';
import { Button } from './Button';

interface Props {
  docId: string;
  currentBg: string | undefined;
  onApply: (url: string | null) => void;
}

export function BackgroundPicker({ docId, currentBg, onApply }: Props) {
  const [open, setOpen] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [uploading, setUploading] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [panelPos, setPanelPos] = useState({ top: 0, right: 0 });

  // Position panel below button
  useEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setPanelPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        !panelRef.current?.contains(e.target as Node) &&
        !btnRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const apply = (url: string | null) => {
    onApply(url);
    setOpen(false);
    setUrlInput('');
  };

  const handleFile = async (file: File) => {
    setUploading(true);
    try {
      const url = await uploadImage(file, docId);
      if (url) apply(url);
    } finally {
      setUploading(false);
    }
  };

  const handleUrlApply = () => {
    const url = urlInput.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) return;
    apply(url);
  };

  return (
    <>
      <Button
        ref={btnRef}
        variant="secondary"
        className={`bg-picker__trigger${currentBg ? ' bg-picker__trigger--active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Set background image"
      >
        🎨
      </Button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="bg-picker__panel"
            style={{ top: panelPos.top, right: panelPos.right }}
          >
            {currentBg && (
              <div
                className="bg-picker__preview"
                style={{ backgroundImage: `url(${currentBg})` }}
              />
            )}

            <div className="bg-picker__section">
              <Button
                variant="ghost"
                fullWidth
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
              >
                {uploading ? '⏳ Uploading…' : '📁 Upload image'}
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                  e.target.value = '';
                }}
              />
            </div>

            <div className="bg-picker__section">
              <div className="bg-picker__url-row">
                <input
                  className="bg-picker__url-input"
                  placeholder="Or paste image URL…"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleUrlApply(); }}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleUrlApply}
                  disabled={!urlInput.trim()}
                >
                  Apply
                </Button>
              </div>
            </div>

            {currentBg && (
              <div className="bg-picker__section">
                <Button variant="danger" fullWidth onClick={() => apply(null)}>
                  ✕ Remove background
                </Button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
