// Entirely offline: no UDP sockets, Electron process or real device is started.
import assert from 'node:assert/strict'
import { parseLldp, LLDP_LOCAL as L, LLDP_REMOTE as R } from '../src/main/lldp/parse.ts'
import { collectLldp } from '../src/main/lldp/snmp.ts'
import { AutomaticLldp } from '../src/main/lldp/automatic.ts'
import { lldpPortLabel, cleanHostLldp, matchLldpNeighbor, retainLldpBindings, validLldpSnapshot } from '../src/shared/lldp.ts'

const v = (oid, value) => ({ oid, value, type: 4 })
const buf = (s) => Buffer.from(s)
function fixture(time = 100, local = 42, index = 7, remotePort = 'Gi1/0/24') {
  return [
    v(`${L}.1.0`, 4), v(`${L}.2.0`, Buffer.from('001122334455', 'hex')), v(`${L}.3.0`, buf('core')),
    v(`${L}.7.1.2.${local}`, 5), v(`${L}.7.1.3.${local}`, buf(`GE0/0/${local}`)),
    ...[[4, 4], [5, Buffer.from('aabbccddeeff', 'hex')], [6, 5], [7, buf(remotePort)], [8, buf('uplink')], [9, buf('access')]]
      .map(([col, value]) => v(`${R}.1.1.${col}.${time}.${local}.${index}`, value)),
    v(`${R}.2.1.3.${time}.${local}.${index}.1.4.192.0.2.2`, 2)
  ]
}
const snapshot = parseLldp(fixture(), '192.0.2.1', 1234)
assert.equal(snapshot.chassisId.text, '00:11:22:33:44:55')
assert.equal(snapshot.neighbors[0].localPort, 'GE0/0/42')
assert.equal(snapshot.neighbors[0].portId.text, 'Gi1/0/24')
assert.deepEqual(snapshot.neighbors[0].addresses, ['192.0.2.2'])
assert.ok(validLldpSnapshot(snapshot))
assert.equal(parseLldp(fixture(999, 42, 99), '192.0.2.1').neighbors[0].key, snapshot.neighbors[0].key, 'SNMP row indexes are not persistent identity')
assert.notEqual(parseLldp(fixture(100, 43), '192.0.2.1').neighbors[0].key, snapshot.neighbors[0].key, 'parallel links stay separate')
assert.throws(() => parseLldp(fixture().filter((r) => r.oid !== `${L}.7.1.3.42`), 'x'), /идентификаторы/)
assert.throws(() => parseLldp([...fixture(), ...fixture(101).filter((r) => r.oid.startsWith(R))], 'x'), /изменилась/)
assert.equal(parseLldp(fixture().filter((r) => r.oid.startsWith(L)), 'x').neighbors.length, 0, 'complete empty table')

const n = snapshot.neighbors[0]
const macRows = fixture().map((r) => r.oid === `${R}.1.1.6.100.42.7` ? v(r.oid, 3)
  : r.oid === `${R}.1.1.7.100.42.7` ? v(r.oid, Buffer.from('aabbccddeeff', 'hex')) : r)
  .filter((r) => r.oid !== `${R}.1.1.9.100.42.7` && !r.oid.startsWith(`${R}.2.`))
