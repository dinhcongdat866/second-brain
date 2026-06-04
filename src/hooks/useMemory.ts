import { useCallback, useEffect, useRef, useState } from 'react';
import { createYjsSyncer } from '../lib/backendSync';
import {
  MEMORY_DOC_ID,
  createMemorySetup,
  readMemoryText,
  readMemoryLog,
  appendToMemory,
  addMemoryLogEntry,
  deleteMemoryLogEntry,
  type MemoryLogEntry,
} from '../collab/memory';

export type { MemoryLogEntry };

/**
 * Loads the Memory Y.Doc in the background and keeps memoryText / memoryLog
 * up to date. Provides stable getter + mutation callbacks so nodeViews that
 * are created once can always read / write the latest state via refs.
 */
export function useMemory(userId?: string) {
  const [memoryText, setMemoryText] = useState('');
  const [memoryLog, setMemoryLog] = useState<MemoryLogEntry[]>([]);
  const memoryTextRef = useRef('');
  const ydocRef = useRef<import('yjs').Doc | null>(null);

  useEffect(() => {
    const { ydoc, persistence, provider, whenReady } = createMemorySetup(userId);
    ydocRef.current = ydoc;
    const syncer = createYjsSyncer(MEMORY_DOC_ID, ydoc);

    const refresh = () => {
      const text = readMemoryText(ydoc);
      memoryTextRef.current = text;
      setMemoryText(text);
      setMemoryLog(readMemoryLog(ydoc));
    };

    whenReady.then(refresh);
    ydoc.on('update', refresh);

    return () => {
      ydoc.off('update', refresh);
      syncer.stop();
      provider.destroy();
      persistence.destroy();
      ydocRef.current = null;
      ydoc.destroy();
    };
  }, [userId]);

  // Stable reference — reads latest text via ref so nodeViews don't recreate.
  const getMemoryContext = useCallback(() => memoryTextRef.current, []);

  const appendMemory = useCallback((
    bullets: string[],
    meta: { sourceCellId: string; sourceDocId: string },
  ) => {
    const ydoc = ydocRef.current;
    if (!ydoc || bullets.length === 0) return;
    const cellId = appendToMemory(ydoc, bullets.map((b) => `- ${b}`));
    addMemoryLogEntry(ydoc, {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      sourceCellId: meta.sourceCellId,
      sourceDocId: meta.sourceDocId,
      content: bullets.join('\n'),
      cellId,
    });
  }, []);

  const deleteLogEntry = useCallback((entryId: string) => {
    const ydoc = ydocRef.current;
    if (ydoc) deleteMemoryLogEntry(ydoc, entryId);
  }, []);

  return { memoryText, memoryDocId: MEMORY_DOC_ID, getMemoryContext, appendMemory, memoryLog, deleteLogEntry };
}
