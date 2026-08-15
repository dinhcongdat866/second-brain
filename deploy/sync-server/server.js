/**
 * y-websocket relay with authorisation.
 *
 * This used to be the stock `y-websocket/bin/server.js`, which accepts any
 * connection to any room. That was survivable only because room names contain a
 * Supabase user id and were never handed out — security by obscurity, and it
 * stopped being survivable the moment documents could be shared by link.
 *
 * Two things happen here that the stock server does not do:
 *
 *   1. A connection must present a room token minted by the FastAPI backend
 *      (POST /documents/{id}/room-token), signed with a secret both processes
 *      share. The token names exactly one room, so a valid token for your own
 *      document is not a key to anyone else's.
 *   2. A token may grant read-only. Since a Yjs peer writes by sending sync
 *      messages, read-only is enforced by dropping those messages before
 *      y-websocket ever sees them. This is the real fence; the editable=false
 *      flag in the client is only what makes the UI honest.
 *
 * Durability is still not this server's job — the client persists to Neon
 * through the backend. This process holds documents in memory and forgets them
 * when the last peer leaves.
 */
const http = require('http')
const WebSocket = require('ws')
const jwt = require('jsonwebtoken')
const decoding = require('lib0/dist/decoding.cjs')
// By path, not by package name: y-websocket's "exports" map does not expose
// bin/, and the stock Dockerfile only got away with it because it ran the file
// directly. A file path bypasses the map the same way.
const { setupWSConnection } = require('./node_modules/y-websocket/bin/utils.js')

const HOST = process.env.HOST || '0.0.0.0'
const PORT = Number(process.env.PORT || 1234)
const SECRET = process.env.SYNC_JWT_SECRET

if (!SECRET) {
  // Refusing to start beats starting without authorisation: a relay that is
  // quietly open looks exactly like a relay that is working.
  console.error('[sync] SYNC_JWT_SECRET is not set — refusing to start.')
  process.exit(1)
}

// y-protocols message types, as y-websocket's utils.js numbers them.
const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const MESSAGE_QUERY_AWARENESS = 3
// …and the sub-types of a sync message.
const SYNC_STEP_1 = 0

/**
 * May a read-only peer send this message?
 *
 * Yes for anything that only asks: syncStep1 requests the document, awareness
 * carries a cursor and is never persisted. No for syncStep2 and update, which
 * are the two ways a peer puts content into the shared doc. Anything
 * unrecognised is refused rather than passed through.
 */
function isReadOnlyMessage(buf) {
  try {
    const decoder = decoding.createDecoder(buf)
    const messageType = decoding.readVarUint(decoder)
    if (messageType === MESSAGE_AWARENESS || messageType === MESSAGE_QUERY_AWARENESS) {
      return true
    }
    if (messageType !== MESSAGE_SYNC) return false
    return decoding.readVarUint(decoder) === SYNC_STEP_1
  } catch {
    return false
  }
}

/** Filter the single 'message' listener setupWSConnection is about to attach. */
function makeReadOnly(conn) {
  const attach = conn.on.bind(conn)
  conn.on = (event, handler) => {
    if (event !== 'message') return attach(event, handler)
    return attach('message', (data) => {
      if (isReadOnlyMessage(new Uint8Array(data))) handler(data)
    })
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('okay')
})

const wss = new WebSocket.Server({ noServer: true })

function refuse(socket, status, reason) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

server.on('upgrade', (request, socket, head) => {
  // The same expression setupWSConnection uses for docName, so the room the
  // token authorises is byte-for-byte the room the document is keyed by.
  const path = request.url.slice(1).split('?')[0]
  const token = new URLSearchParams(request.url.split('?')[1] || '').get('token')

  let claims
  try {
    claims = jwt.verify(token || '', SECRET, { algorithms: ['HS256'] })
  } catch {
    return refuse(socket, 401, 'Unauthorized')
  }
  if (claims.room !== path) return refuse(socket, 403, 'Forbidden')

  wss.handleUpgrade(request, socket, head, (conn) => {
    wss.emit('connection', conn, request, { room: path, canWrite: claims.w === true })
  })
})

wss.on('connection', (conn, request, ctx) => {
  if (!ctx.canWrite) makeReadOnly(conn)
  setupWSConnection(conn, request, { docName: ctx.room })
})

server.listen(PORT, HOST, () => {
  console.log(`[sync] listening on ${HOST}:${PORT}`)
})
