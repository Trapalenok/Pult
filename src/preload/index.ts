import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api } from '@shared/ipc'

function subscribe<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: Api = {
  loadStore: () => ipcRenderer.invoke('store:load'),
  saveStore: (store) => ipcRenderer.invoke('store:save', store),
  setSecret: (id, value) => ipcRenderer.invoke('store:secret', id, value),
  exportConfig: (password) => ipcRenderer.invoke('config:export', password),
  importPick: () => ipcRenderer.invoke('config:import-pick'),
  importApply: (token, mode, password) => ipcRenderer.invoke('config:import-apply', token, mode, password),
  foreignPick: () => ipcRenderer.invoke('foreign:pick'),
  foreignPlan: (token, opts) => ipcRenderer.invoke('foreign:plan', token, opts),
  foreignApply: (token, opts) => ipcRenderer.invoke('foreign:apply', token, opts),
  connect: (hostId, cols, rows) => ipcRenderer.invoke('ssh:connect', hostId, cols, rows),
  onHostKeyPrompt: (cb) => subscribe('hostkey:ask', cb),
  answerHostKey: (requestId, accept) => ipcRenderer.send('hostkey:answer', requestId, accept),
  scrollback: (id) => ipcRenderer.invoke('ssh:scrollback', id),
  write: (id, data) => ipcRenderer.send('ssh:write', id, data),
  broadcast: (ids, data) => ipcRenderer.send('ssh:broadcast', ids, data),
  resize: (id, cols, rows) => ipcRenderer.send('ssh:resize', id, cols, rows),
  close: (id) => ipcRenderer.send('ssh:close', id),
  popout: (session) => ipcRenderer.send('win:popout', session),
  setTheme: (source) => ipcRenderer.send('app:theme', source),
  setChrome: (color, symbolColor) => ipcRenderer.send('app:chrome', color, symbolColor),
  monitorAll: () => ipcRenderer.invoke('monitor:all'),
  monitorProbe: (ids) => ipcRenderer.send('monitor:probe', ids),
  onMonitor: (cb) => subscribe('monitor:update', cb),
  openInBrowser: (hostId) => ipcRenderer.invoke('host:browser', hostId),
  openWinbox: (hostId) => ipcRenderer.invoke('host:winbox', hostId),
  onData: (cb) => subscribe('ssh:data', cb),
  onClosed: (cb) => subscribe('ssh:closed', cb),
  onReturned: (cb) => subscribe('session:returned', cb),
  toolStart: (runId, kind, params) => ipcRenderer.send('tools:start', runId, kind, params),
  toolStop: (runId) => ipcRenderer.send('tools:stop', runId),
  onToolEvent: (cb) => subscribe('tools:event', cb),
  dnsQuery: (q) => ipcRenderer.invoke('tools:dns', q),
  updateState: () => ipcRenderer.invoke('update:state'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: (version) => ipcRenderer.invoke('update:download', version),
  updateCancel: () => ipcRenderer.send('update:cancel'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdate: (cb) => subscribe('update:state', cb)
}

contextBridge.exposeInMainWorld('api', api)
contextBridge.exposeInMainWorld('platform', process.platform)
