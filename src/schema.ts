import { Schema, type Node as PMNode } from 'prosemirror-model';
import { schema as basicSchema } from 'prosemirror-schema-basic';

// ---------------------------------------------------------------------------
// Notebook Schema
// ---------------------------------------------------------------------------
// Structure:
//   doc → block+ (mix paragraph, markdown_cell, code_cell — Notion-like)
//   markdown_cell → block+ (paragraph, heading, blockquote, hr)
//   code_cell → text* (plain text, no marks, monospace)
// ---------------------------------------------------------------------------

const generateId = () => crypto.randomUUID();
const nowISO = () => new Date().toISOString();

const baseCellAttrs = {
  id: { default: '' },
  created_at: { default: '' },
  updated_at: { default: '' },
};

// Group taxonomy:
//   'cell'  = top-level containers (markdown_cell, code_cell)
//   'block' = block-level content INSIDE markdown_cell
//             (paragraph, heading, blockquote, horizontal_rule)
// doc only accepts 'cell' — cells cannot nest into each other.
// markdown_cell only accepts 'block' — no nested cells.

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

    code_cell: {
      content: 'text*',
      group: 'cell',
      marks: '',
      code: true,
      isolating: true,
      attrs: {
        ...baseCellAttrs,
        language: { default: 'plain' },
      },
      parseDOM: [
        {
          tag: 'div[data-type="code-cell"]',
          preserveWhitespace: 'full',
        },
      ],
      toDOM(node) {
        return [
          'div',
          {
            'data-type': 'code-cell',
            'data-id': node.attrs.id,
            'data-language': node.attrs.language,
          },
          ['pre', 0],
        ];
      },
    },

    // ---- Inline-level (block content inside markdown_cell) ----
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

export function createCodeCell(language = 'plain', code = ''): PMNode {
  const content = code ? notebookSchema.text(code) : undefined;
  return notebookSchema.nodes.code_cell.create(
    makeCellAttrs({ language }),
    content,
  );
}

export function createInitialDoc(): PMNode {
  return notebookSchema.nodes.doc.create(null, [createMarkdownCell()]);
}

// DEV ONLY: sample doc with both cell types for visual testing
// before slash command lands. Swap back to createInitialDoc once
// users can insert cells via UI.
export function createDevSampleDoc(): PMNode {
  return notebookSchema.nodes.doc.create(null, [
    createMarkdownCell('Welcome to your second brain.'),
    createCodeCell('javascript', 'console.log("hello world")'),
    createMarkdownCell('Type below. Press Mod-Z to undo.'),
  ]);
}
