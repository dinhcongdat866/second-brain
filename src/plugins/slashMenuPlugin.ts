import { Plugin, PluginKey } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { useUIStore } from '../stores/uiStore';
import {
  filterSlashOptions,
  SLASH_OPTIONS,
  type SlashOption,
} from './slashOptions';

// ---------------------------------------------------------------------------
// SlashMenuPlugin
// ---------------------------------------------------------------------------
// Detects "/" typed in a valid context (start of textblock or after space) and
// activates a slash menu. Tracks query text typed after "/", manages selected
// index via arrow keys, executes the selected option on Enter.
//
// Plugin state is the SOURCE OF TRUTH. Zustand is a MIRROR for React.
// All updates to Zustand happen in view().update() — never in apply().
// ---------------------------------------------------------------------------

interface SlashPluginState {
  active: boolean;
  /** Doc position of the triggering "/" character */
  triggerPos: number;
  /** Selected index within FILTERED options list */
  selectedIndex: number;
}

const inactive: SlashPluginState = {
  active: false,
  triggerPos: -1,
  selectedIndex: 0,
};

type SlashMeta =
  | { type: 'open'; pos: number }
  | { type: 'close' }
  | { type: 'setIndex'; index: number };

export const slashMenuKey = new PluginKey<SlashPluginState>('slashMenu');

// Helper to read current query from doc + triggerPos
function readQuery(doc: import('prosemirror-model').Node, triggerPos: number, head: number): string {
  if (head <= triggerPos) return '';
  return doc.textBetween(triggerPos + 1, head, '\n', '\0');
}

// Helper to execute a selected option
export function executeSlashOption(view: EditorView, option: SlashOption) {
  const state = slashMenuKey.getState(view.state);
  if (!state?.active) return;

  // 1. Delete "/" + query text
  // 2. Close slash menu via meta
  const tr = view.state.tr
    .delete(state.triggerPos, view.state.selection.to)
    .setMeta(slashMenuKey, { type: 'close' } satisfies SlashMeta);
  view.dispatch(tr);

  // 3. Run the option's command on the now-updated state
  option.run(view);
}

export const slashMenuPlugin = new Plugin<SlashPluginState>({
  key: slashMenuKey,

  state: {
    init() {
      return inactive;
    },
    apply(tr, prev) {
      const meta = tr.getMeta(slashMenuKey) as SlashMeta | undefined;

      if (meta?.type === 'open') {
        return { active: true, triggerPos: meta.pos, selectedIndex: 0 };
      }
      if (meta?.type === 'close') {
        return inactive;
      }
      if (meta?.type === 'setIndex') {
        return { ...prev, selectedIndex: meta.index };
      }

      if (!prev.active) return prev;

      // Active — map triggerPos through doc changes
      const newTriggerPos = tr.mapping.map(prev.triggerPos);
      const head = tr.selection.head;

      // Selection moved before or onto the "/" → close
      if (head <= newTriggerPos) return inactive;

      // Query contains whitespace → user is typing normally → close
      const query = readQuery(tr.doc, newTriggerPos, head);
      if (/\s/.test(query)) return inactive;

      // Reset selectedIndex if doc changed (query likely changed)
      const selectedIndex = tr.docChanged ? 0 : prev.selectedIndex;

      return {
        active: true,
        triggerPos: newTriggerPos,
        selectedIndex,
      };
    },
  },

  props: {
    handleTextInput(view, from, _to, text) {
      if (text !== '/') return false;

      const state = view.state;
      const $from = state.selection.$from;

      // Don't trigger inside code mark (user is writing actual code)
      const codeMark = state.schema.marks.code;
      if (codeMark && $from.marks().some((m) => m.type === codeMark)) {
        return false;
      }

      // Must be in a textblock (paragraph/heading/blockquote-paragraph)
      if (!$from.parent.isTextblock) return false;

      // Trigger anywhere within a textblock. False positives are dismissable
      // with Esc — overly strict triggering hurts discoverability more.
      queueMicrotask(() => {
        view.dispatch(
          view.state.tr.setMeta(slashMenuKey, {
            type: 'open',
            pos: from,
          } satisfies SlashMeta),
        );
      });
      return false;
    },

    handleKeyDown(view, event) {
      const state = slashMenuKey.getState(view.state);
      if (!state?.active) return false;

      const head = view.state.selection.head;
      const query = readQuery(view.state.doc, state.triggerPos, head);
      const options = filterSlashOptions(query);

      if (options.length === 0) {
        // Allow Esc/Enter to close, but nav keys do nothing useful
        if (event.key === 'Escape') {
          view.dispatch(view.state.tr.setMeta(slashMenuKey, { type: 'close' }));
          return true;
        }
        return false;
      }

      if (event.key === 'ArrowDown') {
        const next = (state.selectedIndex + 1) % options.length;
        view.dispatch(
          view.state.tr.setMeta(slashMenuKey, {
            type: 'setIndex',
            index: next,
          } satisfies SlashMeta),
        );
        return true;
      }
      if (event.key === 'ArrowUp') {
        const prevIdx =
          (state.selectedIndex - 1 + options.length) % options.length;
        view.dispatch(
          view.state.tr.setMeta(slashMenuKey, {
            type: 'setIndex',
            index: prevIdx,
          } satisfies SlashMeta),
        );
        return true;
      }
      if (event.key === 'Enter') {
        const selected = options[state.selectedIndex];
        if (selected) executeSlashOption(view, selected);
        return true;
      }
      if (event.key === 'Escape') {
        view.dispatch(view.state.tr.setMeta(slashMenuKey, { type: 'close' }));
        return true;
      }

      return false;
    },
  },

  // -------------------------------------------------------------------------
  // Bridge plugin state → Zustand (side-effect-safe location)
  // -------------------------------------------------------------------------
  view() {
    return {
      update(view, prevState) {
        const next = slashMenuKey.getState(view.state);
        const prev = slashMenuKey.getState(prevState);
        if (next === prev) return;

        const store = useUIStore.getState();

        if (!next?.active) {
          if (store.slash.active) store.resetSlash();
          return;
        }

        const head = view.state.selection.head;
        const query = readQuery(view.state.doc, next.triggerPos, head);
        const options = filterSlashOptions(query);

        // Clamp selectedIndex defensively (filter may have shrunk)
        const safeIndex =
          options.length === 0
            ? 0
            : Math.min(next.selectedIndex, options.length - 1);

        // Compute anchor coords from the "/" position
        let anchor: { top: number; left: number } | null;
        try {
          const coords = view.coordsAtPos(next.triggerPos);
          anchor = { top: coords.bottom, left: coords.left };
        } catch {
          anchor = null;
        }

        store.setSlash({
          active: true,
          triggerPos: next.triggerPos,
          query,
          selectedIndex: safeIndex,
          anchor,
        });
      },
      destroy() {
        useUIStore.getState().resetSlash();
      },
    };
  },
});

// Re-export for convenience
export { SLASH_OPTIONS, filterSlashOptions };
