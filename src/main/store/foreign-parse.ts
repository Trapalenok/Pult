import type { SqlJsStatic } from 'sql.js'
import type { Folder, ForeignField, ForeignMapping, ForeignOptions, ForeignPlan, ForeignPreview, ForeignTable, Host, Store } from '@shared/types'

/*
 * Reading host lists out of other programs' bases: an SQLite file of a web SSH manager, a CSV
 * from a spreadsheet, a JSON export. No electron imports here, so test/foreign-import.mjs can
 * run it under plain node.
 */

export interface RawTable {
  name: string
  columns: string[]
  rows: unknown[][]
}

export interface RawFile {
  format: ForeignPreview['format']
  tables: RawTable[]
}

const MAX_ROWS = 200_000

/* ── Reading ───────────────────────────────────────────────── */

export function isSqlite(buf: Uint8Array): boolean {
  return Buffer.from(buf.subarray(0, 16)).toString('latin1') === 'SQLite format 3\0'
}

/** UTF-8 (with or without BOM), else Windows-1251, which Russian Excel saves CSV in. */
export function decodeText(buf: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '')
  } catch {
    return new TextDecoder('windows-1251').decode(buf)
  }
}

export function readSqlite(buf: Uint8Array, SQL: SqlJsStatic): RawFile {
  const db = new SQL.Database(buf)
  try {
    const names = db.exec("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
    const tables = (names[0]?.values ?? []).map(([n]) => {
      const name = String(n)
      const q = `"${name.replaceAll('"', '""')}"`
      const res = db.exec(`SELECT * FROM ${q} LIMIT ${MAX_ROWS}`)[0]
      const columns = res?.columns ?? (db.exec(`PRAGMA table_info(${q})`)[0]?.values ?? []).map((r) => String(r[1]))
      return { name, columns, rows: res?.values ?? [] }
    })
    return { format: 'sqlite', tables }
  } finally {
    db.close()
  }
}

/** RFC 4180 CSV; the delimiter (; , tab |) is picked from the header line. */
export function parseCsv(text: string, name = 'CSV'): RawTable {
  const firstLine = text.slice(0, text.search(/\r?\n|$/))
  const count = (d: string) => firstLine.split(d).length - 1
  const delim = [';', ',', '\t', '|'].reduce((best, d) => (count(d) > count(best) ? d : best), ',')
  const records: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === delim) row.push(cell), (cell = '')
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      if (row.some((c) => c !== '')) records.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  row.push(cell)
  if (row.some((c) => c !== '')) records.push(row)
  const [head = [], ...rows] = records
  return { name, columns: uniqueColumns(head), rows: rows.slice(0, MAX_ROWS) }
}

