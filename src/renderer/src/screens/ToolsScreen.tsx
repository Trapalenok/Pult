import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { hostAddresses, type StoreSnapshot } from '@shared/types'
import { PORT_NAMES, subnetOf, type DnsResult, type DnsType, type PortState, type ToolEvent, type ToolKind, type ToolParams } from '@shared/tools'
import { Badge, Button, Segmented, Toggle } from '../design/components'
import { errorText, newId } from '../util'
import './tools.css'

type Tab = 'ping' | 'trace' | 'dns' | 'ports' | 'sweep'

/** Address handed over from a host's menu; `at` makes the same address count as a new request. */
export interface ToolsTarget {
  address: string
  tab?: Tab
  at: number
}

interface Props {
  store: StoreSnapshot
  target: ToolsTarget | null
}

/** Ping, traceroute, DNS, port check and subnet sweep, all run from this PC. Every tab keeps running while you switch. */
export function ToolsScreen({ store, target }: Props) {
  const [tab, setTab] = useState<Tab>('ping')
  useEffect(() => void (target?.tab && setTab(target.tab)), [target])
  const hosts = useHostIndex(store)
  const panels: Record<Tab, ReactNode> = {
    ping: <PingPanel hosts={hosts} target={target} />,
    trace: <TracePanel hosts={hosts} target={target} />,
    dns: <DnsPanel hosts={hosts} target={target} />,
    ports: <PortsPanel hosts={hosts} target={target} jump={!!(store.settings?.jump?.enabled && store.settings.jump.address)} />,
    sweep: <SweepPanel hosts={hosts} target={target} />
  }
  return (
    <div className="screen">
      <div className="screen__bar drag">
        <div className="no-drag">
          <Segmented<Tab>
            value={tab}
            onChange={setTab}
            options={[
              { value: 'ping', label: 'Ping' },
              { value: 'trace', label: 'Трассировка' },
              { value: 'dns', label: 'DNS' },
              { value: 'ports', label: 'Порты' },
              { value: 'sweep', label: 'Скан сети' }
            ]}
          />
        </div>
        <span className="screen__spacer" />
      </div>
      {(Object.keys(panels) as Tab[]).map((t) => (
        <div key={t} className="screen__scroll tl" style={{ display: t === tab ? undefined : 'none' }}>
          {panels[t]}
        </div>
      ))}
      <datalist id="tl-hosts">
        {store.hosts.flatMap((h) =>
          hostAddresses(h).map((a, i) => (
            <option key={`${h.id}|${a}`} value={a}>
              {i ? `${h.name} (адрес ${i + 1})` : h.name}
            </option>
          ))
        )}
      </datalist>
    </div>
  )
}

/* ── Shared bits ───────────────────────────────────────────── */

interface HostIndex {
  /** Host name typed in place of an address → its address. */
  resolve(text: string): string
  /** Name of the host in the base with this address. */
  nameOf(address?: string): string | undefined
}

function useHostIndex(store: StoreSnapshot): HostIndex {
  return useMemo(() => {
    const byName = new Map(store.hosts.map((h) => [h.name.trim().toLowerCase(), h.address]))
    const byAddr = new Map(store.hosts.flatMap((h) => hostAddresses(h).map((a) => [a.toLowerCase(), h.name] as const)))
    return {
      resolve: (t) => byName.get(t.trim().toLowerCase()) ?? t.trim(),
      nameOf: (a) => (a ? byAddr.get(a.toLowerCase()) : undefined)
    }
  }, [store.hosts])
}

/** One tool run at a time per tab; its events go to onEvent until 'done'. Leaving the app stops it. */
function useRun(onEvent: (ev: ToolEvent) => void) {
  const [running, setRunning] = useState(false)
  const idRef = useRef<string | null>(null)
  const cb = useRef(onEvent)
  cb.current = onEvent
  useEffect(() => {
    const off = window.api.onToolEvent((id, ev) => {
      if (id !== idRef.current) return
      cb.current(ev)
      if (ev.type === 'done') (idRef.current = null), setRunning(false)
    })
    return () => {
      off()
      if (idRef.current) window.api.toolStop(idRef.current)
    }
  }, [])
  return {
    running,
    start<K extends ToolKind>(kind: K, params: ToolParams[K]) {
      if (idRef.current) window.api.toolStop(idRef.current)
      idRef.current = newId()
      setRunning(true)
      window.api.toolStart(idRef.current, kind, params)
    },
    stop() {
      if (idRef.current) window.api.toolStop(idRef.current)
    }
  }
}

