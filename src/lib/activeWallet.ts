/**
 * Which wallet new money lines land in.
 *
 * A device preference, not shared data — the phone in your pocket and the
 * laptop on the desk are plausibly spending from different wallets, and making
 * one of them silently change the other's is the kind of thing you only notice
 * a month later. So localStorage, not the Y.Doc.
 *
 * It also keeps the planner's money input at exactly one keystroke. Picking a
 * wallet per line would be correct bookkeeping and nobody would do it twice;
 * the wallet is chosen once in the money cell and every line follows until you
 * change it.
 *
 * Which is why this is a store rather than two localStorage calls: the choice
 * is made in the money cell and read in the planner cell, two React trees with
 * nothing between them, and `storage` events do not fire in the tab that did
 * the writing. Both subscribe here instead, via useSyncExternalStore.
 */
const KEY = 'moneyActiveWallet';

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Store subscription for useSyncExternalStore. */
export function subscribeActiveWallet(onChange: () => void): () => void {
  listeners.add(onChange);
  if (listeners.size === 1) window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}

/** Another tab changed the choice — same person, same wallet. */
function onStorage(e: StorageEvent): void {
  if (e.key === KEY || e.key === null) notify();
}

export function readActiveWalletId(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null; // private mode — everything falls back to the default wallet
  }
}

export function writeActiveWalletId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, id);
  } catch { /* private mode — the choice just doesn't survive a reload */ }
  notify();
}

/**
 * The wallet a new line belongs to, given the wallets that exist.
 *
 * Falls back to the default (first) wallet when the stored id names a wallet
 * that has since been deleted, so a line never ends up attached to nothing.
 * Returns null when there are no wallets at all — the pre-wallets state, which
 * walletBalance already treats as belonging to the default.
 *
 * Derived on every read rather than corrected in place: the fallback is not
 * worth persisting, and writing it back would mean deleting a wallet quietly
 * rewrites a preference the person never touched.
 */
export function resolveActiveWalletId(
  walletIds: string[],
  stored: string | null = readActiveWalletId(),
): string | null {
  if (walletIds.length === 0) return null;
  return stored && walletIds.includes(stored) ? stored : walletIds[0];
}
