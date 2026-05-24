import { createRoot, type Root } from 'react-dom/client';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';
import type * as Y from 'yjs';
import { getThread } from '../collab/aiThreads';
import { AiCell } from './AiCell';

// ---------------------------------------------------------------------------
// NodeView — bridges the ai_cell PM node ↔ the React chat UI (AiCell).
// ai_cell is an atom: ProseMirror owns nothing inside; React owns it all.
// The conversation lives in Yjs (collab/aiThreads), NOT in the PM document.
// ---------------------------------------------------------------------------

export class AiCellView implements NodeView {
  dom: HTMLElement;
  private root: Root;

  constructor(
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
    ydoc: Y.Doc,
  ) {
    this.dom = document.createElement('div');
    this.dom.className = 'ai-cell';
    this.dom.setAttribute('data-type', 'ai-cell');

    const cellId = node.attrs.id as string;
    const thread = getThread(ydoc, cellId);

    const onDelete = () => {
      const pos = getPos();
      if (pos == null) return;
      // Never delete the last remaining cell — keeps the doc schema-valid.
      if (view.state.doc.childCount === 1) return;
      view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
    };

    this.root = createRoot(this.dom);
    this.root.render(<AiCell thread={thread} onDelete={onDelete} />);
  }

  // atom node with stable attrs — keep this NodeView, never recreate.
  update(node: PMNode) {
    return node.type.name === 'ai_cell';
  }

  // React owns all interaction; PM must not handle events or observe mutations.
  stopEvent() {
    return true;
  }
  
  ignoreMutation() {
    return true;
  }

  destroy() {
    // Unmount on a microtask — React forbids unmount during a render cycle.
    const root = this.root;
    queueMicrotask(() => root.unmount());
  }
}