const macNeighbor = parseLldp(macRows, '192.0.2.1').neighbors[0]
assert.equal(macNeighbor.systemName, '')
assert.deepEqual(macNeighbor.addresses, [])
assert.equal(lldpPortLabel(macNeighbor.portId), 'MAC порта: aa:bb:cc:dd:ee:ff')
assert.equal(lldpPortLabel(n.portId), 'Gi1/0/24')
assert.equal(lldpPortLabel({ ...n.portId, subtype: 7 }), 'Port ID: Gi1/0/24')
const host = (id, address, extra = {}) => ({ id, address, name: 'access', folderId: null, overrides: {}, ...extra })
const target = host('b', '192.0.2.2')
assert.deepEqual(matchLldpNeighbor(n, [target], 'a'), { kind: 'address', hostIds: ['b'] })
assert.equal(matchLldpNeighbor(n, [target, host('c', target.address)], 'a').kind, 'conflict')
assert.equal(matchLldpNeighbor(n, [host('b', '192.0.2.3')], 'a').kind, 'name')
assert.equal(matchLldpNeighbor(n, [host('b', '192.0.2.3', { addresses: [target.address] })], 'a').kind, 'address')
assert.equal(matchLldpNeighbor(n, [{ ...target, lldp: snapshot }], 'a').kind, 'conflict', 'IP reuse cannot override known chassis')
const own = { ...snapshot, chassisId: n.chassisId }
assert.equal(matchLldpNeighbor(n, [{ ...target, lldp: own }], 'a').kind, 'chassis')
assert.equal(matchLldpNeighbor({ ...n, addresses: ['fe80::1'], systemName: '' }, [host('b', 'fe80::1')], 'a').kind, 'none')
assert.equal(matchLldpNeighbor({ ...n, addresses: ['2001:db8::1'] }, [host('b', '2001:0db8:0:0:0:0:0:1')], 'a').kind, 'address')
assert.equal(matchLldpNeighbor(n, [host('a', target.address)], 'a').kind, 'none', 'never suggest source host')

const bound = { ...snapshot, neighbors: [{ ...n, hostId: 'b' }] }
assert.equal(retainLldpBindings(snapshot, bound).neighbors[0].hostId, 'b')
assert.equal(retainLldpBindings(own, bound).neighbors[0].hostId, undefined, 'local chassis replacement clears binding')
assert.equal(retainLldpBindings(parseLldp(fixture(100, 42, 7, 'Gi1/0/23'), 'x'), bound).neighbors[0].hostId, undefined)
assert.equal(cleanHostLldp([host('a', 'x', { lldp: bound })])[0].lldp.neighbors[0].hostId, undefined, 'deleted target cleaned')
assert.equal(cleanHostLldp([host('a', 'x', { lldp: bound }), target])[0].lldp.neighbors[0].hostId, 'b')
assert.equal(cleanHostLldp([host('a', 'x', { lldp: { source: 'garbage' } })])[0].lldp, undefined)
assert.ok(validLldpSnapshot(JSON.parse(JSON.stringify(bound))), 'export/import JSON roundtrip')
assert.equal(validLldpSnapshot({ ...snapshot, observedAt: Infinity }), false)

function mock({ walkError = false, change = false, stall = false, missingStats = false, hiddenLldp = false, unstable = false } = {}) {
  let gets = 0, closed = 0, walks = 0
  return {
    session: {
      on() {},
      get(_oids, cb) { gets++; if (!stall) cb(null, [missingStats ? { oid: 'change', type: 128, value: null } : v('change', change ? gets : 1), v('uptime', 500 + gets)]) },
      subtree(base, _max, feed, done) {
        walks++
        feed(hiddenLldp ? [] : fixture(100, 42, 7, unstable && walks > 2 ? 'Gi1/0/23' : 'Gi1/0/24').filter((r) => r.oid.startsWith(base + '.')))
        done(walkError ? new Error('partial response') : undefined)
      },
      close() { closed++ }
    },
    get closed() { return closed }, get gets() { return gets }, get walks() { return walks }
  }
}
const ok = mock()
assert.equal((await collectLldp('test.invalid', 'unused', new AbortController().signal, () => ok.session)).neighbors.length, 1)
assert.equal(ok.closed, 1)
const noStats = mock({ missingStats: true })
assert.equal((await collectLldp('test.invalid', 'unused', new AbortController().signal, () => noStats.session)).neighbors.length, 1)
assert.equal(noStats.walks, 4, 'missing statistics scalar uses two consistent walks')
const changingWithoutStats = mock({ missingStats: true, unstable: true })
await assert.rejects(collectLldp('test.invalid', 'unused', new AbortController().signal, () => changingWithoutStats.session), /другой результат/)
const restricted = mock({ missingStats: true, hiddenLldp: true })
await assert.rejects(collectLldp('test.invalid', 'unused', new AbortController().signal, () => restricted.session), /SNMP отвечает.*ViewDefault/)
assert.equal(restricted.closed, 1)
for (const opts of [{ walkError: true }, { change: true }]) {
  const m = mock(opts)
  await assert.rejects(collectLldp('test.invalid', 'unused', new AbortController().signal, () => m.session))
  assert.equal(m.closed, 1, 'failure closes session')
}
const m = mock({ stall: true })
const abort = new AbortController()
const pending = collectLldp('test.invalid', 'unused', abort.signal, () => m.session)
abort.abort()
await assert.rejects(pending, /отменено/)
assert.equal(m.closed, 1)
assert.equal(m.gets, 1, 'cancellation cannot start subsequent requests')
const deadline = mock({ stall: true })
await assert.rejects(collectLldp('test.invalid', 'unused', new AbortController().signal, () => deadline.session, 5), /время/)
assert.equal(deadline.closed, 1)
const alreadyAborted = new AbortController(); alreadyAborted.abort()
await assert.rejects(collectLldp('test.invalid', 'unused', alreadyAborted.signal, () => { throw new Error('must not open') }), /отменено/)
// Automatic collection: no real transport, clock or timer required.
let clock = 1000
let config = { folders: [{ id: 'f', parentId: null, name: 'f', defaults: { snmp: true } }],
  hosts: [host('a', '192.0.2.1', { folderId: 'f' })], credentials: [], maps: [], secretIds: [] }
