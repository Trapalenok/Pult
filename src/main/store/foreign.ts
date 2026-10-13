import { dialog, type BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { readFileSync, statSync } from 'fs'
import { basename } from 'path'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import type { ForeignOptions, ForeignPlan, ForeignPreview, StoreSnapshot } from '@shared/types'
import { buildImport, previewTables, readForeign, type RawFile } from './foreign-parse'
import { applyImport, loadStore } from './json-store'

/*
 * Import from another program's base. The file is only read, never written. SQLite goes
 * through sql.js (WebAssembly), so the build needs no native modules.
 */

let sql: Promise<SqlJsStatic> | null = null
const SQL = () => (sql ??= initSqlJs())

/** The file between preview and apply. Only the latest one is kept. */
let pending: { token: string; file: RawFile } | null = null

export async function foreignPick(win: BrowserWindow | null): Promise<ForeignPreview | null> {
  const opts = {
    title: 'Импорт из другой базы',
    properties: ['openFile' as const],
    filters: [
      { name: 'Базы и таблицы', extensions: ['sqlite', 'sqlite3', 'db', 'db3', 's3db', 'csv', 'txt', 'json'] },
      { name: 'Все файлы', extensions: ['*'] }
    ]
  }
  const { canceled, filePaths } = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (canceled || !filePaths[0]) return null
  if (statSync(filePaths[0]).size > 512 * 1024 * 1024) throw new Error('Файл больше 512 МБ, это вряд ли база хостов')
  const name = basename(filePaths[0])
  const file = await readForeign(readFileSync(filePaths[0]), name, SQL)
  if (!file.tables.length) throw new Error('В файле не нашлось ни одной таблицы')
  pending = { token: randomUUID(), file }
  return { token: pending.token, fileName: name, format: file.format, ...previewTables(file) }
}

function opened(token: string): RawFile {
  if (!pending || pending.token !== token) throw new Error('Файл больше не открыт, выберите его ещё раз')
  return pending.file
}

export function foreignPlan(token: string, opts: ForeignOptions): ForeignPlan {
  return buildImport(loadStore(), opened(token), opts, randomUUID).plan
}

export function foreignApply(token: string, opts: ForeignOptions): { snapshot: StoreSnapshot; plan: ForeignPlan } {
  const { secretIds: _s, ...cur } = loadStore()
  const { store, secrets, plan } = buildImport(cur, opened(token), opts, randomUUID)
  const snapshot = applyImport(store, {}, secrets)
  pending = null
  return { snapshot, plan }
}
