// SOCKS5 jump-host: handshake, login, errors, and a real ssh2 session through the proxy.
// Run: npm run test:socks5
import { createServer, connect } from 'net'
import { generateKeyPairSync } from 'crypto'
import ssh2 from 'ssh2'
import { socks5Connect, Socks5Error } from '../src/main/ssh/socks5.ts'
import { tcpPing } from '../src/main/monitor/ping.ts'

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? `: ${extra}` : ''}`)
  if (!ok) failed++
}
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))

/** Minimal SOCKS5 server (RFC 1928/1929). Records the last CONNECT target. */
function socksServer({ user, pass } = {}) {
  const seen = []
  const srv = createServer((c) => {
    c.on('error', () => {})
    let buf = Buffer.alloc(0)
    let step = 'greet'
    const onData = (d) => {
      buf = Buffer.concat([buf, d])
      if (step === 'greet') {
        if (buf.length < 2 || buf.length < 2 + buf[1]) return
        const methods = [...buf.subarray(2, 2 + buf[1])]
        buf = buf.subarray(2 + buf[1])
        if (user) {
          if (!methods.includes(2)) return c.end(Buffer.from([5, 0xff]))
          c.write(Buffer.from([5, 2]))
          step = 'auth'
        } else {
          c.write(Buffer.from([5, 0]))
          step = 'req'
        }
      }
      if (step === 'auth') {
        if (buf.length < 2) return
        const ul = buf[1]
        if (buf.length < 3 + ul) return
        const pl = buf[2 + ul]
        if (buf.length < 3 + ul + pl) return
        const u = buf.subarray(2, 2 + ul).toString()
        const p = buf.subarray(3 + ul, 3 + ul + pl).toString()
        buf = buf.subarray(3 + ul + pl)
        if (u !== user || p !== pass) return c.end(Buffer.from([1, 1]))
        c.write(Buffer.from([1, 0]))
        step = 'req'
      }
      if (step === 'req') {
        if (buf.length < 5) return
        const at = buf[3]
        const len = at === 1 ? 4 : at === 4 ? 16 : 1 + buf[4]
        if (buf.length < 4 + len + 2) return
        const raw = buf.subarray(4, 4 + len)
        const host = at === 1 ? [...raw].join('.') : at === 3 ? raw.subarray(1).toString() : raw.toString('hex')
        const port = buf.readUInt16BE(4 + len)
        buf = buf.subarray(4 + len + 2)
        seen.push({ type: at, host, port })
        step = 'pipe'
        c.removeListener('data', onData)
        const to = host === 'localhost.test' ? '127.0.0.1' : at === 1 ? host : '127.0.0.1'
        const up = connect({ host: to, port })
        up.once('connect', () => {
          c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
          if (buf.length) up.write(buf)
          c.pipe(up).pipe(c)
        })
        up.once('error', () => c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])))
      }
    }
    c.on('data', onData)
  })
  return { srv, seen }
}

const echo = createServer((c) => c.pipe(c))
const echoPort = await listen(echo)

// 1. No auth, IPv4 target, data flows both ways.
{
  const { srv, seen } = socksServer()
  const port = await listen(srv)
  const s = await socks5Connect({ address: '127.0.0.1', port }, '127.0.0.1', echoPort)
  const got = await new Promise((r) => (s.once('data', (d) => r(d.toString())), s.write('привет')))
  check('без авторизации, эхо', got === 'привет', got)
  check('CONNECT с IPv4', seen[0]?.type === 1 && seen[0].host === '127.0.0.1' && seen[0].port === echoPort)
  s.destroy()
  srv.close()
}

// 2. Login/password, domain name target (resolved by the proxy).
{
  const { srv, seen } = socksServer({ user: 'netadm', pass: 'пароль' })
  const port = await listen(srv)
  const s = await socks5Connect({ address: '127.0.0.1', port, username: 'netadm', password: 'пароль' }, 'localhost.test', echoPort)
  const got = await new Promise((r) => (s.once('data', (d) => r(d.toString())), s.write('x')))
  check('логин и пароль, имя хоста', got === 'x' && seen[0]?.type === 3 && seen[0].host === 'localhost.test')
  s.destroy()

  const bad = await socks5Connect({ address: '127.0.0.1', port, username: 'netadm', password: 'нет' }, '127.0.0.1', echoPort).catch((e) => e)
  check('неверный пароль', bad instanceof Socks5Error && /неверный логин/.test(bad.message), bad.message)

  const none = await socks5Connect({ address: '127.0.0.1', port }, '127.0.0.1', echoPort).catch((e) => e)
  check('прокси требует логин', none instanceof Socks5Error && /требует логин/.test(none.message), none.message)
  srv.close()
}

// 3. Target port closed → proxy reply 5; proxy itself down → clear message.
{
  const { srv } = socksServer()
  const port = await listen(srv)
  const closed = createServer()
  const closedPort = await listen(closed)
  closed.close()
  const e = await socks5Connect({ address: '127.0.0.1', port }, '127.0.0.1', closedPort).catch((x) => x)
  check('порт цели закрыт', e instanceof Socks5Error && e.reply === 5, e.message)
  srv.close()
  const down = await socks5Connect({ address: '127.0.0.1', port }, '127.0.0.1', echoPort).catch((x) => x)
  check('прокси не запущен', down instanceof Socks5Error && down.reply === undefined && /порт закрыт/.test(down.message), down.message)
}

// 4. IPv6 target encodes as 16 bytes.
{
  const { srv, seen } = socksServer()
  const port = await listen(srv)
  await socks5Connect({ address: '127.0.0.1', port }, '::ffff:127.0.0.1', echoPort).then((s) => s.destroy(), () => {})
  check('IPv6 адрес', seen[0]?.type === 4 && seen[0].host === '00000000000000000000ffff7f000001', seen[0]?.host)
  srv.close()
}

// 5. A real SSH session (ssh2 client → SOCKS5 → ssh2 server), as Pult opens one.
{
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  const sshd = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'admin' ? ctx.accept() : ctx.reject(['password'])))
    client.on('session', (accept) => accept().on('exec', (acc, _rej, info) => {
      const st = acc()
      st.write(`ran: ${info.command}`)
      st.exit(0)
      st.end()
    }))
    client.on('error', () => {})
  })
  const sshPort = await listen(sshd)
  const { srv } = socksServer({ user: 'u', pass: 'p' })
  const port = await listen(srv)
  const sock = await socks5Connect({ address: '127.0.0.1', port, username: 'u', password: 'p' }, '127.0.0.1', sshPort)
  const out = await new Promise((resolve, reject) => {
    const c = new ssh2.Client()
    c.on('ready', () =>
      c.exec('display version', (err, st) => {
        if (err) return reject(err)
        let s = ''
        st.on('data', (d) => (s += d))
        st.on('close', () => (c.end(), resolve(s)))
      })
    )
    c.on('error', reject)
    c.connect({ sock, username: 'admin', password: 'admin', hostVerifier: () => true })
  }).catch((e) => `error: ${e.message}`)
  check('SSH-сессия через SOCKS5', out === 'ran: display version', out)
  srv.close()
  sshd.close()
}

// 6. Monitoring "ping" through the proxy: TCP connect time; refused = alive; no answer / proxy down = null.
{
  const { srv } = socksServer()
  const port = await listen(srv)
  const open = (a, p) => socks5Connect({ address: '127.0.0.1', port }, a, p)
  const up = await tcpPing(open, '127.0.0.1', echoPort)
  check('пинг через прокси: порт открыт', typeof up === 'number' && up >= 0, String(up))
  const closed = createServer()
  const closedPort = await listen(closed)
  closed.close()
  const refused = await tcpPing(open, '127.0.0.1', closedPort)
  check('пинг через прокси: порт закрыт = жив', typeof refused === 'number', String(refused))
  const silent = await tcpPing(() => new Promise(() => {}), '10.255.255.1', 22, 300)
  check('пинг через прокси: нет ответа', silent === null)
  srv.close()
  const down = await tcpPing(open, '127.0.0.1', echoPort)
  check('пинг через прокси: прокси выключен', down === null)
}

echo.close()
console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
