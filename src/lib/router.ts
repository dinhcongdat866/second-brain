/**
 * The address bar as application state.
 *
 * One route, `/{docId}`, and `/` for "no document named". Hand-rolled rather
 * than a router dependency because there is nothing here to route: the app is
 * one screen, and the whole contract is a path segment in and a pushState out.
 *
 * A store with subscribers rather than a hook reading location directly:
 * `popstate` does not fire for pushState, so the component that navigates and
 * the component that reads have to be told by the same place.
 */

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', notify);
}

export function subscribeRoute(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => { listeners.delete(onChange); };
}

export function readRoutePath(): string {
  return typeof window === 'undefined' ? '/' : window.location.pathname;
}

/**
 * The document id in a path, or null for the root.
 *
 * Only the first segment is read, so an unexpected deeper path degrades to its
 * document rather than to nothing.
 */
export function docIdFromPath(pathname: string): string | null {
  const segment = pathname.split('/').filter(Boolean)[0];
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function docIdFromRoute(): string | null {
  return docIdFromPath(readRoutePath());
}

export function pathForDoc(docId: string): string {
  return `/${encodeURIComponent(docId)}`;
}

/**
 * Point the address bar at a document.
 *
 * `replace` is for corrections the person did not ask for — landing on `/` and
 * being resolved to the last document read, say. Those must not become a back
 * step, or Back would walk through states nobody navigated to.
 */
export function navigateToDoc(docId: string, { replace = false } = {}): void {
  const next = pathForDoc(docId);
  if (window.location.pathname === next) return;
  if (replace) window.history.replaceState(null, '', next);
  else window.history.pushState(null, '', next);
  notify();
}

/** Back to the root, for states that have no document id worth showing. */
export function navigateHome({ replace = true } = {}): void {
  if (window.location.pathname === '/') return;
  if (replace) window.history.replaceState(null, '', '/');
  else window.history.pushState(null, '', '/');
  notify();
}
