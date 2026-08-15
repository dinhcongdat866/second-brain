/**
 * Which wallet new money lines land in. A device preference in localStorage,
 * not shared data — two devices may be spending from different wallets.
 *
 * A store rather than bare localStorage calls because the choice is made in the
 * money cell and read in the planner cell, two React trees with nothing between
 * them, and `storage` does not fire in the tab that did the writing.
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
 * The wallet a new line belongs to, given the wallets that exist. Falls back to
 * the first when the stored id names a deleted wallet; null when there are no
 * wallets at all, which walletBalance treats as the default.
 */
export function resolveActiveWalletId(
  walletIds: string[],
  stored: string | null = readActiveWalletId(),
): string | null {
  if (walletIds.length === 0) return null;
  return stored && walletIds.includes(stored) ? stored : walletIds[0];
}
