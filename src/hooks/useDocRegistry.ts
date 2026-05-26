import { useCallback, useRef, useState } from 'react';
import {
  listDocs,
  createDoc,
  renameDoc,
  deleteDoc,
  restoreDoc,
  getActiveDocId,
  setActiveDocId,
  type DocMeta,
} from '../lib/docRegistry';
import { deleteDocStorage } from '../collab/ydoc';

export function useDocRegistry() {
  const [docs, setDocs] = useState<DocMeta[]>(() => listDocs());
  const [activeDocId, setActiveDocIdState] = useState<string>(
    () => getActiveDocId(),
  );
  const storageCleanupRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = () => setDocs(listDocs());

  const selectDoc = useCallback((id: string) => {
    setActiveDocId(id);
    setActiveDocIdState(id);
  }, []);

  const createNewDoc = useCallback(() => {
    const doc = createDoc('Untitled');
    refresh();
    setActiveDocId(doc.id);
    setActiveDocIdState(doc.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Create a named doc and navigate to it. Used by import flow. */
  const importDoc = useCallback((name: string) => {
    const doc = createDoc(name);
    refresh();
    setActiveDocId(doc.id);
    setActiveDocIdState(doc.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRename = useCallback((id: string, name: string) => {
    renameDoc(id, name);
    refresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDelete = useCallback(
    (id: string) => {
      deleteDoc(id);
      const remaining = listDocs();
      setDocs(remaining);
      if (id === activeDocId) {
        const next = remaining[0].id;
        setActiveDocId(next);
        setActiveDocIdState(next);
      }
      if (storageCleanupRef.current) clearTimeout(storageCleanupRef.current);
      storageCleanupRef.current = setTimeout(() => deleteDocStorage(id), 5500);
    },
    [activeDocId],
  );

  const handleRestore = useCallback((meta: DocMeta) => {
    restoreDoc(meta);
    refresh();
    if (storageCleanupRef.current) clearTimeout(storageCleanupRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    docs,
    activeDocId,
    selectDoc,
    createNewDoc,
    importDoc,
    renameDoc: handleRename,
    deleteDoc: handleDelete,
    restoreDoc: handleRestore,
  };
}
