import { snmpSecretId, type AppSettings, type ConnectionDefaults, type Credential, type EffectiveSettings, type Folder, type Host } from './types'

const BASE: EffectiveSettings = { port: 22, algoProfile: 'compat', webUrl: 'https://{address}', winbox: false, ping: true, snmp: false, jump: true }

/** Folder chain from the root down to the host's folder. Guards against cycles. */
export function folderChain(folders: Folder[], folderId: string | null): Folder[] {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const chain: Folder[] = []
  const seen = new Set<string>()
  let cur = folderId ? byId.get(folderId) : undefined
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    chain.unshift(cur)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return chain
}

function defined(d: ConnectionDefaults): ConnectionDefaults {
  return Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined && v !== ''))
}

/** root.defaults → … → folder.defaults → host.overrides */
export function effectiveSettings(folders: Folder[], host: Host): EffectiveSettings {
  const layers = [...folderChain(folders, host.folderId).map((f) => f.defaults), host.overrides]
  return layers.reduce<EffectiveSettings>((acc, d) => ({ ...acc, ...defined(d) }), { ...BASE })
}

export function renderUrl(template: string, host: Host, s: EffectiveSettings): string {
  return template
    .replaceAll('{address}', host.address)
    .replaceAll('{name}', encodeURIComponent(host.name))
    .replaceAll('{port}', String(s.port))
    .replaceAll('{username}', encodeURIComponent(s.username ?? ''))
}

/** Host first, then its folders from the nearest up to the root. */
function levels(folders: Folder[], host: Host): { id: string; name: string; d: ConnectionDefaults; isHost: boolean }[] {
  return [
    { id: host.id, name: host.name, d: host.overrides, isHost: true },
    ...folderChain(folders, host.folderId)
      .reverse()
      .map((f) => ({ id: f.id, name: f.name, d: f.defaults, isHost: false }))
  ]
}

export interface Login {
  username?: string
  /** Secret id holding the password, if any. */
  secretId?: string
  /** Where the password came from, for the UI: "учётка «…»" or "папка «…»". */
  source?: { kind: 'credential' | 'folder' | 'host'; name: string }
  /** The username was set closer to the host than the saved account the password comes from. */
  usernameOverride?: boolean
}

/**
 * Login for a host. Username and password each come from the nearest level (host, then its folders
 * up to the root) that sets them, like every other setting: a saved account sets both, a typed-in
 * username only the username, an own password only the password. So a host or a subfolder can
 * change the username and keep the password from above, and nothing set closer to the host is
 * silently overruled by an account further up.
 */
export function resolveLogin(folders: Folder[], credentials: Credential[], host: Host, secretIds: Iterable<string>): Login {
  const has = new Set(secretIds)
  let username: string | undefined
  let userLevel = -1
  let password: { secretId?: string; source: NonNullable<Login['source']>; level: number } | undefined
  levels(folders, host).forEach((l, i) => {
    const cred = l.d.credentialId ? credentials.find((x) => x.id === l.d.credentialId) : undefined
    if (username === undefined) {
      if (cred) (username = cred.username), (userLevel = i)
      else if (l.d.username) (username = l.d.username), (userLevel = i)
    }
    if (!password) {
      if (cred) password = { secretId: has.has(cred.id) ? cred.id : undefined, source: { kind: 'credential', name: cred.name }, level: i }
      else if (has.has(l.id)) password = { secretId: l.id, source: { kind: l.isHost ? 'host' : 'folder', name: l.name }, level: i }
    }
  })
  if (!password) return { username }
  return {
    username,
    secretId: password.secretId,
    source: password.source,
    usernameOverride: password.source.kind === 'credential' && userLevel < password.level
  }
}

/** SNMP community: nearest level with one set. */
export function snmpCommunityOwner(folders: Folder[], host: Host, secretIds: Iterable<string>): string | undefined {
  const has = new Set(secretIds)
  return levels(folders, host).find((l) => has.has(snmpSecretId(l.id)))?.id
}

/** Whether this host's SSH, web and WinBox go through the jump host. */
export function usesJump(settings: AppSettings | undefined, s: EffectiveSettings, host: Host): boolean {
  const j = settings?.jump
  return !!(j?.enabled && j.address && s.jump && host.address !== j.address)
}

/** Settings a host or folder can take from above or set itself (icon and colour aside). */
export type InheritField = 'login' | 'port' | 'algoProfile' | 'jump' | 'ping' | 'snmp' | 'webUrl' | 'winbox'

export const INHERIT_LABEL: Record<InheritField, string> = {
  login: 'логин и пароль',
  port: 'порт',
  algoProfile: 'алгоритмы',
  jump: 'jump-host',
  ping: 'ping',
  snmp: 'SNMP',
  webUrl: 'веб-адрес',
  winbox: 'WinBox'
}

/** What this level sets itself instead of taking it from its folders. */
export function ownFields(id: string, d: ConnectionDefaults, secretIds: Iterable<string>): InheritField[] {
  const has = new Set(secretIds)
  const out: InheritField[] = []
  if (d.credentialId || d.username || has.has(id)) out.push('login')
  for (const k of ['port', 'algoProfile', 'jump', 'ping', 'snmp', 'webUrl', 'winbox'] as const) {
    if (d[k] !== undefined && d[k] !== '') out.push(k)
  }
  return out
}

/** The same level with those settings taken from above again. The own password, if any, is the caller's to delete. */
export function dropOwn(d: ConnectionDefaults, fields: InheritField[]): ConnectionDefaults {
  const next = { ...d }
  for (const f of fields) {
    if (f === 'login') {
      delete next.credentialId
      delete next.username
    } else delete next[f]
  }
  return next
}
