import type { EditorView } from 'prosemirror-view';
import {
  insertMarkdownCell,
  smartInsertTextblock,
  smartInsertBlockquote,
  smartInsertDivider,
  toggleCodeMark,
} from '../commands';
import { notebookSchema } from '../schema';

// ---------------------------------------------------------------------------
// Slash menu options
// ---------------------------------------------------------------------------
// Single source of truth: both keymap and slash menu execute through these
// commands. Adding a new option here makes it discoverable in the menu.
// ---------------------------------------------------------------------------

export type SlashGroup = 'basic' | 'block' | 'inline' | 'cell';

export interface SlashOption {
  id: string;
  label: string;
  description?: string;
  icon: string;
  group: SlashGroup;
  keywords: string[];
  shortcut?: string;
  run: (view: EditorView) => void;
}

function dispatch(
  view: EditorView,
  cmd: (state: EditorView['state'], dispatch: EditorView['dispatch']) => boolean,
) {
  cmd(view.state, view.dispatch);
  view.focus();
}

export const SLASH_OPTIONS: SlashOption[] = [
  // ---- Basic ----
  {
    id: 'heading-1',
    label: 'Heading 1',
    description: 'Large section heading',
    icon: 'H1',
    group: 'basic',
    keywords: ['heading', 'h1', 'title', 'large'],
    shortcut: 'Mod+Alt+1',
    run: (view) =>
      dispatch(
        view,
        smartInsertTextblock(notebookSchema.nodes.heading, { level: 1 }),
      ),
  },
  {
    id: 'heading-2',
    label: 'Heading 2',
    description: 'Medium section heading',
    icon: 'H2',
    group: 'basic',
    keywords: ['heading', 'h2', 'subtitle'],
    shortcut: 'Mod+Alt+2',
    run: (view) =>
      dispatch(
        view,
        smartInsertTextblock(notebookSchema.nodes.heading, { level: 2 }),
      ),
  },
  {
    id: 'heading-3',
    label: 'Heading 3',
    description: 'Small section heading',
    icon: 'H3',
    group: 'basic',
    keywords: ['heading', 'h3'],
    shortcut: 'Mod+Alt+3',
    run: (view) =>
      dispatch(
        view,
        smartInsertTextblock(notebookSchema.nodes.heading, { level: 3 }),
      ),
  },
  {
    id: 'paragraph',
    label: 'Paragraph',
    description: 'Plain text block',
    icon: '¶',
    group: 'basic',
    keywords: ['paragraph', 'text', 'plain'],
    shortcut: 'Mod+Alt+0',
    run: (view) =>
      dispatch(view, smartInsertTextblock(notebookSchema.nodes.paragraph)),
  },

  // ---- Block ----
  {
    id: 'blockquote',
    label: 'Quote',
    description: 'Wrap or add a blockquote',
    icon: '❝',
    group: 'block',
    keywords: ['quote', 'blockquote', 'citation'],
    shortcut: 'Mod+Alt+Q',
    run: (view) => dispatch(view, smartInsertBlockquote),
  },
  {
    id: 'divider',
    label: 'Divider',
    description: 'Visual horizontal rule',
    icon: '—',
    group: 'block',
    keywords: ['divider', 'separator', 'hr', 'horizontal', 'line'],
    shortcut: 'Mod+Alt+D',
    run: (view) => dispatch(view, smartInsertDivider),
  },

  // ---- Inline ----
  {
    id: 'code-inline',
    label: 'Code',
    description: 'Inline code formatting',
    icon: '<>',
    group: 'inline',
    keywords: ['code', 'inline', 'mono', 'snippet'],
    shortcut: 'Mod+E',
    run: (view) => dispatch(view, toggleCodeMark),
  },

  // ---- Cell ----
  {
    id: 'markdown-cell',
    label: 'New markdown cell',
    description: 'Add a new cell below',
    icon: '＋',
    group: 'cell',
    keywords: ['cell', 'new', 'markdown', 'block'],
    shortcut: 'Mod+Alt+M',
    run: (view) => dispatch(view, insertMarkdownCell),
  },
];

export const GROUP_LABELS: Record<SlashGroup, string> = {
  basic: 'Basic',
  block: 'Block',
  inline: 'Inline',
  cell: 'Cell',
};

// ---------------------------------------------------------------------------
// Filter logic — simple substring match against label + keywords
// ---------------------------------------------------------------------------

export function filterSlashOptions(query: string): SlashOption[] {
  if (!query) return SLASH_OPTIONS;
  const q = query.toLowerCase();
  return SLASH_OPTIONS.filter((opt) => {
    if (opt.label.toLowerCase().includes(q)) return true;
    return opt.keywords.some((k) => k.toLowerCase().includes(q));
  });
}