const secretValues = new Map()
const calls = [], saved = [], statuses = []
let pendingResolve
let fail = false
let hold = false
const automatic = new AutomaticLldp({
  store: () => config, secret: (id) => secretValues.get(id), now: () => clock,
  collect: async (address, community, signal) => {
    calls.push({ address, community, signal })
    if (hold) return new Promise((resolve) => { pendingResolve = resolve })
    if (fail) throw Error('Synthetic failure with a private secret')
    return snapshot
  },
  save: (id, value) => saved.push({ id, value }), emit: (s) => statuses.push(s)
}, 300000, 1)
const settle = () => new Promise((resolve) => setImmediate(resolve))
automatic.tick(); await settle()
assert.equal(calls.length, 0, 'no community: no automatic requests')
secretValues.set('snmp:f', 'folder-community'); config.secretIds = ['snmp:f']
automatic.tick(); await settle()
assert.equal(calls.length, 1, 'saving inherited community starts collection')
assert.equal(calls[0].community, 'folder-community')
assert.equal(saved.length, 1)
automatic.tick(); await settle()
assert.equal(calls.length, 1, 'unchanged configuration does not flood device')
secretValues.set('snmp:a', 'host-community'); config.secretIds.push('snmp:a')
automatic.tick(); await settle()
assert.equal(calls.length, 2, 'new host override triggers immediate refresh')
assert.equal(calls[1].community, 'host-community')
clock += 300000; fail = true
automatic.tick(); await settle()
assert.equal(saved.length, 2, 'failure retains last successful snapshot')
assert.equal(statuses.at(-1).state, 'error')
assert.ok(!statuses.at(-1).error.includes('private secret'))
automatic.tick(); await settle()
assert.equal(calls.length, 3, 'failed host waits until next interval')
config.hosts[0].lldpAuto = false
automatic.tick(); await settle()
assert.equal(calls.length, 3, 'disabled host is not polled')
config.hosts[0].lldpAuto = true; fail = false; hold = true
automatic.tick(); await settle()
config.hosts[0].address = '192.0.2.99'
automatic.tick()
assert.equal(calls.at(-1).signal.aborted, true, 'address change cancels obsolete request')
pendingResolve(snapshot); await settle()
assert.equal(saved.length, 2, 'obsolete response cannot overwrite current host')
hold = false; automatic.tick(); await settle()
assert.equal(calls.at(-1).address, '192.0.2.99')
assert.equal(saved.length, 3)
hold = true; clock += 300000; automatic.tick(); await settle()
config.hosts = []; automatic.tick()
pendingResolve(snapshot); await settle()
assert.equal(saved.length, 3, 'deleted host cannot be resurrected')
automatic.stop(); automatic.tick()
assert.ok(calls.every((c) => c.address.startsWith('192.0.2.')))
console.log('LLDP: offline parsing, matching, persistence, transport and automatic scheduling checks passed.')
