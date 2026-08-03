import { createRoot, type Root } from 'react-dom/client';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';
import type * as Y from 'yjs';
import type { PlannerHandle } from '../collab/plannerHandle';
import { WeeklyPlannerCell } from './WeeklyPlannerCell';

// ---------------------------------------------------------------------------
// NodeView — bridges the weekly_planner_cell PM node ↔ the React weekly UI.
// weekly_planner_cell is an atom: ProseMirror owns nothing inside; React owns
// it all. Todo data lives in Yjs (collab/weeklyPlans), not in the PM doc.
// ---------------------------------------------------------------------------

export class WeeklyCellView implements NodeView {
  dom: HTMLElement;
  private root: Root;
  private unsubscribe?: () => void;

  constructor(
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
    planner: PlannerHandle,
  ) {
    this.dom = document.createElement('div');
    this.dom.className = 'weekly-cell-wrapper';
    this.root = createRoot(this.dom);

    const onDelete = () => {
      const pos = getPos();
      if (pos == null) return;
      if (view.state.doc.childCount === 1) return;
      view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
      requestAnimationFrame(() => view.focus());
    };

    // All planner cells share the single 'global' plan inside the planner doc;
    // the component resolves (and re-resolves after merges) it internally.
    const renderPlanner = (ydoc: Y.Doc) => {
      this.root.render(<WeeklyPlannerCell ydoc={ydoc} onDelete={onDelete} />);
    };

    const ydoc = planner.get();
    if (ydoc) {
      renderPlanner(ydoc);
      return;
    }

    // The planner doc is still loading. Never call getWeeklyPlan on a
    // still-loading doc: it would create an empty 'global' plan that can shadow
    // the real one on merge (data loss). Show a placeholder and swap in the
    // real UI the moment the handle publishes the doc.
    this.root.render(<div className="weekly-cell-loading">Loading planner…</div>);
    this.unsubscribe = planner.subscribe((loaded) => {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      renderPlanner(loaded);
    });
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
    this.unsubscribe?.();
    const root = this.root;
    queueMicrotask(() => root.unmount());
  }
}
