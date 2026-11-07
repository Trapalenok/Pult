import { app, BrowserWindow, ipcMain, nativeTheme, type BrowserWindowConstructorOptions, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { writeFileSync } from 'fs'
import { effectiveSettings, renderUrl, resolveLogin, usesJump, snmpCommunityOwner } from '@shared/inherit'
import { hostAddresses, JUMP_DEFAULT_PORT, snmpSecretId } from '@shared/types'
import { collectLldp } from './lldp/snmp'
import { AutomaticLldp } from './lldp/automatic'
import type { EffectiveSettings, Host, HostKeyPrompt, HostStatus, ForeignOptions, ImportMode, SessionInfo, Store } from '@shared/types'
import { SessionManager, type Pair } from './ssh/session-manager'
import { openWithKexRetry } from './ssh/kex-retry'
import { openFirstReachable } from './ssh/addresses'
import { fingerprint, keyType } from './ssh/host-key'
import { JumpHost, type JumpLogin } from './ssh/jump'
import { OpenQueue } from './ssh/open-queue'
import { tcpConnect } from './ssh/tcp'
import { getKnownKeys, getSecret, loadStore, saveStore, saveAutomaticLldp, setSecret, trustHost } from './store/json-store'
import { exportConfig, importApply, importPick } from './store/transfer'
import { foreignApply, foreignPick, foreignPlan } from './store/foreign'
import { loadBackground, pickBackground, pruneBackgrounds } from './store/backgrounds'
import { openInBrowser } from './integrations/browser'
import { launchWinbox } from './integrations/winbox'
import { Monitor } from './monitor/monitor'
import { dnsQuery, Tools } from './tools/tools'
import { isSplash, showSplash } from './splash'
import type { ToolEvent, ToolKind, ToolParams } from '@shared/tools'

// The app was called "SSH Client" before Pult. Keep its data folder (%APPDATA%\ssh-client: hosts, passwords,
// and the key that decrypts them) whatever the product name is, so the rename loses nothing.
app.setPath('userData', join(app.getPath('appData'), 'ssh-client'))
// package.json "name" is still ssh-client; this is what Windows shows for the app (taskbar, notifications).
app.setName('Pult')
// Same id electron-builder gives the Start menu shortcut, so Windows ties notifications to the Pult icon.
if (process.platform === 'win32') app.setAppUserModelId('local.sshclient')

let mainWin: BrowserWindow | null = null
/** sessionId → its own window, for sessions popped out of the main one. */
const popouts = new Map<string, BrowserWindow>()

/** Pult's own windows (main and popped-out sessions), not the start-up logo window. */
const allWindows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && !isSplash(w))
const sendAll = (channel: string, ...args: unknown[]) => allWindows().forEach((w) => w.webContents.send(channel, ...args))

const sessions = new SessionManager({
  data: (id, data, end) => sendAll('ssh:data', id, data, end),
  closed: (id, reason) => sendAll('ssh:closed', id, reason)
})

const jump = new JumpHost()
/**
 * A pack of hosts (map sheet, folder) opens a few at a time: see open-queue.ts. Through the jump host or proxy
 * 3 at a time (it drops extra handshakes); straight to the switches more, each switch only sees its own session.
 */
const jumpQueue = new OpenQueue()
const directQueue = new OpenQueue(8)

const toolWindows = new WeakSet<WebContents>()
const lldpRequests = new Map<string, { owner: WebContents; controller: AbortController }>()

/** Port checks "с jump-host" ask for the jump host's key in the main window. */
const tools = new Tools(() => {
  const j = jumpLogin()
  const asker = mainWin?.webContents
  return j && asker ? (address, port) => jump.forward(j, jumpVerifier(asker, j), address, port) : undefined
})

const monitor = new Monitor(
  loadStore,
  getSecret,
  (changed: HostStatus[]) => sendAll('monitor:update', changed),
  (host, s) => {
    if (!loadStore().settings?.jump?.pingVia) return undefined
    const j = jumpFor(host, s)
    const asker = mainWin?.webContents
    if (!j || !asker) return undefined
    return {
      open: (address, port) => jump.forward(j, jumpVerifier(asker, j), address, port),
      label: j.kind === 'socks5' ? 'через SOCKS5-прокси' : 'через jump-host'
    }
  },
  // While a pack of sessions is opening through the jump host, monitoring keeps out of its way.
  () => jumpQueue.busy
)

