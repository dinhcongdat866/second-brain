import type { Swatch } from '../lib/toolbarStyles';

// ---------------------------------------------------------------------------
// Shared flyout pickers used by both formatting toolbars (markdown + weekly).
// Buttons apply on mousedown (preventDefault) so the underlying text selection
// is never lost — works regardless of whether the host toolbar reads the live
// PM selection or a saved native-selection range.
// ---------------------------------------------------------------------------

interface ColorPaletteProps {
  swatches: Swatch[];
  active: string | null;
  onPick: (value: string | null) => void;
}

export function ColorPalette({ swatches, active, onPick }: ColorPaletteProps) {
  return (
    <div className="ftb-flyout ftb-flyout--colors">
      {swatches.map((s) => (
        <button
          key={s.label}
          type="button"
          className={
            'ftb-swatch' +
            (s.value === null ? ' ftb-swatch--clear' : '') +
            (active === s.value ? ' ftb-swatch--on' : '')
          }
          style={s.value ? { background: s.value } : undefined}
          title={s.label}
          onMouseDown={(e) => { e.preventDefault(); onPick(s.value); }}
        >
          {s.value === null ? '×' : ''}
        </button>
      ))}
    </div>
  );
}

interface SizePickerProps {
  swatches: Swatch[];
  active: string | null;
  onPick: (value: string | null) => void;
}

export function SizePicker({ swatches, active, onPick }: SizePickerProps) {
  return (
    <div className="ftb-flyout ftb-flyout--sizes">
      {swatches.map((s) => (
        <button
          key={s.label}
          type="button"
          className={'ftb-size' + (active === s.value ? ' ftb-size--on' : '')}
          title={`Size ${s.label}`}
          onMouseDown={(e) => { e.preventDefault(); onPick(s.value); }}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
