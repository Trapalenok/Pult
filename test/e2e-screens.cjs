// Usage: build, serve out/renderer on 127.0.0.1:5199 (python3 -m http.server), then
// PW=$(npm root -g)/playwright node test/e2e-screens.cjs docs/screens-shellwise <oat|mist|cocoa|midnight|moss|dusk>
// Ferrum: node test/e2e-screens.cjs docs/screens-ferrum <graphite|carbon|blueprint|steel> ferrum
// Renderer-only E2E: out/renderer served over http, window.api mocked with sample data.
const { chromium } = require(process.env.PW)
const OUT = process.argv[2], URL = 'http://127.0.0.1:5199/index.html'
const theme = process.argv[3] || 'oat'
const store = {
  secretIds: [],
  settings: { theme, design: process.argv[4], animations: false },
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
  await page.exposeFunction('__scheme', async (s) => page.emulateMedia({ colorScheme: s === 'system' ? 'light' : s }))
  await page.addInitScript(({ store, status, TERM: termSrc }) => {
    const TERM = eval(termSrc)
    const subs = {}; let n = 0; const names = {}
    const on = (ch) => (cb) => ((subs[ch] ||= []).push(cb), () => {})
    const emit = (ch, ...a) => (subs[ch] || []).forEach((cb) => cb(...a))
    window.platform = 'win32'
    window.api = {
      loadStore: async () => store, saveStore: async (s) => Object.assign(store, s), setSecret: async () => store,
      connect: async (hostId) => { const id = 's' + ++n; const h = store.hosts.find((x) => x.id === hostId); names[id] = h.name
        setTimeout(() => emit('ssh:data', id, TERM(h.name), TERM(h.name).length), 300); return { sessionId: id, hostId, title: h.name } },
      scrollback: async () => ({ data: '', end: 0 }), onStoreChanged: on('store'), onHostKeyPrompt: on('hk'), onHostKeyCancel: on('hkc'), answerHostKey() {}, write() {}, broadcast() {}, resize() {}, close() {}, popout() {},
      setTheme: (s) => window.__scheme(s), setChrome() {}, monitorAll: async () => status, monitorProbe() {}, onMonitor: on('mon'),
      openInBrowser: async () => {}, openWinbox: async () => {}, onData: on('ssh:data'), onClosed: on('closed'), onReturned: on('ret'),
      toolStart() {}, toolStop() {}, onToolEvent: on('tool'), dnsQuery: async () => ({ answers: [] }),
      exportConfig: async () => null, importPick: async () => null, importApply: async () => store, foreignPick: async () => null
    }
  }, { store, status, TERM: TERM.toString() })
  await page.goto(URL); await page.waitForTimeout(1200)
  const shot = async (name) => { await page.waitForTimeout(500); await page.screenshot({ path: `${OUT}/${theme}-${name}.png` }) }
  const nav = (label) => page.locator('.nav-item', { hasText: label }).first().click()
  await shot('1-hosts')
  await page.locator('.crumbs, .card', { hasText: 'Корпус А' }).last().click(); await page.waitForTimeout(300)
  await page.locator('.card', { hasText: 'Серверная 1.04' }).first().click(); await shot('2-folder')
  await page.getByRole('button', { name: /Подключить/ }).first().click(); await page.waitForTimeout(1500); await shot('3-grid')
  await nav('Карта сети'); await page.waitForTimeout(800); await shot('4-map')
  await nav('Инструменты'); await shot('5-tools')
  await nav('Учётные данные'); await shot('6-credentials')
  await page.locator('.nav-item', { hasText: 'Настройки' }).click(); await shot('7-settings')
  await nav('Хосты'); await page.getByRole('button', { name: 'Хост', exact: true }).first().click(); await shot('8-host-sheet')
  console.log(JSON.stringify(errs.slice(0, 10)))
  await b.close()
})()
