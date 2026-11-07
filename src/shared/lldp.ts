import type { Host } from './types'

export interface LldpAutoStatus {
  hostId: string
  state: 'disabled' | 'running' | 'ok' | 'error'
  checkedAt?: number
  nextAt?: number
  error?: string
}

/** Typed bytes: a textual chassis ID must never equal a MAC with the same spelling. */
export interface LldpId {
  subtype: number
  hex: string
  text: string
}

export interface LldpNeighbor {
  key: string
  localPort: string
  localPortId?: LldpId
  chassisId: LldpId
  portId: LldpId
  portDescription: string
  systemName: string
  addresses: string[]
  /** Explicit user choice; discovery never silently creates a binding. */
  hostId?: string
}

export interface LldpSnapshot {
  source: 'snmp'
  address: string
  observedAt: number
  chassisId: LldpId
  systemName: string
  neighbors: LldpNeighbor[]
}

export const lldpIdKey = (id: LldpId): string => JSON.stringify([id.subtype, id.hex])

/** Port ID is not necessarily an interface name. Never substitute chassis ID or infer a port. */
export function lldpPortLabel(id: LldpId): string {
  if (id.subtype === 3) return `MAC порта: ${id.text}`
  if (id.subtype === 5) return id.text
  return `Port ID: ${id.text}`
}

export type LldpMatch = { kind: 'chassis' | 'address' | 'name' | 'conflict' | 'none'; hostIds: string[] }

/** Suggestions only. Contradictory identities and duplicate addresses require a user choice. */
export function matchLldpNeighbor(n: LldpNeighbor, hosts: Host[], sourceHostId: string): LldpMatch {
  const candidates = hosts.filter((h) => h.id !== sourceHostId)
  const chassis = candidates.filter((h) => validLldpSnapshot(h.lldp) && lldpIdKey(h.lldp.chassisId) === lldpIdKey(n.chassisId))
  const ips = new Set(n.addresses.map(managementIp).filter(Boolean))
  const address = candidates.filter((h) => [h.address, ...(h.addresses ?? [])].some((a) => { const ip = managementIp(a); return ip !== undefined && ips.has(ip) }))
  const all = [...new Set([...chassis, ...address].map((h) => h.id))]
  if (all.length > 1) return { kind: 'conflict', hostIds: all }
  if (chassis.length === 1) return { kind: 'chassis', hostIds: all }
  if (address.length === 1) {
    const h = address[0]
    if (validLldpSnapshot(h.lldp) && lldpIdKey(h.lldp.chassisId) !== lldpIdKey(n.chassisId)) return { kind: 'conflict', hostIds: all }
    return { kind: 'address', hostIds: all }
  }
  const names = n.systemName ? candidates.filter((h) => h.name.toLowerCase() === n.systemName.toLowerCase()) : []
  return { kind: names.length ? 'name' : 'none', hostIds: names.map((h) => h.id) }
}

function managementIp(value: string): string | undefined {
  const v = value.trim().replace(/^\[|\]$/g, '')
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(v) && v.split('.').every((n) => Number(n) <= 255)) return v.split('.').map(Number).join('.')
  if (!v.includes(':') || v.includes('%')) return undefined
  try {
    const ip = new URL(`http://[${v}]/`).hostname.slice(1, -1)
    // Link-local address is meaningful only with the receiving interface/scope.
    if (/^fe[89ab]/i.test(ip)) return undefined
    return ip
  } catch { return undefined }
}

/** Used on load/save/import, also clears bindings to deleted hosts. */
export function cleanHostLldp(hosts: Host[]): Host[] {
  const ids = new Set(hosts.map((h) => h.id))
  return hosts.map((h) => {
    if (h.lldp === undefined) return h
    const { lldp, ...rest } = h
    if (!validLldpSnapshot(lldp)) return rest
    return { ...rest, lldp: { ...lldp, neighbors: lldp.neighbors.map((n) => ({ ...n,
      hostId: n.hostId && n.hostId !== h.id && ids.has(n.hostId) ? n.hostId : undefined })) } }
  })
}

/** Never carry a binding over a local chassis replacement or changed remote endpoint. */
export function retainLldpBindings(next: LldpSnapshot, old?: LldpSnapshot): LldpSnapshot {
  if (!old || lldpIdKey(old.chassisId) !== lldpIdKey(next.chassisId)) return next
  const bindings = new Map(old.neighbors.filter((n) => n.hostId).map((n) => [n.key, n.hostId]))
  return { ...next, neighbors: next.neighbors.map((n) => ({ ...n, hostId: bindings.get(n.key) })) }
}

/** Validate persisted/imported data before using it in the UI. No coercion of malformed IDs. */
export function validLldpSnapshot(value: unknown): value is LldpSnapshot {
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const str = (v: unknown) => typeof v === 'string' && v.length <= 4096
  const id = (v: unknown) => obj(v) && Number.isInteger(v.subtype) && Number(v.subtype) >= 1 && Number(v.subtype) <= 7 &&
    typeof v.hex === 'string' && /^(?:[0-9a-f]{2}){1,255}$/.test(v.hex) && str(v.text)
  return obj(value) && value.source === 'snmp' && str(value.address) && typeof value.observedAt === 'number' &&
    Number.isFinite(value.observedAt) && value.observedAt > 0 && id(value.chassisId) && str(value.systemName) &&
    Array.isArray(value.neighbors) && value.neighbors.length <= 4096 && value.neighbors.every((n) =>
      obj(n) && str(n.key) && str(n.localPort) && (n.localPortId === undefined || id(n.localPortId)) && id(n.chassisId) && id(n.portId) &&
      str(n.systemName) && str(n.portDescription) && Array.isArray(n.addresses) && n.addresses.length <= 64 && n.addresses.every(str) &&
      (n.hostId === undefined || str(n.hostId)))
}