function hostById(id: string): Host {
  const host = loadStore().hosts.find((h) => h.id === id)
  if (!host) throw new Error(`Хост не найден: ${id}`)
  return host
}

const automaticLldp = new AutomaticLldp({
  store: loadStore,
  secret: getSecret,
  collect: collectLldp,
  save: (hostId, snapshot) => sendAll('store:changed', saveAutomaticLldp(hostId, snapshot)),
  emit: (status) => sendAll('lldp:auto-status', status)
})
app.on('before-quit', () => automaticLldp.stop())

/** Title bar colours; the renderer sends the active theme's --bg-chrome / --label-1. */
let chrome = { color: '#1e1a17', symbolColor: '#f1e7dc', height: 48 }

function windowOptions(extra: BrowserWindowConstructorOptions): BrowserWindowConstructorOptions {
  return {
    backgroundColor: chrome.color,
    titleBarStyle: 'hidden',
    titleBarOverlay: chrome,
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    ...extra
  }
}

function load(win: BrowserWindow, query: Record<string, string> = {}): void {
  // Nothing but our own UI ever loads in these windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  const qs = new URLSearchParams(query).toString()
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${qs}`)
  else win.loadFile(join(__dirname, '../renderer/index.html'), { search: qs })
}

/** Called once the main window's UI has loaded the base and is ready to be seen. */
let onMainReady: (() => void) | undefined

/** withSplash: at start, the window stays hidden behind the logo window until its UI is ready. */
function createMainWindow(withSplash = false): void {
  mainWin = new BrowserWindow(windowOptions({ width: 1360, height: 860, minWidth: 900, minHeight: 560, title: 'Pult', show: !withSplash }))
  // While hidden behind the splash Chromium would throttle its timers and slow the start; normal again once shown.
  if (withSplash) {
    mainWin.webContents.setBackgroundThrottling(false)
    mainWin.once('show', () => mainWin?.webContents.setBackgroundThrottling(true))
  }
  if (withSplash) showSplash(mainWin, (cb) => (onMainReady = cb))
  load(mainWin)
  mainWin.on('closed', () => {
    mainWin = null
    // The main window owns the app; detached sessions go with it.
    for (const w of popouts.values()) w.destroy()
  })
}

function popout(s: SessionInfo): void {
  const existing = popouts.get(s.sessionId)
  if (existing) return existing.focus()
  const win = new BrowserWindow(windowOptions({ width: 900, height: 600, minWidth: 420, minHeight: 260, title: s.title }))
  popouts.set(s.sessionId, win)
  load(win, { session: s.sessionId, host: s.hostId, title: s.title, ...(s.address ? { address: s.address } : {}) })
  win.on('closed', () => {
    popouts.delete(s.sessionId)
    if (sessions.has(s.sessionId)) mainWin?.webContents.send('session:returned', s)
    else sessions.forget(s.sessionId)
  })
}

/* ── Host key confirmation ─────────────────────────────────── */

const pendingKeys = new Map<string, (accept: boolean) => void>()

/** Debug lines of a failed handshake → userData\ssh-debug.txt (one file, overwritten). Only algorithm lists and idents. */
function saveHandshakeLog(host: Host, lines: string[]): string | undefined {
  if (!lines.length) return undefined
  const file = join(app.getPath('userData'), 'ssh-debug.txt')
  try {
    writeFileSync(file, [`${new Date().toISOString()} ${host.name} ${host.address}`, ...lines, ''].join('\r\n'))
    return file
  } catch {
    return undefined
  }
}

/**
 * Known key: go on silently. New key: ask. Changed key: ask with a warning; the default
 * button in the dialog is "cancel". Nothing is remembered unless the user accepts.
 * Keys are kept per type, like OpenSSH: a switch with DSA and RSA keys offers DSA under the
 * "Старые" profile and RSA under the others, and that is a new key to confirm, not a changed one.
 */
function verifyHostKey(asker: WebContents, host: Host, port: number, blob: Buffer, asked?: string[]): Promise<boolean> {
  const fp = fingerprint(blob)
  const type = keyType(blob)
  const known = getKnownKeys(host.address, port)
  if (known.some((k) => k.fingerprint === fp)) return Promise.resolve(true)
  const previous = known.find((k) => k.keyType === type)
  const prompt: HostKeyPrompt = {
    requestId: randomUUID(),
    hostName: host.name,
    address: host.address,
    port,
    keyType: type,
    fingerprint: fp,
    previous,
    otherTypes: previous ? undefined : known.map((k) => k.keyType)
  }
  return new Promise((resolve) => {
    asked?.push(prompt.requestId)
    pendingKeys.set(prompt.requestId, (accept) => {
      if (accept) trustHost(host.address, port, { keyType: type, fingerprint: fp })
      resolve(accept)
    })
    if (asker.isDestroyed()) return resolve(false)
    asker.send('hostkey:ask', prompt)
  })
}

/** Questions about host keys of a connection that already gave up (timeout, closed) leave the window. */
function dropKeyQuestions(asker: WebContents, ids: string[]): void {
  for (const id of ids) {
    const answer = pendingKeys.get(id)
    if (!answer) continue
    pendingKeys.delete(id)
    answer(false)
    if (!asker.isDestroyed()) asker.send('hostkey:cancel', id)
  }
}

/**
 * A login typed in a session's terminal becomes the host's own (username + password on the host itself, in
 * place of a saved account it had), and every window gets the new base so its next save does not undo it.
 */
function rememberLogin(hostId: string, username: string, password: string): void {
  const { secretIds: _s, ...store } = loadStore()
  const host = store.hosts.find((h) => h.id === hostId)
  if (!host) throw new Error('хост удалён')
  host.overrides = { ...host.overrides, username, credentialId: undefined }
  saveStore(store)
  sendAll('store:changed', setSecret(host.id, password))
}

/** Jump host login for this host, or undefined when it connects directly. */
function jumpFor(host: Host, s: EffectiveSettings): JumpLogin | undefined {
  const store = loadStore()
  return usesJump(store.settings, s, host) ? jumpLogin() : undefined
}

/** The jump host from Settings, when it is set up and turned on. */
function jumpLogin(): JumpLogin | undefined {
  const store = loadStore()
  const j = store.settings?.jump
  if (!j?.enabled || !j.address) return undefined
  const cred = store.credentials.find((c) => c.id === j.credentialId)
  const kind = j.kind ?? 'ssh'
  return {
    kind,
    address: j.address,
    port: j.port ?? JUMP_DEFAULT_PORT[kind],
    username: cred?.username,
    password: cred ? getSecret(cred.id) : undefined,
    algoProfile: j.algoProfile ?? 'compat'
  }
}

const jumpVerifier = (asker: WebContents, j: JumpLogin) => (blob: Buffer) =>
  verifyHostKey(asker, { id: 'jump', folderId: null, name: 'Jump-host (мастер-кей)', address: j.address, overrides: {} }, j.port, blob)

/** host:port reachable from this PC: itself, or a local tunnel through the jump host. */
async function reach(asker: WebContents, host: Host, s: EffectiveSettings, address: string, port: number): Promise<{ address: string; port: number }> {
  const j = jumpFor(host, s)
  if (!j) return { address, port }
  return { address: '127.0.0.1', port: await jump.tunnel(j, jumpVerifier(asker, j), address, port) }
}

/** The host as seen at one of its addresses: the one asked for, else the one monitoring saw answer. */
function pickAddress(host: Host, address?: string): Host {
  const all = hostAddresses(host)
  const a = address && all.includes(address) ? address : monitor.addressOrder(host)[0]
  return a ? { ...host, address: a } : host
}

function registerIpc(): void {
  ipcMain.handle('lldp:auto-status', () => automaticLldp.all())
  ipcMain.handle('store:load', () => loadStore())
  ipcMain.handle('store:save', (_e, next: Store) => {
    const saved = saveStore(next)
    automaticLldp.refresh()
    return saved
  })
  ipcMain.handle('lldp:read', async (e, hostId: string, requestId: string) => {
    if (typeof hostId !== 'string' || typeof requestId !== 'string' || requestId.length > 100 || !requestId) throw new Error('Некорректный запрос LLDP.')
    if (!allWindows().some((w) => w.webContents === e.sender)) throw new Error('Окно недоступно.')
    if (lldpRequests.size >= 4 || lldpRequests.has(requestId) || [...lldpRequests.values()].some((r) => r.owner === e.sender)) throw new Error('Дождитесь завершения текущего чтения LLDP.')
    const store = loadStore()
    const host = store.hosts.find((h) => h.id === hostId)
    if (!host) throw new Error('Хост не найден. Сначала сохраните хост.')
    if (!effectiveSettings(store.folders, host).snmp) throw new Error('Сначала включите и сохраните SNMP у хоста или папки.')
    const owner = snmpCommunityOwner(store.folders, host, store.secretIds)
    const community = owner ? getSecret(snmpSecretId(owner)) : undefined
    if (!community) throw new Error('Сначала сохраните SNMP community у хоста или папки.')
    const controller = new AbortController()
    const cancel = () => controller.abort()
    lldpRequests.set(requestId, { owner: e.sender, controller })
    e.sender.once('destroyed', cancel)
    try {
      // Uses saved settings only; no discovery-triggered connections to advertised neighbor addresses.
      return await collectLldp(monitor.addressOrder(host)[0], community, controller.signal)
    } finally {
      e.sender.removeListener('destroyed', cancel)
      lldpRequests.delete(requestId)
    }
  })
  ipcMain.handle('lldp:cancel', (e, requestId: string) => {
    const request = lldpRequests.get(requestId)
    if (request?.owner === e.sender) request.controller.abort()
  })
  ipcMain.handle('store:secret', (_e, id: string, value: string | null) => {
    const saved = setSecret(id, value)
    automaticLldp.refresh()
    return saved
  })
  ipcMain.handle('config:export', (e, password?: string) => exportConfig(BrowserWindow.fromWebContents(e.sender), password))
  ipcMain.handle('config:import-pick', (e) => importPick(BrowserWindow.fromWebContents(e.sender)))
  ipcMain.handle('config:import-apply', (_e, token: string, mode: ImportMode, password?: string) => {
    const saved = importApply(token, mode, password)
    automaticLldp.refresh()
    return saved
  })
  ipcMain.handle('foreign:pick', (e) => foreignPick(BrowserWindow.fromWebContents(e.sender)))
  ipcMain.handle('foreign:plan', (_e, token: string, opts: ForeignOptions) => foreignPlan(token, opts))
  ipcMain.handle('foreign:apply', (_e, token: string, opts: ForeignOptions) => {
    const result = foreignApply(token, opts)
    automaticLldp.refresh()
    return result
  })
  ipcMain.handle('mapbg:pick', (e) => pickBackground(BrowserWindow.fromWebContents(e.sender)))
  ipcMain.handle('mapbg:load', (_e, file: string) => loadBackground(file))

  ipcMain.handle('ssh:connect', (e, hostId: string, cols: number, rows: number, address?: string) => connectHost(e.sender, hostId, cols, rows, address))
  // Same host, same address, same session id: the pane that lost its connection gets a new one in place.
  ipcMain.handle('ssh:reconnect', (e, sessionId: string, hostId: string, address?: string) => {
    const size = sessions.endedSize(sessionId) ?? { cols: 120, rows: 32 }
    return connectHost(e.sender, hostId, size.cols, size.rows, address, sessionId)
  })
  ipcMain.on('hostkey:answer', (_e, requestId: string, accept: boolean) => {
    pendingKeys.get(requestId)?.(accept)
    pendingKeys.delete(requestId)
  })
  ipcMain.handle('ssh:scrollback', (_e, id: string) => sessions.scrollback(id))
  ipcMain.on('ssh:write', (_e, id: string, data: string) => sessions.write(id, data))
  ipcMain.on('ssh:broadcast', (_e, ids: string[], data: string) => sessions.broadcast(ids, data))
  ipcMain.on('ssh:resize', (_e, id: string, cols: number, rows: number) => sessions.resize(id, cols, rows))
  ipcMain.on('ssh:close', (_e, id: string) => sessions.forget(id))
  ipcMain.on('win:popout', (_e, s: SessionInfo) => popout(s))
  ipcMain.on('app:ready', (e) => {
    if (e.sender !== mainWin?.webContents) return
    onMainReady?.()
    onMainReady = undefined
  })

  ipcMain.handle('monitor:all', () => monitor.all())
  ipcMain.on('monitor:probe', (_e, ids: string[]) => void monitor.probe(ids))

  // Setting themeSource also flips prefers-color-scheme in every renderer.
  ipcMain.on('app:theme', (_e, source: 'system' | 'dark' | 'light') => (nativeTheme.themeSource = source))
  ipcMain.on('app:chrome', (_e, color: string, symbolColor: string, height?: number) => {
    chrome = { ...chrome, color, symbolColor, height: height && height >= 24 && height <= 64 ? Math.round(height) : chrome.height }
    allWindows().forEach((w) => (w.setTitleBarOverlay?.(chrome), w.setBackgroundColor(color)))
  })

  ipcMain.handle('host:browser', async (e, hostId: string, address?: string) => {
    const host = pickAddress(hostById(hostId), address)
    const s = effectiveSettings(loadStore().folders, host)
    const url = new URL(renderUrl(s.webUrl, host, s))
    const to = await reach(e.sender, host, s, url.hostname, Number(url.port) || (url.protocol === 'https:' ? 443 : 80))
    if (to.address !== url.hostname) (url.hostname = to.address), (url.port = String(to.port))
    return openInBrowser(url.toString())
  })
  ipcMain.on('tools:start', (e, runId: string, kind: ToolKind, params: ToolParams[ToolKind]) => {
    const sender = e.sender
    if (!toolWindows.has(sender)) toolWindows.add(sender), sender.once('destroyed', () => tools.stopOwner(sender.id))
    tools.start(runId, kind, params, sender.id, (ev: ToolEvent) => !sender.isDestroyed() && sender.send('tools:event', runId, ev))
  })
  ipcMain.on('tools:stop', (_e, runId: string) => tools.stop(runId))
  ipcMain.handle('tools:dns', (_e, q) => dnsQuery(q))

  ipcMain.handle('host:winbox', async (e, hostId: string, address?: string) => {
    const store = loadStore()
    const host = pickAddress(hostById(hostId), address)
    const s = effectiveSettings(store.folders, host)
    const login = resolveLogin(store.folders, store.credentials, host, store.secretIds)
    const path = store.settings?.winboxPath ?? 'C:\\Program Files\\MikroTik\\winbox64.exe'
    const password = store.settings?.winboxPassPassword !== false ? getSecret(login.secretId) : undefined
    const to = await reach(e.sender, host, s, host.address, 8291)
    launchWinbox(path, to.port === 8291 ? to.address : `${to.address}:${to.port}`, login.username, password)
  })
}

/** Opens an SSH session to the host; with reuseId it is a reconnect of that closed session. */
async function connectHost(asker: WebContents, hostId: string, cols: number, rows: number, address?: string, reuseId?: string): Promise<SessionInfo> {
  const store = loadStore()
  const host = hostById(hostId)
  const s = effectiveSettings(store.folders, host)
  const login = resolveLogin(store.folders, store.credentials, host, store.secretIds)
  const j = jumpFor(host, s)
  // A chosen address is the only one tried; otherwise the one monitoring saw answer goes first, then the rest.
  const order = address ? [address] : monitor.addressOrder(host)
  const asked: string[] = []
  const openAt = (addr: string) => {
    const at: Host = { ...host, address: addr }
    const open = async (only?: Pair) => {
      const sock = j ? await jump.forward(j, jumpVerifier(asker, j), addr, s.port) : await tcpConnect(addr, s.port)
      return sessions.open(
        at,
        s,
        { username: login.username, password: getSecret(login.secretId) },
        cols,
        rows,
        (blob) => verifyHostKey(asker, at, s.port, blob, asked),
        sock,
        only,
        (username, password) => rememberLogin(hostId, username, password),
        reuseId
      )
    }
    return openWithKexRetry(`${addr}:${s.port}`, open, (last, tried, log) => {
      const file = saveHandshakeLog(at, log)
      return new Error(
        `${last.message}\n` +
          (tried.length > 1 ? `Перепробовал ${tried.length} сочетаний (${tried.map((p) => `${p.kex} + ${p.hostKey}`).join('; ')}), подпись не сошлась ни в одном.\n` : '') +
          (file ? `Журнал рукопожатия: ${file}` : '')
      )
    })
  }
  const { result: sessionId, address: used } = await (j ? jumpQueue : directQueue)
    .open(() => openFirstReachable(order, openAt))
    .finally(() => dropKeyQuestions(asker, asked))
  return { sessionId, hostId, title: host.name, address: used }
}

app.whenReady().then(() => {
  const theme = loadStore().settings?.theme ?? 'system'
  nativeTheme.themeSource = theme === 'system' ? 'system' : /light|^oat$|^mist$/.test(theme) ? 'light' : 'dark'
  registerIpc()
  createMainWindow(true)
  monitor.start()
  automaticLldp.start()
  setTimeout(() => {
    try {
      pruneBackgrounds(loadStore())
    } catch {
      /* not important enough to stop the start */
    }
  }, 10000)
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createMainWindow())
})

app.on('window-all-closed', () => {
  monitor.stop()
  tools.stopAll()
  sessions.closeAll()
  jump.reset()
  if (process.platform !== 'darwin') app.quit()
})
