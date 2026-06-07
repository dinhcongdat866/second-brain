import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { Node } from 'prosemirror-model';

export const placeholderKey = new PluginKey('placeholder');

function buildDecorations(doc: Node): DecorationSet {
  const decos: Decoration[] = [];

  doc.forEach((cell, cellOffset) => {
    if (cell.type.name !== 'markdown_cell') return;
    if (cell.childCount !== 1) return;

    const block = cell.firstChild!;
    if (block.type.name === 'paragraph' && block.content.size === 0) {
      // +1 for the cell's opening token to get the paragraph's position
      const paraPos = cellOffset + 1;
      decos.push(
        Decoration.node(paraPos, paraPos + block.nodeSize, {
          class: 'pm-placeholder',
        })
      );
    }
  });

  return DecorationSet.create(doc, decos);
}

export const placeholderPlugin = new Plugin({
  key: placeholderKey,
  state: {
    init(_, { doc }) {
      return buildDecorations(doc);
    },
    apply(tr, set) {
      if (!tr.docChanged) return set;

      // Determine the new-doc range touched by this transaction.
      let minChanged = Infinity, maxChanged = -Infinity;
      for (let i = 0; i < tr.steps.length; i++) {
        tr.mapping.maps[i].forEach((_oldFrom, _oldTo, newFrom, newTo) => {
          if (newFrom < minChanged) minChanged = newFrom;
          if (newTo   > maxChanged) maxChanged = newTo;
        });
      }

      if (minChanged === Infinity) return set.map(tr.mapping, tr.doc);

      // Map existing decorations through the transform (cheap), then do a
      // targeted re-scan only for cells that overlap the changed range.
      let newSet = set.map(tr.mapping, tr.doc);

      tr.doc.forEach((cell, cellOffset) => {
        if (cell.type.name !== 'markdown_cell' || cell.childCount !== 1) return;
        const cellEnd = cellOffset + cell.nodeSize;
        if (cellEnd <= minChanged || cellOffset >= maxChanged) return;

        const block = cell.firstChild!;
        if (block.type.name !== 'paragraph') return;

        const paraPos = cellOffset + 1;
        const paraEnd = paraPos + block.nodeSize;

        // Remove potentially-stale decoration for this paragraph.
        const stale = newSet.find(paraPos, paraEnd);
        if (stale.length > 0) newSet = newSet.remove(stale);

        // Re-add if the paragraph is now empty.
        if (block.content.size === 0) {
          newSet = newSet.add(tr.doc, [
            Decoration.node(paraPos, paraEnd, { class: 'pm-placeholder' }),
          ]);
        }
      });

      return newSet;
    },
  },
  props: {
    decorations(state) {
      return this.getState(state);
    },
  },
});