function uniqueColumns(head: string[]): string[] {
  const seen = new Map<string, number>()
  return head.map((h, i) => {
    const base = h.trim() || `Колонка ${i + 1}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n ? `${base} (${n + 1})` : base
  })
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Nested objects become dotted columns: credentials.username. */
function flatten(o: Record<string, unknown>, prefix = '', out: Record<string, unknown> = {}, depth = 0): Record<string, unknown> {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (isObj(v) && depth < 3) flatten(v, key, out, depth + 1)
    else out[key] = v
  }
  return out
}

function objectsToTable(name: string, items: Record<string, unknown>[]): RawTable {
  const flat = items.slice(0, MAX_ROWS).map((x) => flatten(x))
  const columns: string[] = []
  const known = new Set<string>()
  for (const r of flat) for (const k of Object.keys(r)) if (!known.has(k)) known.add(k), columns.push(k)
  return { name, columns, rows: flat.map((r) => columns.map((c) => r[c])) }
}

/**
 * Every list of objects in the file becomes a table named by its path: the root array, or
 * {"hosts": [...], "groups": [...]}. A map of objects ({"sw1": {...}, "sw2": {...}}) counts too,
 * its keys going into a "key" column.
 */
class PultConfigError extends Error {}

export function parseJson(text: string): RawFile {
  const root: unknown = JSON.parse(text)
  if (isObj(root) && root.format === 'ssh-client-config') {
    throw new PultConfigError('Это экспорт Pult. Откройте Настройки → Перенос конфигурации → Импорт. Там будут восстановлены учётные записи и запрошен пароль файла, если он содержит зашифрованные пароли.')
  }
  if (isObj(root) && Array.isArray(root.hosts) && Array.isArray(root.folders) && isObj(root.secrets) && isObj(root.knownHosts)) {
    throw new PultConfigError('Это рабочий store.json Pult. Его пароли привязаны к исходной системе. На исходном ПК выполните «Перенос конфигурации → Экспорт» с включёнными паролями, затем импортируйте полученный файл через «Перенос конфигурации → Импорт».')
  }
  const tables: RawTable[] = []
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > 4) return
    if (Array.isArray(v)) {
      const objs = v.filter(isObj)
      if (objs.length && objs.length >= v.length / 2) tables.push(objectsToTable(path, objs))
      return
    }
    if (!isObj(v)) return
    const vals = Object.values(v)
    if (vals.length >= 2 && vals.every((x) => isObj(x) && Object.keys(x).length >= 2 && !Object.values(x).some(Array.isArray))) {
      tables.push(objectsToTable(path, Object.entries(v).map(([key, x]) => ({ key, ...(x as Record<string, unknown>) }))))
      return
    }
    for (const [k, x] of Object.entries(v)) walk(x, path === '$' ? k : `${path}.${k}`, depth + 1)
  }
  walk(root, '$', 0)
  return { format: 'json', tables }
}

/** SQLite by its header, else JSON if it parses, else CSV. */
export function readForeign(buf: Uint8Array, fileName: string, SQL: () => Promise<SqlJsStatic>): Promise<RawFile> | RawFile {
  if (isSqlite(buf)) return SQL().then((s) => readSqlite(buf, s))
  if (/\.(sqlite3?|db3?|s3db)$/i.test(fileName))
    throw new Error('Файл не похож на базу SQLite. Возможно, она зашифрована (SQLCipher) или это не та база.')
  const text = decodeText(buf)
  if (/^\s*[[{]/.test(text)) {
    try {
      return parseJson(text)
    } catch (e) {
      if (e instanceof PultConfigError) throw e
      if (/\.json$/i.test(fileName)) throw new Error('JSON-файл не читается: в нём ошибка синтаксиса')
    }
  }
  return { format: 'csv', tables: [parseCsv(text, fileName.replace(/\.[^.]+$/, '') || 'CSV')] }
}

/* ── Guessing columns ──────────────────────────────────────── */

export const cellText = (v: unknown): string => {
  if (v === null || v === undefined) return ''
  if (v instanceof Uint8Array) return ''
  if (Array.isArray(v)) return v.map(cellText).filter(Boolean).join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v).trim()
}

// Normalised header names, best first.
const SYNONYMS: Record<ForeignField, string[]> = {
  address: ['ip', 'ipaddress', 'ipaddr', 'address', 'addr', 'host', 'hostname', 'hostaddress', 'server', 'serveraddress', 'remotehost', 'target', 'адрес', 'ipадрес', 'хост'],
  name: ['name', 'label', 'title', 'alias', 'displayname', 'caption', 'servername', 'devicename', 'hostname', 'description', 'имя', 'название', 'наименование'],
  port: ['port', 'sshport', 'remoteport', 'порт'],
  username: ['username', 'user', 'login', 'loginname', 'account', 'usr', 'sshuser', 'пользователь', 'логин', 'учетка'],
  password: ['password', 'pass', 'passwd', 'pwd', 'secret', 'sshpassword', 'пароль'],
  folder: ['folder', 'group', 'foldername', 'groupname', 'folderid', 'groupid', 'path', 'category', 'directory', 'dir', 'location', 'site', 'tags', 'tag', 'папка', 'группа', 'категория'],
  protocol: ['protocol', 'proto', 'connectiontype', 'scheme', 'протокол']
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-.:()]/g, '').replace(/ё/g, 'е')

export const looksLikeHost = (v: string) =>
  /^(\S+@)?(\d{1,3}(\.\d{1,3}){3}|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+|\[?[0-9a-f:]+:[0-9a-f:]+\]?)(:\d{1,5})?$/i.test(v)

const SECRETISH = /pass|pwd|secret|парол|token|privatekey|passphrase/i

function headerScore(field: ForeignField, column: string): number {
  const list = SYNONYMS[field]
  const whole = norm(column)
  const last = norm(column.split('.').pop() ?? column)
  for (const n of [whole, last]) {
    const i = list.indexOf(n)
    if (i >= 0) return 100 - i
  }
  const j = list.findIndex((s) => s.length >= 4 && last.includes(s))
  return j >= 0 ? 50 - j : 0
}

export function guessMapping(t: RawTable): ForeignMapping {
  const sample = t.rows.slice(0, 50)
  const values = (ci: number) => sample.map((r) => cellText(r[ci])).filter(Boolean)
  const hostShare = (ci: number) => {
    const v = values(ci)
    return v.length ? v.filter(looksLikeHost).length / v.length : 0
  }
  const used = new Set<number>()
  const out: ForeignMapping = {}
  const pick = (field: ForeignField, extra: (ci: number) => number = () => 0, min = 1) => {
    let best = -1
    let bestScore = 0
    t.columns.forEach((c, ci) => {
      if (used.has(ci) || /^(id|uuid|rowid|_id)$/i.test(norm(c))) return
      const s = headerScore(field, c) + extra(ci)
      if (s > bestScore) (best = ci), (bestScore = s)
    })
    if (best >= 0 && bestScore >= min) {
      used.add(best)
      out[field] = t.columns[best]
    }
  }
  // The address column is the one that holds addresses, whatever it is called.
  pick('address', (ci) => hostShare(ci) * 60, 30)
  pick('name', (ci) => (hostShare(ci) > 0.9 && /\d{1,3}(\.\d{1,3}){3}/.test(values(ci)[0] ?? '') ? -30 : 0))
  pick('port', (ci) => (values(ci).every((v) => /^\d{1,5}$/.test(v)) ? 0 : -60))
  pick('username')
  pick('password')
  pick('folder')
  pick('protocol')
  if (!out.protocol) {
    // "type" only when it really holds protocols, not device kinds.
    const ci = t.columns.findIndex((c, i) => !used.has(i) && norm(c) === 'type' && values(i).some((v) => /^(ssh|rdp|vnc|telnet)/i.test(v)))
    if (ci >= 0) out.protocol = t.columns[ci]
  }
  return out
}

function tableScore(t: RawTable, g: ForeignMapping): number {
  if (!g.address || !t.rows.length) return 0
  return 10 + Object.keys(g).length * 3 + Math.min(Math.log10(t.rows.length + 1), 4)
}

export function previewTables(file: RawFile): { tables: ForeignTable[]; bestTable: string } {
  let bestTable = file.tables[0]?.name ?? ''
  let best = -1
  const tables = file.tables.map((t) => {
    const guess = guessMapping(t)
    const score = tableScore(t, guess)
    if (score > best) (best = score), (bestTable = t.name)
    const masked = new Set(t.columns.map((c, i) => (SECRETISH.test(c) || c === guess.password ? i : -1)))
    const sample = t.rows.slice(0, 5).map((r) => t.columns.map((_, i) => (masked.has(i) && cellText(r[i]) ? '••••••' : cellText(r[i]).slice(0, 80))))
    return { name: t.name, columns: t.columns, rowCount: t.rows.length, sample, guess }
  })
  return { tables, bestTable }
}

/* ── Building hosts ────────────────────────────────────────── */

/** MAX_ADDRESSES - 1 from shared/types; kept local so this file stays type-only-importing for the node test. */
const EXTRA_ADDRESSES = 2

/** "admin@10.0.0.1:2222" → its parts. */
export function splitAddress(raw: string): { address: string; port?: number; username?: string } {
  let s = raw.trim().replace(/^ssh:\/\//i, '').replace(/\/.*$/, '')
  let username: string | undefined
  const at = s.lastIndexOf('@')
  if (at > 0) (username = s.slice(0, at)), (s = s.slice(at + 1))
  let port: number | undefined
  const v6 = /^\[(.+)\](?::(\d+))?$/.exec(s)
  if (v6) return { address: v6[1], port: v6[2] ? Number(v6[2]) : undefined, username }
  const m = /^([^:]+):(\d{1,5})$/.exec(s)
  if (m) (s = m[1]), (port = Number(m[2]))
  return { address: s, port, username }
}

const ENCRYPTED = /^(\$2[aby]?\$|\$argon2|\$[156]\$|\{S?SHA|[0-9a-f]{32,}$|[A-Za-z0-9+/]{40,}={0,2}$|[A-Za-z0-9+/=]{16,}:[A-Za-z0-9+/=]{16,})/

/**
 * Folder ids in the folder column (Nexterm-style folderId → folders table) are looked up in the
 * table that has those ids in an id column, walking its parent column for nesting.
 */
function folderLookup(file: RawFile, table: RawTable, column: string): { table: string; path: (v: string) => string[] } | undefined {
  const ci = table.columns.indexOf(column)
  const ids = [...new Set(table.rows.map((r) => cellText(r[ci])).filter(Boolean))]
  if (!ids.length || !ids.every((v) => /^[\w-]{1,64}$/.test(v)) || ids.some((v) => /[a-zа-я]{4,}/i.test(v) && !/^[0-9a-f-]{8,}$/i.test(v))) return
  for (const t of file.tables) {
    if (t === table) continue
    const idCol = t.columns.findIndex((c) => /^(id|uuid|_id|key)$/i.test(c))
    if (idCol < 0) continue
    const nameCol = t.columns.findIndex((c, i) => i !== idCol && headerScore('name', c) >= 90)
    if (nameCol < 0) continue
    const parentCol = t.columns.findIndex((c) => /^parent(_?id)?$|^parentfolder(id)?$|^parentgroup(id)?$/i.test(norm(c)))
    const byId = new Map(t.rows.map((r) => [cellText(r[idCol]), r]))
    if (!ids.every((v) => byId.has(v))) continue
    return {
      table: t.name,
      path: (v) => {
        const out: string[] = []
        const seen = new Set<string>()
        let cur = byId.get(v)
        while (cur && out.length < 16) {
          const id = cellText(cur[idCol])
          if (seen.has(id)) break
          seen.add(id)
          out.unshift(cellText(cur[nameCol]) || id)
          cur = parentCol >= 0 ? byId.get(cellText(cur[parentCol])) : undefined
        }
        return out
      }
    }
  }
}

/** "Офис/Этаж 1/Серверная" (also \ and >) → nested folders. */
const splitPath = (v: string) => v.split(/\s*[/\\>]\s*/).map((s) => s.trim()).filter(Boolean)

/**
 * The whole import, as a pure function: the base after it, the passwords to encrypt (keyed by
 * new host ids) and a summary. Run once for the preview, again for real.
 */
export function buildImport(
  cur: Store,
  file: RawFile,
  opts: ForeignOptions,
  newId: () => string
): { store: Store; secrets: Record<string, string>; plan: ForeignPlan } {
  const table = file.tables.find((t) => t.name === opts.table)
  if (!table) throw new Error('В файле нет такой таблицы')
  const col = (f: ForeignField) => {
    const name = opts.mapping[f]
    const i = name === undefined ? -1 : table.columns.indexOf(name)
    return (r: unknown[]) => (i < 0 ? '' : cellText(r[i]))
  }
  const get = Object.fromEntries((Object.keys(SYNONYMS) as ForeignField[]).map((f) => [f, col(f)])) as Record<ForeignField, (r: unknown[]) => string>
  if (!opts.mapping.address) throw new Error('Выберите колонку с адресом')
  const lookup = opts.mapping.folder ? folderLookup(file, table, opts.mapping.folder) : undefined

  const folders: Folder[] = [...cur.folders]
  const hosts: Host[] = [...cur.hosts]
  const secrets: Record<string, string> = {}
  const plan: ForeignPlan = { rows: table.rows.length, hosts: 0, duplicates: 0, noAddress: 0, notSsh: 0, folders: 0, passwords: 0, passwordsLookEncrypted: false, folderLookup: lookup?.table, sample: [] }

  const child = (parentId: string | null, name: string): string => {
    const have = folders.find((f) => f.parentId === parentId && f.name.toLowerCase() === name.toLowerCase())
    if (have) return have.id
    const f: Folder = { id: newId(), parentId, name, defaults: {} }
    folders.push(f)
    plan.folders++
    return f.id
  }
  if (opts.targetFolderId && !folders.some((f) => f.id === opts.targetFolderId)) throw new Error('Папка назначения удалена, выберите другую')
  const base = opts.newFolder?.trim() ? child(opts.targetFolderId, opts.newFolder.trim()) : opts.targetFolderId
  const baseLen = plan.folders
  const namesOf = new Map(folders.map((f) => [f.id, f.name]))

  const key = (address: string, port: number) => `${address.toLowerCase()}:${port}`
  const seen = new Set(cur.hosts.map((h) => key(h.address, h.overrides.port ?? 22)))
  let encrypted = 0

  for (const r of table.rows) {
    const proto = get.protocol(r).toLowerCase()
    if (proto && !proto.includes('ssh') && proto !== '22') {
      plan.notSsh++
      continue
    }
    // A cell may list several addresses of one device ("10.0.0.1, 10.1.0.1"): the first is the main one.
    const [first = '', ...more] = get.address(r).split(/[,;\s]+/).filter(Boolean)
    const parts = splitAddress(first)
    const extra = [...new Set(more.map((m) => splitAddress(m).address).filter((a) => a && a !== parts.address))].slice(0, EXTRA_ADDRESSES)
    if (!parts.address) {
      plan.noAddress++
      continue
    }
    const p = Number(get.port(r))
    const port = Number.isInteger(p) && p > 0 && p < 65536 ? p : parts.port
    const k = key(parts.address, port ?? 22)
    if (seen.has(k) && opts.duplicates === 'skip') {
      plan.duplicates++
      continue
    }
    seen.add(k)

    let folderId = base
    const fv = get.folder(r)
    if (fv) {
      const path = lookup ? lookup.path(fv) : splitPath(fv.split(',')[0])
      for (const seg of path) folderId = child(folderId, seg)
    }
    const username = get.username(r) || parts.username
    const host: Host = {
      id: newId(),
      folderId,
      name: get.name(r) || parts.address,
      address: parts.address,
      ...(extra.length ? { addresses: extra } : {}),
      overrides: { ...(port && port !== 22 ? { port } : {}), ...(username ? { username } : {}) }
    }
    hosts.push(host)
    plan.hosts++
    const pw = get.password(r)
    if (pw) {
      secrets[host.id] = pw
      plan.passwords++
      if (ENCRYPTED.test(pw)) encrypted++
    }
    if (plan.sample.length < 8) {
      for (const f of folders) namesOf.set(f.id, f.name)
      const chain: string[] = []
      for (let id = folderId; id; id = folders.find((f) => f.id === id)?.parentId ?? null) chain.unshift(namesOf.get(id) ?? '')
      plan.sample.push({ name: host.name, address: host.address, port, username, folder: chain.join(' / '), password: !!pw })
    }
  }
  plan.passwordsLookEncrypted = plan.passwords > 0 && encrypted / plan.passwords > 0.6
  // A folder made only for this import, with nothing put in it, is not worth creating.
  if (plan.hosts === 0 && baseLen) {
    folders.splice(folders.length - plan.folders, plan.folders)
    plan.folders = 0
  }
  return { store: { ...cur, folders, hosts }, secrets, plan }
}
