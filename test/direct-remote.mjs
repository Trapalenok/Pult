import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { rdpDestination, rdpUser, rdpFile } = require('../out/test/main/integrations/mstsc.cjs')
const { VncChannel } = require('../out/test/renderer/src/VncChannel.cjs')

assert.equal(rdpDestination('server.example', 3389), 'server.example')
assert.equal(rdpDestination('2001:db8::1', 3390), '[2001:db8::1]:3390')
assert.equal(rdpUser('admin', 'DOMAIN'), 'DOMAIN\\admin')
assert.equal(rdpUser('OTHER\\admin', 'DOMAIN'), 'OTHER\\admin')
assert.throws(() => rdpDestination('server\r\npassword:s:secret', 3389))
const rdpText = rdpFile('server.example', 'DOMAIN\\admin').subarray(2).toString('utf16le')
assert.match(rdpText, /full address:s:server\.example\r\nusername:s:DOMAIN\\admin/)
assert.doesNotMatch(rdpText, /password:s:/)

let dataHandler
let closeHandler
const sent = []
globalThis.window = { api: {
  onVncData: (cb) => (dataHandler = cb, () => {}),
  onVncClosed: (cb) => (closeHandler = cb, () => {}),
  vncStart: async () => 'session',
  vncReady: (id) => sent.push(['ready', id]),
  vncSend: (id, bytes) => sent.push(['send', id, Buffer.from(bytes).toString()]),
  vncClose: (id) => sent.push(['close', id])
} }
const channel = new VncChannel()
let opened = false
let received = ''
channel.onopen = () => { opened = true }
channel.onmessage = (event) => { received = Buffer.from(event.data).toString() }
await channel.connect()
assert.equal(opened, true)
channel.send(new TextEncoder().encode('input').buffer)
dataHandler('session', Buffer.from('screen'))
assert.equal(received, 'screen')
assert.deepEqual(sent[0], ['ready', 'session'])
closeHandler('session')
assert.equal(channel.readyState, 3)
console.log('RDP launch settings and VNC IPC channel: OK')
