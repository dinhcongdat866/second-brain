// ---------------------------------------------------------------------------
// Shared style presets for the formatting toolbars (markdown cell + weekly cell)
//
// Single source of truth so both toolbars, the PM schema marks, and the weekly
// markdown renderer agree on which colors / sizes exist. The `ALLOWED_*` sets
// are used by the weekly renderer to validate marker values before injecting
// a <span style> — only values we generated are ever emitted (no XSS from a
// hand-typed marker).
// ---------------------------------------------------------------------------

export interface Swatch {
  label: string;
  /** CSS value to apply. `null` means "clear / default" (removes the style). */
  value: string | null;
}

/** Text color presets — solid hex, readable on light and dark backgrounds. */
export const TEXT_COLORS: Swatch[] = [
  { label: 'Default', value: null },
  { label: 'Red',     value: '#e03131' },
  { label: 'Orange',  value: '#e8590c' },
  { label: 'Yellow',  value: '#f08c00' },
  { label: 'Green',   value: '#2f9e44' },
  { label: 'Teal',    value: '#0c8599' },
  { label: 'Blue',    value: '#1971c2' },
  { label: 'Violet',  value: '#9c36b5' },
];

/** Background/highlight presets — hex8 with alpha so they read over any bg. */
export const BG_COLORS: Swatch[] = [
  { label: 'None',    value: null },
  { label: 'Yellow',  value: '#ffe06688' },
  { label: 'Green',   value: '#b2f2bb88' },
  { label: 'Blue',    value: '#a5d8ff88' },
  { label: 'Pink',    value: '#fcc2d788' },
  { label: 'Grape',   value: '#eebefa88' },
  { label: 'Gray',    value: '#dee2e688' },
];

/** Font-size presets — em so they scale with the surrounding context. */
export const FONT_SIZES: Swatch[] = [
  { label: 'S',  value: '0.85em' },
  { label: 'M',  value: null },     // default
  { label: 'L',  value: '1.3em' },
  { label: 'XL', value: '1.7em' },
];

export const ALLOWED_TEXT = new Set(
  TEXT_COLORS.map((s) => s.value).filter((v): v is string => v != null),
);
export const ALLOWED_BG = new Set(
  BG_COLORS.map((s) => s.value).filter((v): v is string => v != null),
);
export const ALLOWED_SIZE = new Set(
  FONT_SIZES.map((s) => s.value).filter((v): v is string => v != null),
);

// ---------------------------------------------------------------------------
// Weekly-cell markers
//
// Weekly todos are stored as markdown strings in Yjs, so styles are encoded as
// compact markers the weekly renderer expands into spans:
//   {c=#e03131}text{/c}   text color
//   {b=#ffe06688}text{/b} background
//   {s=1.3em}text{/s}     font size
// ---------------------------------------------------------------------------

export type StyleKind = 'color' | 'bg' | 'size';

const KIND_CHAR: Record<StyleKind, string> = { color: 'c', bg: 'b', size: 's' };

export function weeklyOpen(kind: StyleKind, value: string): string {
  return `{${KIND_CHAR[kind]}=${value}}`;
}

export function weeklyClose(kind: StyleKind): string {
  return `{/${KIND_CHAR[kind]}}`;
}

/** Matches a style-marker opener `{c=...}` / `{b=...}` / `{s=...}` at index 0. */
export const STYLE_OPEN_RE = /^\{[cbs]=[^}]+\}/;
/** Matches a style-marker closer `{/c}` / `{/b}` / `{/s}` at index 0. */
export const STYLE_CLOSE_RE = /^\{\/[cbs]\}/;

/**
 * Expands weekly style markers in an already HTML-escaped string into spans.
 * A marker is only expanded if its value is one of our presets — otherwise the
 * literal marker text is left untouched (defends against hand-typed markers).
 */
export function renderStyleMarkers(escaped: string): string {
  return escaped
    .replace(/\{c=([^}]+)\}(.*?)\{\/c\}/gs, (m, v: string, inner: string) =>
      ALLOWED_TEXT.has(v) ? `<span style="color:${v}">${inner}</span>` : m,
    )
    .replace(/\{b=([^}]+)\}(.*?)\{\/b\}/gs, (m, v: string, inner: string) =>
      ALLOWED_BG.has(v) ? `<span style="background-color:${v}">${inner}</span>` : m,
    )
    .replace(/\{s=([^}]+)\}(.*?)\{\/s\}/gs, (m, v: string, inner: string) =>
      ALLOWED_SIZE.has(v) ? `<span style="font-size:${v}">${inner}</span>` : m,
    );
}
