import { createRoot, type Root } from 'react-dom/client';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';
import type * as Y from 'yjs';
import { getWeeklyPlan } from '../collab/weeklyPlans';
import { WeeklyPlannerCell } from './WeeklyPlannerCell';

// ---------------------------------------------------------------------------
// NodeView — bridges the weekly_planner_cell PM node ↔ the React weekly UI.
// weekly_planner_cell is an atom: ProseMirror owns nothing inside; React owns
// it all. Todo data lives in Yjs (collab/weeklyPlans), not in the PM doc.
// ---------------------------------------------------------------------------

export class WeeklyCellView implements NodeView {
  dom: HTMLElement;
  private root: Root;

  constructor(
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
    ydoc: Y.Doc,
  ) {
    this.dom = document.createElement('div');
    this.dom.className = 'weekly-cell-wrapper';

    // All planner cells share one plan in the global plannerYdoc.
    // Using a fixed key so every cell renders the same source of truth.
    const plan = getWeeklyPlan(ydoc, 'global');

    const onDelete = () => {
      const pos = getPos();
      if (pos == null) return;
      if (view.state.doc.childCount === 1) return;
      view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
      requestAnimationFrame(() => view.focus());
    };

    this.root = createRoot(this.dom);
    this.root.render(<WeeklyPlannerCell plan={plan} onDelete={onDelete} />);
  }

  update(node: PMNode) {
    return node.type.name === 'weekly_planner_cell';
  }

  stopEvent() {
    return true;
  }

  ignoreMutation() {
    return true;
  }

  destroy() {
    const root = this.root;
    queueMicrotask(() => root.unmount());
  }
}
