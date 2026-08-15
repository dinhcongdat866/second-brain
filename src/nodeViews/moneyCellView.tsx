import { createRoot, type Root } from 'react-dom/client';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';
import type * as Y from 'yjs';
import type { PlannerHandle } from '../collab/plannerHandle';
import { MoneyCell } from './MoneyCell';

/**
 * Bridges the money_cell PM node ↔ the React money lens. An atom that holds no
 * data of its own — every figure is read out of the money log in the planner
 * Y.Doc, so two of these cells in two documents can never disagree.
 */
export class MoneyCellView implements NodeView {
  dom: HTMLElement;
  private root: Root;
  private unsubscribe?: () => void;

  constructor(
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
    planner: PlannerHandle,
    isGuest: boolean,
  ) {
    this.dom = document.createElement('div');
    this.dom.className = 'money-cell-wrapper';
    this.root = createRoot(this.dom);

    const onDelete = () => {
      const pos = getPos();
      if (pos == null) return;
      if (view.state.doc.childCount === 1) return;
      view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
      requestAnimationFrame(() => view.focus());
    };

    const render = (ydoc: Y.Doc) => {
      this.root.render(<MoneyCell ydoc={ydoc} onDelete={onDelete} isGuest={isGuest} />);
    };

    const ydoc = planner.get();
    if (ydoc) {
      render(ydoc);
      return;
    }

    // Same rule as the weekly cell: totals from a doc whose entries have not
    // been applied yet would show a confident zero for a moment.
    this.root.render(<div className="money-cell-loading">Loading…</div>);
    this.unsubscribe = planner.subscribe((loaded) => {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      render(loaded);
    });
  }

  update(node: PMNode) {
    return node.type.name === 'money_cell';
  }

  stopEvent() {
    return true;
  }

  ignoreMutation() {
    return true;
  }

  destroy() {
    this.unsubscribe?.();
    const root = this.root;
    queueMicrotask(() => root.unmount());
  }
}
