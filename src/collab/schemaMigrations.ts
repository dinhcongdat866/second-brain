/**
 * Schema migrations for the notebook Y.Doc.
 *
 * The ProseMirror document is reconstructed from the Yjs XmlFragment against the
 * CURRENT schema. If the schema changes incompatibly (a node/mark is renamed or
 * removed) an old doc can fail to bind — the editor renders blank and the data,
 * while still safe in Yjs, becomes unreachable. This module versions the doc and
 * runs forward migrations so a schema change ships with a data transform instead
 * of breaking old documents.
 *
 * How to add a migration when you make an incompatible schema change:
 *   1. Bump CURRENT_SCHEMA_VERSION.
 *   2. Register migrations[<new version>] = (ydoc) => { ...transform... }.
 *      The transform mutates the XmlFragment / sidecar maps in place to match
 *      the new schema (rename nodes, drop a removed mark, etc.).
 */

import * as Y from 'yjs';

export const CURRENT_SCHEMA_VERSION = 1;

const META_KEY = 'meta';
const VERSION_FIELD = 'schemaVersion';

type Migration = (ydoc: Y.Doc) => void;

/**
 * Forward migrations: `migrations[n]` upgrades a doc FROM version n-1 TO n.
 * Empty today (versioning starts at 1); populate as the schema evolves.
 */
const migrations: Record<number, Migration> = {};

function getMeta(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap(META_KEY);
}

export function getSchemaVersion(ydoc: Y.Doc): number | undefined {
  const v = getMeta(ydoc).get(VERSION_FIELD);
  return typeof v === 'number' ? v : undefined;
}

/**
 * Bring a doc up to CURRENT_SCHEMA_VERSION before it is bound to ProseMirror.
 *
 * - Unversioned docs are assumed to already match the current schema (versioning
 *   is being introduced now, so every existing doc is on the current schema) and
 *   are simply stamped.
 * - Older versions run each registered migration in order, then are stamped.
 *
 * Runs in a single transaction. Idempotent — a current doc is a no-op.
 */
export function runMigrations(ydoc: Y.Doc): void {
  const stored = getSchemaVersion(ydoc);
  if (stored === CURRENT_SCHEMA_VERSION) return;

  ydoc.transact(() => {
    // Unversioned ⇒ treat as already-current (no historical migrations to run).
    const from = stored ?? CURRENT_SCHEMA_VERSION;
    for (let v = from + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
      migrations[v]?.(ydoc);
    }
    getMeta(ydoc).set(VERSION_FIELD, CURRENT_SCHEMA_VERSION);
  });
}
