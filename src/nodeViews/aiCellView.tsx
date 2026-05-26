import { createRoot, type Root } from 'react-dom/client';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';
import type * as Y from 'yjs';
import { getThread } from '../collab/aiThreads';
import { extractDocContext } from '../lib/docContext';
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
    docId: string,
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
      // Return focus to PM editor so Ctrl+Z immediately undoes the deletion.
      requestAnimationFrame(() => view.focus());
    };

    const getDocContext = () => extractDocContext(view.state.doc);

    this.root = createRoot(this.dom);
    this.root.render(
      <AiCell thread={thread} getDocContext={getDocContext} onDelete={onDelete} cellId={cellId} docId={docId} />,
    );

    // After React renders, move browser focus into the ai_cell's input field.
    // Without this, the PM contenteditable still holds focus with a NodeSelection
    // on the newly inserted atom — any keypress would replace the node.
    setTimeout(() => {
      const input = this.dom.querySelector<HTMLInputElement>('input');
      input?.focus();
    }, 0);
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
