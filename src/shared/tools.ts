/** Network tools screen: ping, traceroute, DNS, port check, subnet sweep. Everything runs from this PC. */

export type ToolKind = 'ping' | 'trace' | 'ports' | 'sweep'

export interface PingParams {
  target: string
  /** 0: until stopped. */
  count: number
  intervalMs: number
  timeoutMs: number
  /** ICMP payload, bytes. */
  size: number
}

export interface TraceParams {
  target: string
  maxHops: number
  timeoutMs: number
  /** Ask DNS for each hop's name (slower). */
  resolve: boolean
}

export interface PortsParams {
  target: string
  /** "22,80,443,8000-8010" */
  ports: string
  timeoutMs: number
  /** Connect from the jump host (мастер-кей) instead of this PC. */
  viaJump: boolean
}

export interface SweepParams {
  /** "192.168.1.0/24", "192.168.1.10-50", "10.0.0.1-10.0.1.254" */
  range: string
  timeoutMs: number
}

export interface ToolParams {
  ping: PingParams
  trace: TraceParams
  ports: PortsParams
  sweep: SweepParams
}

export type PortState = 'open' | 'closed' | 'filtered'

export type ToolEvent =
  | { type: 'ping'; seq: number; rtt: number | null; ttl?: number }
  | { type: 'hop'; hop: number; rtts: (number | null)[]; address?: string; name?: string }
  | { type: 'port'; port: number; state: PortState; ms?: number }
  | { type: 'alive'; address: string; rtt: number }
  | { type: 'progress'; done: number; total: number }
  /** Informational text from the tool (traceroute header and the like). */
  | { type: 'line'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done' }

export type DnsType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'NS' | 'TXT' | 'SOA' | 'SRV' | 'PTR' | 'SYSTEM'

export interface DnsQuery {
  name: string
  type: DnsType
  /** "10.0.0.1" or "10.0.0.1:5353"; empty: the servers Windows uses. */
  server?: string
}

export interface DnsAnswer {
  type: string
  value: string
  ttl?: number
}

export interface DnsResult {
  query: DnsQuery
  answers: DnsAnswer[]
  ms: number
  /** Servers that were asked; "система" for SYSTEM (hosts file + OS resolver). */
  servers: string[]
  error?: string
}

/** Well-known TCP ports, for labels in the port check. */
export const PORT_NAMES: Record<number, string> = {
  21: 'FTP',
  22: 'SSH',
  23: 'Telnet',
  25: 'SMTP',
  53: 'DNS',
  80: 'HTTP',
  88: 'Kerberos',
  110: 'POP3',
  135: 'RPC',
  139: 'NetBIOS',
  143: 'IMAP',
  389: 'LDAP',
  443: 'HTTPS',
  445: 'SMB',
  636: 'LDAPS',
  830: 'NETCONF',
  1433: 'MS SQL',
  1723: 'PPTP',
  2000: 'MikroTik BTest',
  3306: 'MySQL',
  3389: 'RDP',
  5432: 'PostgreSQL',
  5900: 'VNC',
  5985: 'WinRM',
  8080: 'HTTP-alt',
  8291: 'WinBox',
  8443: 'HTTPS-alt',
  8728: 'RouterOS API',
  8729: 'RouterOS API-SSL'
}

export const MAX_PORTS = 4096
export const MAX_SWEEP = 4096

/** "22, 80,8000-8010" → sorted unique ports. Throws with a readable message. */
export function parsePorts(text: string): number[] {
  const set = new Set<number>()
  for (const part of text.split(/[\s,;]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/)
    if (!m) throw new Error(`Непонятный порт: «${part}»`)
    const a = Number(m[1])
    const b = m[2] ? Number(m[2]) : a
    if (a < 1 || b > 65535 || a > b) throw new Error(`Порт вне диапазона 1–65535: «${part}»`)
    for (let p = a; p <= b; p++) {
      set.add(p)
      if (set.size > MAX_PORTS) throw new Error(`Не больше ${MAX_PORTS} портов за раз`)
    }
  }
  if (set.size === 0) throw new Error('Укажите порты')
  return [...set].sort((x, y) => x - y)
}

const ipToInt = (ip: string): number | null => {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const o = m.slice(1).map(Number)
  if (o.some((x) => x > 255)) return null
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0
}
const intToIp = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')

/**
 * IPv4 range → addresses. "a.b.c.d/nn" skips network and broadcast (for /31 and /32 keeps all),
 * "a.b.c.10-50" is the last octet, "a.b.c.d-e.f.g.h" a full range.
 */
export function parseRange(text: string): string[] {
  const t = text.trim()
  let from: number | null = null
  let to: number | null = null
  let m: RegExpMatchArray | null
  if ((m = t.match(/^([\d.]+)\/(\d{1,2})$/))) {
    const base = ipToInt(m[1])
    const bits = Number(m[2])
    if (base === null || bits > 32) throw new Error(`Непонятная подсеть: «${t}»`)
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    from = (base & mask) >>> 0
    to = (from | (~mask >>> 0)) >>> 0
    if (bits < 31) (from += 1), (to -= 1)
  } else if ((m = t.match(/^([\d.]+)\s*-\s*([\d.]+)$/))) {
    from = ipToInt(m[1])
    if (from !== null && /^\d{1,3}$/.test(m[2])) to = Number(m[2]) > 255 ? null : ((from & 0xffffff00) | Number(m[2])) >>> 0
    else to = ipToInt(m[2])
    if (from === null || to === null) throw new Error(`Непонятный диапазон: «${t}»`)
  } else if ((from = ipToInt(t)) !== null) {
    to = from
  } else {
    throw new Error('Укажите подсеть (192.168.1.0/24) или диапазон (192.168.1.10-50)')
  }
  if (from > to) throw new Error('Начало диапазона больше конца')
  if (to - from + 1 > MAX_SWEEP) throw new Error(`Не больше ${MAX_SWEEP} адресов за раз (это /20)`)
  const out: string[] = []
  for (let n = from; n <= to; n++) out.push(intToIp(n))
  return out
}

/** The /24 an IPv4 address sits in, as a sweep range; anything else unchanged. */
export function subnetOf(address: string): string {
  const n = ipToInt(address.trim())
  return n === null ? address : `${intToIp((n & 0xffffff00) >>> 0)}/24`
}
