import { spawn, type ChildProcess } from 'child_process'
import { promises as dns } from 'dns'
import { connect, isIP } from 'net'
import { StringDecoder } from 'string_decoder'
import type { Duplex } from 'stream'
import {
  parsePorts,
  parseRange,
  type DnsAnswer,
  type DnsQuery,
  type DnsResult,
  type PingParams,
  type PortState,
  type PortsParams,
  type SweepParams,
  type ToolEvent,
  type ToolKind,
  type ToolParams,
  type TraceParams
} from '@shared/tools'
import { parseRtt } from '../monitor/ping'
import { decodeCp866, parseHop, parseTtl } from './parse'

const win = process.platform === 'win32'
type Emit = (ev: ToolEvent) => void
/** Opens address:port from the jump host; rejects when it can't. */
export type JumpForward = (address: string, port: number) => Promise<Duplex>

/** Text decoder for the system ping/tracert: OEM code page on Windows, UTF-8 elsewhere. */
function consoleDecoder(): (b: Buffer) => string {
  if (win) return decodeCp866
  const d = new StringDecoder('utf8')
  return (b) => d.write(b)
}

const clampInt = (v: unknown, min: number, max: number, def: number) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def
}

/** Only host names and addresses reach the command line: no options, no shell. */
function checkTarget(t: string): string {
  const s = t.trim()
  if (!s) throw new Error('Укажите адрес или имя хоста')
  if (!/^[\w.:%-]+$/.test(s) || s.startsWith('-')) throw new Error(`Недопустимый адрес: «${s}»`)
  return s
}

const sleep = (ms: number, stopped: () => boolean) =>
  new Promise<void>((resolve) => {
    const started = Date.now()
    const tick = () => (stopped() || Date.now() - started >= ms ? resolve() : setTimeout(tick, Math.min(100, ms)))
    tick()
  })

/** One echo request; kill() aborts it. */
function pingOnce(address: string, timeoutMs: number, size: number, track: (p: ChildProcess) => void): Promise<{ rtt: number | null; ttl?: number }> {
  const args = win
    ? ['-n', '1', '-w', String(timeoutMs), '-l', String(size), address]
    : ['-n', '-c', '1', '-W', String(Math.max(1, Math.round(timeoutMs / 1000))), '-s', String(size), address]
  return new Promise((resolve) => {
    let out = ''
    const p = spawn('ping', args, { windowsHide: true })
    track(p)
    p.stdout.on('data', (d: Buffer) => (out += d.toString('latin1')))
    p.on('error', () => resolve({ rtt: null }))
    p.on('close', () => {
      const rtt = parseRtt(out)
      resolve({ rtt, ttl: rtt === null ? undefined : parseTtl(out) })
    })
    setTimeout(() => p.kill(), timeoutMs + 3000)
  })
}

class Run {
  stopped = false
  constructor(readonly owner: number) {}
  private procs = new Set<ChildProcess>()

  track = (p: ChildProcess) => {
    this.procs.add(p)
    p.on('close', () => this.procs.delete(p))
    if (this.stopped) p.kill()
  }

  stop(): void {
    this.stopped = true
    for (const p of this.procs) p.kill()
  }
}

async function runPing(run: Run, p: PingParams, emit: Emit): Promise<void> {
  const target = checkTarget(p.target)
  const count = clampInt(p.count, 0, 100000, 0)
  const interval = clampInt(p.intervalMs, 200, 60000, 1000)
  const timeout = clampInt(p.timeoutMs, 100, 10000, 1000)
  const size = clampInt(p.size, 0, 65500, 32)
  for (let seq = 1; !run.stopped && (count === 0 || seq <= count); seq++) {
    const started = Date.now()
    const r = await pingOnce(target, timeout, size, run.track)
    if (run.stopped) break
    emit({ type: 'ping', seq, ...r })
    if (count !== 0 && seq === count) break
    await sleep(interval - (Date.now() - started), () => run.stopped)
  }
}

