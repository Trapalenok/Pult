// Map jitter check: status updates must not hide/re-measure nodes, and a dragged node must not jump back while it is saved.
// Usage: build, serve out/renderer on 127.0.0.1:5199 (python3 -m http.server), then
// PW=$(npm root -g)/playwright node test/e2e-jitter.cjs
// Renderer-only E2E: out/renderer served over http, window.api mocked with sample data.
const { chromium } = require(process.env.PW)
const OUT = process.argv[2], URL = 'http://127.0.0.1:5199/index.html'
const theme = process.argv[3] || 'oat'
const store = {
  secretIds: [],
  settings: { theme, animations: false },
  credentials: [{ id: 'c1', name: 'Админ сети', username: 'netadmin' }, { id: 'c2', name: 'Huawei legacy', username: 'root' }],
  folders: [
    { id: 'f1', parentId: null, name: 'Корпус А', kind: 'building', tint: 'orange', defaults: { credentialId: 'c1' } },
    { id: 'f2', parentId: 'f1', name: 'Серверная 1.04', kind: 'room', tint: 'blue', defaults: {} },
    { id: 'f3', parentId: null, name: 'Филиал Север', kind: 'building', tint: 'green', defaults: {} },
    { id: 'f4', parentId: 'f1', name: 'Стойка R2', kind: 'rack', tint: 'purple', defaults: {} }
  ],
  hosts: [
    { id: 'h1', folderId: null, name: 'core-sw-01', address: '10.0.0.1', icon: 'switch', tint: 'blue', overrides: {} },
    { id: 'h2', folderId: null, name: 'mikrotik-edge', address: '10.0.0.254', icon: 'router', tint: 'orange', overrides: { winbox: true } },
    { id: 'h3', folderId: null, name: 'srv-files', address: '10.0.1.20', icon: 'server', tint: 'teal', overrides: {} },
    { id: 'h4', folderId: null, name: 'nas-backup', address: '10.0.1.30', icon: 'storage', tint: 'purple', overrides: {} },
    { id: 'h5', folderId: null, name: 'huawei-s5720', address: '10.0.0.2', icon: 'switch', tint: 'red', overrides: { algoProfile: 'legacy' } },
    { id: 'h6', folderId: null, name: 'fw-usergate', address: '10.0.0.3', icon: 'firewall', tint: 'indigo', overrides: {} },
    { id: 'h7', folderId: 'f2', name: 'esxi-01', address: '10.0.2.11', icon: 'server', tint: 'green', overrides: {} },
    { id: 'h8', folderId: 'f2', name: 'esxi-02', address: '10.0.2.12', icon: 'server', tint: 'green', overrides: {} },
    { id: 'h9', folderId: 'f2', name: 'ups-apc', address: '10.0.2.50', icon: 'storage', tint: 'gray', overrides: {} },
    { id: 'h10', folderId: 'f2', name: 'cam-hall', address: '10.0.3.7', icon: 'camera', tint: 'pink', overrides: {} }
  ],
  maps: [{ id: 'm1', name: 'Ядро', nodes: [
    { id: 'n1', hostId: 'h2', x: 360, y: 40 }, { id: 'n2', hostId: 'h6', x: 360, y: 180 }, { id: 'n3', hostId: 'h1', x: 360, y: 320 },
    { id: 'n4', hostId: 'h3', x: 120, y: 470, zoneId: 'z1' }, { id: 'n5', hostId: 'h4', x: 360, y: 470, zoneId: 'z1' }, { id: 'n6', hostId: 'h5', x: 640, y: 470 },
    { id: 'n7', label: 'Провайдер', x: 680, y: 50 }],
    links: [{ id: 'l1', from: 'n1', to: 'n2', fromIf: 'ether1', toIf: 'port1' }, { id: 'l2', from: 'n2', to: 'n3' }, { id: 'l3', from: 'n3', to: 'n4', fromIf: 'GE0/0/1' },
      { id: 'l4', from: 'n3', to: 'n5' }, { id: 'l5', from: 'n3', to: 'n6', shape: 'step' }, { id: 'l6', from: 'n7', to: 'n1', label: '1 Гбит/с' }],
    zones: [{ id: 'z1', name: 'Серверная 1.04', shape: 'rect', tint: 'blue', x: 90, y: 420, w: 520, h: 150 }] }]
}
const hist = (rtt) => Array.from({ length: 30 }, (_, i) => (i === 21 && rtt > 3 ? null : rtt + (i % 5) * 0.4))
const status = store.hosts.map((h, i) => ({ hostId: h.id, alive: h.id !== 'h5', rtt: h.id === 'h5' ? undefined : 1 + i * 0.7, history: h.id === 'h5' ? Array(30).fill(null) : hist(1 + i * 0.7), checkedAt: Date.now(),
  snmp: ['h1', 'h7'].includes(h.id) ? { ok: true, temp: h.id === 'h1' ? 43 : 58, uptime: 86400 * 41 } : undefined }))
