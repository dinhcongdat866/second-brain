import type * as Y from 'yjs';
import type { EditorView } from 'prosemirror-view';
import {
  insertMarkdownCell,
  makeInsertAiCell,
  makeInsertWeeklyCell,
  smartInsertTextblock,
  smartInsertBlockquote,
  smartInsertDivider,
  toggleCodeMark,
} from '../commands';
import { notebookSchema } from '../schema';

// ---------------------------------------------------------------------------
// ydoc late-bind
// ---------------------------------------------------------------------------
// slashOptions is a static module, but insertAiCell needs ydoc to seed the
// thread atomically with the cell creation. Call bindYDoc() once after the
// collab setup is ready (App.tsx / persistence.whenSynced).
// The app has exactly one Y.Doc per session — a module-level ref is safe.
// ---------------------------------------------------------------------------

let _ydoc: Y.Doc | null = null;

/** Wire the active Y.Doc so AI cell creation can seed its thread atomically. */
export function bindYDoc(ydoc: Y.Doc): void {
  _ydoc = ydoc;
}

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
  {
    id: 'ai-cell',
    label: 'AI cell',
    description: 'Hội thoại với AI về nội dung',
    icon: '✨',
    group: 'cell',
    keywords: ['ai', 'cell', 'chat', 'assistant', 'hoi', 'prompt'],
    run: (view) => {
      if (!_ydoc) {
        console.warn('[slashOptions] insertAiCell called before ydoc was bound');
        return;
      }
      dispatch(view, makeInsertAiCell(_ydoc));
    },
  },
  {
    id: 'weekly-cell',
    label: 'Weekly planner',
    description: 'Lịch tuần 7 cột với todo list',
    icon: '📅',
    group: 'cell',
    keywords: ['week', 'weekly', 'planner', 'todo', 'lich', 'tuan', 'calendar'],
    run: (view) => {
      if (!_ydoc) {
        console.warn('[slashOptions] insertWeeklyCell called before ydoc was bound');
        return;
      }
      dispatch(view, makeInsertWeeklyCell(_ydoc));
    },
  },
];

export const GROUP_LABELS: Record<SlashGroup, string> = {
  basic: 'Basic',
  block: 'Block',
  inline: 'Inline',
  cell: 'Cell',
};

// ---------------------------------------------------------------------------
// Filter + sort logic
// ---------------------------------------------------------------------------
// Scoring (higher = first):
//   3 — label starts with query  (e.g. "/ai" → "AI cell")
//   2 — a keyword starts with query (prefix match — avoids mid-word noise like
//        "plain" matching "/ai" because "pl*ai*n" ⊃ "ai")
//   1 — label contains query somewhere
// Keywords use startsWith, not includes, to prevent false positives.
// ---------------------------------------------------------------------------

export function filterSlashOptions(query: string): SlashOption[] {
  if (!query) return SLASH_OPTIONS;
  const q = query.toLowerCase();

  const scored: Array<{ opt: SlashOption; score: number }> = [];

  for (const opt of SLASH_OPTIONS) {
    const label = opt.label.toLowerCase();
    const labelStarts   = label.startsWith(q);
    const labelContains = label.includes(q);
    const kwStarts      = opt.keywords.some((k) => k.toLowerCase().startsWith(q));

    if (!labelContains && !kwStarts) continue;

    const score = labelStarts ? 3 : kwStarts ? 2 : 1;
    scored.push({ opt, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.opt);
}
