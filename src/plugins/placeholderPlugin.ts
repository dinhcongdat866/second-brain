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
      return buildDecorations(tr.doc);
    },
  },
  props: {
    decorations(state) {
      return this.getState(state);
    },
  },
});
