// node --experimental-strip-types test/addresses.mjs
// A host with several addresses: the next one is tried only when the one before did not answer.
import assert from 'node:assert/strict'
import { openFirstReachable, unreachable } from '../src/main/ssh/addresses.ts'

const fails = (msg, code) => Object.assign(new Error(msg), code ? { code } : {})
const run = (outcomes) => {
  const tried = []
  return openFirstReachable(Object.keys(outcomes), async (a) => {
    tried.push(a)
    const o = outcomes[a]
    if (o instanceof Error) throw o
    return `s@${a}`
  }).then((r) => ({ ...r, tried }), (e) => ({ error: e.message, tried }))
}

let r = await run({ '10.0.0.1': fails('Хост не отвечает (таймаут).'), '10.1.0.1': 'ok', '10.2.0.1': 'ok' })
assert.deepEqual(r, { result: 's@10.1.0.1', address: '10.1.0.1', tried: ['10.0.0.1', '10.1.0.1'] })

r = await run({ '10.0.0.1': fails('Неверный логин или пароль.'), '10.1.0.1': 'ok' })
assert.deepEqual(r, { error: 'Неверный логин или пароль.', tried: ['10.0.0.1'] }, 'a wrong password is not retried at another address')

r = await run({ '10.0.0.1': fails('Порт закрыт: SSH на хосте не отвечает.'), '10.1.0.1': fails('x', 'EHOSTUNREACH'), '10.2.0.1': fails('Хост недоступен по сети.') })
assert.equal(r.tried.length, 3)
assert.match(r.error, /^10\.0\.0\.1: Порт закрыт.*\n10\.1\.0\.1: x\n10\.2\.0\.1: Хост недоступен/s)

r = await run({ '10.0.0.1': fails('(SSH) Channel open failure: Connection refused'), '10.1.0.1': 'ok' })
assert.equal(r.address, '10.1.0.1', 'refused through the jump host counts as not answering')

r = await run({ '10.0.0.1': 'ok' })
assert.equal(r.address, '10.0.0.1')
assert.equal(unreachable(fails('Подключение отменено: ключ хоста не подтверждён.')), false)
console.log('addresses: ok')
