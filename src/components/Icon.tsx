/**
 * The app's icon set — outline strokes, one grid, one weight.
 *
 * The header used to mix three languages: text labels ("History", "Import .md"),
 * an emoji (📊) and a filled colour swatch, so no two controls looked like they
 * belonged to the same set. Emoji in particular render in the system's own
 * colour and weight, which is why one of them looked pasted in.
 *
 * These inherit `currentColor` and size from `font-size`, so a button styles
 * them the same way it styles a text label.
 */
interface IconProps {
  name: IconName;
  /** Pixel size of the square box. Defaults to 17 — the header's size. */
  size?: number;
}

export type IconName =
  | 'menu'
  | 'history'
  | 'chart'
  | 'palette'
  | 'more'
  | 'import'
  | 'export'
  | 'eye'
  | 'eyeOff'
  | 'share'
  | 'close'
  | 'back';

/** Path data only — every icon shares the 24×24 box and the stroke below. */
const PATHS: Record<IconName, string> = {
  menu:    'M4 7h16M4 12h16M4 17h16',
  history: 'M3 12a9 9 0 1 0 3-6.7M3 4v4h4M12 8v4l3 2',
  chart:   'M4 20V10M10 20V4M16 20v-7M4 20h16',
  palette: 'M12 3a9 9 0 1 0 0 18h1.5a2 2 0 0 0 1.6-3.2 2 2 0 0 1 1.6-3.2H19a2.5 2.5 0 0 0 2.5-2.5A9.3 9.3 0 0 0 12 3ZM7.5 12.5h.01M9.5 8.5h.01M14 7.5h.01',
  more:    'M5 12h.01M12 12h.01M19 12h.01',
  import:  'M12 3v11M8 10.5l4 3.5 4-3.5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  export:  'M12 14V3M8 6.5 12 3l4 3.5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  eye:     'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  eyeOff:  'M4 4l16 16M9.9 5.2A9.9 9.9 0 0 1 12 5c6.5 0 10 6 10 6a17 17 0 0 1-3.3 3.9M6.3 7.9A17 17 0 0 0 2 11s3.5 6 10 6a10 10 0 0 0 3.4-.6',
  share:   'M15 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM15 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8.6 13.5l3.8 2.2M12.4 8.3 8.6 10.5',
  close:   'M6 6l12 12M18 6 6 18',
  back:    'M15 5l-7 7 7 7',
};

export function Icon({ name, size = 17 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block' }}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
