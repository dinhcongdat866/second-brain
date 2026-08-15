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

## Known gaps

- A write link is anonymous. Nothing records who made an edit, and the modal
  says as much next to the option.
- Revoking a share does not disconnect a session already holding a valid token;
  it takes effect within the token's 12-hour lifetime, or immediately on the
  visitor's next page load.
