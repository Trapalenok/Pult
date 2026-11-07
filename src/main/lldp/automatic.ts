import { createHash } from 'crypto'
import { effectiveSettings, snmpCommunityOwner } from '@shared/inherit'
import { hostAddresses, snmpSecretId, type StoreSnapshot } from '@shared/types'
import type { LldpAutoStatus, LldpSnapshot } from '@shared/lldp'
import { LldpReadError } from './errors'

type Target = { id: string; addresses: string[]; community: string; fingerprint: string }
/** Main-process scheduler. No device I/O until start/tick; injected collector enables offline tests. */
export class AutomaticLldp {
  private timer?: ReturnType<typeof setInterval>
  private refreshTimer?: ReturnType<typeof setTimeout>
  private stopped = false
  private states = new Map<string, { fingerprint: string; due: number }>()
  private active = new Map<string, { fingerprint: string; controller: AbortController }>()
  private statuses = new Map<string, LldpAutoStatus>()

  constructor(private deps: {
    store(): StoreSnapshot
    secret(id: string): string | undefined
    collect(address: string, community: string, signal: AbortSignal): Promise<LldpSnapshot>
    save(hostId: string, snapshot: LldpSnapshot): void
    emit(status: LldpAutoStatus): void
    now?(): number
  }, private intervalMs = 5 * 60 * 1000, private concurrency = 2) {}

  all(): LldpAutoStatus[] { return [...this.statuses.values()] }
  start(): void {
    if (this.timer) return
    this.stopped = false
    this.tick()
    this.timer = setInterval(() => this.tick(), 10000)
  }
  /** Coalesce saveStore + login/community writes into one refresh of final settings. */
  refresh(): void {
    if (this.stopped) return
    clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => this.tick(), 300)
  }
  stop(): void {
    this.stopped = true
    clearInterval(this.timer)
    clearTimeout(this.refreshTimer)
    this.timer = undefined
    for (const task of this.active.values()) task.controller.abort()
  }
  private now(): number { return this.deps.now?.() ?? Date.now() }
  private emit(status: LldpAutoStatus): void { this.statuses.set(status.hostId, status); this.deps.emit(status) }

  private targets(): Map<string, Target> {
    const store = this.deps.store()
    const targets = new Map<string, Target>()
    for (const host of store.hosts) {
      if (host.lldpAuto === false || !effectiveSettings(store.folders, host).snmp) continue
      const owner = snmpCommunityOwner(store.folders, host, store.secretIds)
      if (!owner) continue
      let community: string | undefined
      try { community = this.deps.secret(snmpSecretId(owner)) } catch { continue }
      if (!community) continue
      const addresses = hostAddresses(host)
      if (!addresses.length) continue
      const fingerprint = createHash('sha256').update(JSON.stringify([addresses, owner, community])).digest('hex')
      targets.set(host.id, { id: host.id, addresses, community, fingerprint })
    }
    return targets
  }

  /** Configuration is re-read before starting and before applying any response. */
  tick(): void {
    if (this.stopped) return
    const targets = this.targets()
    for (const [id, task] of this.active) {
      if (targets.get(id)?.fingerprint !== task.fingerprint) task.controller.abort()
    }
    for (const id of this.states.keys()) if (!targets.has(id)) this.states.delete(id)
    for (const id of this.statuses.keys()) if (!targets.has(id)) {
      this.emit({ hostId: id, state: 'disabled' })
      this.statuses.delete(id)
    }
    for (const target of targets.values()) {
      const state = this.states.get(target.id)
      if (!state || state.fingerprint !== target.fingerprint) this.states.set(target.id, { fingerprint: target.fingerprint, due: 0 })
      if (this.active.size >= this.concurrency) break
      if (this.active.has(target.id) || this.states.get(target.id)!.due > this.now()) continue
      const controller = new AbortController()
      this.active.set(target.id, { fingerprint: target.fingerprint, controller })
      this.emit({ hostId: target.id, state: 'running' })
      void this.run(target, controller)
    }
  }

  private async run(target: Target, controller: AbortController): Promise<void> {
    const valid = () => !this.stopped && !controller.signal.aborted && this.targets().get(target.id)?.fingerprint === target.fingerprint
    try {
      let snapshot: LldpSnapshot | undefined
      let diagnostic: LldpReadError | undefined
      for (const address of target.addresses) {
        if (controller.signal.aborted) return
        try { snapshot = await this.deps.collect(address, target.community, controller.signal); break } catch (e) {
          if (e instanceof LldpReadError) diagnostic = e
        }
      }
      if (!valid()) return
      if (!snapshot) throw diagnostic ?? new Error('LLDP недоступен по сохранённым адресам.')
      this.deps.save(target.id, snapshot)
      this.emit({ hostId: target.id, state: 'ok', checkedAt: this.now(), nextAt: this.now() + this.intervalMs })
    } catch (e) {
      // Do not relay arbitrary transport errors that could contain credentials.
      if (valid()) this.emit({ hostId: target.id, state: 'error', checkedAt: this.now(), nextAt: this.now() + this.intervalMs,
        error: e instanceof LldpReadError ? e.message : 'Не удалось обновить LLDP. Проверьте SNMP community, права чтения LLDP-MIB и доступность UDP 161. Предыдущие данные сохранены.' })
    } finally {
      this.active.delete(target.id)
      if (valid()) this.states.set(target.id, { fingerprint: target.fingerprint, due: this.now() + this.intervalMs })
      if (this.timer && !this.stopped) this.refresh()
    }
  }
}
