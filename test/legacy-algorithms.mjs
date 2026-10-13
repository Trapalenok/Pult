// Run with Electron's Node (npm run test:legacy): Electron's BoringSSL differs from Node's OpenSSL.
import '../src/main/ssh/dh-groups.ts'
const { default: ssh2 } = await import('ssh2')
import { algorithmsFor } from '../src/main/ssh/algorithms.ts'
const { Server, Client, utils } = ssh2
const hostKey = utils.generateKeyPairSync('rsa', { bits: 2048 }).private
// Emulates an old Huawei VRP: ssh-rsa host key, SHA-1 DH, CBC, hmac-sha1 only.
const server = new Server({ hostKeys: [hostKey], algorithms: {
  kex: ['diffie-hellman-group1-sha1'], serverHostKey: ['ssh-rsa'], cipher: ['aes128-cbc'], hmac: ['hmac-sha1'] } },
  (c) => { c.on('authentication', (ctx) => ctx.method === 'password' && ctx.password === 'pw' ? ctx.accept() : ctx.reject(['password']))
           c.on('error', () => {}) })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const tryProfile = (p) => new Promise((res) => {
  const cl = new Client()
  cl.on('ready', () => { cl.end(); res('OK') }).on('error', (e) => res('FAIL: ' + e.message))
  cl.connect({ host: '127.0.0.1', port, username: 'admin', password: 'pw', algorithms: algorithmsFor(p) })
})
for (const p of ['modern', 'compat', 'legacy']) console.log(p, '->', await tryProfile(p))
server.close()
