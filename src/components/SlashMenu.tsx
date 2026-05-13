import { useEffect, useMemo, useRef } from 'react';
import type { EditorView } from 'prosemirror-view';
import { useUIStore } from '../stores/uiStore';
import {
  filterSlashOptions,
  GROUP_LABELS,
  type SlashGroup,
  type SlashOption,
} from '../plugins/slashOptions';
import {
  executeSlashOption,
  slashMenuKey,
} from '../plugins/slashMenuPlugin';

// ---------------------------------------------------------------------------
// SlashMenu — popover rendered when slash plugin is active
// ---------------------------------------------------------------------------
// State source: useUIStore.slash (mirrored from PM plugin).
// Keyboard navigation handled in the PM plugin, NOT here.
// This component adds:
//   - Click-outside dismissal
//   - Viewport-aware positioning (flip above cursor if no room below)
//   - Mouse hover preview-selects
//   - Mouse click executes
// ---------------------------------------------------------------------------

const MENU_MAX_HEIGHT = 340;
const MENU_GAP = 6;

interface SlashMenuProps {
  view: EditorView | null;
}

function closeSlash(view: EditorView) {
  view.dispatch(view.state.tr.setMeta(slashMenuKey, { type: 'close' }));
}

export function SlashMenu({ view }: SlashMenuProps) {
  const slash = useUIStore((s) => s.slash);
  const menuRef = useRef<HTMLDivElement>(null);

  // Click-outside dismissal (only when slash is active)
  useEffect(() => {
    if (!slash.active || !view) return;

    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      // Click inside menu — let the option click handle it
      if (menuRef.current?.contains(target)) return;
      // Click inside editor — let PM's selection update handle it
      if (view!.dom.contains(target)) return;
      // Click outside both — close
      closeSlash(view!);
    }

    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [slash.active, view]);

  // Scroll selected option into view
  useEffect(() => {
    if (!slash.active || !menuRef.current) return;
    const selected = menuRef.current.querySelector('[data-selected="true"]');
    if (selected && 'scrollIntoView' in selected) {
      (selected as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }, [slash.active, slash.selectedIndex, slash.query]);

  // Compute filtered options + grouped layout
  const { options, grouped } = useMemo(() => {
    const opts = filterSlashOptions(slash.query);
    const groups = opts.reduce<Record<SlashGroup, SlashOption[]>>(
      (acc, opt) => {
        (acc[opt.group] ||= []).push(opt);
        return acc;
      },
      {} as Record<SlashGroup, SlashOption[]>,
    );
    return { options: opts, grouped: groups };
  }, [slash.query]);

  // Compute popover position with viewport-aware flipping
  const position = useMemo(() => {
    if (!slash.anchor) return null;
    const viewportH = window.innerHeight;
    const spaceBelow = viewportH - slash.anchor.top;
    const placeAbove = spaceBelow < MENU_MAX_HEIGHT + 16;
    return {
      top: placeAbove
        ? slash.anchor.top - MENU_MAX_HEIGHT - MENU_GAP - 18
        : slash.anchor.top + MENU_GAP,
      left: slash.anchor.left,
    };
  }, [slash.anchor]);

  if (!slash.active || !position || !view) return null;

  if (options.length === 0) {
    return (
      <div
        ref={menuRef}
        className="slash-menu"
        style={{ position: 'fixed', top: position.top, left: position.left }}
      >
        <div className="slash-empty">No matching options</div>
      </div>
    );
  }

  let flatIndex = 0;

  return (
    <div
      ref={menuRef}
      className="slash-menu"
      style={{ position: 'fixed', top: position.top, left: position.left }}
    >
      {(Object.keys(grouped) as SlashGroup[]).map((groupKey) => (
        <div key={groupKey} className="slash-group">
          <div className="slash-group-label">{GROUP_LABELS[groupKey]}</div>
          {grouped[groupKey].map((opt) => {
            const isSelected = flatIndex === slash.selectedIndex;
            const currentIndex = flatIndex;
            flatIndex++;
            return (
              <button
                key={opt.id}
                type="button"
                className="slash-option"
                data-selected={isSelected}
                onMouseDown={(e) => {
                  e.preventDefault();
                  executeSlashOption(view, opt);
                }}
                onMouseEnter={() => {
                  if (currentIndex !== slash.selectedIndex) {
                    useUIStore
                      .getState()
                      .setSlash({ selectedIndex: currentIndex });
                  }
                }}
              >
                <span className="slash-option-icon">{opt.icon}</span>
                <span className="slash-option-text">
                  <span className="slash-option-label">{opt.label}</span>
                  {opt.description && (
                    <span className="slash-option-desc">{opt.description}</span>
                  )}
                </span>
                {opt.shortcut && (
                  <span className="slash-option-shortcut">{opt.shortcut}</span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
