import { Schema, type Node as PMNode } from 'prosemirror-model';
import { schema as basicSchema } from 'prosemirror-schema-basic';

// ---------------------------------------------------------------------------
// Notebook Schema
// ---------------------------------------------------------------------------
// Structure:
//   doc → cell+ (markdown_cell | ai_cell)
//   markdown_cell → block+ (paragraph, heading, blockquote, hr)
//   ai_cell → atom (no PM content; conversation lives in Yjs — collab/aiThreads)
// ---------------------------------------------------------------------------

const generateId = () => crypto.randomUUID();
const nowISO = () => new Date().toISOString();

const baseCellAttrs = {
  id: { default: '' },
  created_at: { default: '' },
  updated_at: { default: '' },
};

// Group taxonomy:
//   'cell'  = top-level containers (markdown_cell, ai_cell;
//             future: code_cell, chart_cell, etc.)
//   'block' = block-level content INSIDE a cell
//             (paragraph, heading, blockquote, horizontal_rule)
// doc only accepts 'cell' — cells cannot nest into each other.

export const notebookSchema = new Schema({
  nodes: {
    // Root: only cells at top level
    doc: {
      content: 'cell+',
    },

    // ---- Cell types ----

    markdown_cell: {
      content: 'block+',
      group: 'cell',
      attrs: baseCellAttrs,
      isolating: true,
      parseDOM: [{ tag: 'div[data-type="markdown-cell"]' }],
      toDOM(node) {
        return [
          'div',
          {
            'data-type': 'markdown-cell',
            'data-id': node.attrs.id,
          },
          0,
        ];
      },
    },

    // ai_cell: atom — PM owns nothing inside; a NodeView (React) renders the
    // whole chat UI, and the conversation data lives in Yjs (collab/aiThreads).
    ai_cell: {
      group: 'cell',
      atom: true,
      attrs: baseCellAttrs,
      parseDOM: [{ tag: 'div[data-type="ai-cell"]' }],
      toDOM(node) {
        return ['div', { 'data-type': 'ai-cell', 'data-id': node.attrs.id }];
      },
    },

    // ---- Block-level content inside markdown_cell ----
    // Override group from schema-basic to ensure they belong to 'block', not 'cell'.

    paragraph: { ...basicSchema.spec.nodes.get('paragraph')!, group: 'block' },
    heading: { ...basicSchema.spec.nodes.get('heading')!, group: 'block' },
    blockquote: { ...basicSchema.spec.nodes.get('blockquote')!, group: 'block' },
    horizontal_rule: {
      ...basicSchema.spec.nodes.get('horizontal_rule')!,
      group: 'block',
    },
    text: basicSchema.spec.nodes.get('text')!,
    hard_break: basicSchema.spec.nodes.get('hard_break')!,
  },
  marks: basicSchema.spec.marks,
});

// ---------------------------------------------------------------------------
// Helpers for creating cells with proper defaults
// ---------------------------------------------------------------------------
// Schema defaults can't be functions, so generate id/timestamps via helpers.
// Always create cells through these — never direct .create() with empty attrs.
// ---------------------------------------------------------------------------

function makeCellAttrs(extra: Record<string, unknown> = {}) {
  const now = nowISO();
  return {
    id: generateId(),
    created_at: now,
    updated_at: now,
    ...extra,
  };
}

export function createMarkdownCell(text = ''): PMNode {
  const paragraph = text
    ? notebookSchema.nodes.paragraph.create(null, notebookSchema.text(text))
    : notebookSchema.nodes.paragraph.create();
  return notebookSchema.nodes.markdown_cell.create(makeCellAttrs(), paragraph);
}

export function createAiCell(): PMNode {
  return notebookSchema.nodes.ai_cell.create(makeCellAttrs());
}

export function createInitialDoc(): PMNode {
  return notebookSchema.nodes.doc.create(null, [createMarkdownCell()]);
}
