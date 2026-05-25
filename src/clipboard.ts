import { Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import type { EditorState, Transaction } from 'prosemirror-state';

// ---------------------------------------------------------------------------
// transformPastedHTML
// ---------------------------------------------------------------------------
// Convert HTML elements the schema doesn't support into safe equivalents.
// Lists → paragraphs. Tables → one paragraph per row (cells joined by " · ").

export function transformPastedHTML(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  flattenLists(doc.body);
  flattenTables(doc.body);
  return doc.body.innerHTML;
}

function flattenLists(root: Element): void {
  const d = root.ownerDocument!;
  root.querySelectorAll('li').forEach(li => {
    const p = d.createElement('p');
    p.innerHTML = li.innerHTML;
    li.replaceWith(p);
  });
  root.querySelectorAll('ul, ol').forEach(list => {
    const parent = list.parentNode!;
    while (list.firstChild) parent.insertBefore(list.firstChild, list);
    parent.removeChild(list);
  });
}

function flattenTables(root: Element): void {
  const d = root.ownerDocument!;
  root.querySelectorAll('table').forEach(table => {
    const parent = table.parentNode!;
    table.querySelectorAll('tr').forEach(row => {
      const cells = Array.from(row.querySelectorAll('td, th'))
        .map(c => c.textContent?.trim())
        .filter(Boolean);
      if (!cells.length) return;
      const p = d.createElement('p');
      p.textContent = cells.join(' · ');
      parent.insertBefore(p, table);
    });
    parent.removeChild(table);
  });
}

// ---------------------------------------------------------------------------
// pasteNormPlugin
// ---------------------------------------------------------------------------
// After a paste that leaves the cursor at the END of a heading — and the
// cursor was NOT already inside a heading before the paste — insert an empty
// paragraph after the heading and move the cursor into it.
//
// Why: pasting rich HTML like "<h2>Title</h2>" leaves the cursor inside the
// heading node. Every subsequent keystroke or paste then continues as heading,
// which surprises users. Adding a paragraph exit mirrors Notion / Google Docs.

const pasteNormKey = new PluginKey<null>('pasteNorm');

export const pasteNormPlugin = new Plugin({
  key: pasteNormKey,
  appendTransaction(
    transactions: readonly Transaction[],
    prevState: EditorState,
    nextState: EditorState,
  ) {
    if (!transactions.some(tr => tr.getMeta('uiEvent') === 'paste')) return null;

    const { $from } = nextState.selection;
    const headingType = nextState.schema.nodes.heading;

    const atHeadingEnd =
      $from.parent.type === headingType &&
      $from.parentOffset === $from.parent.content.size;
    if (!atHeadingEnd) return null;

    // Don't interfere when the user was already editing a heading before paste.
    if (prevState.selection.$from.parent.type === headingType) return null;

    const headingEnd = $from.after($from.depth);
    const tr = nextState.tr;
    const para = nextState.schema.nodes.paragraph.create();
    tr.insert(headingEnd, para);
    tr.setSelection(TextSelection.near(tr.doc.resolve(headingEnd + 1)));
    return tr;
  },
});
