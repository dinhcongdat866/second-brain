import { Plugin, PluginKey } from 'prosemirror-state';
import { set } from 'idb-keyval';
import { useUIStore } from '../stores/uiStore';

export const NOTEBOOK_IDB_KEY = 'notebook:default';

export const autosaveKey = new PluginKey('autosave');

let savedTimer: ReturnType<typeof setTimeout> | null = null;

function debounce<T extends (...args: never[]) => void>(fn: T, delay: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: never[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  }) as T;
}

const persist = debounce((json: unknown) => {
  set(NOTEBOOK_IDB_KEY, json)
    .then(() => {
      useUIStore.getState().setSaveStatus('saved');
      if (savedTimer) clearTimeout(savedTimer);
      savedTimer = setTimeout(() => {
        useUIStore.getState().setSaveStatus('idle');
      }, 2000);
    })
    .catch(console.error);
}, 500);

export const autosavePlugin = new Plugin({
  key: autosaveKey,
  view() {
    return {
      update(view, prevState) {
        if (!view.state.doc.eq(prevState.doc)) {
          useUIStore.getState().setSaveStatus('pending');
          persist(view.state.doc.toJSON());
        }
      },
    };
  },
});
