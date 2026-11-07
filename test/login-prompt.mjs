// No login, or a wrong one: the session opens and asks in the terminal ("login as:", "password:"), like PuTTY,
// then offers to remember what worked. Run: npm run test:login
import { generateKeyPairSync } from 'crypto'
import ssh2 from 'ssh2'
import { SessionManager } from '../src/main/ssh/session-manager.ts'
import { tcpConnect } from '../src/main/ssh/tcp.ts'

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? `: ${extra}` : ''}`)
  if (!ok) failed++
}
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
/** kbd: the server takes only keyboard-interactive, like some Huawei / Cisco. */
const server = (kbd) => {
  const sshd = new ssh2.Server({ hostKeys: [privateKey], banner: 'Authorized users only' }, (client) => {
    client.on('error', () => {})
    client.on('authentication', (ctx) => {
      const ok = ctx.username === 'admin'
      if (!kbd && ctx.method === 'password') return ok && ctx.password === 'secret' ? ctx.accept() : ctx.reject(['password', 'keyboard-interactive'])
      if (kbd && ctx.method === 'keyboard-interactive')
        return ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) => (ok && answers[0] === 'secret' ? ctx.accept() : ctx.reject(['keyboard-interactive'])))
      ctx.reject(kbd ? ['keyboard-interactive'] : ['password', 'keyboard-interactive'])
    })
    client.on('session', (accept) => {
      const s = accept()
      s.on('pty', (a) => a())
      s.on('shell', (a) => a().write('<HW5720>'))
    })
  })
  return new Promise((r) => sshd.listen(0, '127.0.0.1', () => r({ sshd, port: sshd.address().port })))
}

const out = new Map()
const closed = new Map()
const sessions = new SessionManager({
  data: (id, d) => out.set(id, (out.get(id) ?? '') + d),
  closed: (id, reason) => closed.set(id, reason)
})
const text = (id) => out.get(id) ?? ''
const until = async (cond, ms = 4000) => {
  const t = Date.now()
  while (!cond()) {
    if (Date.now() - t > ms) return false
    await new Promise((r) => setTimeout(r, 20))
  }
  return true
}

async function open(port, login, remembered) {
  const s = { port, algoProfile: 'compat', webUrl: '', winbox: false, ping: false, snmp: false, jump: false }
  const sock = await tcpConnect('127.0.0.1', port, 1500)
  return sessions.open({ id: 'h', folderId: null, name: 'sw', address: '127.0.0.1', overrides: {} }, s, login, 80, 24, async () => true, sock, undefined,
    (u, p) => remembered.push([u, p]))
}

for (const kbd of [false, true]) {
  const tag = kbd ? '[keyboard-interactive] ' : '[password] '
  const { sshd, port } = await server(kbd)

  // 1. Nothing saved: no "Invalid username", the session asks.
  let saved = []
  let id = await open(port, {}, saved)
  check(tag + 'no login: session opens and asks "login as"', await until(() => text(id).endsWith('login as: ')), JSON.stringify(text(id)))
  sessions.write(id, 'admin\r')
  check(tag + 'then the password', await until(() => text(id).endsWith("admin@127.0.0.1's password: ")), JSON.stringify(text(id)))
  sessions.write(id, 'secret\r')
  check(tag + 'password not echoed', !text(id).includes('secret'))
  check(tag + 'asks to remember', await until(() => text(id).includes('Запомнить логин и пароль')))
  sessions.write(id, '\r')
  check(tag + 'Enter remembers admin / secret', await until(() => saved.length === 1) && saved[0][0] === 'admin' && saved[0][1] === 'secret', JSON.stringify(saved))
  check(tag + 'shell opens after that', await until(() => text(id).includes('<HW5720>')))
  sessions.write(id, 'x')
  sessions.close(id)

  // 2. Wrong saved password: "Доступ запрещён", login offered as default, typed password works; "n" keeps nothing.
  saved = []
  id = await open(port, { username: 'admin', password: 'wrong' }, saved)
  check(tag + 'wrong password: asks again with the login prefilled', await until(() => text(id).endsWith('login as [admin]: ')), JSON.stringify(text(id)))
  check(tag + 'says access denied, banner shown', text(id).includes('Доступ запрещён.') && text(id).includes('Authorized users only'))
  sessions.write(id, '\r')
  await until(() => text(id).endsWith('password: '))
  sessions.write(id, 'secrex\x7ft\r')
  await until(() => text(id).includes('Запомнить'))
  sessions.write(id, 'n\r')
  check(tag + 'backspace works, "n" saves nothing, shell opens', await until(() => text(id).includes('<HW5720>')) && saved.length === 0, JSON.stringify(text(id).slice(-120)))
  sessions.close(id)

  // 3. Right saved login: straight in, nothing asked, nothing remembered.
  saved = []
  id = await open(port, { username: 'admin', password: 'secret' }, saved)
  await until(() => text(id).includes('<HW5720>'))
  check(tag + 'saved login: no prompts', text(id) === '<HW5720>', JSON.stringify(text(id)))
  sessions.close(id)

  // 4. Ctrl+C at the prompt closes the session.
  id = await open(port, {}, [])
  await until(() => text(id).endsWith('login as: '))
  sessions.write(id, '\x03')
  check(tag + 'Ctrl+C: session closed "вход отменён"', await until(() => closed.has(id)) && closed.get(id) === 'вход отменён', closed.get(id))

  // 5. Three wrong rounds: closed as a wrong password.
  id = await open(port, { username: 'admin', password: 'wrong' }, [])
  for (let i = 0; i < 3; i++) {
    await until(() => /login as \[admin\]: $/.test(text(id)))
    sessions.write(id, '\r')
    await until(() => text(id).endsWith('password: '))
    out.set(id, '')
    sessions.write(id, 'bad\r')
  }
  check(tag + 'three wrong rounds: closed "Неверный логин или пароль."', await until(() => closed.has(id)) && closed.get(id) === 'Неверный логин или пароль.', closed.get(id))
  sshd.close()
}
sessions.closeAll()
console.log(failed ? `${failed} failed` : 'all ok')
process.exit(failed ? 1 : 0)
