import type { LldpId, LldpNeighbor, LldpSnapshot } from '@shared/lldp'
import { lldpIdKey } from '@shared/lldp'

export const LLDP_LOCAL = '1.0.8802.1.1.2.1.3'
export const LLDP_REMOTE = '1.0.8802.1.1.2.1.4'
export interface LldpVarbind { oid: string; value: unknown }

const text = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : typeof v === 'string' ? v : '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 4096)

function identifier(subtype: unknown, value: unknown, macSubtype: number): LldpId {
  const t = Number(subtype)
  const bytes = Buffer.isBuffer(value) ? value : typeof value === 'string' ? Buffer.from(value, 'utf8') : undefined
  if (!Number.isInteger(t) || t < 1 || t > 7 || !bytes?.length || bytes.length > 255) throw new Error('Неполные идентификаторы LLDP; предыдущие данные сохранены.')
  const hex = bytes.toString('hex')
  return { subtype: t, hex, text: t === macSubtype ? (hex.match(/.{2}/g) ?? []).join(':') : text(bytes) || hex }
}

/** Standard LLDP-MIB indexes, not ifIndex and not permanent remote-row identifiers. */
export function parseLldp(rows: LldpVarbind[], address: string, observedAt = Date.now()): LldpSnapshot {
  const values = new Map(rows.map((v) => [v.oid, v.value]))
  const chassisId = identifier(values.get(`${LLDP_LOCAL}.1.0`), values.get(`${LLDP_LOCAL}.2.0`), 4)
  const remote = new Map<string, Map<number, unknown>>()
  const addresses = new Map<string, string[]>()
  for (const row of rows) {
    const base = `${LLDP_REMOTE}.1.1.`
    if (row.oid.startsWith(base)) {
      const parts = row.oid.slice(base.length).split('.').map(Number)
      if (parts.length !== 4 || parts.some((p) => !Number.isSafeInteger(p) || p < 0)) throw new Error('Некорректный индекс LLDP.')
      const [column, ...index] = parts
      const key = index.join('.')
      const entry = remote.get(key) ?? new Map<number, unknown>()
      entry.set(column, row.value)
      remote.set(key, entry)
    }
    const man = `${LLDP_REMOTE}.2.1.`
    if (row.oid.startsWith(man)) {
      // column.timeMark.localPort.remIndex.addressFamily.addressLength.addressBytes
      const p = row.oid.slice(man.length).split('.').map(Number)
      const [column, time, port, index, family, length, ...bytes] = p
      if (column !== 3) continue // lldpRemManAddrIfSubtype: one instance per address
      if (p.some((v) => !Number.isSafeInteger(v) || v < 0) || bytes.length !== length || bytes.some((b) => b > 255)) throw new Error('Некорректный адрес LLDP.')
      let ip: string | undefined
      if (family === 1 && length === 4) ip = bytes.join('.')
      if (family === 2 && length === 16) {
        const groups = Array.from({ length: 8 }, (_, i) => ((bytes[i * 2] << 8) | bytes[i * 2 + 1]).toString(16))
        // URL uses the platform IPv6 canonicalizer; retain scoped addresses for display only.
        ip = new URL(`http://[${groups.join(':')}]/`).hostname.slice(1, -1)
      }
      if (ip) {
        const key = [time, port, index].join('.')
        const list = addresses.get(key) ?? []
        if (!list.includes(ip)) list.push(ip)
        if (list.length > 64) throw new Error('Слишком много адресов LLDP.')
        addresses.set(key, list)
      }
    }
  }
  const neighbors: LldpNeighbor[] = []
  const keys = new Set<string>()
  for (const [index, fields] of remote) {
    const localNum = index.split('.')[1]
    const localBase = `${LLDP_LOCAL}.7.1`
    const localPortId = identifier(values.get(`${localBase}.2.${localNum}`), values.get(`${localBase}.3.${localNum}`), 3)
    const remoteChassis = identifier(fields.get(4), fields.get(5), 4)
    const portId = identifier(fields.get(6), fields.get(7), 3)
    const key = JSON.stringify([lldpIdKey(localPortId), lldpIdKey(remoteChassis), lldpIdKey(portId)])
    if (keys.has(key)) throw new Error('Таблица LLDP изменилась во время чтения; повторите запрос.')
    keys.add(key)
    neighbors.push({ key, localPort: localPortId.text, localPortId, chassisId: remoteChassis, portId,
      portDescription: text(fields.get(8)), systemName: text(fields.get(9)), addresses: addresses.get(index) ?? [] })
  }
  if (neighbors.length > 4096) throw new Error('Слишком много соседей LLDP.')
  return { source: 'snmp', address, observedAt, chassisId, systemName: text(values.get(`${LLDP_LOCAL}.3.0`)), neighbors }
}
