import { app, dialog, type BrowserWindow } from 'electron'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { MAX_ADDRESSES, type Host, type ImportMode, type ImportPreview, type Store, type StoreSnapshot } from '@shared/types'
import { applyImport, dumpStore, loadStore, type KnownHost } from './json-store'
import { backgroundsOf, restoreBackgrounds } from './backgrounds'
import { cleanHostLldp } from '@shared/lldp'

/*
 * Moving the base between PCs and colleagues. safeStorage secrets only decrypt on the machine
 * and Windows account that wrote them, so a file carries them re-encrypted with a password the
 * user types (scrypt → AES-256-GCM), or not at all.
 */

// Kept from the "SSH Client" days so old exports still import.
const FORMAT = 'ssh-client-config'
const VERSION = 1

interface SealedSecrets {
  kdf: 'scrypt'
  N: number
  r: number
  p: number
  salt: string
  iv: string
  tag: string
  data: string
}

interface ConfigFile {
  format: typeof FORMAT
  version: number
  exportedAt: string
  app: string
  store: Store
  knownHosts: Record<string, KnownHost>
  secrets?: SealedSecrets
  /** Map backdrop pictures by file name, base64. Older files have none. */
  backgrounds?: Record<string, string>
}

const KDF = { N: 1 << 15, r: 8, p: 1 }
const key = (password: string, salt: Buffer, k: { N: number; r: number; p: number }) =>
  scryptSync(password, salt, 32, { ...k, maxmem: 128 * k.N * k.r * 2 })

function seal(secrets: Record<string, string>, password: string): SealedSecrets {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(password, salt, KDF), iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()])
  const b64 = (b: Buffer) => b.toString('base64')
  return { kdf: 'scrypt', ...KDF, salt: b64(salt), iv: b64(iv), tag: b64(cipher.getAuthTag()), data: b64(data) }
}

function unseal(s: SealedSecrets, password: string): Record<string, string> {
  const buf = (v: string) => Buffer.from(v, 'base64')
  if (!(s.N <= 1 << 20 && s.r <= 32 && s.p <= 4)) throw new Error('Файл повреждён: странные параметры шифрования')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(password, buf(s.salt), s), buf(s.iv))
    decipher.setAuthTag(buf(s.tag))
    return JSON.parse(Buffer.concat([decipher.update(buf(s.data)), decipher.final()]).toString('utf8'))
  } catch {
    throw new Error('Неверный пароль файла')
  }
}

export async function exportConfig(win: BrowserWindow | null, password?: string): Promise<string | null> {
  const stamp = new Date().toISOString().slice(0, 10)
  const opts = {
    title: 'Экспорт конфигурации',
    defaultPath: join(app.getPath('documents'), `pult-${stamp}.json`),
    filters: [{ name: 'Конфигурация Pult', extensions: ['json'] }]
  }
  const { canceled, filePath } = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (canceled || !filePath) return null
  const { store, knownHosts, secrets } = dumpStore(!!password)
  const file: ConfigFile = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    app: app.getVersion(),
    store,
    knownHosts,
    secrets: password && secrets ? seal(secrets, password) : undefined,
    backgrounds: backgroundsOf(store)
  }
  writeFileSync(filePath, JSON.stringify(file, null, 2))
  return filePath
}

/* ── Import ────────────────────────────────────────────────── */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const hasIds = (v: unknown) => Array.isArray(v) && v.every((x) => isObj(x) && typeof x.id === 'string')

function parse(text: string): ConfigFile {
  let f: unknown
  try {
    f = JSON.parse(text)
  } catch {
    throw new Error('Это не JSON-файл')
  }
  if (!isObj(f) || f.format !== FORMAT) throw new Error('Это не файл конфигурации Pult')
  if (typeof f.version !== 'number' || f.version > VERSION) throw new Error('Файл сделан более новой версией программы, обновите её')
  const s = f.store
  if (!isObj(s) || !hasIds(s.folders) || !hasIds(s.hosts) || !hasIds(s.credentials ?? []) || !hasIds(s.maps ?? []))
    throw new Error('Файл повреждён: нет списков папок и хостов')
  const bad = (s.hosts as Record<string, unknown>[]).find((h) => typeof h.name !== 'string' || typeof h.address !== 'string')
  if (bad) throw new Error(`Файл повреждён: у хоста ${String(bad.id)} нет имени или адреса`)
  if (f.secrets !== undefined && !(isObj(f.secrets) && f.secrets.kdf === 'scrypt' && typeof f.secrets.data === 'string'))
    throw new Error('Файл повреждён: блок паролей не читается')
  const store: Store = {
    folders: s.folders as Store['folders'],
    hosts: cleanHostLldp((s.hosts as Host[]).map(cleanAddresses)),
    credentials: (s.credentials ?? []) as Store['credentials'],
    maps: (s.maps ?? []) as Store['maps'],
    workspaces: (hasIds(s.workspaces ?? []) ? s.workspaces ?? [] : []) as Store['workspaces'],
    settings: isObj(s.settings) ? (s.settings as Store['settings']) : undefined
  }
  return { ...(f as unknown as ConfigFile), store, knownHosts: isObj(f.knownHosts) ? (f.knownHosts as ConfigFile['knownHosts']) : {} }
}

