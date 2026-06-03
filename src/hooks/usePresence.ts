import { useEffect, useState } from 'react';
import type { WebsocketProvider } from 'y-websocket';

export interface Peer {
  name: string;
  color: string;
}

/** Returns the list of remote peers currently connected to the same room. */
export function usePresence(
  providerRef: React.RefObject<WebsocketProvider | null>,
): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([]);

  useEffect(() => {
    const provider = providerRef.current;
    if (!provider) {
      setPeers([]);
      return;
    }

    const { awareness } = provider;
    const localId = awareness.clientID;

    const sync = () => {
      const result: Peer[] = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === localId) return;
        const user = state.user as Peer | undefined;
        if (user?.name && user?.color) result.push(user);
      });
      setPeers(result);
    };

    awareness.on('change', sync);
    sync();
    return () => awareness.off('change', sync);
  // providerRef is a stable ref object — re-run when its .current changes
  // (tracked via ydoc dependency in parent, not here directly).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerRef.current]);

  return peers;
}
