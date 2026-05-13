import { type Command, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { chainCommands, exitCode } from 'prosemirror-commands';
import { notebookSchema, createCodeCell, createMarkdownCell } from './schema';

// ---------------------------------------------------------------------------
// Insert hard break (Enter, Shift-Enter)
// ---------------------------------------------------------------------------
// In code_cell (which doesn't allow inline nodes), this would fail — caller
// should chain with newlineInCode for code cells.
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

export const insertCodeCell: Command = (state, dispatch) => {
  return insertCellAfterCurrent(createCodeCell())(state, dispatch);
};

export const insertMarkdownCell: Command = (state, dispatch) => {
  return insertCellAfterCurrent(createMarkdownCell())(state, dispatch);
};