function runTrace(run: Run, p: TraceParams, emit: Emit): Promise<void> {
  const target = checkTarget(p.target)
  const hops = clampInt(p.maxHops, 1, 64, 30)
  const timeout = clampInt(p.timeoutMs, 100, 10000, 1000)
  const args = win
    ? [...(p.resolve ? [] : ['-d']), '-h', String(hops), '-w', String(timeout), target]
    : [...(p.resolve ? [] : ['-n']), '-m', String(hops), '-w', String(Math.max(1, Math.round(timeout / 1000))), '-q', '3', target]
  return new Promise((resolve, reject) => {
    const proc = spawn(win ? 'tracert' : 'traceroute', args, { windowsHide: true })
    run.track(proc)
    const decode = consoleDecoder()
    let buf = ''
    const flush = (all: boolean) => {
      const lines = buf.split(/\r?\n/)
      buf = all ? '' : (lines.pop() ?? '')
      for (const line of lines) {
        const hop = parseHop(line)
        if (hop) emit({ type: 'hop', ...hop })
        else if (line.trim()) emit({ type: 'line', text: line.trim() })
      }
    }
    proc.stdout.on('data', (d: Buffer) => ((buf += decode(d)), flush(false)))
    proc.stderr.on('data', (d: Buffer) => emit({ type: 'line', text: decode(d).trim() }))
    proc.on('error', (e) => reject(new Error(win ? `Не удалось запустить tracert: ${e.message}` : `Не найден traceroute: ${e.message}`)))
    proc.on('close', () => (flush(true), resolve()))
  })
}