const TERM = (name) => `\x1b[38;2;143;179;217mLinux ${name} 6.1.0-28-amd64\x1b[0m\r\n\r\nLast login: Mon Oct 12 08:14:03 2026 from 10.0.0.50\r\n` +
  `\x1b[1;38;2;232;167;124mnetadmin@${name}\x1b[0m:\x1b[38;2;143;179;217m~\x1b[0m$ uptime\r\n 08:15:22 up 41 days,  3:02,  1 user,  load average: 0.08, 0.11, 0.09\r\n` +
  `\x1b[1;38;2;232;167;124mnetadmin@${name}\x1b[0m:\x1b[38;2;143;179;217m~\x1b[0m$ ip -br a\r\nlo               \x1b[32mUNKNOWN\x1b[0m        127.0.0.1/8\r\nens192           \x1b[32mUP\x1b[0m             10.0.2.11/24\r\nens224           \x1b[31mDOWN\x1b[0m\r\n` +
  `\x1b[1;38;2;232;167;124mnetadmin@${name}\x1b[0m:\x1b[38;2;143;179;217m~\x1b[0m$ `
;(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
  const page = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
  await page.addInitScript(({ store, status }) => {
    const subs = {}
    const on = (ch) => (cb) => ((subs[ch] ||= []).push(cb), () => {})
    const emit = (ch, ...a) => (subs[ch] || []).forEach((cb) => cb(...a))
    window.platform = 'win32'
    window.__emit = emit
    window.api = {
      // The real save goes through IPC and disk: answer late.
      loadStore: async () => store, saveStore: (s) => new Promise((r) => setTimeout(() => r(JSON.parse(JSON.stringify(Object.assign(store, s)))), 400)), setSecret: async () => store,
      connect: async () => ({}), scrollback: async () => ({ data: '', end: 0 }), onHostKeyPrompt: on('hk'), answerHostKey() {}, write() {}, broadcast() {}, resize() {}, close() {}, popout() {},
      setTheme() {}, setChrome() {}, monitorAll: async () => status, monitorProbe() {}, onMonitor: on('mon'),
      openInBrowser: async () => {}, openWinbox: async () => {}, onData: on('ssh:data'), onClosed: on('closed'), onReturned: on('ret'),
      toolStart() {}, toolStop() {}, onToolEvent: on('tool'), dnsQuery: async () => ({ answers: [] }),
      exportConfig: async () => null, importPick: async () => null, importApply: async () => store, foreignPick: async () => null
    }
    // A monitor storm: one host's fresh status every 30 ms, rtt and history always changing.
    let k = 0
    setInterval(() => { const s = status[k++ % status.length]; window.__emit('mon', [{ ...s, rtt: Math.random() * 20, history: [...s.history.slice(1), Math.random() * 20], checkedAt: Date.now() }]) }, 30)
  }, { store, status })
  await page.goto(URL); await page.waitForTimeout(1000)
  await page.locator('.nav-item', { hasText: 'Карта сети' }).first().click(); await page.waitForTimeout(1000)
  const r = await page.evaluate(() => new Promise((done) => {
    let hidden = 0, recreated = 0
    const nodes = () => [...document.querySelectorAll('.react-flow__node')]
    const start = new Set(nodes())
    const mo = new MutationObserver((ms) => ms.forEach((m) => {
      if (m.type === 'attributes' && m.target.classList?.contains('react-flow__node') && m.target.style.visibility === 'hidden') hidden++
      if (m.type === 'childList') m.addedNodes.forEach((n) => n.classList?.contains('react-flow__node') && recreated++)
    }))
    mo.observe(document.querySelector('.react-flow'), { subtree: true, attributes: true, attributeFilter: ['style'], childList: true })
    setTimeout(() => { mo.disconnect(); done({ count: start.size, hidden, recreated, same: nodes().every((n) => start.has(n)) }) }, 3000)
  }))
  console.log('idle 3s under status storm:', JSON.stringify(r))
  // Drag huawei-s5720 by 200 px right and watch where it is for a second after release.
  const node = page.locator('.react-flow__node', { hasText: 'huawei-s5720' })
  const bb = await node.boundingBox()
  await page.mouse.move(bb.x + 40, bb.y + 20); await page.mouse.down()
  const track = []
  for (let i = 1; i <= 20; i++) { await page.mouse.move(bb.x + 40 + i * 10, bb.y + 20); await page.waitForTimeout(25); track.push(Math.round((await node.boundingBox()).x - bb.x)) }
  await page.mouse.up()
  for (let i = 0; i < 25; i++) { await page.waitForTimeout(40); track.push(Math.round((await node.boundingBox()).x - bb.x)) }
  console.log('x offset while dragging, then after release:', track.join(' '))
  const back = track.slice(20).filter((x) => x < 190).length
  console.log('samples after release where the node jumped back:', back)
  console.log('saved x:', await page.evaluate(() => 0) , JSON.stringify(errs.slice(0, 5)))
  await b.close()
})()
