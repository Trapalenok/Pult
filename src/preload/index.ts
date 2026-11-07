import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api } from '@shared/ipc'

function subscribe<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: Api = {
  lldpAutoStatus: () => ipcRenderer.invoke('lldp:auto-status'),
  onLldpAutoStatus: (cb) => subscribe('lldp:auto-status', cb),
  lldpRead: (hostId, requestId) => ipcRenderer.invoke('lldp:read', hostId, requestId),
  lldpCancel: (requestId) => ipcRenderer.invoke('lldp:cancel', requestId),
  loadStore: () => ipcRenderer.invoke('store:load'),
  saveStore: (store) => ipcRenderer.invoke('store:save', store),
  setSecret: (id, value) => ipcRenderer.invoke('store:secret', id, value),
  onStoreChanged: (cb) => subscribe('store:changed', cb),
  exportConfig: (password) => ipcRenderer.invoke('config:export', password),
  importPick: () => ipcRenderer.invoke('config:import-pick'),
  importApply: (token, mode, password) => ipcRenderer.invoke('config:import-apply', token, mode, password),
  foreignPick: () => ipcRenderer.invoke('foreign:pick'),
  foreignPlan: (token, opts) => ipcRenderer.invoke('foreign:plan', token, opts),
  foreignApply: (token, opts) => ipcRenderer.invoke('foreign:apply', token, opts),
  connect: (hostId, cols, rows, address) => ipcRenderer.invoke('ssh:connect', hostId, cols, rows, address),
  reconnect: (sessionId, hostId, address) => ipcRenderer.invoke('ssh:reconnect', sessionId, hostId, address),
  onHostKeyPrompt: (cb) => subscribe('hostkey:ask', cb),
  onHostKeyCancel: (cb) => subscribe('hostkey:cancel', cb),
  answerHostKey: (requestId, accept) => ipcRenderer.send('hostkey:answer', requestId, accept),
  scrollback: (id) => ipcRenderer.invoke('ssh:scrollback', id),
  write: (id, data) => ipcRenderer.send('ssh:write', id, data),
  broadcast: (ids, data) => ipcRenderer.send('ssh:broadcast', ids, data),
  resize: (id, cols, rows) => ipcRenderer.send('ssh:resize', id, cols, rows),
  close: (id) => ipcRenderer.send('ssh:close', id),
  popout: (session) => ipcRenderer.send('win:popout', session),
  ready: () => ipcRenderer.send('app:ready'),
  setTheme: (source) => ipcRenderer.send('app:theme', source),
  setChrome: (color, symbolColor, height) => ipcRenderer.send('app:chrome', color, symbolColor, height),
  monitorAll: () => ipcRenderer.invoke('monitor:all'),
  monitorProbe: (ids) => ipcRenderer.send('monitor:probe', ids),
  onMonitor: (cb) => subscribe('monitor:update', cb),
  openInBrowser: (hostId, address) => ipcRenderer.invoke('host:browser', hostId, address),
  openWinbox: (hostId, address) => ipcRenderer.invoke('host:winbox', hostId, address),
  onData: (cb) => subscribe('ssh:data', cb),
  onClosed: (cb) => subscribe('ssh:closed', cb),
  onReturned: (cb) => subscribe('session:returned', cb),
  toolStart: (runId, kind, params) => ipcRenderer.send('tools:start', runId, kind, params),
  toolStop: (runId) => ipcRenderer.send('tools:stop', runId),
  onToolEvent: (cb) => subscribe('tools:event', cb),
  dnsQuery: (q) => ipcRenderer.invoke('tools:dns', q),
  pickMapBackground: () => ipcRenderer.invoke('mapbg:pick'),
  loadMapBackground: (file) => ipcRenderer.invoke('mapbg:load', file)
}

contextBridge.exposeInMainWorld('api', api)
contextBridge.exposeInMainWorld('platform', process.platform)
