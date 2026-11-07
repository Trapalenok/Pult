// Monitor: a lost echo is retried before a host is called down; SNMP that never answers is asked
// less often; a device without temperature is not walked for it every round.
// Run: npm run test:monitor (bundles monitor.ts with ping and SNMP replaced by fakes).
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'url'
import { dirname, join } from 'path'
import assert from 'assert/strict'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'out/test/monitor.mjs')
await build({
  entryPoints: [join(root, 'src/main/monitor/monitor.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'warning',
  alias: { '@shared': join(root, 'src/shared') },
  plugins: [{
    name: 'fakes',
    setup(b) {
      b.onResolve({ filter: /^\.\/(snmp)$/ }, () => ({ path: 'fake-snmp', namespace: 'fake' }))
      b.onResolve({ filter: /^child_process$/ }, () => ({ path: 'fake-cp', namespace: 'fake' }))
      b.onLoad({ filter: /^fake-snmp$/, namespace: 'fake' }, () => ({ contents: 'export const pollSnmp = (...a) => globalThis.__snmp(...a)', loader: 'js' }))
      // ping.ts spawns the system ping: each spawn takes its answer from globalThis.__echo().
      b.onLoad({ filter: /^fake-cp$/, namespace: 'fake' }, () => ({
        contents: `import { EventEmitter } from 'events'
export function spawn() {
  const p = new EventEmitter(); p.stdout = new EventEmitter(); p.kill = () => {}
  const ok = globalThis.__echo()
  setTimeout(() => { if (ok) p.stdout.emit('data', Buffer.from('Reply from 10.0.0.1: bytes=32 time=3ms TTL=64')); p.emit('close') }, 1)
  return p
}`,
        loader: 'js'
      }))
    }
  }]
})
const { Monitor } = await import(pathToFileURL(out).href)

const store = {
  folders: [],
  hosts: [{ id: 'h1', folderId: null, name: 'sw', address: '10.0.0.1', overrides: { ping: true, snmp: true } }],
  credentials: [],
  maps: [],
  secretIds: ['snmp:h1']
}
let sent = []
const m = new Monitor(() => store, () => 'public', (c) => sent.push(...c))
const round = async () => (sent = [], await m['round'](), m.all()[0])

// 1. Two lost echoes, then a reply: still up, one round, three echoes.
let echoes = [false, false, true], echoCount = 0
globalThis.__echo = () => (echoCount++, echoes.shift() ?? true)
let snmpCalls = []
globalThis.__snmp = async (a, c, o) => (snmpCalls.push(o), { ok: true, uptime: 10, noTemp: true })
let s = await round()
assert.equal(s.alive, true, 'one or two lost echoes do not make the host down')
assert.equal(echoCount, 3)
assert.equal(s.history.at(-1), 3)

// 2. All three lost: down.
echoes = [false, false, false]
globalThis.__echo = () => echoes.shift() ?? false
globalThis.__snmp = async () => ({ ok: false, error: 'нет ответа SNMP' })
s = await round()
assert.equal(s.alive, false)
assert.equal(s.history.at(-1), null)

// 3. SNMP silent: after 3 rounds it is asked only every 10th round, the last answer stays.
let asked = 0
globalThis.__echo = () => true
globalThis.__snmp = async () => (asked++, { ok: false, error: 'нет ответа SNMP' })
for (let i = 0; i < 12; i++) s = await round()
assert.ok(asked <= 4, `silent SNMP asked ${asked} times in 12 rounds`)
assert.equal(s.snmp.ok, false)
assert.equal(s.snmp.quiet, true)
assert.equal(s.alive, true)

// 4. Temperature: absent → the next rounds skip the walk (temp: false).
const m2 = new Monitor(() => store, () => 'public', () => {})
snmpCalls = []
globalThis.__snmp = async (a, c, o) => (snmpCalls.push(o.temp), { ok: true, uptime: 10, noTemp: true })
for (let i = 0; i < 5; i++) await m2['round']()
assert.deepEqual(snmpCalls, [true, false, false, false, false])
assert.equal(m2.all()[0].snmp.noTemp, true)

console.log('monitor: ok')