function probeDirect(host: string, port: number, timeoutMs: number): Promise<{ state: PortState; ms?: number }> {
  return new Promise((resolve) => {
    const started = Date.now()
    const sock = connect({ host, port })
    const done = (state: PortState) => {
      sock.destroy()
      resolve(state === 'open' ? { state, ms: Date.now() - started } : { state })
    }
    sock.setTimeout(timeoutMs, () => done('filtered'))
    sock.once('connect', () => done('open'))
    // Refused: the host answered with RST. Unreachable / timed out: nothing answered.
    sock.once('error', (e: NodeJS.ErrnoException) => done(e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' ? 'closed' : 'filtered'))
  })
}

function probeJump(fwd: JumpForward, host: string, port: number, timeoutMs: number): Promise<{ state: PortState; ms?: number }> {
  const started = Date.now()
  return new Promise((resolve) => {
    // The jump host's own TCP timeout can be long; ours wins.
    const timer = setTimeout(() => resolve({ state: 'filtered' }), timeoutMs + 1000)
    fwd(host, port).then(
      (st) => {
        clearTimeout(timer)
        st.destroy()
        resolve({ state: 'open', ms: Date.now() - started })
      },
      () => (clearTimeout(timer), resolve({ state: 'closed' }))
    )
  })
}

async function runPorts(run: Run, p: PortsParams, emit: Emit, jump?: JumpForward): Promise<void> {
  const target = checkTarget(p.target)
  const ports = parsePorts(p.ports)
  const timeout = clampInt(p.timeoutMs, 100, 10000, 1500)
  if (p.viaJump && !jump) throw new Error('Jump-host не настроен (Настройки → Jump-host)')
  const queue = [...ports]
  let done = 0
  const worker = async () => {
    for (let port = queue.shift(); port !== undefined && !run.stopped; port = queue.shift()) {
      const r = p.viaJump && jump ? await probeJump(jump, target, port, timeout) : await probeDirect(target, port, timeout)
      if (run.stopped) return
      emit({ type: 'port', port, ...r })
      emit({ type: 'progress', done: ++done, total: ports.length })
    }
  }
  // Through the jump host every probe is a channel in one SSH connection: keep it gentle.
  await Promise.all(Array.from({ length: Math.min(p.viaJump ? 8 : 128, ports.length) }, worker))
}

async function runSweep(run: Run, p: SweepParams, emit: Emit): Promise<void> {
  const addrs = parseRange(p.range)
  const timeout = clampInt(p.timeoutMs, 100, 5000, 700)
  const queue = [...addrs]
  let done = 0
  const worker = async () => {
    for (let a = queue.shift(); a && !run.stopped; a = queue.shift()) {
      const r = await pingOnce(a, timeout, 32, run.track)
      if (run.stopped) return
      if (r.rtt !== null) emit({ type: 'alive', address: a, rtt: r.rtt })
      emit({ type: 'progress', done: ++done, total: addrs.length })
    }
  }
  await Promise.all(Array.from({ length: Math.min(64, addrs.length) }, worker))
}

/** Running tools by id; each belongs to the window that started it. */
export class Tools {
  private runs = new Map<string, Run>()

  constructor(private jump: () => JumpForward | undefined) {}

  start<K extends ToolKind>(id: string, kind: K, params: ToolParams[K], owner: number, emit: Emit): void {
    this.stop(id)
    const run = new Run(owner)
    this.runs.set(id, run)
    const go = (): Promise<void> => {
      switch (kind) {
        case 'ping':
          return runPing(run, params as PingParams, emit)
        case 'trace':
          return runTrace(run, params as TraceParams, emit)
        case 'ports':
          return runPorts(run, params as PortsParams, emit, (params as PortsParams).viaJump ? this.jump() : undefined)
        case 'sweep':
          return runSweep(run, params as SweepParams, emit)
      }
      return Promise.reject(new Error(`Неизвестный инструмент: ${kind}`))
    }
    go()
      .catch((e: Error) => emit({ type: 'error', message: e.message }))
      .finally(() => {
        if (this.runs.get(id) === run) this.runs.delete(id)
        emit({ type: 'done' })
      })
  }

  stop(id: string): void {
    this.runs.get(id)?.stop()
  }

  /** The window that started these runs is gone. */
  stopOwner(owner: number): void {
    for (const r of this.runs.values()) if (r.owner === owner) r.stop()
  }

  stopAll(): void {
    for (const r of this.runs.values()) r.stop()
  }
}

/* ── DNS ───────────────────────────────────────────────────── */

const DNS_ERRORS: Record<string, string> = {
  ENOTFOUND: 'Имя не найдено (NXDOMAIN)',
  ENODATA: 'Записей такого типа нет',
  ETIMEOUT: 'DNS-сервер не ответил',
  ECONNREFUSED: 'DNS-сервер отклонил запрос',
  ESERVFAIL: 'Ошибка на DNS-сервере (SERVFAIL)',
  EREFUSED: 'DNS-сервер отказал (REFUSED)',
  EBADNAME: 'Недопустимое имя',
  EFORMERR: 'Сервер не понял запрос (FORMERR)'
}

export async function dnsQuery(q: DnsQuery): Promise<DnsResult> {
  const name = q.name.trim().replace(/\.$/, '')
  if (!name) throw new Error('Укажите имя или адрес')
  const started = Date.now()
  // An address asked for A/AAAA means "what is its name".
  const type = isIP(name) && (q.type === 'A' || q.type === 'AAAA') ? 'PTR' : q.type
  const result = (answers: DnsAnswer[], servers: string[], error?: string): DnsResult => ({
    query: { ...q, type },
    answers,
    ms: Date.now() - started,
    servers,
    error
  })

  if (type === 'SYSTEM') {
    try {
      const all = await dns.lookup(name, { all: true })
      return result(all.map((a) => ({ type: a.family === 6 ? 'AAAA' : 'A', value: a.address })), ['система (hosts + Windows)'])
    } catch (e) {
      return result([], ['система (hosts + Windows)'], DNS_ERRORS[(e as NodeJS.ErrnoException).code ?? ''] ?? (e as Error).message)
    }
  }

  const r = new dns.Resolver({ timeout: 2500, tries: 2 })
  const server = q.server?.trim()
  if (server) {
    const m = server.match(/^\[?([0-9a-f:.]+?)\]?(?::(\d+))?$/i)
    if (!m || !isIP(m[1])) throw new Error('DNS-сервер: укажите IP-адрес, например 10.0.0.1')
    r.setServers([m[2] ? (isIP(m[1]) === 6 ? `[${m[1]}]:${m[2]}` : `${m[1]}:${m[2]}`) : m[1]])
  }
  const servers = r.getServers()
  try {
    let answers: DnsAnswer[]
    switch (type) {
      case 'A':
        answers = (await r.resolve4(name, { ttl: true })).map((a) => ({ type, value: a.address, ttl: a.ttl }))
        break
      case 'AAAA':
        answers = (await r.resolve6(name, { ttl: true })).map((a) => ({ type, value: a.address, ttl: a.ttl }))
        break
      case 'CNAME':
        answers = (await r.resolveCname(name)).map((v) => ({ type, value: v }))
        break
      case 'MX':
        answers = (await r.resolveMx(name)).sort((a, b) => a.priority - b.priority).map((v) => ({ type, value: `${v.priority} ${v.exchange}` }))
        break
      case 'NS':
        answers = (await r.resolveNs(name)).map((v) => ({ type, value: v }))
        break
      case 'TXT':
        answers = (await r.resolveTxt(name)).map((v) => ({ type, value: v.join('') }))
        break
      case 'SOA': {
        const s = await r.resolveSoa(name)
        answers = [{ type, value: `${s.nsname} ${s.hostmaster} serial ${s.serial} refresh ${s.refresh} retry ${s.retry} expire ${s.expire} min ${s.minttl}` }]
        break
      }
      case 'SRV':
        answers = (await r.resolveSrv(name)).map((v) => ({ type, value: `${v.priority} ${v.weight} ${v.port} ${v.name}` }))
        break
      case 'PTR':
        answers = (isIP(name) ? await r.reverse(name) : await r.resolvePtr(name)).map((v) => ({ type, value: v }))
        break
      default:
        throw new Error(`Тип ${type} не поддерживается`)
    }
    return result(answers, servers)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? ''
    if (!DNS_ERRORS[code] && !code) throw e
    return result([], servers, DNS_ERRORS[code] ?? `${code}: ${(e as Error).message}`)
  }
}
