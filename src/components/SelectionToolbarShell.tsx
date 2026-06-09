import { useEffect, type Ref } from 'react';
import { ColorPalette, SizePicker } from './ToolbarPickers';
import { TEXT_COLORS, BG_COLORS, FONT_SIZES, type StyleKind } from '../lib/toolbarStyles';

export interface ActiveStyles {
  color: string | null;
  bg: string | null;
  size: string | null;
}

export type ToolbarFlyout = 'text' | 'bg' | 'size' | null;

interface Props {
  containerRef?: Ref<HTMLDivElement>;
  pos: { left: number; top: number };
  /** Highlighted marks (markdown cell tracks them; weekly cell omits). */
  activeMarks?: Set<string>;
  activeStyles?: ActiveStyles;

  /** Flyout is parent-controlled so each cell can clear it from its own effects. */
  flyout: ToolbarFlyout;
  setFlyout: (f: ToolbarFlyout) => void;

  // Link sub-mode (owned by the parent so it can use PM marks or text markers).
  linkMode: boolean;
  linkUrl: string;
  linkInputRef: Ref<HTMLInputElement>;
  onLinkChange: (v: string) => void;
  onLinkApply: () => void;
  onLinkCancel: () => void;
  onLinkTrigger: () => void;

  onMark: (name: 'strong' | 'em' | 'strikethrough' | 'code') => void;
  onStyle: (kind: StyleKind, value: string | null) => void;
}

const NO_MARKS: Set<string> = new Set();
const NO_STYLES: ActiveStyles = { color: null, bg: null, size: null };

/**
 * Presentational selection toolbar shared by the markdown cell (FloatingToolbar)
 * and the weekly cell. Owns only the flyout open/close; all apply logic and
 * show/hide positioning live in the parent, since the two cells store formatting
 * differently (real PM marks vs. inline text markers).
 */
export function SelectionToolbarShell({
  containerRef,
  pos,
  activeMarks = NO_MARKS,
  activeStyles = NO_STYLES,
  flyout,
  setFlyout,
  linkMode,
  linkUrl,
  linkInputRef,
  onLinkChange,
  onLinkApply,
  onLinkCancel,
  onLinkTrigger,
  onMark,
  onStyle,
}: Props) {
  const applyStyle = (kind: StyleKind, value: string | null) => {
    onStyle(kind, value);
    setFlyout(null);
  };

  // When a flyout is open, pressing 1–8 (or 1–4 for size) picks the
  // corresponding swatch — faster than reaching for the mouse.
  useEffect(() => {
    if (!flyout) return;
    const swatches = flyout === 'text' ? TEXT_COLORS : flyout === 'bg' ? BG_COLORS : FONT_SIZES;
    const onKeyDown = (e: KeyboardEvent) => {
      // Don't intercept while typing in any input / textarea.
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key >= '1' && e.key <= '9') {
        const idx = Number(e.key) - 1;
        if (idx < swatches.length) {
          e.preventDefault();
          // 'text' flyout maps to the 'color' StyleKind ('text' is the flyout id,
          // 'color' is the kind name used by the style system).
          const kind: StyleKind = flyout === 'text' ? 'color' : (flyout as StyleKind);
          onStyle(kind, swatches[idx].value);
          setFlyout(null);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  // onStyle / setFlyout are stable refs (useCallback / useState setter).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyout]);

  const on = (name: string) => (activeMarks.has(name) ? ' ftb__btn--on' : '');

  return (
    <div
      ref={containerRef}
      className="floating-toolbar"
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {linkMode ? (
        <div className="ftb__link-row">
          <input
            ref={linkInputRef}
            className="ftb__link-input"
            placeholder="https://..."
            value={linkUrl}
            onChange={(e) => onLinkChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); onLinkApply(); }
              if (e.key === 'Escape') { e.preventDefault(); onLinkCancel(); }
            }}
          />
          <button className="ftb__btn" onMouseDown={(e) => e.preventDefault()} onClick={onLinkApply} title="Apply">↵</button>
        </div>
      ) : (
        <>
          <button className={`ftb__btn${on('strong')}`} onMouseDown={(e) => e.preventDefault()} onClick={() => onMark('strong')} title="Bold (Ctrl+B / ⌘B)"><b>B</b></button>
          <button className={`ftb__btn${on('em')}`} onMouseDown={(e) => e.preventDefault()} onClick={() => onMark('em')} title="Italic (Ctrl+I / ⌘I)"><i>I</i></button>
          <button className={`ftb__btn${on('strikethrough')}`} onMouseDown={(e) => e.preventDefault()} onClick={() => onMark('strikethrough')} title="Strikethrough"><s>S</s></button>
          <button className={`ftb__btn${on('code')}`} onMouseDown={(e) => e.preventDefault()} onClick={() => onMark('code')} title="Inline code (Ctrl+E / ⌘E)"><code>{`</>`}</code></button>
          <div className="ftb__sep" />
          <button className={`ftb__btn${on('link')}`} onMouseDown={(e) => e.preventDefault()} onClick={onLinkTrigger} title="Link">⌖</button>
          <div className="ftb__sep" />
          <button
            className={`ftb__btn${flyout === 'text' ? ' ftb__btn--on' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setFlyout(flyout === 'text' ? null : 'text')}
            title="Text color"
          ><span className="ftb__ico" style={{ borderBottom: `2px solid ${activeStyles.color ?? 'currentColor'}` }}>A</span></button>
          <button
            className={`ftb__btn${flyout === 'bg' ? ' ftb__btn--on' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setFlyout(flyout === 'bg' ? null : 'bg')}
            title="Highlight"
          ><span className="ftb__ico" style={{ background: activeStyles.bg ?? undefined, borderRadius: 2, padding: '0 2px' }}>A</span></button>
          <button
            className={`ftb__btn${flyout === 'size' ? ' ftb__btn--on' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setFlyout(flyout === 'size' ? null : 'size')}
            title="Font size"
          >A↕</button>

          {flyout === 'text' && (
            <ColorPalette swatches={TEXT_COLORS} active={activeStyles.color} onPick={(v) => applyStyle('color', v)} />
          )}
          {flyout === 'bg' && (
            <ColorPalette swatches={BG_COLORS} active={activeStyles.bg} onPick={(v) => applyStyle('bg', v)} />
          )}
          {flyout === 'size' && (
            <SizePicker swatches={FONT_SIZES} active={activeStyles.size} onPick={(v) => applyStyle('size', v)} />
          )}
        </>
      )}
    </div>
  );
}