/** Extra addresses come along as they are; anything that is not a list of strings is dropped. */
function cleanAddresses(h: Host): Host {
  const { addresses, ...rest } = h
  const list = Array.isArray(addresses) ? addresses.filter((a): a is string => typeof a === 'string' && a.trim() !== '').map((a) => a.trim()).slice(0, MAX_ADDRESSES - 1) : []
  return list.length ? { ...rest, addresses: list } : rest
}

/** Parsed files between preview and apply. Only the latest one is kept. */
let pending: { token: string; file: ConfigFile } | null = null

export async function importPick(win: BrowserWindow | null): Promise<ImportPreview | null> {
  const opts = {
    title: 'Импорт конфигурации',
    properties: ['openFile' as const],
    filters: [{ name: 'Конфигурация Pult', extensions: ['json'] }]
  }
  const { canceled, filePaths } = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (canceled || !filePaths[0]) return null
  const file = parse(readFileSync(filePaths[0], 'utf8'))
  pending = { token: randomUUID(), file }
  const cur = loadStore()
  const fresh = <T extends { id: string }>(next: T[], have: T[]) => {
    const ids = new Set(have.map((x) => x.id))
    return next.filter((x) => !ids.has(x.id)).length
  }
  const s = file.store
  return {
    token: pending.token,
    fileName: basename(filePaths[0]),
    exportedAt: file.exportedAt,
    counts: { folders: s.folders.length, hosts: s.hosts.length, credentials: s.credentials.length, maps: s.maps.length, knownHosts: Object.keys(file.knownHosts).length },
    fresh: {
      folders: fresh(s.folders, cur.folders),
      hosts: fresh(s.hosts, cur.hosts),
      credentials: fresh(s.credentials, cur.credentials),
      maps: fresh(s.maps, cur.maps)
    },
    hasSecrets: !!file.secrets,
    hasSettings: !!s.settings
  }
}

/** Adds what this base lacks (by id) and keeps everything it already has, settings included. */
export function merge(cur: Store, next: Store): { store: Store; added: Set<string> } {
  const added = new Set<string>()
  const add = <T extends { id: string }>(have: T[], incoming: T[]): T[] => {
    const ids = new Set(have.map((x) => x.id))
    const fresh = incoming.filter((x) => !ids.has(x.id))
    fresh.forEach((x) => added.add(x.id))
    return [...have, ...fresh]
  }
  const folders = add(cur.folders, next.folders)
  const folderIds = new Set(folders.map((f) => f.id))
  const maps = add(cur.maps, next.maps)
  const mapIds = new Set(maps.map((m) => m.id))
  return {
    added,
    store: {
      // Links to things neither base has would point nowhere: lift them to the top level.
      folders: folders.map((f) => (f.parentId && !folderIds.has(f.parentId) ? { ...f, parentId: null } : f)),
      hosts: add(cur.hosts, next.hosts).map((h) => (h.folderId && !folderIds.has(h.folderId) ? { ...h, folderId: null } : h)),
      credentials: add(cur.credentials, next.credentials),
      maps: maps.map((m) => (m.parentId && !mapIds.has(m.parentId) ? { ...m, parentId: undefined } : m)),
      workspaces: add(cur.workspaces ?? [], next.workspaces ?? []),
      settings: cur.settings
    }
  }
}

export function importApply(token: string, mode: ImportMode, password?: string): StoreSnapshot {
  if (!pending || pending.token !== token) throw new Error('Файл больше не открыт, выберите его ещё раз')
  const { file } = pending
  if (mode !== 'merge' && mode !== 'replace') throw new Error('Неизвестный режим импорта')
  if (file.secrets && !password) throw new Error('Введите пароль файла, заданный при экспорте. Импорт без расшифровки паролей отменён.')
  let secrets: Record<string, string> = {}
  if (file.secrets && password) secrets = unseal(file.secrets, password)
  const owner = (secretId: string) => secretId.replace(/^snmp:/, '')
  let result: StoreSnapshot
  if (mode === 'replace') {
    // The path of the program Pult starts for WinBox stays this PC's: a file from elsewhere must not pick what runs here.
    const winboxPath = loadStore().settings?.winboxPath
    const settings = file.store.settings ? { ...file.store.settings, winboxPath } : undefined
    result = applyImport({ ...file.store, settings }, file.knownHosts, secrets)
  } else {
    const { store, added } = merge(loadStore(), file.store)
    // A password already set here is never overwritten by one from the file.
    const fresh = Object.fromEntries(Object.entries(secrets).filter(([id]) => added.has(owner(id))))
    result = applyImport(store, file.knownHosts, fresh)
  }
  restoreBackgrounds(isObj(file.backgrounds) ? file.backgrounds : undefined)
  pending = null
  return result
}
