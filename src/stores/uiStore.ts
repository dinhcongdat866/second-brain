import { create } from 'zustand';

// ---------------------------------------------------------------------------
// UI Store — shared state between PM plugins and React components
// ---------------------------------------------------------------------------
// Why a store? PM plugins shouldn't render UI directly, and React components
// shouldn't poll PM state. The store is a thin bridge: PM pushes UI-related
// state here via plugin view methods (side-effect safe), React subscribes.
//
// Rule: plugin `apply()` is pure — never write to this store from `apply()`.
//       Use plugin `view().update()` instead.
// ---------------------------------------------------------------------------

export interface SlashState {
  active: boolean;
  /** Doc position of the triggering "/" character */
  triggerPos: number;
  /** Text typed after "/" — used for filtering */
  query: string;
  /** Currently highlighted option index in the filtered list */
  selectedIndex: number;
  /** Anchor coords (relative to viewport) for popover positioning */
  anchor: { top: number; left: number } | null;
}

export type SaveStatus = 'idle' | 'pending' | 'saved';

interface UIState {
  slash: SlashState;
  setSlash: (partial: Partial<SlashState>) => void;
  resetSlash: () => void;

  saveStatus: SaveStatus;
  setSaveStatus: (status: SaveStatus) => void;
}

const initialSlash: SlashState = {
  active: false,
  triggerPos: -1,
  query: '',
  selectedIndex: 0,
  anchor: null,
};

export const useUIStore = create<UIState>((set) => ({
  slash: initialSlash,
  setSlash: (partial) =>
    set((state) => ({ slash: { ...state.slash, ...partial } })),
  resetSlash: () => set({ slash: initialSlash }),

  saveStatus: 'idle',
  setSaveStatus: (status) => set({ saveStatus: status }),
}));
