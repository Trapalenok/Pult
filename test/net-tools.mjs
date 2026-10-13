// node --experimental-strip-types test/net-tools.mjs
// Network tools: cp866 console text, tracert/traceroute hop lines, port lists and sweep ranges.
import assert from 'node:assert/strict'
import { decodeCp866, parseHop, parseTtl } from '../src/main/tools/parse.ts'
import { parsePorts, parseRange, subnetOf } from '../src/shared/tools.ts'

const enc = (s) => {
  // Inverse of decodeCp866 for the test strings.
  const table = [...Array(128).keys()].map((i) => decodeCp866(Buffer.from([0x80 + i])))
  assert.equal(new Set(table).size, 128, 'cp866 table has 128 distinct chars')
  return Buffer.from([...s].map((ch) => (ch.charCodeAt(0) < 128 ? ch.charCodeAt(0) : 0x80 + table.indexOf(ch))))
}
const ru = 'Трассировка маршрута к core [10.0.0.1] с максимальным числом прыжков 30: Ёё №'
assert.equal(decodeCp866(enc(ru)), ru)

const hops = [
  ['  1    <1 мс    <1 мс    <1 мс  192.168.1.1', { hop: 1, rtts: [0.5, 0.5, 0.5], address: '192.168.1.1' }],
  ['  2     3 ms     2 ms     *     core-sw.local [10.0.0.1]', { hop: 2, rtts: [3, 2, null], name: 'core-sw.local', address: '10.0.0.1' }],
  ['  3     *        *        *     Превышен интервал ожидания для запроса.', { hop: 3, rtts: [null, null, null], address: undefined }],
  [' 4  gw (172.16.0.1)  0.512 ms  0.488 ms *', { hop: 4, rtts: [0.512, 0.488, null], name: 'gw', address: '172.16.0.1' }],
  [' 5  10.1.1.1  1.234 ms  1.100 ms  1.050 ms', { hop: 5, rtts: [1.234, 1.1, 1.05], address: '10.1.1.1' }],
  [' 6  * * *', { hop: 6, rtts: [null, null, null], address: undefined }],
  ['  7    12 ms    11 ms    10 ms  2001:db8::1', { hop: 7, rtts: [12, 11, 10], address: '2001:db8::1' }]
]
for (const [line, want] of hops) assert.deepEqual(parseHop(line), want, line)
for (const line of ['Трассировка маршрута к ya.ru [5.255.255.242]', 'Трассировка завершена.', '', 'over a maximum of 30 hops:', 'traceroute to 10.0.0.1 (10.0.0.1), 30 hops max, 60 byte packets'])
  assert.equal(parseHop(line), null, line)

assert.equal(parseTtl('Reply from 10.0.0.1: bytes=32 time=3ms TTL=128'), 128)
assert.equal(parseTtl('64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.045 ms'), 64)

assert.deepEqual(parsePorts('443, 22 80;22 8000-8002'), [22, 80, 443, 8000, 8001, 8002])
assert.throws(() => parsePorts('22,abc'), /abc/)
assert.throws(() => parsePorts('70000'), /диапазон/)
assert.throws(() => parsePorts('1-65535'), /4096/)

const r24 = parseRange('192.168.1.77/24')
assert.equal(r24.length, 254)
assert.equal(r24[0], '192.168.1.1')
assert.equal(r24.at(-1), '192.168.1.254')
assert.deepEqual(parseRange('10.0.0.10-12'), ['10.0.0.10', '10.0.0.11', '10.0.0.12'])
assert.deepEqual(parseRange('10.0.0.255-10.0.1.1'), ['10.0.0.255', '10.0.1.0', '10.0.1.1'])
assert.deepEqual(parseRange('10.0.0.5/32'), ['10.0.0.5'])
assert.deepEqual(parseRange('10.0.0.5'), ['10.0.0.5'])
assert.throws(() => parseRange('10.0.0.0/16'), /4096/)
assert.throws(() => parseRange('10.0.0.20-10'), /больше/)
assert.throws(() => parseRange('hello'), /подсеть/)
assert.equal(subnetOf('10.20.30.40'), '10.20.30.0/24')
assert.equal(subnetOf('core.local'), 'core.local')

console.log('net-tools: ok')
