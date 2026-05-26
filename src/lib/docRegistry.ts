/**
 * Lightweight document registry stored in localStorage.
 * Each entry is metadata only — the actual CRDT content lives in IndexedDB
 * under the key `notebook:<id>`.
 *
 * On first load (no registry yet) we bootstrap a single "Journal" doc with
 * id = 'default', which maps to the pre-existing `notebook:default` store so
 * users don't lose their existing data.
 */

export interface DocMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

const REGISTRY_KEY = 'doc-registry';
const ACTIVE_KEY = 'active-doc-id';

function load(): DocMeta[] {
  try {
    const raw = localStorage.getItem(REGISTRY_KEY);
    if (raw) return JSON.parse(raw) as DocMeta[];
  } catch {}
  return [];
}

function save(docs: DocMeta[]): void {
  localStorage.setItem(REGISTRY_KEY, JSON.stringify(docs));
}

export function listDocs(): DocMeta[] {
  const docs = load();
  if (docs.length > 0) return docs;

  // Bootstrap: map to the existing notebook:default IndexedDB store
  const initial: DocMeta = {
    id: 'default',
    name: 'Journal',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  save([initial]);
  return [initial];
}

export function createDoc(name: string): DocMeta {
  const docs = load();
  const doc: DocMeta = {
    id: crypto.randomUUID(),
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  docs.push(doc);
  save(docs);
  return doc;
}

export function renameDoc(id: string, name: string): void {
  const docs = load();
  const doc = docs.find((d) => d.id === id);
  if (!doc) return;
  doc.name = name;
  doc.updatedAt = new Date().toISOString();
  save(docs);
}

/** Remove a doc from the registry. The IndexedDB data is left intact. */
export function deleteDoc(id: string): void {
  save(load().filter((d) => d.id !== id));
}

/** Re-insert a previously deleted doc (undo delete). No-op if already present. */
export function restoreDoc(meta: DocMeta): void {
  const docs = load();
  if (!docs.some((d) => d.id === meta.id)) {
    docs.push(meta);
    save(docs);
  }
}

export function touchDoc(id: string): void {
  const docs = load();
  const doc = docs.find((d) => d.id === id);
  if (!doc) return;
  doc.updatedAt = new Date().toISOString();
  save(docs);
}

export function getActiveDocId(): string {
  const stored = localStorage.getItem(ACTIVE_KEY);
  if (stored) {
    // Validate the stored id still exists in the registry
    const docs = listDocs();
    if (docs.some((d) => d.id === stored)) return stored;
  }
  return listDocs()[0].id;
}

export function setActiveDocId(id: string): void {
  localStorage.setItem(ACTIVE_KEY, id);
}
