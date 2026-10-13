// DSA host keys (old Huawei VRP) in Electron, whose BoringSSL has no DSA: npm run test:dsa.
// Signatures are made with Node's OpenSSL (keys.json from plain node) and checked by the shim
// under Electron's Node, where crypto.verify would otherwise throw UNSUPPORTED_ALGORITHM.
import { readFileSync } from 'fs'
import crypto from 'crypto'
import '../src/main/ssh/dsa-verify.ts'

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/dsa-signatures.json', import.meta.url)))
let failed = 0
const check = (name, got, want) => {
  const ok = got === want
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}`)
}
for (const f of fixtures) {
  const data = Buffer.from(f.data, 'hex')
  const sig = Buffer.from(f.sig, 'hex')
  check(`${f.bits}-bit ${f.hash}, valid`, crypto.verify(f.hash, data, f.publicKey, sig), true)
  const bad = Buffer.from(data)
  bad[0] ^= 1
  check(`${f.bits}-bit ${f.hash}, other data`, crypto.verify(f.hash, bad, f.publicKey, sig), false)
}
// RSA still goes through the native code path.
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 })
const rsaSig = crypto.sign('sha1', Buffer.from('x'), rsa.privateKey)
check('RSA native path', crypto.verify('sha1', Buffer.from('x'), rsa.publicKey.export({ type: 'spki', format: 'pem' }), rsaSig), true)
process.exit(failed ? 1 : 0)
