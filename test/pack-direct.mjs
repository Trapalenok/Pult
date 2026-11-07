// A pack of hosts opened straight from this PC, some of them dead (no answer at all, like a switch that is off):
// the dead ones must give up quickly and must not hold the live ones back.
// Run: npm run test:pack
import { createServer } from 'net'
import { generateKeyPairSync } from 'crypto'
import ssh2 from 'ssh2'
import { SessionManager } from '../src/main/ssh/session-manager.ts'
import { OpenQueue } from '../src/main/ssh/open-queue.ts'
import { tcpConnect } from '../src/main/ssh/tcp.ts'

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? `: ${extra}` : ''}`)
  if (!ok) failed++
}
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
const sshd = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
  client.on('error', () => {})
  client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'admin' ? ctx.accept() : ctx.reject(['password'])))
  client.on('session', (accept) => {
    const s = accept()
    s.on('pty', (a) => a())
    s.on('shell', (a) => a().write('sw#'))
  })
})
const port = await new Promise((r) => sshd.listen(0, '127.0.0.1', () => r(sshd.address().port)))
// "Dead" hosts: accept TCP but the SYN never gets an answer is impossible to fake locally, so a short connect timeout
// is checked against a non-routable address instead.
const DEAD = '10.255.255.1'

const sessions = new SessionManager({ data() {}, closed() {} })
const queue = new OpenQueue(8)
const s = { port, algoProfile: 'compat', webUrl: '', winbox: false, ping: false, snmp: false, jump: false }
const open = (address, p = port) =>
  queue.open(async () => {
    const sock = await tcpConnect(address, p, 1500)
    return sessions.open({ id: address, folderId: null, name: address, address, overrides: {} }, s, { username: 'admin', password: 'admin' }, 80, 24, async () => true, sock)
  })

const t0 = Date.now()
const hosts = [...Array.from({ length: 12 }, () => '127.0.0.1'), DEAD, DEAD, DEAD]
const results = await Promise.allSettled(hosts.map((h) => open(h)))
const ms = Date.now() - t0
const up = results.filter((r) => r.status === 'fulfilled').length
const down = results.filter((r) => r.status === 'rejected')
check('12 live hosts connected', up === 12, `${up}`)
check('3 dead hosts failed with a timeout', down.length === 3 && down.every((r) => /таймаут/.test(r.reason.message)), down.map((r) => r.reason.message).join('; '))
check('pack done in a few seconds, not 90 s per dead host', ms < 8000, `${ms} ms`)
const refused = await open('127.0.0.1', 1).catch((e) => e)
check('closed port fails at once', /Порт закрыт/.test(refused.message), refused.message)
sessions.closeAll()
sshd.close()
console.log(failed ? `${failed} failed` : 'all ok')
process.exit(failed ? 1 : 0)