/** Fills the address when a host's menu sends one here. */
function useTarget(target: ToolsTarget | null, set: (a: string) => void, map: (a: string) => string = (a) => a) {
  const last = useRef(0)
  useEffect(() => {
    if (target && target.at !== last.current) (last.current = target.at), set(map(target.address))
  }, [target])
}

function Form({ children, onSubmit }: { children: ReactNode; onSubmit(): void }) {
  return (
    <form className="tl-form" onSubmit={(e) => (e.preventDefault(), onSubmit())}>
      {children}
    </form>
  )
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={wide ? 'tl-field is-wide' : 'tl-field'}>
      <span>{label}</span>
      {children}
    </label>
  )
}

function TargetInput({ value, onChange, placeholder = 'Адрес или имя хоста', list = true }: { value: string; onChange(v: string): void; placeholder?: string; list?: boolean }) {
  return <input className="tl-input mono" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} list={list ? 'tl-hosts' : undefined} spellCheck={false} />
}

function NumberInput({ value, onChange, min, max, step }: { value: number; onChange(v: number): void; min: number; max: number; step?: number }) {
  return <input className="tl-input tl-input--num" type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} />
}

function Choice<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange(v: T): void }) {
  return (
    <select className="tl-input" value={String(value)} onChange={(e) => onChange(options.find((o) => String(o.value) === e.target.value)!.value)}>
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

function RunButton({ running, disabled, onStop, label = 'Запустить' }: { running: boolean; disabled?: boolean; onStop(): void; label?: string }) {
  return running ? (
    <Button type="button" variant="destructive" icon="xmark" onClick={onStop}>
      Остановить
    </Button>
  ) : (
    <Button type="submit" variant="filled" icon="play" disabled={disabled}>
      {label}
    </Button>
  )
}

function CopyButton({ text }: { text: () => string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      type="button"
      variant="plain"
      size="sm"
      icon={done ? 'check' : undefined}
      onClick={() => navigator.clipboard.writeText(text()).then(() => (setDone(true), setTimeout(() => setDone(false), 1200)))}
    >
      {done ? 'Скопировано' : 'Копировать'}
    </Button>
  )
}

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'good' | 'bad' | 'warn' }) {
  return (
    <div className={['tl-stat', tone && `is-${tone}`].filter(Boolean).join(' ')}>
      <span className="tl-stat__value">{value}</span>
      <span className="tl-stat__label">{label}</span>
    </div>
  )
}

function Progress({ done, total }: { done: number; total: number }) {
  if (!total) return null
  return (
    <div className="tl-progress" title={`${done} из ${total}`}>
      <div style={{ width: `${(done / total) * 100}%` }} />
    </div>
  )
}

function ErrorLine({ text }: { text: string | null }) {
  return text ? <div className="tl-error">{text}</div> : null
}

const ms = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v < 1 ? '<1 мс' : `${Math.round(v * 10) / 10} мс`)

/* ── Ping ──────────────────────────────────────────────────── */

interface Echo {
  seq: number
  rtt: number | null
  ttl?: number
  at: number
}

