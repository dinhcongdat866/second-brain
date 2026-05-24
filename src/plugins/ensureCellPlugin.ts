import { Plugin } from 'prosemirror-state';
import { createMarkdownCell } from '../schema';

// ---------------------------------------------------------------------------
// Ensure Cell Plugin
// ---------------------------------------------------------------------------
// PM's schema (doc → block+) guarantees at least one block always exists.
// But when user does Ctrl+A + Delete, the leftover might be:
//   - An empty code_cell (annoying — they wanted clean slate)
//   - An empty paragraph at doc level (orphan, not wrapped in cell)
//
// This plugin normalizes: if the doc has been reduced to a single empty
// non-markdown block, replace it with a fresh empty markdown_cell.
// ---------------------------------------------------------------------------

export const ensureCellPlugin = new Plugin({
  appendTransaction(transactions, _oldState, newState) {
    const docChanged = transactions.some((tr) => tr.docChanged);
    if (!docChanged) return null;

    const { doc } = newState;
    if (doc.childCount !== 1) return null;

    const onlyChild = doc.firstChild!;
    const isEmpty = onlyChild.content.size === 0;
    // markdown_cell and ai_cell are both legitimate lone survivors.
    // (ai_cell is an atom — content.size is always 0, but its real content
    //  lives in Yjs, so "empty" here does NOT mean "discardable".)
    const name = onlyChild.type.name;
    const isLegitCell = name === 'markdown_cell' || name === 'ai_cell';

    // Only fixup if doc has shrunk to a single empty non-cell block
    if (isEmpty && !isLegitCell) {
      const cell = createMarkdownCell();
      return newState.tr.replaceWith(0, doc.content.size, cell);
    }

    return null;
  },
});
