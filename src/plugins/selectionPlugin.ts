import { Plugin } from 'prosemirror-state';
import type { EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

type Listener = (view: EditorView) => void;
const listeners = new Set<Listener>();

export const selectionPlugin = new Plugin({
  view() {
    return {
      update(view: EditorView, prevState: EditorState) {
        if (view.state.selection.eq(prevState.selection)) return;
        listeners.forEach((cb) => cb(view));
      },
    };
  },
});

export function subscribeToSelection(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
