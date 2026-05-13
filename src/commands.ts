import { type Command, TextSelection, AllSelection } from 'prosemirror-state';
import type { Node as PMNode, NodeType } from 'prosemirror-model';
import {
  chainCommands,
  exitCode,
  setBlockType,
  wrapIn,
  lift,
  toggleMark,
} from 'prosemirror-commands';
import { notebookSchema, createMarkdownCell } from './schema';

// ---------------------------------------------------------------------------
// Insert hard break (Enter, Shift-Enter)
// ---------------------------------------------------------------------------
// Inserts <br> inline. exitCode is chained first as a safe no-op for future
// code-like nodes; today it just falls through.
// ---------------------------------------------------------------------------

export const insertHardBreak: Command = chainCommands(
  exitCode,
  (state, dispatch) => {
    const hardBreak = notebookSchema.nodes.hard_break;
    if (!hardBreak) return false;
    if (dispatch) {
      dispatch(
        state.tr.replaceSelectionWith(hardBreak.create()).scrollIntoView(),
      );
    }
    return true;
  },
);

// ---------------------------------------------------------------------------
// Insert cell as sibling at doc level
// ---------------------------------------------------------------------------
// Always insert AFTER the current cell as a top-level sibling — never nest.
// We bypass PM's auto-lift logic (which can be blocked by defining: true)
// by computing the doc-level position explicitly.
// ---------------------------------------------------------------------------

function insertCellAfterCurrent(cell: PMNode): Command {
  return (state, dispatch) => {
    if (!dispatch) return true;

    const { $from } = state.selection;
    const docType = state.schema.nodes.doc;

    // Find the depth where parent is doc — that's the top-level cell depth
    let cellDepth = -1;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d - 1).type === docType) {
        cellDepth = d;
        break;
      }
    }
    if (cellDepth === -1) return false;

    // Position right after the current top-level cell
    const insertPos = $from.after(cellDepth);
    const tr = state.tr.insert(insertPos, cell);

    // Explicit cursor placement inside the new cell's text content.
    // markdown_cell: open token (1) + paragraph open token (1) = +2
    // code_cell:     open token (1) = +1
    const isMarkdown = cell.type.name === 'markdown_cell';
    const cursorPos = insertPos + (isMarkdown ? 2 : 1);
    tr.setSelection(TextSelection.create(tr.doc, cursorPos));
    tr.scrollIntoView();

    dispatch(tr);
    return true;
  };
}

export const insertMarkdownCell: Command = (state, dispatch) => {
  return insertCellAfterCurrent(createMarkdownCell())(state, dispatch);
};

// ---------------------------------------------------------------------------
// Block-level commands (used by both keymaps and slash menu)
// ---------------------------------------------------------------------------

export const setHeading = (level: 1 | 2 | 3): Command =>
  setBlockType(notebookSchema.nodes.heading, { level });

export const setParagraph: Command = setBlockType(
  notebookSchema.nodes.paragraph,
);

// Toggle blockquote: wrap if not already in one, lift if inside.
export const toggleBlockquote: Command = (state, dispatch) => {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === notebookSchema.nodes.blockquote) {
      return lift(state, dispatch);
    }
  }
  return wrapIn(notebookSchema.nodes.blockquote)(state, dispatch);
};

export const insertHorizontalRule: Command = (state, dispatch) => {
  const hr = notebookSchema.nodes.horizontal_rule;
  if (!hr) return false;
  if (dispatch) {
    dispatch(state.tr.replaceSelectionWith(hr.create()).scrollIntoView());
  }
  return true;
};

// ---------------------------------------------------------------------------
// Smart insert (used by slash menu)
// ---------------------------------------------------------------------------
// Notion-style behavior:
//   - If cursor is in an EMPTY textblock → convert it (clean, no clutter)
//   - If cursor is in a NON-EMPTY textblock → insert new block below
// Result: multiple block types can coexist within a markdown_cell without
// each slash invocation destroying existing content.
// ---------------------------------------------------------------------------

export function smartInsertTextblock(
  type: NodeType,
  attrs?: Record<string, unknown>,
): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    const inEmptyTextblock =
      $from.parent.isTextblock && $from.parent.content.size === 0;

    if (inEmptyTextblock) {
      // Convert current empty textblock — preserves cell-clean structure
      return setBlockType(type, attrs)(state, dispatch);
    }

    // Insert as new sibling block below current
    if (!dispatch) return true;
    const newNode = type.createAndFill(attrs);
    if (!newNode) return false;

    const insertPos = $from.after($from.depth);
    const tr = state.tr.insert(insertPos, newNode);
    tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + 1)));
    tr.scrollIntoView();
    dispatch(tr);
    return true;
  };
}

export const smartInsertBlockquote: Command = (state, dispatch) => {
  const { $from } = state.selection;
  const inEmptyParagraph =
    $from.parent.type === notebookSchema.nodes.paragraph &&
    $from.parent.content.size === 0;

  if (inEmptyParagraph) {
    return wrapIn(notebookSchema.nodes.blockquote)(state, dispatch);
  }

  if (!dispatch) return true;
  const blockquote = notebookSchema.nodes.blockquote.createAndFill();
  if (!blockquote) return false;

  const insertPos = $from.after($from.depth);
  const tr = state.tr.insert(insertPos, blockquote);
  // +2: open blockquote + open inner paragraph
  tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + 2)));
  tr.scrollIntoView();
  dispatch(tr);
  return true;
};

