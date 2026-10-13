import { app, BrowserWindow, ipcMain, nativeTheme, type BrowserWindowConstructorOptions, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { effectiveSettings, renderUrl, resolveLogin, usesJump } from '@shared/inherit'
import { JUMP_DEFAULT_PORT } from '@shared/types'
import type { EffectiveSettings, Host, HostKeyPrompt, HostStatus, ForeignOptions, ImportMode, SessionInfo, Store } from '@shared/types'
import { SessionManager } from './ssh/session-manager'
import { fingerprint, keyType } from './ssh/host-key'
import { JumpHost, type JumpLogin } from './ssh/jump'
import { OpenQueue } from './ssh/open-queue'
import { getKnownHost, getSecret, loadStore, saveStore, setSecret, trustHost } from './store/json-store'
import { exportConfig, importApply, importPick } from './store/transfer'
import { foreignApply, foreignPick, foreignPlan } from './store/foreign'
import { openInBrowser } from './integrations/browser'
import { launchWinbox } from './integrations/winbox'
import { Monitor } from './monitor/monitor'
import { dnsQuery, Tools } from './tools/tools'
import { Updater } from './update/updater'
import type { ToolEvent, ToolKind, ToolParams } from '@shared/tools'

// The app was called "SSH Client" before Pult. Keep its data folder (%APPDATA%\ssh-client: hosts, passwords,
// and the key that decrypts them) whatever the product name is, so the rename loses nothing.
app.setPath('userData', join(app.getPath('appData'), 'ssh-client'))

let mainWin: BrowserWindow | null = null
/** sessionId → its own window, for sessions popped out of the main one. */
const popouts = new Map<string, BrowserWindow>()

const allWindows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
const sendAll = (channel: string, ...args: unknown[]) => allWindows().forEach((w) => w.webContents.send(channel, ...args))

const sessions = new SessionManager({
  data: (id, data, end) => sendAll('ssh:data', id, data, end),
  closed: (id, reason) => sendAll('ssh:closed', id, reason)
})

const updater = new Updater((state) => sendAll('update:state', state))

const jump = new JumpHost()
/** A pack of hosts (map sheet, folder) opens a few at a time: see open-queue.ts. */
const openQueue = new OpenQueue()

const toolWindows = new WeakSet<WebContents>()

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
  }
)

function hostById(id: string): Host {
  const host = loadStore().hosts.find((h) => h.id === id)
  if (!host) throw new Error(`Хост не найден: ${id}`)
  return host
}

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

function createMainWindow(): void {
  mainWin = new BrowserWindow(windowOptions({ width: 1360, height: 860, minWidth: 900, minHeight: 560, title: 'Pult' }))
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
  load(win, { session: s.sessionId, host: s.hostId, title: s.title })
  win.on('closed', () => {
    popouts.delete(s.sessionId)
    if (sessions.has(s.sessionId)) mainWin?.webContents.send('session:returned', s)
  })
}

/* ── Host key confirmation ─────────────────────────────────── */

const pendingKeys = new Map<string, (accept: boolean) => void>()

/**
 * Known key: go on silently. New key: ask. Changed key: ask with a warning; the default
 * button in the dialog is "cancel". Nothing is remembered unless the user accepts.
 */
