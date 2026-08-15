import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import {
  createRegistrySetup,
  readDocs,
  createDoc,
  renameDoc,
  deleteDoc,
  restoreDoc,
  touchDoc,
  setDocBgImage,
  bootstrapRegistry,
  optimisticDocs,
  REGISTRY_DOC_ID,
  type DocMeta,
  type RegistrySetup,
} from '../collab/registry';
import { deleteDocStorage } from '../collab/ydoc';
import { deleteDocState, deleteDocImages, createYjsSyncer, applyServerState } from '../lib/backendSync';
import { apiFetch } from '../lib/http';
import { supabase } from '../lib/supabase';
import { exposeYDoc } from '../lib/devYDocs';
import { docIdFromPath, navigateHome, navigateToDoc, readRoutePath, subscribeRoute } from '../lib/router';

const ACTIVE_KEY = 'active-doc-id';

/*
 * localStorage keeps its job — remembering where you were — but no longer
 * decides which document is open. The address bar does, because a link someone
 * sent you has to win over the last thing this device happened to read.
 */

// ---------------------------------------------------------------------------
// Guest registry — simple React state, no network, no Yjs
// ---------------------------------------------------------------------------

function makeGuestDoc(): DocMeta {
  const now = new Date().toISOString();
  return { id: 'guest-default', name: 'Journal', createdAt: now, updatedAt: now };
}

