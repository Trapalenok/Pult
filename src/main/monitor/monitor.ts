import { effectiveSettings, snmpCommunityOwner } from '@shared/inherit'
import { hostAddresses, snmpSecretId, type EffectiveSettings, type Host, type HostStatus, type StoreSnapshot } from '@shared/types'
import { pingRetry, tcpPingRetry, type TcpOpen } from './ping'
import { pollSnmp } from './snmp'

const HISTORY = 30
const CONCURRENCY = 24
/** Longest a probed host waits before its result is sent to the windows, ms. */
const EMIT_EVERY = 1000
/** SNMP silent this many rounds in a row: the host is asked only every SNMP_QUIET_EVERY rounds. */
const SNMP_QUIET_AFTER = 3
const SNMP_QUIET_EVERY = 10
/** A device without temperature in any known MIB: the tables are walked again every this many rounds. */
const TEMP_RECHECK_EVERY = 30

/** What SNMP has shown about a host so far, so devices that don't answer aren't asked every round. */
interface SnmpMemo {
  fails: number
  /** Round number of the next poll while quiet. */
  next: number
  /** Round number of the next temperature walk; 0 = every round. */
  tempNext: number
}

/**
 * Background availability: ICMP ping and SNMP, never SSH, so no VTY line is taken on the device.
 * One round every `monitorInterval` seconds over all hosts that have ping or SNMP enabled.
 */
export class Monitor {
  private status = new Map<string, HostStatus>()
  private timer?: NodeJS.Timeout
  private running = false
  private roundNo = 0
  private snmpMemo = new Map<string, SnmpMemo>()

  constructor(
    private store: () => StoreSnapshot,
    private secret: (id: string) => string | undefined,
    private emit: (changed: HostStatus[]) => void,
    /** How to reach the host through the jump host when its ping should go that way; undefined = ICMP from this PC. */
    private viaJump: (host: Host, s: EffectiveSettings) => { open: TcpOpen; label: string } | undefined = () => undefined,
    /** True while sessions are opening through the jump host: probes through it wait, the last result stays. */
    private jumpBusy: () => boolean = () => false
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

  /** The host's addresses, the one that answered last round first. */
  addressOrder(host: Host): string[] {
    const all = hostAddresses(host)
    const p = this.status.get(host.id)?.preferred
    return p && all.includes(p) ? [p, ...all.filter((a) => a !== p)] : all
  }

  /** Probe these hosts now (e.g. a map sheet was opened, a host was just added). */
  async probe(hostIds: string[]): Promise<void> {
    const want = new Set(hostIds)
    await this.check(this.store().hosts.filter((h) => want.has(h.id)).map((h) => h.id))
  }

  private async round(): Promise<void> {
    if (this.running) return
    this.running = true
    this.roundNo++
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
    for (const id of this.status.keys()) if (!alive.has(id)) this.status.delete(id), this.snmpMemo.delete(id)
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
    if (via && prev && this.jumpBusy()) return
    const addrs = hostAddresses(host)
    const pingOne = (a: string) => (via ? tcpPingRetry(via.open, a, s.port) : pingRetry(a))
    const memo = this.snmpMemo.get(hostId) ?? { fails: 0, next: 0, tempNext: 0 }
    // Quiet SNMP: the last answer (a failure) stands until its turn comes again.
    const snmpDue = !!community && (memo.fails < SNMP_QUIET_AFTER || this.roundNo >= memo.next)
    const snmpPoll = (a: string) => pollSnmp(a, community!, { temp: this.roundNo >= memo.tempNext })
    let rtt: number | null | undefined
    let snmpStatus: Awaited<ReturnType<typeof pollSnmp>> | undefined
    let perAddress: HostStatus['addresses']
    let preferred = addrs[0] ?? host.address
    if (addrs.length > 1) {
      // Every address is pinged; SNMP then asks the first one that answered.
      const rtts = s.ping ? await Promise.all(addrs.map(pingOne)) : []
      if (s.ping) {
        perAddress = addrs.map((address, i) => ({ address, rtt: rtts[i] }))
        const i = rtts.findIndex((r) => r !== null)
        rtt = i >= 0 ? rtts[i] : null
        if (i >= 0) preferred = addrs[i]
      }
      snmpStatus = snmpDue ? await snmpPoll(preferred) : undefined
    } else {
      ;[rtt, snmpStatus] = await Promise.all([
        !s.ping ? Promise.resolve(undefined) : pingOne(preferred),
        snmpDue ? snmpPoll(preferred) : Promise.resolve(undefined)
      ])
    }
    if (snmpStatus) {
      if (snmpStatus.ok) {
        memo.fails = 0
        if (snmpStatus.noTemp && this.roundNo >= memo.tempNext) memo.tempNext = this.roundNo + TEMP_RECHECK_EVERY
        else if (snmpStatus.temp !== undefined) memo.tempNext = 0
      } else {
        memo.fails++
        if (memo.fails >= SNMP_QUIET_AFTER) {
          memo.next = this.roundNo + SNMP_QUIET_EVERY
          snmpStatus = { ...snmpStatus, quiet: true }
        }
      }
      this.snmpMemo.set(hostId, memo)
    } else if (community && prev?.snmp) snmpStatus = prev.snmp
    const history = s.ping ? [...(prev?.history ?? []), rtt ?? null].slice(-HISTORY) : []
    // Either probe answering means the box is up; ICMP is often filtered while SNMP is not.
    const alive = rtt === undefined && !snmpStatus ? null : (rtt !== undefined && rtt !== null) || !!snmpStatus?.ok
    const next: HostStatus = {
      hostId,
      alive,
      rtt: rtt ?? undefined,
      history,
      probe: via ? `TCP :${s.port} ${via.label}` : undefined,
      addresses: perAddress,
      preferred: addrs.length > 1 ? preferred : undefined,
      snmp: s.snmp ? (snmpStatus ?? { ok: false, error: 'не задан community' }) : undefined,
      checkedAt: Date.now()
    }
    this.status.set(hostId, next)
    return next
  }
}