function verifyHostKey(asker: WebContents, host: Host, port: number, blob: Buffer): Promise<boolean> {
  const fp = fingerprint(blob)
  const type = keyType(blob)
  const known = getKnownHost(host.address, port)
  if (known && known.fingerprint === fp) return Promise.resolve(true)
  const prompt: HostKeyPrompt = {
    requestId: randomUUID(),
    hostName: host.name,
    address: host.address,
    port,
    keyType: type,
    fingerprint: fp,
    previous: known
  }
  return new Promise((resolve) => {
    pendingKeys.set(prompt.requestId, (accept) => {
      if (accept) trustHost(host.address, port, { keyType: type, fingerprint: fp })
      resolve(accept)
    })
    if (asker.isDestroyed()) return resolve(false)
    asker.send('hostkey:ask', prompt)
  })
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

function registerIpc(): void {
  ipcMain.handle('store:load', () => loadStore())
  ipcMain.handle('store:save', (_e, next: Store) => saveStore(next))
  ipcMain.handle('store:secret', (_e, id: string, value: string | null) => setSecret(id, value))
  ipcMain.handle('config:export', (e, password?: string) => exportConfig(BrowserWindow.fromWebContents(e.sender), password))
  ipcMain.handle('config:import-pick', (e) => importPick(BrowserWindow.fromWebContents(e.sender)))
  ipcMain.handle('config:import-apply', (_e, token: string, mode: ImportMode, password?: string) => importApply(token, mode, password))
  ipcMain.handle('foreign:pick', (e) => foreignPick(BrowserWindow.fromWebContents(e.sender)))
  ipcMain.handle('foreign:plan', (_e, token: string, opts: ForeignOptions) => foreignPlan(token, opts))
  ipcMain.handle('foreign:apply', (_e, token: string, opts: ForeignOptions) => foreignApply(token, opts))

  ipcMain.handle('ssh:connect', async (e, hostId: string, cols: number, rows: number) => {
    const store = loadStore()
    const host = hostById(hostId)
    const s = effectiveSettings(store.folders, host)
    const login = resolveLogin(store.folders, store.credentials, host, store.secretIds)
    const j = jumpFor(host, s)
    const sessionId = await openQueue.open(async () => {
      const sock = j ? await jump.forward(j, jumpVerifier(e.sender, j), host.address, s.port) : undefined
      return sessions.open(
        host,
        s,
        { username: login.username, password: getSecret(login.secretId) },
        cols,
        rows,
        (blob) => verifyHostKey(e.sender, host, s.port, blob),
        sock
      )
    })
    return { sessionId, hostId, title: host.name }
  })
  ipcMain.on('hostkey:answer', (_e, requestId: string, accept: boolean) => {
    pendingKeys.get(requestId)?.(accept)
    pendingKeys.delete(requestId)
  })
  ipcMain.handle('ssh:scrollback', (_e, id: string) => sessions.scrollback(id))
  ipcMain.on('ssh:write', (_e, id: string, data: string) => sessions.write(id, data))
  ipcMain.on('ssh:broadcast', (_e, ids: string[], data: string) => sessions.broadcast(ids, data))
  ipcMain.on('ssh:resize', (_e, id: string, cols: number, rows: number) => sessions.resize(id, cols, rows))
  ipcMain.on('ssh:close', (_e, id: string) => sessions.close(id))
  ipcMain.on('win:popout', (_e, s: SessionInfo) => popout(s))

  ipcMain.handle('monitor:all', () => monitor.all())
  ipcMain.on('monitor:probe', (_e, ids: string[]) => void monitor.probe(ids))

  // Setting themeSource also flips prefers-color-scheme in every renderer.
  ipcMain.on('app:theme', (_e, source: 'system' | 'dark' | 'light') => (nativeTheme.themeSource = source))
  ipcMain.on('app:chrome', (_e, color: string, symbolColor: string) => {
    chrome = { ...chrome, color, symbolColor }
    allWindows().forEach((w) => (w.setTitleBarOverlay?.(chrome), w.setBackgroundColor(color)))
  })

  ipcMain.handle('host:browser', async (e, hostId: string) => {
    const host = hostById(hostId)
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

  ipcMain.handle('update:state', () => updater.get())
  ipcMain.handle('update:check', () => updater.check())
  ipcMain.handle('update:download', (_e, version: string) => updater.download(version))
  ipcMain.on('update:cancel', () => updater.cancel())
  ipcMain.handle('update:install', () => updater.install())

  ipcMain.handle('host:winbox', async (e, hostId: string) => {
    const store = loadStore()
    const host = hostById(hostId)
    const s = effectiveSettings(store.folders, host)
    const login = resolveLogin(store.folders, store.credentials, host, store.secretIds)
    const path = store.settings?.winboxPath ?? 'C:\\Program Files\\MikroTik\\winbox64.exe'
    const password = store.settings?.winboxPassPassword !== false ? getSecret(login.secretId) : undefined
    const to = await reach(e.sender, host, s, host.address, 8291)
    launchWinbox(path, to.port === 8291 ? to.address : `${to.address}:${to.port}`, login.username, password)
  })
}

app.whenReady().then(() => {
  const theme = loadStore().settings?.theme ?? 'system'
  nativeTheme.themeSource = theme === 'system' ? 'system' : /light|^oat$|^mist$/.test(theme) ? 'light' : 'dark'
  registerIpc()
  createMainWindow()
  monitor.start()
  // A few seconds after start, so the first window and the monitor go first. Off in Settings.
  if (loadStore().settings?.updateCheck !== false) setTimeout(() => void updater.check(true), 5000)
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createMainWindow())
})

app.on('window-all-closed', () => {
  monitor.stop()
  tools.stopAll()
  sessions.closeAll()
  jump.reset()
  if (process.platform !== 'darwin') app.quit()
})
