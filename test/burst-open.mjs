// A pack of hosts opened at once (map sheet, folder) through a jump host that drops connections
// beyond a few in the handshake at the same time, like OpenSSH MaxStartups or a busy proxy.
// Run: npm run test:burst
import { createServer, connect } from 'net'
import { generateKeyPairSync } from 'crypto'
import ssh2 from 'ssh2'
import { JumpHost } from '../src/main/ssh/jump.ts'
import { SessionManager } from '../src/main/ssh/session-manager.ts'
import { OpenQueue } from '../src/main/ssh/open-queue.ts'

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? `: ${extra}` : ''}`)
  if (!ok) failed++
}
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })

/** The switches: an SSH server with a shell, behind a gate that drops what is over `limit` pre-login connections. */
function switches() {
  const authed = new Map() // remote port → logged in
  const sshd = new ssh2.Server({ hostKeys: [privateKey] }, (client, info) => {
    client.on('error', () => {})
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'admin' ? ctx.accept() : ctx.reject(['password'])))
    client.on('ready', () => {
      authed.set(info.port, true)
      gate.inHandshake--
    })
    client.on('session', (accept) => {
      const s = accept()
      s.on('pty', (a) => a())
      s.on('shell', (a) => a().write('MES2348B#'))
    })
  })
  const gate = createServer((sock) => {
    sock.on('error', () => {})
    if (gate.inHandshake >= gate.limit) {
      gate.dropped++
      // Some boxes say why before hanging up; a bare CR in that line is ssh2's "Invalid header".
      return gate.busyText ? sock.end('\rToo many sessions\r\n') : sock.destroy()
    }
    gate.inHandshake++
    gate.peak = Math.max(gate.peak, gate.inHandshake)
    const port = sock.remotePort
    sock.once('close', () => {
      if (!authed.get(port)) gate.inHandshake--
      authed.delete(port)
    })
    sshd.injectSocket(sock)
  })
  Object.assign(gate, { limit: 3, inHandshake: 0, peak: 0, dropped: 0, busyText: false })
  return gate
}

/** Jump host (мастер-кей): OpenSSH-like direct-tcpip. */
const jumpd = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
  client.on('error', () => {})
  client.on('authentication', (ctx) => ctx.accept())
  client.on('tcpip', (accept, reject, info) => {
    const up = connect({ host: '127.0.0.1', port: info.destPort })
    up.once('error', () => reject())
    up.once('connect', () => {
      const ch = accept()
      ch.on('error', () => {})
      ch.pipe(up).pipe(ch)
      up.on('close', () => ch.destroy())
    })
  })
})

/** No-auth SOCKS5, IPv4 targets only. */
const socksd = createServer((c) => {
  c.on('error', () => {})
  let buf = Buffer.alloc(0)
  let step = 'greet'
  const onData = (d) => {
    buf = Buffer.concat([buf, d])
    if (step === 'greet') {
      if (buf.length < 2 || buf.length < 2 + buf[1]) return
      buf = buf.subarray(2 + buf[1])
      c.write(Buffer.from([5, 0]))
      step = 'req'
    }
    if (step === 'req' && buf.length >= 10) {
      const port = buf.readUInt16BE(8)
      c.removeListener('data', onData)
      const up = connect({ host: '127.0.0.1', port })
      up.once('error', () => c.destroy())
      up.once('connect', () => {
        c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
        c.pipe(up).pipe(c)
        up.on('close', () => c.destroy())
      })
    }
  }
  c.on('data', onData)
})

const jumpPort = await listen(jumpd)
const socksPort = await listen(socksd)
const HOSTS = 12
const settings = { port: 0, algoProfile: 'compat' }
const sessions = new SessionManager({ data() {}, closed() {} })
const trust = async () => true

/** Opens HOSTS sessions at once, as connectMany does; returns how many came up and the errors. */
async function burst(kind, gate, queued) {
  const jump = new JumpHost()
  const j = kind === 'ssh'
    ? { kind, address: '127.0.0.1', port: jumpPort, username: 'u', password: 'p', algoProfile: 'compat' }
    : { kind, address: '127.0.0.1', port: socksPort, algoProfile: 'compat' }
  const queue = new OpenQueue()
  const host = { id: 'h', folderId: null, name: 'sw', address: '127.0.0.1', overrides: {} }
  const openOne = async () => {
    const sock = await jump.forward(j, trust, '127.0.0.1', settings.port)
    return sessions.open(host, settings, { username: 'admin', password: 'admin' }, 80, 24, trust, sock)
  }
  const results = await Promise.allSettled(
    Array.from({ length: HOSTS }, () => (queued ? queue.open(openOne, [200, 400]) : openOne()))
  )
  const ok = results.filter((r) => r.status === 'fulfilled')
  ok.forEach((r) => sessions.close(r.value))
  jump.reset()
  const errors = [...new Set(results.filter((r) => r.status === 'rejected').map((r) => r.reason.message))]
  return { up: ok.length, errors }
}

for (const kind of ['ssh', 'socks5']) {
  const label = kind === 'ssh' ? 'SSH jump-host' : 'SOCKS5'
  for (const limit of [3, 2, 1]) {
    const gate = switches()
    gate.limit = limit
    settings.port = await listen(gate)

    const before = await burst(kind, gate, false)
    if (limit === 3) {
      check(`${label}: старое открытие пачки воспроизводит обрыв`, before.up < HOSTS && before.errors.some((m) => /lost before handshake/i.test(m)),
        `${before.up}/${HOSTS}, ${before.errors.join('; ')}`)
    }

    gate.peak = 0
    gate.dropped = 0
    const after = await burst(kind, gate, true)
    check(`${label}, лимит ${limit}: очередь открывает все ${HOSTS}`, after.up === HOSTS,
      `${after.up}/${HOSTS}, пик в handshake ${gate.peak}, сброшено и повторено ${gate.dropped}${after.errors.length ? ', ' + after.errors.join('; ') : ''}`)
    gate.close()
  }
}

// A busy box that answers with a text line instead of the SSH version string, then hangs up.
{
  const gate = switches()
  gate.busyText = true
  settings.port = await listen(gate)
  const before = await burst('ssh', gate, false)
  check('занятый коммутатор отвечает текстом: старое открытие', before.up < HOSTS && before.errors.some((m) => /Invalid header/i.test(m)),
    `${before.up}/${HOSTS}, ${before.errors.join('; ')}`)
  gate.dropped = 0
  const after = await burst('ssh', gate, true)
  check(`занятый коммутатор отвечает текстом: очередь открывает все ${HOSTS}`, after.up === HOSTS,
    `${after.up}/${HOSTS}, сброшено и повторено ${gate.dropped}${after.errors.length ? ', ' + after.errors.join('; ') : ''}`)
  gate.close()
}

// Wrong password is not retried: the error comes back on the first try.
{
  let tries = 0
  const e = await new OpenQueue().open(async () => (tries++, Promise.reject(new Error('Неверный логин или пароль.'))), [10, 10]).catch((x) => x)
  check('неверный пароль не повторяется', tries === 1 && /Неверный/.test(e.message))
}

jumpd.close()
socksd.close()
console.log(failed ? `\n${failed} FAILED` : '\nall ok')
process.exit(failed ? 1 : 0)
