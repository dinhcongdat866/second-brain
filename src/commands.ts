import {
  type Command,
  TextSelection,
  NodeSelection,
  AllSelection,
  Selection,
} from 'prosemirror-state';
import type { Node as PMNode, NodeType } from 'prosemirror-model';
import {
  chainCommands,
  exitCode,
  setBlockType,
  wrapIn,
  lift,
  toggleMark,
} from 'prosemirror-commands';
import type * as Y from 'yjs';
import { notebookSchema, createMarkdownCell, createAiCell } from './schema';
import { getThread } from './collab/aiThreads';

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

    // Position right after the current top-level cell.
    // When inserting a markdown_cell, skip past any immediately-following ai_cells.
    // An ai_cell "belongs" to its preceding context; a new markdown_cell should
    // open a fresh section AFTER the whole AI exchange.
    let insertPos = $from.after(cellDepth);
    if (cell.type.name === 'markdown_cell') {
      const { doc } = state;
      while (insertPos < doc.content.size) {
        const next = doc.nodeAt(insertPos);
        if (!next || next.type.name !== 'ai_cell') break;
        insertPos += next.nodeSize;
      }
    }

    const tr = state.tr.insert(insertPos, cell);

    if (cell.type.name === 'ai_cell') {
      // ai_cell is an atom — no text position inside; select the node itself.
      tr.setSelection(NodeSelection.create(tr.doc, insertPos));
    } else {
      // markdown_cell: open token (1) + paragraph open token (1) = +2
      tr.setSelection(TextSelection.create(tr.doc, insertPos + 2));
    }
    tr.scrollIntoView();

    dispatch(tr);
    return true;
  };
}

export const insertMarkdownCell: Command = (state, dispatch) => {
  return insertCellAfterCurrent(createMarkdownCell())(state, dispatch);
};

/**
 * Factory that returns a Command for inserting an ai_cell.
 *
 * Critically, the ai_cell's Y.Array thread entry is created inside the SAME
 * ydoc.transact() as the PM dispatch. This produces ONE Yjs update message
 * that carries both the XmlFragment change and the aiThreads entry atomically.
 *
 * Without this, a peer can receive the XmlFragment update (ai_cell appears),
 * mount the NodeView, call getThread() and create its own Y.Array — before
 * the creator's aiThreads update arrives. Two peers then hold different Y.Array
 * instances under the same Y.Map key; Y.Map last-write-wins discards one,
 * silently losing every message written to it.
 */
export function makeInsertAiCell(ydoc: Y.Doc): Command {
  return (state, dispatch) => {
    const cell = createAiCell();
    ydoc.transact(() => {
      // PM dispatch runs synchronously; ySyncPlugin's inner ydoc.transact()
      // is absorbed into this outer one — both changes land in one update.
      insertCellAfterCurrent(cell)(state, dispatch);
      getThread(ydoc, cell.attrs.id as string);
    });
    return true;
  };
}

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

  const expectedSel = TextSelection.between(
    state.doc.resolve(cellStart),
    state.doc.resolve(cellEnd),
  );
  const alreadyCellSelected = from === expectedSel.from && to === expectedSel.to;

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

// ---------------------------------------------------------------------------
// Append cell at end of doc (used by the "Add cell" button bar below editor)
// These do NOT depend on cursor position — always insert after the last cell.
// ---------------------------------------------------------------------------

export const appendMarkdownCell: Command = (state, dispatch) => {
  const cell = createMarkdownCell();
  const insertPos = state.doc.content.size;
  if (dispatch) {
    const tr = state.tr.insert(insertPos, cell);
    tr.setSelection(TextSelection.create(tr.doc, insertPos + 2));
    tr.scrollIntoView();
    dispatch(tr);
  }
  return true;
};

export function makeAppendAiCell(ydoc: Y.Doc): Command {
  return (state, dispatch) => {
    const cell = createAiCell();
    const insertPos = state.doc.content.size;
    ydoc.transact(() => {
      if (dispatch) {
        const tr = state.tr.insert(insertPos, cell);
        tr.setSelection(NodeSelection.create(tr.doc, insertPos));
        tr.scrollIntoView();
        dispatch(tr);
      }
      getThread(ydoc, cell.attrs.id as string);
    });
    return true;
  };
}

// ---------------------------------------------------------------------------
// Convert empty heading → paragraph on Backspace
// ---------------------------------------------------------------------------
// When cursor is at the start of an empty heading, Backspace converts it to
// a plain paragraph instead of deleting — consistent with Notion behavior.
// deleteEmptyCell then handles the next Backspace if the paragraph is the
// only child in the cell.
// ---------------------------------------------------------------------------

export const convertEmptyHeadingToParagraph: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty) return false;
  if ($from.parentOffset !== 0) return false;
  if ($from.parent.content.size !== 0) return false;
  if ($from.parent.type !== notebookSchema.nodes.heading) return false;

  return setParagraph(state, dispatch);
};

// ---------------------------------------------------------------------------
// Delete empty cell on Backspace
// ---------------------------------------------------------------------------
// If the cursor is in a markdown_cell that has exactly one empty paragraph,
// delete the whole cell and move cursor to the previous cell (or next if first).
// ensureCellPlugin will backfill a fresh cell if the doc ends up empty.
// ---------------------------------------------------------------------------

export const deleteEmptyCell: Command = (state, dispatch) => {
  const { selection, doc } = state;
  if (!selection.empty) return false;

  const { $from } = selection;

  // Find markdown_cell depth
  let cellDepth = -1;
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type.name === 'markdown_cell') {
      cellDepth = d;
      break;
    }
  }
  if (cellDepth === -1) return false;

  const cell = $from.node(cellDepth);

  // Cell must be empty: one paragraph, no text
  if (cell.childCount !== 1) return false;
  const block = cell.firstChild!;
  if (block.type.name !== 'paragraph' || block.content.size !== 0) return false;

  // Don't delete the last remaining cell
  if (doc.childCount === 1) return false;

  if (dispatch) {
    const cellStart = $from.before(cellDepth);
    const cellEnd = cellStart + cell.nodeSize;
    const isFirstCell = cellStart === 0;

    const tr = state.tr.delete(cellStart, cellEnd);

    // Move cursor to end of previous cell, or start of next if deleting first
    const targetPos = isFirstCell ? cellStart : cellStart - 1;
    const resolved = tr.doc.resolve(Math.max(0, targetPos));
    tr.setSelection(Selection.near(resolved, isFirstCell ? 1 : -1));
    dispatch(tr.scrollIntoView());
  }

  return true;
};
