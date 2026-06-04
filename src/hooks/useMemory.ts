import { useCallback, useEffect, useRef, useState } from 'react';
import { createYjsSyncer } from '../lib/backendSync';
import { MEMORY_DOC_ID, createMemorySetup, readMemoryText } from '../collab/memory';

/**
 * Loads the Memory Y.Doc in the background and keeps `memoryText` up to date.
 * Provides a stable `getMemoryContext` getter (ref pattern) so nodeViews
 * created once always read the latest value without being recreated.
 */
export function useMemory(userId?: string) {
  const [memoryText, setMemoryText] = useState('');
  const memoryTextRef = useRef('');

  useEffect(() => {
    const { ydoc, persistence, provider, whenReady } = createMemorySetup(userId);
    const syncer = createYjsSyncer(MEMORY_DOC_ID, ydoc);

    const refresh = () => {
      const text = readMemoryText(ydoc);
      memoryTextRef.current = text;
      setMemoryText(text);
    };

    whenReady.then(refresh);
    ydoc.on('update', refresh);

    return () => {
      ydoc.off('update', refresh);
      syncer.stop();
      provider.destroy();
      persistence.destroy();
      ydoc.destroy();
    };
  }, [userId]);

  // Stable reference — always returns the latest text via the ref.
  const getMemoryContext = useCallback(() => memoryTextRef.current, []);

  return { memoryText, memoryDocId: MEMORY_DOC_ID, getMemoryContext };
}
