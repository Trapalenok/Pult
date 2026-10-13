// node --experimental-strip-types test/ping-parse.mjs
// Windows prints ping output in the console code page (cp866 for Russian); ping.ts reads it as latin1.
import assert from 'node:assert/strict'
import { parseRtt } from '../src/main/monitor/ping.ts'

const RU = 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмноп'
const RU2 = 'рстуфхцчшщъыьэюя'
const cp866 = (s) =>
  Buffer.from([...s].map((ch) => (RU.includes(ch) ? 0x80 + RU.indexOf(ch) : RU2.includes(ch) ? 0xe0 + RU2.indexOf(ch) : ch.charCodeAt(0)))).toString('latin1')

const cases = [
  [cp866('Ответ от 192.168.1.1: число байт=32 время=12мс TTL=64'), 12],
  [cp866('Ответ от 192.168.1.1: число байт=32 время<1мс TTL=255'), 0.5],
  [cp866('Превышен интервал ожидания для запроса.'), null],
  [cp866('Ответ от 192.168.1.5: Заданный узел недоступен.'), null],
  ['Reply from 10.0.0.1: bytes=32 time=3ms TTL=128', 3],
  ['Reply from 10.0.0.1: bytes=32 time<1ms TTL=128', 0.5],
  ['64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.045 ms', 0.045]
]
for (const [out, want] of cases) assert.equal(parseRtt(out), want, out)
console.log(`ping parsing: ${cases.length} cases ok`)
