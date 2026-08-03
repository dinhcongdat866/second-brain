import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';
import { createPlannerHandle, nullPlannerHandle } from '../plannerHandle';

describe('plannerHandle', () => {
  it('starts empty and exposes the doc once set', () => {
    const handle = createPlannerHandle();
    expect(handle.get()).toBeNull();

    const ydoc = new Y.Doc();
    handle.set(ydoc);
    expect(handle.get()).toBe(ydoc);
  });

  it('notifies subscribers when the doc lands', () => {
    const handle = createPlannerHandle();
    const seen: Y.Doc[] = [];
    handle.subscribe((doc) => seen.push(doc));

    const ydoc = new Y.Doc();
    handle.set(ydoc);
    expect(seen).toEqual([ydoc]);
  });

  it('lets a listener unsubscribe itself while being notified', () => {
    // WeeklyCellView does exactly this: it unsubscribes inside its own callback
    // so the late server merge doesn't re-render the cell a second time.
    const handle = createPlannerHandle();
    const listener = vi.fn(() => unsubscribe());
    const unsubscribe = handle.subscribe(listener);

    handle.set(new Y.Doc());
    handle.set(new Y.Doc());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not notify after unsubscribe', () => {
    const handle = createPlannerHandle();
    const listener = vi.fn();
    handle.subscribe(listener)();

    handle.set(new Y.Doc());
    expect(listener).not.toHaveBeenCalled();
  });

  it('clears the doc without notifying', () => {
    const handle = createPlannerHandle();
    const listener = vi.fn();
    handle.subscribe(listener);

    handle.set(null);
    expect(handle.get()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  it('nullPlannerHandle never yields a doc', () => {
    expect(nullPlannerHandle.get()).toBeNull();
    expect(() => nullPlannerHandle.subscribe(() => {})()).not.toThrow();
  });
});
