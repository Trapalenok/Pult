import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Store, StoreSnapshot } from '@shared/types'

// A JSON file in userData: one per Windows account, never synced anywhere.
const file = () => join(app.getPath('userData'), 'store.json')

export interface KnownHost {
  keyType: string
  fingerprint: string
  addedAt: string
}

interface OnDisk extends Store {
  /** Secret id → value encrypted with safeStorage (DPAPI on Windows), base64. See snmpSecretId. */
  secrets: Record<string, string>
  /** "address:port" → trusted host key. */
  knownHosts: Record<string, KnownHost>
}

const SAMPLE: OnDisk = {
  folders: [
    { id: 'f-hq', parentId: null, name: 'Главный офис', kind: 'building', tint: 'blue', defaults: {} },
    { id: 'f-hq-1', parentId: 'f-hq', name: 'Этаж 1', kind: 'floor', tint: 'indigo', defaults: {} },
    { id: 'f-hq-1-srv', parentId: 'f-hq-1', name: 'Серверная', kind: 'room', tint: 'purple', defaults: { username: 'admin' } },
    { id: 'f-hq-1-srv-k1', parentId: 'f-hq-1-srv', name: 'Кросс 1', kind: 'cross', tint: 'orange', defaults: {} },
    { id: 'f-mikrotik', parentId: null, name: 'MikroTik', tint: 'teal', defaults: { username: 'admin', winbox: true, webUrl: 'http://{address}' } }
  ],
  hosts: [
    { id: 'h-1', folderId: 'f-hq-1-srv', name: 'sw-core-01', address: '192.168.1.10', overrides: {} },
    { id: 'h-2', folderId: 'f-hq-1-srv-k1', name: 'sw-access-01', address: '192.168.1.11', overrides: {} },
    { id: 'h-3', folderId: 'f-mikrotik', name: 'gw-office', address: '192.168.1.1', overrides: {} }
  ],
  credentials: [],
  maps: [],
  workspaces: [],
  secrets: {},
  knownHosts: {}
}

let disk: OnDisk

function read(): OnDisk {
  if (!disk) {
    const loaded = existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')) : JSON.parse(JSON.stringify(SAMPLE))
    // Files from older versions lack the newer collections.
    disk = { credentials: [], maps: [], workspaces: [], secrets: {}, knownHosts: {}, ...loaded }
  }
  return disk
}

function write(): void {
  const tmp = file() + '.tmp'
  writeFileSync(tmp, JSON.stringify(disk, null, 2))
  renameSync(tmp, file())
}

export function loadStore(): StoreSnapshot {
  const { secrets, knownHosts: _k, ...rest } = read()
  return { ...JSON.parse(JSON.stringify(rest)), secretIds: Object.keys(secrets) }
}

/** Renderer sends the editable collections; secrets are kept, minus those of deleted items. */
export function saveStore(next: Store): StoreSnapshot {
  const d = read()
  const alive = new Set([...next.folders, ...next.hosts, ...next.credentials].map((x) => x.id))
  const owner = (secretId: string) => secretId.replace(/^snmp:/, '')
  const secrets = Object.fromEntries(Object.entries(d.secrets).filter(([id]) => alive.has(owner(id))))
  disk = { ...d, folders: next.folders, hosts: next.hosts, credentials: next.credentials, maps: next.maps, workspaces: next.workspaces ?? [], settings: next.settings, secrets }
  write()
  return loadStore()
}

export function setSecret(id: string, value: string | null): StoreSnapshot {
  const d = read()
  if (value === null || value === '') delete d.secrets[id]
  else d.secrets[id] = encrypt(value)
  write()
  return loadStore()
}

export function getSecret(id: string | undefined): string | undefined {
  const v = id ? read().secrets[id] : undefined
  return v === undefined ? undefined : decrypt(v)
}

export function getKnownHost(address: string, port: number): KnownHost | undefined {
  return read().knownHosts[`${address}:${port}`]
}

export function trustHost(address: string, port: number, key: Omit<KnownHost, 'addedAt'>): void {
  read().knownHosts[`${address}:${port}`] = { ...key, addedAt: new Date().toISOString() }
  write()
}

/** For export: the editable collections, trusted host keys and, only when asked, secrets in plain text. */
export function dumpStore(withSecrets: boolean): { store: Store; knownHosts: Record<string, KnownHost>; secrets?: Record<string, string> } {
  const { secrets, knownHosts, ...store } = JSON.parse(JSON.stringify(read())) as OnDisk
  return {
    store,
    knownHosts,
    secrets: withSecrets ? Object.fromEntries(Object.keys(secrets).map((id) => [id, decrypt(secrets[id])])) : undefined
  }
}

/**
 * Writes an imported store. Secrets come in plain text and are encrypted for this machine;
 * known host keys only fill gaps, so a key trusted here is never replaced from a file.
 */
export function applyImport(next: Store, knownHosts: Record<string, KnownHost>, secrets: Record<string, string>): StoreSnapshot {
  const d = read()
  for (const [id, v] of Object.entries(secrets)) if (v) d.secrets[id] = encrypt(v)
  disk = { ...d, knownHosts: { ...knownHosts, ...d.knownHosts } }
  return saveStore(next)
}

// "plain:" only where the OS has no keyring (rare Linux setups); Windows always has DPAPI.
function encrypt(v: string): string {
  return safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(v).toString('base64')
    : 'plain:' + Buffer.from(v).toString('base64')
}

function decrypt(v: string): string {
  if (v.startsWith('plain:')) return Buffer.from(v.slice(6), 'base64').toString()
  return safeStorage.decryptString(Buffer.from(v, 'base64'))
}
