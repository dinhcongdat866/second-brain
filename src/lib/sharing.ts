/**
 * Link sharing: what a document allows, and the ticket that gets a socket into
 * its relay room.
 */
import type { WebsocketProvider } from 'y-websocket';
import { apiFetch, HttpError } from './http';

/** What someone holding the link may do. */
export type LinkAccess = 'none' | 'read' | 'write';

export interface ShareInfo {
  docId: string;
  /** Whose document this is. The relay room is built from it. */
  ownerId: string;
  linkAccess: LinkAccess;
  /** Copied from the owner's registry when published; '' if never published. */
  name: string;
  isOwner: boolean;
  canWrite: boolean;
}

interface ShareWire {
  doc_id: string;
  owner_id: string;
  link_access: LinkAccess;
  name: string;
  is_owner: boolean;
  can_write: boolean;
}

const toShareInfo = (w: ShareWire): ShareInfo => ({
  docId: w.doc_id,
  ownerId: w.owner_id,
  linkAccess: w.link_access,
  name: w.name,
  isOwner: w.is_owner,
  canWrite: w.can_write,
});

/**
 * Null when the server says this document is not visible to you — and a thrown
 * error when it could not say anything at all.
 *
 * The two must not collapse into one value. "Not found" locks a visitor out,
 * which is right; doing the same because the backend was asleep would lock a
 * person out of their own document the moment their connection wobbled.
 */
export async function fetchShare(docId: string): Promise<ShareInfo | null> {
  try {
    const res = await apiFetch(`/documents/${encodeURIComponent(docId)}/share`);
    return toShareInfo((await res.json()) as ShareWire);
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 401)) return null;
    throw err;
  }
}

export async function setShare(
  docId: string,
  linkAccess: LinkAccess,
  name: string,
): Promise<ShareInfo> {
  const res = await apiFetch(`/documents/${encodeURIComponent(docId)}/share`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ link_access: linkAccess, name }),
  });
  return toShareInfo((await res.json()) as ShareWire);
}

export function shareUrl(docId: string): string {
  return `${window.location.origin}/${encodeURIComponent(docId)}`;
}

// ---------------------------------------------------------------------------
// Room tokens
// ---------------------------------------------------------------------------

interface RoomToken {
  room: string;
  token: string;
  canWrite: boolean;
  /** Seconds until the token stops being accepted. */
  expiresIn: number;
}

async function fetchRoomToken(docId: string): Promise<RoomToken> {
  const res = await apiFetch(`/documents/${encodeURIComponent(docId)}/room-token`, {
    method: 'POST',
  });
  const w = (await res.json()) as {
    room: string; token: string; can_write: boolean; expires_in: number;
  };
  return { room: w.room, token: w.token, canWrite: w.can_write, expiresIn: w.expires_in };
}

/** Refresh at 80% of the lifetime, and never spin faster than once a minute. */
const refreshDelay = (expiresIn: number) => Math.max(60_000, expiresIn * 800);

/**
 * Fetch a room token and let the provider connect.
 *
 * The provider is created with `connect: false` so no socket is opened before
 * there is a ticket for it — the relay refuses an untokened upgrade, and
 * y-websocket would otherwise sit in a reconnect loop against a 401.
 *
 * Failure is deliberately quiet. The document still loads from IndexedDB and
 * merges server state over HTTP, so a missing token costs live sync, not the
 * document. Throwing here would turn a degraded network into a blank screen.
 *
 * The refresh only replaces the query parameter and does not reconnect: the
 * relay checks the token once, at upgrade. What matters is that a token is
 * already fresh whenever a reconnect happens to occur.
 */
export function attachRoomToken(provider: WebsocketProvider, docId: string): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async () => {
    try {
      const { token, room, expiresIn } = await fetchRoomToken(docId);
      if (stopped) return;
      // The room string is built twice from the same parts — collabRoom() here,
      // _room_name() in the backend — and the relay compares them for equality.
      // Drift between the two would refuse every socket with nothing in the
      // console to say why, so say it here.
      if (room !== provider.roomname) {
        console.error(
          `[sharing] room mismatch for ${docId}: the token authorises "${room}" ` +
            `but this provider joined "${provider.roomname}". The relay will refuse it.`,
        );
      }
      provider.params.token = token;
      provider.connect();
      timer = setTimeout(run, refreshDelay(expiresIn));
    } catch {
      /* no live sync this session — see above */
    }
  };

  void run();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
