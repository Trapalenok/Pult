// "Переподключить": a session the server dropped connects again under the same id, its output carrying on
// after what the pane already shows. Run: npm run test:reconnect
import { generateKeyPairSync } from 'crypto'
import ssh2 from 'ssh2'
import { SessionManager, SignatureError } from '../src/main/ssh/session-manager.ts'
import { openWithKexRetry } from '../src/main/ssh/kex-retry.ts'
import { droppedBeforeHandshake } from '../src/main/ssh/open-queue.ts'

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? `: ${extra}` : ''}`)
  if (!ok) failed++
}
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })

let logins = 0
/** Shell streams of the logged-in clients, to hang up from the server side. */
const shells = []
let up = true
const sshd = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
  client.on('error', () => {})
  if (!up) return client.end()
  client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'admin' ? ctx.accept() : ctx.reject(['password'])))
  client.on('ready', () => logins++)
  client.on('session', (accept) => {
    const s = accept()
    s.on('pty', (a) => a())
    s.on('shell', (a) => {
      const sh = a()
      shells.push({ sh, client })
      sh.write(`login ${logins}\r\nSW#`)
    })
  })
})
const port = await new Promise((r) => sshd.listen(0, '127.0.0.1', () => r(sshd.address().port)))

const data = []
const closed = []
const sessions = new SessionManager({ data: (id, d, end) => data.push({ id, d, end }), closed: (id, reason) => closed.push({ id, reason }) })
const host = { id: 'h1', folderId: null, name: 'sw', address: '127.0.0.1', overrides: {} }
const s = { port, algoProfile: 'modern' }
const login = { username: 'admin', password: 'admin' }
const wait = (cond, ms = 5000) => new Promise((resolve, reject) => {
  const t0 = Date.now()
  const tick = () => (cond() ? resolve() : Date.now() - t0 > ms ? reject(new Error('timeout')) : setTimeout(tick, 20))
  tick()
})

const id = await sessions.open(host, s, login, 100, 30, async () => true)
await wait(() => data.some((x) => x.d.includes('SW#')))
const firstEnd = data.at(-1).end

// The switch hangs up (reload, VTY timeout).
shells[0].client.end()
await wait(() => closed.length === 1)
check('closed event for the dropped session', closed[0].id === id)
check('closed session is no longer live', !sessions.has(id))
check('its output is kept for the pane', sessions.scrollback(id).data.includes('login 1'))
check('terminal size is kept', sessions.endedSize(id)?.cols === 100 && sessions.endedSize(id)?.rows === 30)

// A reconnect while the switch is still down fails and leaves the pane ready for another try.
up = false
let err
await sessions.open(host, s, login, 100, 30, async () => true, undefined, undefined, undefined, id).catch((e) => (err = e))
check('failed reconnect rejects', !!err, err?.message)
check('after a failed reconnect the output is still there', sessions.scrollback(id).end === firstEnd)
up = true

const again = await sessions.open(host, s, login, 100, 30, async () => true, undefined, undefined, undefined, id)
check('reconnect keeps the session id', again === id)
await wait(() => data.some((x) => x.d.includes('login 2')))
const next = data.find((x) => x.d.includes('login 2'))
check('new output continues after the old offset', next.end > firstEnd, `${firstEnd} → ${next.end}`)
const sb = sessions.scrollback(id).data
check('scrollback holds both connections', sb.includes('login 1') && sb.includes('login 2'))
check('reconnected session is live and writable', sessions.has(id))

let threw = false
await sessions.open(host, s, login, 100, 30, async () => true, undefined, undefined, undefined, id).catch(() => (threw = true))
check('a second reconnect of a live session is refused', threw)

// The user closes the pane: nothing is kept.
sessions.forget(id)
await wait(() => closed.length === 2)
check('forget drops the kept output', sessions.scrollback(id).end === 0 && !sessions.endedSize(id))

sessions.closeAll()
sshd.close()

// A cached Huawei KEX pair must not cost two queue backoffs if the switch resets it.
const pairId = 'cached-huawei-pair'
const pairsTried = []
await openWithKexRetry(pairId, async (only) => {
  pairsTried.push(only)
  if (!only) throw new SignatureError('signature mismatch', undefined, ['diffie-hellman-group14-sha1'], ['ssh-rsa'])
  return 'initial connection'
}, () => new Error('unexpected KEX failure'))
const reconnectPairs = []
const fallback = await openWithKexRetry(pairId, async (only) => {
  reconnectPairs.push(only)
  if (only) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
  return 'full profile connection'
}, () => new Error('unexpected KEX failure'))
check('cached KEX reset retries immediately with full profile', fallback === 'full profile connection' && reconnectPairs.length === 2 && reconnectPairs[0]?.kex === 'diffie-hellman-group14-sha1' && reconnectPairs[1] === undefined, JSON.stringify(reconnectPairs))
check('ECONNRESET after SSH handshake skips queue backoffs', !droppedBeforeHandshake(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', sshHandshakeCompleted: true })))
check('ECONNRESET before SSH handshake still retries', droppedBeforeHandshake(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })))
console.log(failed ? `\n${failed} FAILED` : '\nall ok')
process.exit(failed ? 1 : 0)
