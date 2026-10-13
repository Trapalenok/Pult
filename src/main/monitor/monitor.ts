import { effectiveSettings, snmpCommunityOwner } from '@shared/inherit'
import { snmpSecretId, type EffectiveSettings, type Host, type HostStatus, type StoreSnapshot } from '@shared/types'
import { ping, tcpPing, type TcpOpen } from './ping'
import { pollSnmp } from './snmp'

const HISTORY = 30
const CONCURRENCY = 24
/** Longest a probed host waits before its result is sent to the windows, ms. */
const EMIT_EVERY = 1000

/**
 * Background availability: ICMP ping and SNMP, never SSH, so no VTY line is taken on the device.
 * One round every `monitorInterval` seconds over all hosts that have ping or SNMP enabled.
 */
export class Monitor {
  private status = new Map<string, HostStatus>()
  private timer?: NodeJS.Timeout
  private running = false

  constructor(
    private store: () => StoreSnapshot,
    private secret: (id: string) => string | undefined,
    private emit: (changed: HostStatus[]) => void,
    /** How to reach the host through the jump host when its ping should go that way; undefined = ICMP from this PC. */
    private viaJump: (host: Host, s: EffectiveSettings) => { open: TcpOpen; label: string } | undefined = () => undefined
  ) {}

  start(): void {
    const tick = async () => {
      await this.round().catch(() => {})
      this.timer = setTimeout(tick, (this.store().settings?.monitorInterval ?? 30) * 1000)
    }
    tick()
  }

  stop(): void {
    clearTimeout(this.timer)
  }

  all(): HostStatus[] {
    return [...this.status.values()]
  }

  /** Probe these hosts now (e.g. a map sheet was opened, a host was just added). */
  async probe(hostIds: string[]): Promise<void> {
    const want = new Set(hostIds)
    await this.check(this.store().hosts.filter((h) => want.has(h.id)).map((h) => h.id))
  }

  private async round(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.check(this.store().hosts.map((h) => h.id))
    } finally {
      this.running = false
    }
  }

  private async check(ids: string[]): Promise<void> {
    const queue = [...ids]
    // Results go out in batches, not one message per host: each message re-renders the whole window.
    let batch: HostStatus[] = []
    let flushTimer: NodeJS.Timeout | undefined
    const flush = () => {
      clearTimeout(flushTimer)
      flushTimer = undefined
      if (batch.length) this.emit(batch)
      batch = []
    }
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        const s = await this.checkOne(id)
        if (!s) continue
        batch.push(s)
        flushTimer ??= setTimeout(flush, EMIT_EVERY)
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
    flush()
    // Hosts deleted since the last round.
    const alive = new Set(this.store().hosts.map((h) => h.id))
    for (const id of this.status.keys()) if (!alive.has(id)) this.status.delete(id)
  }

  private async checkOne(hostId: string): Promise<HostStatus | undefined> {
    const store = this.store()
    const host = store.hosts.find((h) => h.id === hostId)
    if (!host) return
    const s = effectiveSettings(store.folders, host)
    const prev = this.status.get(hostId)
    const communityOwner = s.snmp ? snmpCommunityOwner(store.folders, host, store.secretIds) : undefined
    const community = communityOwner ? this.secret(snmpSecretId(communityOwner)) : undefined

    const via = s.ping ? this.viaJump(host, s) : undefined
    const [rtt, snmpStatus] = await Promise.all([
      !s.ping ? Promise.resolve(undefined) : via ? tcpPing(via.open, host.address, s.port) : ping(host.address),
      community ? pollSnmp(host.address, community) : Promise.resolve(undefined)
    ])
    const history = s.ping ? [...(prev?.history ?? []), rtt ?? null].slice(-HISTORY) : []
    // Either probe answering means the box is up; ICMP is often filtered while SNMP is not.
    const alive = rtt === undefined && !snmpStatus ? null : (rtt !== undefined && rtt !== null) || !!snmpStatus?.ok
    const next: HostStatus = {
      hostId,
      alive,
      rtt: rtt ?? undefined,
      history,
      probe: via ? `TCP :${s.port} ${via.label}` : undefined,
      snmp: s.snmp ? (snmpStatus ?? { ok: false, error: 'не задан community' }) : undefined,
      checkedAt: Date.now()
    }
    this.status.set(hostId, next)
    return next
  }
}
