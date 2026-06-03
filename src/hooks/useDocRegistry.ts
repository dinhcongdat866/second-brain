import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createRegistrySetup,
  readDocs,
  createDoc,
  renameDoc,
  deleteDoc,
  restoreDoc,
  touchDoc,
  bootstrapRegistry,
  optimisticDocs,
  REGISTRY_DOC_ID,
  type DocMeta,
  type RegistrySetup,
} from '../collab/registry';
import { deleteDocStorage } from '../collab/ydoc';
import { deleteDocState, deleteDocImages, createYjsSyncer } from '../lib/backendSync';

const ACTIVE_KEY = 'active-doc-id';

function readActive(): string {
  return localStorage.getItem(ACTIVE_KEY) ?? optimisticDocs()[0].id;
}

/**
 * Document registry hook, backed by a shared Y.Doc (synced cross-client +
 * persisted to Neon). `activeDocId` stays per-device in localStorage.
 *
 * First paint uses an optimistic list (legacy localStorage / default) so the
 * sidebar isn't empty; once the registry Y.Doc syncs, the real list takes over.
 */
export function useDocRegistry() {
  const [docs, setDocs] = useState<DocMeta[]>(() => optimisticDocs());
  const [activeDocId, setActiveDocIdState] = useState<string>(() => readActive());
  const setupRef = useRef<RegistrySetup | null>(null);
  const storageCleanupRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Create the registry Y.Doc once for the whole app session.
  useEffect(() => {
    const setup = createRegistrySetup();
    setupRef.current = setup;
    const syncer = createYjsSyncer(REGISTRY_DOC_ID, setup.ydoc);

    const refresh = () => setDocs(readDocs(setup.docsMap));
    setup.docsMap.observeDeep(refresh);

    let cancelled = false;
    setup.whenReady.then(() => {
      if (cancelled) return;
      bootstrapRegistry(setup.docsMap);
      const list = readDocs(setup.docsMap);
      setDocs(list);
      // Active doc may have been deleted on another device — fall back to first.
      setActiveDocIdState((prev) =>
        list.some((d) => d.id === prev) ? prev : list[0]?.id ?? prev,
      );
    });

    return () => {
      cancelled = true;
      setup.docsMap.unobserveDeep(refresh);
      syncer.stop();
      setup.provider.destroy();
      setup.persistence.destroy();
      setup.ydoc.destroy();
    };
  }, []);

  const setActive = (id: string) => {
    localStorage.setItem(ACTIVE_KEY, id);
    setActiveDocIdState(id);
  };

  const selectDoc = useCallback((id: string) => setActive(id), []);

  const createNewDoc = useCallback(() => {
    const map = setupRef.current?.docsMap;
    if (!map) return;
    const doc = createDoc(map, 'New Document');
    setActive(doc.id);
  }, []);

  /** Create a named doc and navigate to it. Used by the import flow. */
  const importDoc = useCallback((name: string) => {
    const map = setupRef.current?.docsMap;
    if (!map) return;
    const doc = createDoc(map, name);
    setActive(doc.id);
  }, []);

  const handleRename = useCallback((id: string, name: string) => {
    const map = setupRef.current?.docsMap;
    if (map) renameDoc(map, id, name);
  }, []);

  const handleDelete = useCallback(
    (id: string) => {
      const map = setupRef.current?.docsMap;
      if (!map) return;
      deleteDoc(map, id);
      if (id === activeDocId) {
        const next = readDocs(map)[0]?.id;
        if (next) setActive(next);
      }
      // Defer destructive storage cleanup past the undo window.
      if (storageCleanupRef.current) clearTimeout(storageCleanupRef.current);
      storageCleanupRef.current = setTimeout(() => {
        deleteDocStorage(id);
        deleteDocState(id);
        deleteDocImages(id);
      }, 5500);
    },
    [activeDocId],
  );

  const handleRestore = useCallback((meta: DocMeta) => {
    const map = setupRef.current?.docsMap;
    if (map) restoreDoc(map, meta);
    if (storageCleanupRef.current) clearTimeout(storageCleanupRef.current);
  }, []);

  const handleTouch = useCallback((id: string) => {
    const map = setupRef.current?.docsMap;
    if (map) touchDoc(map, id);
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
    touchDoc: handleTouch,
  };
}
