// Folders, drag and drop, workspaces, group tabs. Usage as e2e-screens.cjs:
// PW=$(npm root -g)/playwright node test/e2e-workspace.cjs <screenshot dir> [theme]
// Renderer-only: out/renderer served over http on 127.0.0.1:5199, window.api mocked; saves are checked on the mock store.
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
    { id: 'f4', parentId: 'f1', name: 'Стойка R2', kind: 'rack', tint: 'purple', defaults: {} },
    { id: 'f5', parentId: 'f2', name: 'Кросс 1', kind: 'cross', tint: 'blue', defaults: {} },
    { id: 'f6', parentId: 'f5', name: 'Полка 3', kind: 'folder', tint: 'blue', defaults: { port: 2222 } }
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
    { id: 'h10', folderId: 'f2', name: 'cam-hall', address: '10.0.3.7', icon: 'camera', tint: 'pink', overrides: {} },
    { id: 'h11', folderId: 'f6', name: 'HW5720 - 52.46', address: '10.0.52.46', icon: 'switch', overrides: { username: 'old', port: 22, algoProfile: 'legacy' } }
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

const assert = (cond, msg) => { if (!cond) { console.log('FAIL ' + msg); process.exitCode = 1 } else console.log('ok   ' + msg) }
;(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
  const page = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
  page.on('dialog', (d) => d.accept())
  await page.exposeFunction('__scheme', async (s) => page.emulateMedia({ colorScheme: s === 'system' ? 'light' : s }))
  await page.addInitScript(({ store, status, TERM: termSrc }) => {
    const TERM = eval(termSrc)
    const subs = {}; let n = 0
    const on = (ch) => (cb) => ((subs[ch] ||= []).push(cb), () => {})
    const emit = (ch, ...a) => (subs[ch] || []).forEach((cb) => cb(...a))
    window.__store = store; window.__broadcasts = []; window.__secrets = []
    window.platform = 'win32'
    window.api = {
      loadStore: async () => store, saveStore: async (s) => (Object.assign(store, JSON.parse(JSON.stringify(s))), store),
      setSecret: async (id, v) => (window.__secrets.push([id, v]), store),
      connect: async (hostId) => { const id = 's' + ++n; const h = store.hosts.find((x) => x.id === hostId)
        await new Promise((r) => setTimeout(r, 150 + Math.random() * 300))
        if (h.name === 'cam-hall') throw new Error("Error invoking remote method 'ssh:connect': Error: Хост не отвечает (таймаут).")
        setTimeout(() => emit('ssh:data', id, TERM(h.name), TERM(h.name).length), 100); return { sessionId: id, hostId, title: h.name } },
      scrollback: async () => ({ data: '', end: 0 }), onHostKeyPrompt: on('hk'), answerHostKey() {}, write() {}, broadcast: (ids, d) => window.__broadcasts.push([ids, d]), resize() {}, close() {}, popout() {},
      setTheme: (s) => window.__scheme(s), setChrome() {}, monitorAll: async () => status, monitorProbe() {}, onMonitor: on('mon'),
      openInBrowser: async () => {}, openWinbox: async () => {}, onData: on('ssh:data'), onClosed: on('closed'), onReturned: on('ret'),
      toolStart() {}, toolStop() {}, onToolEvent: on('tool'), dnsQuery: async () => ({ answers: [] }),
      exportConfig: async () => null, importPick: async () => null, importApply: async () => store, foreignPick: async () => null
    }
  }, { store, status, TERM: TERM.toString() })
  await page.goto(URL); await page.waitForTimeout(1200)
  const S = () => page.evaluate(() => window.__store)
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: `${OUT}/${theme}-${name}.png` }) }
  const card = (t) => page.locator('.card', { hasText: t }).first()

  // 1. A host deep inside with its own settings shows it, and the top folder can make everything inside inherit.
  await card('Корпус А').click(); await card('Серверная 1.04').click(); await card('Кросс 1').click(); await card('Полка 3').click()
  assert(await card('HW5720').locator('.ds-badge', { hasText: 'свои настройки' }).count() === 1, 'host with own settings is marked')
  await shot('w1-own-settings')
  await page.locator('.crumbs button', { hasText: 'Корпус А' }).click()
  await page.getByRole('button', { name: 'Изменить папку' }).click()
  await page.getByText('Всё внутри берёт настройки папок').first().waitFor()
  await page.getByRole('switch', { name: 'Всё внутри берёт настройки папок' }).click()
  await shot('w2-folder-apply-inside')
  await page.locator('.ds-sheet__bar button', { hasText: 'Готово' }).click(); await page.waitForTimeout(400)
  let st = await S()
  const hw = st.hosts.find((h) => h.id === 'h11'), shelf = st.folders.find((f) => f.id === 'f6')
  assert(JSON.stringify(hw.overrides) === '{}', `deep host inherits again: ${JSON.stringify(hw.overrides)}`)
  assert(shelf.defaults.port === undefined, 'subfolder port dropped')
  assert(st.folders.find((f) => f.id === 'f1').defaults.credentialId === 'c1', 'folder keeps its own login')

  // 2. Drag a host card onto a folder card, and a folder onto the sidebar tree.
  await page.locator('.crumbs button', { hasText: 'Хосты' }).click(); await page.waitForTimeout(300)
  await card('srv-files').dragTo(card('Филиал Север')); await page.waitForTimeout(300)
  st = await S()
  assert(st.hosts.find((h) => h.id === 'h3').folderId === 'f3', 'host dragged into a folder')
  await card('Филиал Север').dragTo(page.locator('.tree-item', { hasText: 'Корпус А' }).first()); await page.waitForTimeout(300)
  st = await S()
  assert(st.folders.find((f) => f.id === 'f3').parentId === 'f1', 'folder dragged into a sidebar folder')
  await page.locator('.crumbs button', { hasText: 'Хосты' }).click(); await card('Корпус А').click(); await page.waitForTimeout(200)
  await card('Филиал Север').dragTo(page.locator('.crumbs button', { hasText: 'Хосты' })); await page.waitForTimeout(300)
  st = await S()
  assert(st.folders.find((f) => f.id === 'f3').parentId === null, 'folder dragged back to the top via breadcrumbs')
  await card('Корпус А').dragTo(page.locator('.tree-item', { hasText: 'Серверная 1.04' }).first()).catch(() => {})
  st = await S()
  assert(st.folders.find((f) => f.id === 'f1').parentId === null, 'folder cannot go inside itself')

  // 3. Workspace from picked hosts, opened as one tab.
  await page.locator('.crumbs button', { hasText: 'Хосты' }).click(); await page.waitForTimeout(300)
  for (const h of ['core-sw-01', 'huawei-s5720', 'fw-usergate']) await card(h).click({ modifiers: ['Control'] })
  await page.getByRole('button', { name: 'В Workspace' }).click()
  await page.locator('.ds-sheet input').first().fill('Ядро')
  await shot('w3-workspace-sheet')
  await page.locator('.ds-sheet__bar button', { hasText: 'Создать' }).click(); await page.waitForTimeout(300)
  st = await S()
  assert(st.workspaces?.length === 1 && st.workspaces[0].hostIds.length === 3, 'workspace saved with 3 hosts')
  await page.locator('.ws-row .nav-item', { hasText: 'Ядро' }).click(); await page.waitForTimeout(1200)
  assert(await page.locator('.tab--group', { hasText: 'Ядро' }).count() === 1, 'workspace opens as one tab')
  assert(await page.locator('.pane:visible').count() === 3, 'workspace shows its 3 terminals in a grid')
  await shot('w4-workspace-open')

  // 4. A folder opens as one more tab; its failure is reported once; broadcast stays on screen.
  await page.locator('.nav-item', { hasText: 'Хосты' }).first().click(); await card('Корпус А').click(); await card('Серверная 1.04').click()
  await page.getByRole('button', { name: /Подключиться ко всем/ }).first().click(); await page.waitForTimeout(1500)
  assert(await page.locator('.tab--group').count() === 2, 'folder opens as a second group tab')
  assert(await page.locator('.pane:visible').count() === 4, 'folder tab shows its 4 live terminals (one host is down)')
  assert(await page.locator('.ds-banner', { hasText: 'не подключились 1 из 5' }).count() === 1, 'one combined error for the folder')
  await shot('w5-two-groups')
  await page.locator('.broadcast__input').fill('display version'); await page.keyboard.press('Enter')
  const bc = await page.evaluate(() => window.__broadcasts.at(-1))
  assert(bc && bc[0].length === 4, `broadcast goes only to the 4 sessions on screen (${bc && bc[0].length})`)
  await page.locator('.tab--group', { hasText: 'Ядро' }).locator('.tab__close').click(); await page.waitForTimeout(300)
  assert(await page.locator('.tab--group').count() === 1, 'closing a group tab closes it')
  console.log('errors', JSON.stringify(errs.slice(0, 10)))
  await b.close()
})()