export function useGuestDocRegistry() {
  const [docs, setDocs] = useState<DocMeta[]>(() => [makeGuestDoc()]);
  const [activeDocId, setActiveDocId] = useState('guest-default');

  // A guest arriving on someone's share link and choosing "try it now" gets
  // their own scratch notebook, so the id in the address bar now names a
  // document that is not on screen. Guest ids are tab-local and would 404 on
  // reload anyway, so the honest address here is the root.
  useEffect(() => { navigateHome(); }, []);

  const selectDoc = useCallback((id: string) => setActiveDocId(id), []);

  const createNewDoc = useCallback(() => {
    const now = new Date().toISOString();
    const doc: DocMeta = { id: crypto.randomUUID(), name: 'New Document', createdAt: now, updatedAt: now };
    setDocs((prev) => [...prev, doc]);
    setActiveDocId(doc.id);
  }, []);

  const importDoc = useCallback((name: string) => {
    const now = new Date().toISOString();
    const doc: DocMeta = { id: crypto.randomUUID(), name, createdAt: now, updatedAt: now };
    setDocs((prev) => [...prev, doc]);
    setActiveDocId(doc.id);
  }, []);

  const handleRename = useCallback((id: string, name: string) => {
    setDocs((prev) => prev.map((d) => d.id === id ? { ...d, name } : d));
  }, []);

  const handleDelete = useCallback((id: string) => {
    setDocs((prev) => {
      const next = prev.filter((d) => d.id !== id);
      if (id === activeDocId && next.length > 0) setActiveDocId(next[0].id);
      return next;
    });
  }, [activeDocId]);

  const handleRestore = useCallback((meta: DocMeta) => {
    setDocs((prev) => prev.some((d) => d.id === meta.id) ? prev : [...prev, meta]);
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
    touchDoc: () => {},
    setBgImage: () => {},
  };
}

// ---------------------------------------------------------------------------
// Authenticated registry — Yjs + WebSocket + Neon
// ---------------------------------------------------------------------------

/**
 * Document registry hook, backed by a shared Y.Doc (synced cross-client +
 * persisted to Neon). `activeDocId` stays per-device in localStorage.
 *
 * First paint uses an optimistic list (legacy localStorage / default) so the
 * sidebar isn't empty; once the registry Y.Doc syncs, the real list takes over.
 */
export function useDocRegistry(userId?: string, enabled = true) {
  const [docs, setDocs] = useState<DocMeta[]>(() => optimisticDocs());
  // The address bar is the selector, so which document is open is DERIVED from
  // it rather than mirrored into state. Mirroring meant an effect writing state
  // on every navigation, and two sources that could disagree for a frame.
  const routePath = useSyncExternalStore(subscribeRoute, readRoutePath, () => '/');
  const routedId = docIdFromPath(routePath);
  // Only consulted when the path names nothing — landing on the root.
  const [lastOpened, setLastOpened] = useState<string>(
    () => localStorage.getItem(ACTIVE_KEY) ?? optimisticDocs()[0].id,
  );
  const activeDocId = routedId ?? lastOpened;
  const setupRef = useRef<RegistrySetup | null>(null);
  const syncerRef = useRef<ReturnType<typeof createYjsSyncer> | null>(null);
  const storageCleanupRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Create the registry Y.Doc once for the whole app session.
  useEffect(() => {
    const setup = createRegistrySetup(userId);
    setupRef.current = setup;
    exposeYDoc('registry', setup.ydoc);
    const syncer = createYjsSyncer(REGISTRY_DOC_ID, setup.ydoc);
    syncerRef.current = syncer;

    const refresh = () => setDocs(readDocs(setup.docsMap));
    setup.docsMap.observeDeep(refresh);

    // Re-pull the registry from Neon whenever the tab becomes visible so the
    // doc list reflects documents created on another device without a full reload.
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        applyServerState(REGISTRY_DOC_ID, setup.ydoc).catch(() => {});
      }
    };
    window.addEventListener('visibilitychange', onVisible);

    let cancelled = false;
    setup.whenReady.then(async () => {
      if (cancelled) return;
      const wasEmpty = setup.docsMap.size === 0;
      bootstrapRegistry(setup.docsMap);

      // If registry was empty (just rebuilt or fresh account), scan the server
      // for orphaned docs and restore them into the registry.
      if (wasEmpty) {
        try {
          const res = await apiFetch('/documents');
          const serverDocs = await res.json() as { doc_id: string; updated_at: string }[];
          const known = new Set(readDocs(setup.docsMap).map((d) => d.id));
          setup.ydoc.transact(() => {
            for (const { doc_id, updated_at } of serverDocs) {
              if (!known.has(doc_id)) {
                const entry = new Y.Map<unknown>();
                entry.set('name', `Recovered (${updated_at.slice(0, 10)})`);
                entry.set('createdAt', updated_at);
                entry.set('updatedAt', updated_at);
                setup.docsMap.set(doc_id, entry);
              }
            }
          });
        } catch {
          // backend unreachable — skip recovery
        }
      }

      const list = readDocs(setup.docsMap);
      setDocs(list);
      // The remembered document may have been deleted on another device.
      // Deliberately NOT applied to an id that came from the address bar: that
      // id may be a link to somebody else's document, and jumping to the first
      // of your own would swallow the link before it was ever resolved.
      setLastOpened((prev) => (list.some((d) => d.id === prev) ? prev : list[0]?.id ?? prev));
    });

    return () => {
      cancelled = true;
      setup.docsMap.unobserveDeep(refresh);
      window.removeEventListener('visibilitychange', onVisible);
      syncer.stop();
      syncerRef.current = null;
      setup.provider.destroy();
      setup.persistence.destroy();
      setup.ydoc.destroy();
    };
  // userId in deps: if userId changes (shouldn't normally happen, but guards
  // against stale room scoping if the user object arrives after first render).
  }, [userId]);

  const setActive = (id: string) => {
    setLastOpened(id);
    navigateToDoc(id);
  };

  const selectDoc = useCallback((id: string) => setActive(id), []);

  // Both writes below update something outside React — the address bar and
  // localStorage — from state that already exists. Neither sets React state,
  // which is what keeps this out of the cascading-render trap.
  useEffect(() => {
    // Landed on the root: put the open document into the address bar, as a
    // replace so Back does not bounce straight back here.
    //
    // `enabled` is false in guest mode, where this hook still runs but its
    // document list is not the one on screen — without the guard it would put
    // an id from the signed-out registry into the address bar.
    if (enabled && routedId === null) navigateToDoc(activeDocId, { replace: true });
  }, [enabled, routedId, activeDocId]);

  useEffect(() => {
    try { localStorage.setItem(ACTIVE_KEY, activeDocId); } catch { /* private mode */ }
  }, [activeDocId]);

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
      // Flush the registry to Supabase immediately so the deletion is durable
      // even if the user signs out before the debounce timer fires.
      syncerRef.current?.flush();
      if (id === activeDocId) {
        const next = readDocs(map)[0]?.id;
        if (next) setActive(next);
      }
      // Capture the auth token now while the session is still valid.
      // The cleanup timer may fire after sign-out, at which point
      // supabase.auth.getSession() returns null and the DELETEs would 401.
      supabase.auth.getSession().then(({ data }) => {
        const token = data.session?.access_token ?? null;
        if (storageCleanupRef.current) clearTimeout(storageCleanupRef.current);
        storageCleanupRef.current = setTimeout(() => {
          deleteDocStorage(id, userId);
          deleteDocState(id, token);
          deleteDocImages(id, token);
        }, 5500);
      });
    },
    [activeDocId, userId],
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

  const handleSetBgImage = useCallback((id: string, url: string | null) => {
    const map = setupRef.current?.docsMap;
    if (map) setDocBgImage(map, id, url);
  }, []);

  const flushRegistry = useCallback(() => {
    syncerRef.current?.flush();
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
    setBgImage: handleSetBgImage,
    flushRegistry,
  };
}
