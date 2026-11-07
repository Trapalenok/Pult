import { app, dialog, type BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { extname, join } from 'path'
import type { MapBackgroundFile, Store } from '@shared/types'

/*
 * Map backdrops (a floor plan, a site photo) are kept as files next to the base, not inside it:
 * the base is rewritten and sent to the window on every change, a picture would ride along each time.
 */

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp', '.svg': 'image/svg+xml' }
const MAX_BYTES = 40 * 1024 * 1024
/** Our own file names only: nothing outside the folder can be asked for. */
const NAME = /^[0-9a-f-]{36}\.(png|jpe?g|gif|bmp|webp|svg)$/i

const dir = () => join(app.getPath('userData'), 'map-backgrounds')
const dataUrl = (name: string, data: Buffer) => `data:${MIME[extname(name).toLowerCase()]};base64,${data.toString('base64')}`

/** Open dialog, then a copy of the picture goes into the backdrop folder. Null when cancelled. */
export async function pickBackground(win: BrowserWindow | null): Promise<MapBackgroundFile | null> {
  const opts = {
    title: 'Подложка для листа карты',
    properties: ['openFile' as const],
    filters: [{ name: 'Изображения', extensions: Object.keys(MIME).map((e) => e.slice(1)) }]
  }
  const { canceled, filePaths } = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (canceled || !filePaths[0]) return null
  const ext = extname(filePaths[0]).toLowerCase()
  if (!MIME[ext]) throw new Error('Нужна картинка: PNG, JPEG, GIF, BMP, WebP или SVG')
  if (statSync(filePaths[0]).size > MAX_BYTES) throw new Error('Картинка больше 40 МБ, уменьшите её')
  const data = readFileSync(filePaths[0])
  const file = `${randomUUID()}${ext}`
  mkdirSync(dir(), { recursive: true })
  writeFileSync(join(dir(), file), data)
  return { file, url: dataUrl(file, data) }
}

/** The picture as a data: URL (the window's CSP allows only those), or null when the file is gone. */
export function loadBackground(file: string): string | null {
  if (!NAME.test(file)) return null
  const p = join(dir(), file)
  return existsSync(p) ? dataUrl(file, readFileSync(p)) : null
}

/** Pictures the maps point at, for a config export. */
export function backgroundsOf(store: Store): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of store.maps) {
    const f = m.background?.file
    if (!f || !NAME.test(f) || out[f]) continue
    const p = join(dir(), f)
    if (existsSync(p)) out[f] = readFileSync(p).toString('base64')
  }
  return out
}

/** Pictures from an imported file; ones already here are left as they are. */
export function restoreBackgrounds(files: Record<string, unknown> | undefined): void {
  if (!files) return
  mkdirSync(dir(), { recursive: true })
  for (const [f, b64] of Object.entries(files)) {
    const p = join(dir(), f)
    if (NAME.test(f) && typeof b64 === 'string' && !existsSync(p)) writeFileSync(p, Buffer.from(b64, 'base64'))
  }
}

/** Drops pictures no sheet uses any more (replaced or removed backdrops, deleted sheets). */
export function pruneBackgrounds(store: Store): void {
  if (!existsSync(dir())) return
  const used = new Set(store.maps.map((m) => m.background?.file).filter(Boolean))
  for (const f of readdirSync(dir())) {
    if (NAME.test(f) && !used.has(f)) {
      try {
        unlinkSync(join(dir(), f))
      } catch {
        /* in use or already gone: next start */
      }
    }
  }
}