function PingPanel({ hosts, target }: { hosts: HostIndex; target: ToolsTarget | null }) {
  const [addr, setAddr] = useState('')
  const [count, setCount] = useState(0)
  const [interval, setIntervalMs] = useState(1000)
  const [size, setSize] = useState(32)
  const [timeout, setTimeoutMs] = useState(1000)
  const [echoes, setEchoes] = useState<Echo[]>([])
  const [ran, setRan] = useState('')
  const [error, setError] = useState<string | null>(null)
  const run = useRun((ev) => {
    if (ev.type === 'ping') setEchoes((e) => [...e, { seq: ev.seq, rtt: ev.rtt, ttl: ev.ttl, at: Date.now() }].slice(-5000))
    if (ev.type === 'error') setError(ev.message)
  })
  useTarget(target, setAddr)
  const logRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = logRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 60) el.scrollTop = el.scrollHeight
  }, [echoes])

  const st = useMemo(() => pingStats(echoes), [echoes])
  const start = () => {
    const t = hosts.resolve(addr)
    setEchoes([]), setError(null), setRan(t)
    run.start('ping', { target: t, count, intervalMs: interval, timeoutMs: timeout, size })
  }
  const label = ran + (hosts.nameOf(ran) ? ` (${hosts.nameOf(ran)})` : '')

  return (
    <>
      <Form onSubmit={start}>
        <Field label="Адрес" wide>
          <TargetInput value={addr} onChange={setAddr} />
        </Field>
        <Field label="Запросов">
          <Choice<number> value={count} onChange={setCount} options={[{ value: 0, label: 'Пока не остановлю' }, { value: 4, label: '4' }, { value: 10, label: '10' }, { value: 100, label: '100' }, { value: 1000, label: '1000' }]} />
        </Field>
        <Field label="Интервал">
          <Choice<number> value={interval} onChange={setIntervalMs} options={[{ value: 200, label: '0,2 с' }, { value: 500, label: '0,5 с' }, { value: 1000, label: '1 с' }, { value: 2000, label: '2 с' }, { value: 5000, label: '5 с' }]} />
        </Field>
        <Field label="Таймаут, мс">
          <NumberInput value={timeout} onChange={setTimeoutMs} min={100} max={10000} step={100} />
        </Field>
        <Field label="Размер, байт">
          <NumberInput value={size} onChange={setSize} min={0} max={65500} />
        </Field>
        <RunButton running={run.running} disabled={!addr.trim()} onStop={run.stop} />
      </Form>
      <ErrorLine text={error} />

      {echoes.length > 0 && (
        <>
          <div className="tl-head">
            <h3>
              {label} {run.running && <span className="tl-live">идёт</span>}
            </h3>
            <CopyButton text={() => pingText(label, echoes, st)} />
          </div>
          <div className="tl-stats">
            <Stat label="Отправлено" value={st.sent} />
            <Stat label="Получено" value={st.received} tone={st.received ? 'good' : 'bad'} />
            <Stat label="Потери" value={`${st.loss}%`} tone={st.loss === 0 ? 'good' : st.loss === 100 ? 'bad' : 'warn'} />
            <Stat label="Мин" value={ms(st.min)} />
            <Stat label="Сред" value={ms(st.avg)} />
            <Stat label="Макс" value={ms(st.max)} />
            <Stat label="Джиттер" value={ms(st.jitter)} />
          </div>
          <PingChart echoes={echoes.slice(-120)} />
          <div className="tl-log mono" ref={logRef}>
            {echoes.slice(-500).map((e) => (
              <div key={e.seq} className={e.rtt === null ? 'is-bad' : undefined}>
                <span className="tl-log__time">{new Date(e.at).toLocaleTimeString()}</span>
                {e.rtt === null ? `#${e.seq}  нет ответа` : `#${e.seq}  ответ от ${ran}: время ${ms(e.rtt)}${e.ttl ? `  TTL=${e.ttl}` : ''}`}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}

function pingStats(echoes: Echo[]) {
  const ok = echoes.map((e) => e.rtt).filter((v): v is number => v !== null)
  const sent = echoes.length
  const sum = ok.reduce((a, b) => a + b, 0)
  let jitter: number | null = null
  if (ok.length > 1) jitter = ok.slice(1).reduce((a, v, i) => a + Math.abs(v - ok[i]), 0) / (ok.length - 1)
  return {
    sent,
    received: ok.length,
    loss: sent ? Math.round(((sent - ok.length) / sent) * 1000) / 10 : 0,
    min: ok.length ? Math.min(...ok) : null,
    max: ok.length ? Math.max(...ok) : null,
    avg: ok.length ? sum / ok.length : null,
    jitter
  }
}

function pingText(label: string, echoes: Echo[], st: ReturnType<typeof pingStats>): string {
  const lines = echoes.map((e) => `${new Date(e.at).toLocaleTimeString()}  #${e.seq}  ${e.rtt === null ? 'нет ответа' : `${ms(e.rtt)}${e.ttl ? ` TTL=${e.ttl}` : ''}`}`)
  return [`Ping ${label}`, ...lines, '', `Отправлено ${st.sent}, получено ${st.received}, потери ${st.loss}%`, `Мин ${ms(st.min)}, сред ${ms(st.avg)}, макс ${ms(st.max)}, джиттер ${ms(st.jitter)}`].join('\n')
}

function PingChart({ echoes }: { echoes: Echo[] }) {
  const n = 120
  const w = 720
  const h = 64
  const max = Math.max(5, ...echoes.map((e) => e.rtt ?? 0))
  const bw = w / n
  const start = n - echoes.length
  return (
    <svg className="tl-chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      {echoes.map((e, i) => {
        const bh = e.rtt === null ? h : Math.max(2, (e.rtt / max) * (h - 4))
        return <rect key={e.seq} x={(start + i) * bw} y={h - bh} width={Math.max(1, bw - 1)} height={bh} rx={1} className={e.rtt === null ? 'is-lost' : ''} />
      })}
      <text x={4} y={12}>{ms(max)}</text>
    </svg>
  )
}

/* ── Traceroute ────────────────────────────────────────────── */

interface HopRow {
  hop: number
  rtts: (number | null)[]
  address?: string
  name?: string
}

function TracePanel({ hosts, target }: { hosts: HostIndex; target: ToolsTarget | null }) {
  const [addr, setAddr] = useState('')
  const [maxHops, setMaxHops] = useState(30)
  const [timeout, setTimeoutMs] = useState(1000)
  const [resolve, setResolve] = useState(false)
  const [rows, setRows] = useState<HopRow[]>([])
  const [info, setInfo] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const run = useRun((ev) => {
    if (ev.type === 'hop') setRows((r) => [...r, ev])
    if (ev.type === 'line') setInfo((i) => [...i, ev.text])
    if (ev.type === 'error') setError(ev.message)
  })
  useTarget(target, setAddr)
  const start = () => {
    setRows([]), setInfo([]), setError(null)
    run.start('trace', { target: hosts.resolve(addr), maxHops, timeoutMs: timeout, resolve })
  }
  const text = () =>
    [...info.slice(0, 2), ...rows.map((r) => `${String(r.hop).padStart(3)}  ${r.rtts.map((v) => (v === null ? '*' : ms(v)).padStart(8)).join(' ')}  ${r.address ?? 'нет ответа'}${r.name ? ` (${r.name})` : ''}`)].join('\n')

  return (
    <>
      <Form onSubmit={start}>
        <Field label="Адрес" wide>
          <TargetInput value={addr} onChange={setAddr} />
        </Field>
        <Field label="Макс. прыжков">
          <NumberInput value={maxHops} onChange={setMaxHops} min={1} max={64} />
        </Field>
        <Field label="Таймаут, мс">
          <NumberInput value={timeout} onChange={setTimeoutMs} min={100} max={10000} step={100} />
        </Field>
        <Field label="Имена узлов">
          <span className="tl-toggle">
            <Toggle checked={resolve} onChange={setResolve} label="Определять имена узлов" />
          </span>
        </Field>
        <RunButton running={run.running} disabled={!addr.trim()} onStop={run.stop} />
      </Form>
      <ErrorLine text={error} />
      {(rows.length > 0 || info.length > 0) && (
        <>
          <div className="tl-head">
            <h3>
              {info[0] ?? addr} {run.running && <span className="tl-live">идёт</span>}
            </h3>
            <CopyButton text={text} />
          </div>
          <table className="tl-table">
            <thead>
              <tr>
                <th className="num">№</th>
                <th className="num">1</th>
                <th className="num">2</th>
                <th className="num">3</th>
                <th>Узел</th>
                <th>В базе</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.hop} className={r.address ? undefined : 'is-dim'}>
                  <td className="num">{r.hop}</td>
                  {[0, 1, 2].map((i) => (
                    <td key={i} className={['num mono', r.rtts[i] === null && 'bad'].filter(Boolean).join(' ')}>
                      {r.rtts[i] === undefined ? '' : r.rtts[i] === null ? '*' : ms(r.rtts[i])}
                    </td>
                  ))}
                  <td className="mono sel">
                    {r.address ?? 'нет ответа'}
                    {r.name && <span className="tl-sub"> {r.name}</span>}
                  </td>
                  <td>{hosts.nameOf(r.address) ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {info.length > 1 && <p className="tl-note">{info.slice(1).join(' ')}</p>}
        </>
      )}
    </>
  )
}

/* ── DNS ───────────────────────────────────────────────────── */

const DNS_TYPES: { value: DnsType; label: string }[] = [
  { value: 'A', label: 'A' },
  { value: 'AAAA', label: 'AAAA' },
  { value: 'PTR', label: 'PTR (обратная)' },
  { value: 'CNAME', label: 'CNAME' },
  { value: 'MX', label: 'MX' },
  { value: 'NS', label: 'NS' },
  { value: 'TXT', label: 'TXT' },
  { value: 'SOA', label: 'SOA' },
  { value: 'SRV', label: 'SRV' },
  { value: 'SYSTEM', label: 'Как Windows (hosts + DNS)' }
]

function DnsPanel({ hosts, target }: { hosts: HostIndex; target: ToolsTarget | null }) {
  const [name, setName] = useState('')
  const [type, setType] = useState<DnsType>('A')
  const [server, setServer] = useState('')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<DnsResult[]>([])
  const [error, setError] = useState<string | null>(null)
  useTarget(target, setName)
  const ask = () => {
    setBusy(true), setError(null)
    window.api
      .dnsQuery({ name: hosts.resolve(name), type, server: type === 'SYSTEM' ? undefined : server })
      .then((r) => setResults((all) => [r, ...all].slice(0, 30)))
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(false))
  }
  return (
    <>
      <Form onSubmit={ask}>
        <Field label="Имя или адрес" wide>
          <TargetInput value={name} onChange={setName} placeholder="core-sw.corp.local или 10.0.0.1" />
        </Field>
        <Field label="Тип записи">
          <Choice<DnsType> value={type} onChange={setType} options={DNS_TYPES} />
        </Field>
        <Field label="DNS-сервер">
          <input className="tl-input mono" value={type === 'SYSTEM' ? '' : server} disabled={type === 'SYSTEM'} onChange={(e) => setServer(e.target.value)} placeholder="как в Windows" spellCheck={false} />
        </Field>
        <Button type="submit" variant="filled" icon="search" disabled={!name.trim() || busy}>
          {busy ? 'Запрос…' : 'Запросить'}
        </Button>
      </Form>
      <ErrorLine text={error} />
      {results.map((r, i) => (
        <section key={results.length - i} className="tl-card">
          <div className="tl-head">
            <h3>
              <span className="mono sel">{r.query.name}</span> <Badge tint="blue">{r.query.type === 'SYSTEM' ? 'системный' : r.query.type}</Badge>
            </h3>
            <span className="tl-sub">
              {r.servers.join(', ')} · {r.ms} мс
            </span>
            {r.answers.length > 0 && <CopyButton text={() => r.answers.map((a) => a.value).join('\n')} />}
          </div>
          {r.error ? (
            <div className="tl-error">{r.error}</div>
          ) : (
            <table className="tl-table">
              <tbody>
                {r.answers.map((a, j) => (
                  <tr key={j}>
                    <td className="tl-type">{a.type}</td>
                    <td className="mono sel">{a.value}</td>
                    <td className="tl-sub">{hosts.nameOf(a.value) ? `в базе: ${hosts.nameOf(a.value)}` : ''}</td>
                    <td className="num tl-sub">{a.ttl !== undefined ? `TTL ${a.ttl}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </>
  )
}

/* ── Port check ────────────────────────────────────────────── */

const PORT_PRESETS = [
  { label: 'Управление', ports: '22,23,80,443,8291,8728,8729,3389,5900' },
  { label: 'Web', ports: '80,443,8080,8443' },
  { label: 'Windows', ports: '135,139,445,3389,5985' },
  { label: 'AD / LDAP', ports: '53,88,389,636,3268,3269' },
  { label: '1–1024', ports: '1-1024' }
]

const STATE_LABEL: Record<PortState, string> = { open: 'открыт', closed: 'закрыт', filtered: 'нет ответа' }
const STATE_TINT = { open: 'green', closed: 'gray', filtered: 'orange' } as const

function PortsPanel({ hosts, target, jump }: { hosts: HostIndex; target: ToolsTarget | null; jump: boolean }) {
  const [addr, setAddr] = useState('')
  const [ports, setPorts] = useState(PORT_PRESETS[0].ports)
  const [timeout, setTimeoutMs] = useState(1500)
  const [viaJump, setViaJump] = useState(false)
  const [onlyOpen, setOnlyOpen] = useState(false)
  const [res, setRes] = useState<Map<number, { state: PortState; ms?: number }>>(new Map())
  const [prog, setProg] = useState({ done: 0, total: 0 })
  const [ran, setRan] = useState('')
  const [error, setError] = useState<string | null>(null)
  const run = useRun((ev) => {
    if (ev.type === 'port') setRes((m) => new Map(m).set(ev.port, { state: ev.state, ms: ev.ms }))
    if (ev.type === 'progress') setProg(ev)
    if (ev.type === 'error') setError(ev.message)
  })
  useTarget(target, setAddr)
  const start = () => {
    const t = hosts.resolve(addr)
    setRes(new Map()), setProg({ done: 0, total: 0 }), setError(null), setRan(t)
    run.start('ports', { target: t, ports, timeoutMs: timeout, viaJump: jump && viaJump })
  }
  const rows = [...res.entries()].sort((a, b) => a[0] - b[0]).filter(([, r]) => !onlyOpen || r.state === 'open')
  const count = (s: PortState) => [...res.values()].filter((r) => r.state === s).length

  return (
    <>
      <Form onSubmit={start}>
        <Field label="Адрес" wide>
          <TargetInput value={addr} onChange={setAddr} />
        </Field>
        <Field label="Порты" wide>
          <input className="tl-input mono" value={ports} onChange={(e) => setPorts(e.target.value)} placeholder="22,80,443,8000-8100" spellCheck={false} />
        </Field>
        <Field label="Таймаут, мс">
          <NumberInput value={timeout} onChange={setTimeoutMs} min={100} max={10000} step={100} />
        </Field>
        {jump && (
          <Field label="Через jump-host">
            <span className="tl-toggle">
              <Toggle checked={viaJump} onChange={setViaJump} label="Проверять с jump-host" />
            </span>
          </Field>
        )}
        <RunButton running={run.running} disabled={!addr.trim() || !ports.trim()} onStop={run.stop} label="Проверить" />
      </Form>
      <div className="tl-chips">
        {PORT_PRESETS.map((p) => (
          <button key={p.label} type="button" className={['tl-chip', ports === p.ports && 'is-on'].filter(Boolean).join(' ')} onClick={() => setPorts(p.ports)}>
            {p.label}
          </button>
        ))}
      </div>
      <ErrorLine text={error} />
      {prog.total > 0 && (
        <>
          <div className="tl-head">
            <h3>
              {ran}
              {hosts.nameOf(ran) && <span className="tl-sub"> {hosts.nameOf(ran)}</span>} {run.running && <span className="tl-live">{prog.done} из {prog.total}</span>}
            </h3>
            <label className="tl-inline">
              Только открытые <Toggle checked={onlyOpen} onChange={setOnlyOpen} label="Только открытые" />
            </label>
            <CopyButton text={() => rows.map(([p, r]) => `${p}\t${PORT_NAMES[p] ?? ''}\t${STATE_LABEL[r.state]}`).join('\n')} />
          </div>
          <Progress done={prog.done} total={prog.total} />
          <div className="tl-stats">
            <Stat label="Открыто" value={count('open')} tone={count('open') ? 'good' : undefined} />
            <Stat label="Закрыто" value={count('closed')} />
            <Stat label="Нет ответа" value={count('filtered')} tone={count('filtered') ? 'warn' : undefined} />
          </div>
          <table className="tl-table">
            <thead>
              <tr>
                <th className="num">Порт</th>
                <th>Служба</th>
                <th>Состояние</th>
                <th className="num">Время</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([p, r]) => (
                <tr key={p} className={r.state === 'open' ? undefined : 'is-dim'}>
                  <td className="num mono">{p}</td>
                  <td>{PORT_NAMES[p] ?? ''}</td>
                  <td>
                    <Badge tint={STATE_TINT[r.state]}>{STATE_LABEL[r.state]}</Badge>
                  </td>
                  <td className="num mono">{r.ms !== undefined ? `${r.ms} мс` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {viaJump && jump && <p className="tl-note">Проверка шла с jump-host: «открыт» значит, что jump-host или прокси смог подключиться к порту.</p>}
        </>
      )}
    </>
  )
}

/* ── Subnet sweep ──────────────────────────────────────────── */

function SweepPanel({ hosts, target }: { hosts: HostIndex; target: ToolsTarget | null }) {
  const [range, setRange] = useState('')
  const [timeout, setTimeoutMs] = useState(700)
  const [alive, setAlive] = useState<{ address: string; rtt: number }[]>([])
  const [prog, setProg] = useState({ done: 0, total: 0 })
  const [onlyNew, setOnlyNew] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = useRun((ev) => {
    if (ev.type === 'alive') setAlive((a) => [...a, { address: ev.address, rtt: ev.rtt }])
    if (ev.type === 'progress') setProg(ev)
    if (ev.type === 'error') setError(ev.message)
  })
  useTarget(target, setRange, subnetOf)
  const start = () => {
    setAlive([]), setProg({ done: 0, total: 0 }), setError(null)
    run.start('sweep', { range, timeoutMs: timeout })
  }
  const sorted = alive
    .slice()
    .sort((a, b) => ipNum(a.address) - ipNum(b.address))
    .filter((a) => !onlyNew || !hosts.nameOf(a.address))
  const known = alive.filter((a) => hosts.nameOf(a.address)).length

  return (
    <>
      <Form onSubmit={start}>
        <Field label="Подсеть или диапазон" wide>
          <input className="tl-input mono" value={range} onChange={(e) => setRange(e.target.value)} placeholder="192.168.1.0/24 или 192.168.1.10-50" spellCheck={false} />
        </Field>
        <Field label="Таймаут, мс">
          <NumberInput value={timeout} onChange={setTimeoutMs} min={100} max={5000} step={100} />
        </Field>
        <RunButton running={run.running} disabled={!range.trim()} onStop={run.stop} label="Сканировать" />
      </Form>
      <ErrorLine text={error} />
      {prog.total > 0 && (
        <>
          <div className="tl-head">
            <h3>
              {range} {run.running && <span className="tl-live">{prog.done} из {prog.total}</span>}
            </h3>
            <label className="tl-inline">
              Только новые <Toggle checked={onlyNew} onChange={setOnlyNew} label="Только адреса, которых нет в базе" />
            </label>
            <CopyButton text={() => sorted.map((a) => `${a.address}\t${ms(a.rtt)}\t${hosts.nameOf(a.address) ?? ''}`).join('\n')} />
          </div>
          <Progress done={prog.done} total={prog.total} />
          <div className="tl-stats">
            <Stat label="Проверено" value={prog.done} />
            <Stat label="Отвечают" value={alive.length} tone={alive.length ? 'good' : undefined} />
            <Stat label="Есть в базе" value={known} />
            <Stat label="Нет в базе" value={alive.length - known} tone={alive.length - known ? 'warn' : undefined} />
          </div>
          <table className="tl-table">
            <thead>
              <tr>
                <th>Адрес</th>
                <th className="num">Время</th>
                <th>В базе</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((a) => (
                <tr key={a.address}>
                  <td className="mono sel">{a.address}</td>
                  <td className="num mono">{ms(a.rtt)}</td>
                  <td>{hosts.nameOf(a.address) ?? <span className="tl-sub">нет</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!run.running && alive.length === 0 && <p className="tl-note">Никто не ответил на ping. Учтите, что ICMP может быть закрыт на устройствах или в межсетевом экране.</p>}
        </>
      )}
    </>
  )
}

const ipNum = (a: string) => a.split('.').reduce((n, o) => n * 256 + Number(o), 0)
