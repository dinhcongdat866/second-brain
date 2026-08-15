# Sharing a document by link

## What changed

Documents have an address (`/{docId}`) and a link setting: **private**,
**anyone with the link can read**, or **anyone with the link can edit**.

## Why the relay had to be rewritten first

Rooms are named `notebook-{ownerId}-{docId}`, and until now the relay was the
stock `y-websocket/bin/server.js`, which admits anyone to any room. That was
survivable only because room names contain a Supabase user id and were never
handed out — the name *was* the credential.

Sharing hands the name out. And because a Yjs peer writes simply by sending
sync messages, being admitted to a room has always meant being able to write to
it. So "anyone with the link can read" is unenforceable on a relay that cannot
tell a reader from a writer: the client-side `editable: false` would be a
suggestion, removable from devtools.

`deploy/sync-server/server.js` replaces the stock binary:

- the backend mints a short-lived HS256 token naming **one** room and carrying
  one bit, `w`, signed with a secret both processes share;
- the relay verifies it at the HTTP upgrade and refuses anything else;
- for `w: false` it filters the connection's message listener, allowing
  syncStep1 and awareness through and dropping syncStep2 and update — the two
  messages that put content into the shared doc.

`server.test.js` spawns the relay and drives real peers at it: no token, wrong
room, wrong secret and expired token are all refused, a read-only peer receives
the document but cannot change it, and a second write peer can.

## Access rules

`backend/app/access.py` holds `decide_access` and nothing else — no FastAPI, no
SQLAlchemy — so the rule that decides whether a stranger sees your notebook can
be read and tested without standing a server up (`backend/tests/test_access.py`,
runnable with bare Python).

The order matters, and the first rule is the one that keeps sharing from
breaking what already worked:

1. **The caller has their own document under this id → that is the one they
   get.** Ids are not globally unique: every pre-registry account carries a
   document literally called `default`. Without this rule, one person publishing
   `default` would redirect everybody else's.
2. A share row exists → owner keeps write access; `read` gives the owner's rows
   read-only; `write` gives them read-write; `none` is **404**, not 403,
   because whether a private document exists is not a visitor's business.
3. No share row → the caller's own document, exactly as before sharing existed.

An unrecognised `link_access` value falls through to 404, so a typo fails closed.

### Writes land under the owner

A delta from someone editing through a write link is stored with the **owner's**
`user_id`. Filing it under the editor would put the work in an account the owner
never reads, and it would simply disappear.

### Appending and replacing are different powers

`POST /documents/{id}/updates` appends a delta. Nothing is overwritten, so the
worst a write link can do through it is add content.

`POST /documents/{id}/state` replaces the stored document outright and deletes
the delta rows up to a number the caller supplies. It is **owner only**, and it
has to be: given a write link it was one request away from replacing a year of
notes with an empty document. The `if not body` guard does not help, because an
empty `Y.Doc` still encodes to a few non-zero bytes.

There was a mitigation but not a defence — Yjs merges additively, so an owner
whose IndexedDB cache still held the document would silently restore it on the
next load. On a fresh device they would have seen the wiped version.

Visitors lose nothing. The append path is what the client uses for every
keystroke anyway; a shared session flushes through `flushAppend` on tab-hide
instead of taking a snapshot. Auto-snapshots are skipped in a shared session
for the same reason: they are stored inside the shared Y.Doc, so a visitor
running them would file entries into the author's history.

### Legacy ids cannot always be published

`document_shares.doc_id` is the primary key, because a share row is what makes
an id resolvable to an owner without a session. That forces global uniqueness,
which legacy ids do not have. Publishing an id another account already published
returns **409** with a message saying so, rather than pointing the link at the
wrong notebook.

## What a shared page withholds

The AI, weekly planner and money cells all read **whoever is looking** — their
API key, their week, their money. Rendered as-is inside someone else's document
they would quietly show you your own life on their page, and an AI cell would
spend your key. In a shared document all three are replaced by a plaque
(`personalCellView.tsx`), and the share modal says so before you publish.

Images already worked: `/images/{id}` has always been served publicly by id.

## Tokens and offline

Every relay connection now needs a token, including the registry, the planner
and the memory doc (those are per-user singletons and are never shareable).
Providers are created with `connect: false` and connect once a token arrives —
otherwise y-websocket would spin in a reconnect loop against a 401.

A failed token request is deliberately quiet. The document still loads from
IndexedDB and merges server state over HTTP, so a missing token costs live sync,
not the document.

## Deploying

Both Fly apps need the **same** secret, and the relay refuses to start without
it — a relay that is quietly open looks exactly like one that is working.

Run each from its own directory so flyctl reads the app name out of the local
`fly.toml`. Naming the apps on the command line is how you discover that the
backend is not called `second-brain-api` — Fly appended a suffix when that name
turned out to be taken.

```bash
cd backend            && fly secrets set SYNC_JWT_SECRET="…"
cd deploy/sync-server && fly secrets set SYNC_JWT_SECRET="…"
```

Generate the value once and paste the same string into both. Two different
values means the backend signs with one key and the relay verifies with another,
so every socket is refused.

`vercel.json` adds the SPA rewrite, without which `/{docId}` 404s on reload.

### Publishing an id requires holding it

`PUT /share` writes a row saying "this id belongs to me", and the rest of the
system trusts that row — it is what resolves an id to an account for a caller
with no session. It used to take the caller's word, writing `user_id` straight
from the token without asking whether they had anything under that id.

Nothing could be read that way: a squatter's rows are empty, and an id the real
owner already holds still resolves to them by the first rule in `decide_access`.
What it allowed was squatting. Claim the id first and the person who actually
has that document can never publish it, because the second claim is refused as
a duplicate. Publishing now requires a row in `yjs_documents` **or**
`yjs_updates` under (caller, doc_id) — both count, because a document typed into
for a few seconds has deltas but may not have a snapshot yet.

## Revocation

A token is verified once, at the upgrade. On its own that meant a socket opened
a minute before a share was revoked kept its rights for as long as the tab
stayed open — indefinitely, not for the token's lifetime.

The relay now closes a connection when its token expires, which is what makes
the lifetime an actual bound. It is one hour: the client refreshes at 80% of
that, so a fresh token is already in hand and the reconnect is silent, and a
revoked share stops working within the hour. Reloading the page revokes
immediately, because the next token request is simply refused.

## Known gaps

- A write link is anonymous. Nothing records who made an edit, and the modal
  says as much next to the option.
- A failed token request is silent. Live sync stops and the document falls back
  to HTTP save, which is correct behaviour, but nothing on screen says so.
- Two implementations build the relay room string — `collabRoom()` on the
  client, `_room_name()` on the server — and the relay compares them for
  equality. Drift would refuse every socket; `attachRoomToken` logs an explicit
  error if the token names a different room than the provider joined, but the
  duplication is still there.
