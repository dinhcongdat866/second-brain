/* End-to-end check of the authorising relay: rejection, write, and the read-only fence. */
const { spawn } = require('child_process')
const path = require('path')
const WebSocket = require('ws')
const jwt = require('jsonwebtoken')
const Y = require('yjs')
const encoding = require('lib0/dist/encoding.cjs')
const decoding = require('lib0/dist/decoding.cjs')
const syncProtocol = require('y-protocols/dist/sync.cjs')

const SECRET = 'test-secret-do-not-ship'
const PORT = 3999
const ROOM = 'notebook-user1-doc1'
const sign = (room, w) => jwt.sign({ room, w }, SECRET, { algorithm: 'HS256', expiresIn: '5m' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

function connect(room, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/${room}?token=${token}`)
  ws.binaryType = 'arraybuffer'
  const doc = new Y.Doc()
  ws.on('open', () => {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 0)
    syncProtocol.writeSyncStep1(enc, doc)
    ws.send(encoding.toUint8Array(enc))
  })
  ws.on('message', (data) => {
    const dec = decoding.createDecoder(new Uint8Array(data))
    if (decoding.readVarUint(dec) !== 0) return
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 0)
    syncProtocol.readSyncMessage(dec, enc, doc, 'remote')
    if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc))
  })
  doc.on('update', (update, origin) => {
    if (origin === 'remote' || ws.readyState !== WebSocket.OPEN) return
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 0)
    syncProtocol.writeUpdate(enc, update)
    ws.send(encoding.toUint8Array(enc))
  })
  return { ws, doc }
}

function expectRejected(room, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/${room}?token=${token}`)
    // Resolve BEFORE terminate: terminate() fires 'error' synchronously, so
    // tearing down first would settle the promise with the error instead.
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode); ws.terminate() })
    ws.on('open', () => { resolve(0); ws.close() })
    ws.on('error', () => resolve(-1))
  })
}

async function main() {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, SYNC_JWT_SECRET: SECRET, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', (d) => process.stdout.write('[server] ' + d))
  server.stderr.on('data', (d) => process.stdout.write('[server:err] ' + d))
  await sleep(900)

  check('no token is refused', (await expectRejected(ROOM, '')) === 401)
  check('token for another room is refused',
    (await expectRejected(ROOM, sign('notebook-user2-doc9', true))) === 403)
  check('token signed with the wrong secret is refused',
    (await expectRejected(ROOM, jwt.sign({ room: ROOM, w: true }, 'wrong', { expiresIn: '5m' }))) === 401)
  check('expired token is refused',
    (await expectRejected(ROOM, jwt.sign({ room: ROOM, w: true }, SECRET, { expiresIn: -10 }))) === 401)

  // Writer joins and types.
  const writer = connect(ROOM, sign(ROOM, true))
  await sleep(400)
  writer.doc.getText('t').insert(0, 'from owner')
  await sleep(400)

  // Read-only peer joins: must receive the text.
  const reader = connect(ROOM, sign(ROOM, false))
  await sleep(600)
  check('read-only peer receives the document',
    reader.doc.getText('t').toString() === 'from owner',
    JSON.stringify(reader.doc.getText('t').toString()))

  // Read-only peer types: the relay must drop it, so the writer never sees it.
  reader.doc.getText('t').insert(0, 'VANDAL ')
  await sleep(700)
  check('read-only peer cannot write',
    writer.doc.getText('t').toString() === 'from owner',
    JSON.stringify(writer.doc.getText('t').toString()))

  // A second writer proves the drop is about permission, not about the wiring.
  const writer2 = connect(ROOM, sign(ROOM, true))
  await sleep(500)
  writer2.doc.getText('t').insert(0, 'peer: ')
  await sleep(700)
  check('a second write-token peer does reach the first',
    writer.doc.getText('t').toString() === 'peer: from owner',
    JSON.stringify(writer.doc.getText('t').toString()))

  for (const c of [writer, reader, writer2]) c.ws.close()
  server.kill()
  await sleep(200)
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
