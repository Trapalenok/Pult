import { dropOwn, effectiveSettings, folderChain, INHERIT_LABEL, ownFields, type InheritField } from '@shared/inherit'
import type { AlgoProfile, Folder, FolderKind, Host, HostIcon, HostStatus, Store, StoreSnapshot, Tint } from '@shared/types'
import type { IconName } from './design/icons'

/** A host's colour: its own, else the nearest folder's, else blue. */
export function hostTint(store: Store, host: Host): Tint {
  return host.tint ?? folderChain(store.folders, host.folderId).reverse().find((f) => f.tint)?.tint ?? 'blue'
}

/** The folder and every folder nested in it, at any depth. */
export function subtreeIds(folders: Folder[], rootId: string): Set<string> {
  const ids = new Set([rootId])
  let grew = true
  while (grew) {
    grew = false
    for (const f of folders) {
      if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
        ids.add(f.id)
        grew = true
      }
    }
  }
  return ids
}

export function hostsInSubtree(store: Store, folderId: string): Host[] {
  const ids = subtreeIds(store.folders, folderId)
  return store.hosts.filter((h) => h.folderId && ids.has(h.folderId))
}

export function folderPath(folders: Folder[], id: string | null): string {
  return folderChain(folders, id).map((f) => f.name).join(' / ')
}

/** 1 хост, 2 хоста, 5 хостов */
export const plural = (n: number, one: string, few: string, many: string) =>
  `${n} ${n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many}`

export const ALGO_LABEL: Record<AlgoProfile, string> = {
  compat: 'Авто: новые и старые',
  modern: 'Только современные',
  legacy: 'Старые в приоритете'
}

export const TINTS: Tint[] = ['blue', 'indigo', 'purple', 'pink', 'red', 'orange', 'green', 'teal', 'gray']

export const newId = () => crypto.randomUUID()

export function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  // ipcRenderer.invoke wraps main-process errors; the wrapper text means nothing to the user.
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}


/** Physical levels: Здание → Этаж → Помещение → Стойка / Кросс. Only the icon and the default for a new subfolder depend on it. */
export const FOLDER_KINDS: { kind: FolderKind; label: string; icon: IconName; next: FolderKind }[] = [
  { kind: 'folder', label: 'Папка', icon: 'folder', next: 'folder' },
  { kind: 'building', label: 'Здание', icon: 'building', next: 'floor' },
  { kind: 'floor', label: 'Этаж', icon: 'floor', next: 'room' },
  { kind: 'room', label: 'Помещение', icon: 'room', next: 'cross' },
  { kind: 'rack', label: 'Стойка', icon: 'rack', next: 'folder' },
  { kind: 'cross', label: 'Кросс', icon: 'cross', next: 'folder' }
]
/** Icons a host can show; picked in the host sheet or for many hosts at once. */
export const HOST_ICONS: { icon: HostIcon; label: string }[] = [
  { icon: 'server', label: 'Сервер' },
  { icon: 'router', label: 'Роутер' },
  { icon: 'switch', label: 'Коммутатор' },
  { icon: 'firewall', label: 'Firewall' },
  { icon: 'wifi', label: 'Wi-Fi' },
  { icon: 'camera', label: 'Камера' },
  { icon: 'pc', label: 'ПК' },
  { icon: 'printer', label: 'Принтер' },
  { icon: 'storage', label: 'Хранилище' },
  { icon: 'phone', label: 'Телефон' }
]

/** A host's icon: its own, else a router for WinBox hosts, else a server. */
export function hostIcon(store: Store, host: Host): HostIcon {
  return host.icon ?? (effectiveSettings(store.folders, host).winbox ? 'router' : 'server')
}

export const kindMeta = (k?: FolderKind) => FOLDER_KINDS.find((x) => x.kind === (k ?? 'folder'))!

export type Health = 'up' | 'down' | 'unknown'
export function health(s?: HostStatus): Health {
  if (!s || s.alive === null) return 'unknown'
  return s.alive ? 'up' : 'down'
}

/** Up/down counts for a set of hosts. */
export function healthSummary(hostIds: string[], status: Map<string, HostStatus>): { up: number; down: number; unknown: number } {
  const r = { up: 0, down: 0, unknown: 0 }
  hostIds.forEach((id) => r[health(status.get(id))]++)
  return r
}

export function formatUptime(sec?: number): string | undefined {
  if (sec === undefined) return undefined
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return d ? `${d} д ${h} ч` : h ? `${h} ч ${m} мин` : `${m} мин`
}

export function formatRtt(ms?: number): string | undefined {
  if (ms === undefined) return undefined
  return ms < 1 ? '<1 мс' : `${Math.round(ms)} мс`
}

/** How many of these hosts and folders set something themselves, per setting. */
export function ownSummary(store: StoreSnapshot, hostIds: string[], folderIds: string[]): { items: number; fields: Partial<Record<InheritField, number>> } {
  const want = { h: new Set(hostIds), f: new Set(folderIds) }
  const levels = [
    ...store.hosts.filter((h) => want.h.has(h.id)).map((h) => ownFields(h.id, h.overrides, store.secretIds)),
    ...store.folders.filter((f) => want.f.has(f.id)).map((f) => ownFields(f.id, f.defaults, store.secretIds))
  ]
  const fields: Partial<Record<InheritField, number>> = {}
  levels.forEach((l) => l.forEach((x) => (fields[x] = (fields[x] ?? 0) + 1)))
  return { items: levels.filter((l) => l.length).length, fields }
}

/** "логин и пароль: 8, порт: 2" */
export const describeOwn = (fields: Partial<Record<InheritField, number>>) =>
  (Object.entries(fields) as [InheritField, number][]).map(([k, n]) => `${INHERIT_LABEL[k]}: ${n}`).join(', ')

/**
 * These hosts and folders drop every connection setting of their own (login and password, port,
 * algorithms, jump-host, monitoring, web, WinBox) and take them from their folders again.
 * Returns the new base and the own passwords to delete.
 */
export function inheritFromFolders(store: StoreSnapshot, hostIds: string[], folderIds: string[]): { store: StoreSnapshot; ops: [string, null][] } {
  const want = { h: new Set(hostIds), f: new Set(folderIds) }
  const ops: [string, null][] = []
  const reset = <T extends { id: string }>(x: T, d: Host['overrides']) => {
    const own = ownFields(x.id, d, store.secretIds)
    if (own.includes('login') && store.secretIds.includes(x.id)) ops.push([x.id, null])
    return dropOwn(d, own)
  }
  return {
    ops,
    store: {
      ...store,
      hosts: store.hosts.map((h) => (want.h.has(h.id) ? { ...h, overrides: reset(h, h.overrides) } : h)),
      folders: store.folders.map((f) => (want.f.has(f.id) ? { ...f, defaults: reset(f, f.defaults) } : f))
    }
  }
}

/**
 * Moves hosts and folders into `target` (null = top level). A folder never goes into itself or
 * anything inside it; such folders are left where they are.
 */
export function moveInto<T extends Store>(store: T, hostIds: string[], folderIds: string[], target: string | null): T {
  const blocked = new Set<string>()
  for (const id of folderIds) if (target && subtreeIds(store.folders, id).has(target)) blocked.add(id)
  const fs = new Set(folderIds.filter((id) => !blocked.has(id)))
  const hs = new Set(hostIds)
  return {
    ...store,
    folders: store.folders.map((f) => (fs.has(f.id) ? { ...f, parentId: target } : f)),
    hosts: store.hosts.map((h) => (hs.has(h.id) ? { ...h, folderId: target } : h))
  }
}