export const smartInsertDivider: Command = (state, dispatch) => {
  if (!dispatch) return true;
  const hr = notebookSchema.nodes.horizontal_rule.create();
  const paragraph = notebookSchema.nodes.paragraph.create();
  const { $from } = state.selection;

  const inEmptyParagraph =
    $from.parent.type === notebookSchema.nodes.paragraph &&
    $from.parent.content.size === 0;

  let tr;
  let cursorPos: number;

  if (inEmptyParagraph) {
    // Replace empty paragraph with [hr, paragraph] — no clutter
    const startPos = $from.before();
    const endPos = $from.after();
    tr = state.tr.replaceWith(startPos, endPos, [hr, paragraph]);
    cursorPos = startPos + hr.nodeSize + 1;
  } else {
    // Insert below current block, keep existing content intact
    const insertPos = $from.after($from.depth);
    tr = state.tr.insert(insertPos, [hr, paragraph]);
    cursorPos = insertPos + hr.nodeSize + 1;
  }

  tr.setSelection(TextSelection.near(tr.doc.resolve(cursorPos)));
  tr.scrollIntoView();
  dispatch(tr);
  return true;
};

// ---------------------------------------------------------------------------
// Exit blockquote on Backspace at start of empty paragraph
// ---------------------------------------------------------------------------

export const exitBlockquoteOnBackspace: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty) return false;
  if ($from.parentOffset !== 0) return false;
  if ($from.parent.content.size !== 0) return false;

  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === notebookSchema.nodes.blockquote) {
      return lift(state, dispatch);
    }
  }
  return false;
};

// ---------------------------------------------------------------------------
// Prevent Backspace from pulling a paragraph INTO a previous blockquote
// ---------------------------------------------------------------------------
// PM's default joinBackward merges the current block into the previous one.
// When the previous block is a blockquote, this extends the blockquote —
// surprising and rarely desired. Block this specific case.
// ---------------------------------------------------------------------------

export const preventJoinIntoBlockquote: Command = (state) => {
  const { $from, empty } = state.selection;
  if (!empty) return false;
  if ($from.parentOffset !== 0) return false;

  // Current textblock must be a direct child of the cell
  const parent = $from.node($from.depth - 1);
  if (parent.type !== notebookSchema.nodes.markdown_cell) return false;

  const idx = $from.index($from.depth - 1);
  if (idx === 0) return false;

  const prevSibling = parent.child(idx - 1);
  if (prevSibling.type !== notebookSchema.nodes.blockquote) return false;

  // Returning true marks the key as handled — joinBackward never runs.
  return true;
};

// ---------------------------------------------------------------------------
// Exit current container (blockquote/heading) → new paragraph below it
// ---------------------------------------------------------------------------
// Mod-Enter from inside a blockquote/heading: keeps the original block intact
// and creates a fresh paragraph as its sibling, cursor moved into it.
// ---------------------------------------------------------------------------

export const exitToParagraph: Command = (state, dispatch) => {
  const { $from } = state.selection;

  // Walk up from cursor. Stop at cell boundary (never exit a cell).
  // Prefer outermost non-cell container (blockquote > heading > paragraph).
  let exitDepth = -1;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type === notebookSchema.nodes.markdown_cell) break;

    // Blockquote takes priority — exit the whole quote
    if (node.type === notebookSchema.nodes.blockquote) {
      exitDepth = d;
      break;
    }
    // Fallback: exit the current textblock (paragraph/heading)
    if (exitDepth === -1) exitDepth = d;
  }
  if (exitDepth === -1) return false;

  if (!dispatch) return true;
  const afterPos = $from.after(exitDepth);
  const newParagraph = notebookSchema.nodes.paragraph.create();
  const tr = state.tr.insert(afterPos, newParagraph);
  tr.setSelection(TextSelection.near(tr.doc.resolve(afterPos + 1)));
  tr.scrollIntoView();
  dispatch(tr);
  return true;
};

// ---------------------------------------------------------------------------
// Smart Select All — multi-stage Ctrl+A
// ---------------------------------------------------------------------------
// Press 1: select content of the current cell
// Press 2: select all content in the document
// ---------------------------------------------------------------------------

export const smartSelectAll: Command = (state, dispatch) => {
  const { $from, from, to } = state.selection;
  const docType = state.schema.nodes.doc;

  let cellDepth = -1;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d - 1).type === docType) {
      cellDepth = d;
      break;
    }
  }
  if (cellDepth === -1) return false;

  const cellStart = $from.start(cellDepth);
  const cellEnd = $from.end(cellDepth);

  const alreadyCellSelected = from === cellStart && to === cellEnd;

  if (alreadyCellSelected) {
    // Stage 2: select entire document
    if (dispatch) {
      dispatch(state.tr.setSelection(new AllSelection(state.doc)));
    }
    return true;
  }

  // Stage 1: select cell content
  const $start = state.doc.resolve(cellStart);
  const $end = state.doc.resolve(cellEnd);
  if (dispatch) {
    dispatch(state.tr.setSelection(TextSelection.between($start, $end)));
  }
  return true;
};

// ---------------------------------------------------------------------------
// Toggle inline code mark (for slash menu + keymap)
// ---------------------------------------------------------------------------

export const toggleCodeMark: Command = (state, dispatch) => {
  return toggleMark(notebookSchema.marks.code)(state, dispatch);
};
