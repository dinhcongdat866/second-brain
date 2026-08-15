/**
 * What the address bar is actually pointing at.
 *
 * A document id in a URL is ambiguous on its own: it can be one of yours, one
 * somebody shared with you, or nothing at all. This resolves which, so the rest
 * of the app never has to guess whether it is looking at an editor or a reader.
 */
import { useEffect, useMemo, useState } from 'react';
import { fetchShare } from '../lib/sharing';

export type DocSession =
  | { kind: 'loading' }
  /** Yours. Normal editing, normal persistence. */
  | { kind: 'own' }
  /** Someone else's, reached by link. */
  | { kind: 'shared'; ownerId: string; canWrite: boolean; name: string }
  /** No such document, or it is private and you are not the owner. */
  | { kind: 'missing' };

const OWN: DocSession = { kind: 'own' };
const LOADING: DocSession = { kind: 'loading' };

export function useDocSession(
  docId: string,
  knownOwnDocIds: string[],
  isGuest: boolean,
): DocSession {
  const isKnown = knownOwnDocIds.includes(docId);
  // Answering without a request is not an optimisation here, it is the
  // requirement: opening your own notebook must not wait on a backend.
  const settledLocally = isKnown || isGuest;

  // Tagged with the id it describes, so a stale answer for the previous
  // document can never be read as the answer for this one.
  const [resolved, setResolved] = useState<{ docId: string; session: DocSession } | null>(null);

  useEffect(() => {
    if (settledLocally) return;
    let cancelled = false;
    const settle = (session: DocSession) => {
      if (!cancelled) setResolved({ docId, session });
    };

    fetchShare(docId)
      .then((share) => {
        if (share === null) { settle({ kind: 'missing' }); return; }
        if (share.isOwner) { settle(OWN); return; }
        settle({
          kind: 'shared',
          ownerId: share.ownerId,
          canWrite: share.canWrite,
          name: share.name,
        });
      })
      // The backend could not answer. Assume the document is yours rather than
      // reporting it missing: a registry that has not loaded yet, or a sleeping
      // backend, must not read as "this document does not exist".
      .catch(() => settle(OWN));

    return () => { cancelled = true; };
  }, [docId, settledLocally]);

  return useMemo(() => {
    if (settledLocally) return OWN;
    return resolved?.docId === docId ? resolved.session : LOADING;
  }, [settledLocally, resolved, docId]);
}
