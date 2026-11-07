import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { StringDecoder } from 'string_decoder'
import type { Duplex } from 'stream'
import type { Algorithms, Client, ClientChannel, ConnectConfig } from 'ssh2'
import type { EffectiveSettings, Host } from '@shared/types'
import { algorithmsFor } from './algorithms'
import { isYes, LineReader, loginFlow } from './login'
import './dh-groups'
import './dsa-verify'

// ssh2 is loaded lazily so the DH group shim above is in place before ssh2 captures crypto functions.
// A static import would be hoisted above it by the bundler.
export const ssh2 = import('ssh2')

/** Output kept per session so a terminal re-created in another window can replay it. */
const SCROLLBACK_BYTES = 512 * 1024

interface Session {
  client: Client
  stream?: ClientChannel
  scrollback: string[]
  scrollbackSize: number
  /** Characters emitted so far. Lets a terminal tell replayed output from live output. */
  total: number
  /** Login typed in the terminal before the shell opens: keystrokes go here instead of the channel. */
  reader?: LineReader
  cols: number
  rows: number
}

export interface SessionEvents {
  /** end = session offset just after this chunk. */
  data(sessionId: string, data: string, end: number): void
  closed(sessionId: string, reason: string): void
}

/** What a closed session leaves for a reconnect under the same id: its output and terminal size. */
type Ended = Pick<Session, 'scrollback' | 'scrollbackSize' | 'total' | 'cols' | 'rows'>

export class SessionManager {
  private sessions = new Map<string, Session>()
  /** Sessions that lost their connection but whose pane is still open, so "Переподключить" can reuse the id. */
  private ended = new Map<string, Ended>()

  constructor(private events: SessionEvents) {}

  /** Terminal size of a closed session, for its reconnect. */
  endedSize(sessionId: string): { cols: number; rows: number } | undefined {
    const e = this.ended.get(sessionId)
    return e && { cols: e.cols, rows: e.rows }
  }

  /**
   * verifyHostKey gets the server's public key blob before authentication and decides whether to
   * go on (known key, or the user confirmed a new one).
   */
  async open(
    host: Host,
    s: EffectiveSettings,
    login: { username?: string; password?: string },
    cols: number,
    rows: number,
    verifyHostKey: (blob: Buffer) => Promise<boolean>,
    /** Channel through the jump host to host:port; direct TCP when absent. */
    sock?: Duplex,
    /** Offer only this KEX method and host key type (a pair that is known to work, or the next one to try). */
    only?: Pair,
    /** The user typed a login that worked and asked to keep it for this host. */
    remember?: (username: string, password: string) => void,
    /**
     * Reconnect: open under this closed session's id. Its output carries on where it stopped, so the pane,
     * the tab and a popped-out window stay as they are.
     */
    reuseId?: string
  ): Promise<string> {
    const password = login.password
    const { Client } = await ssh2
    // Read before anything is registered: a missing key file must not leave a dead session behind.
    let privateKey: Buffer | undefined
    try {
      privateKey = host.privateKeyPath ? readFileSync(host.privateKeyPath) : undefined
    } catch (e) {
      throw new Error(`Не удалось прочитать файл ключа ${host.privateKeyPath}: ${(e as Error).message}`)
    }
    if (reuseId && this.sessions.has(reuseId)) throw new Error('Сессия ещё подключена.')
    const sessionId = reuseId ?? randomUUID()
    const client = new Client()
    const before = reuseId ? this.ended.get(reuseId) : undefined
    const session: Session = { client, scrollback: [], scrollbackSize: 0, total: 0, ...before, cols, rows }
    this.sessions.set(sessionId, session)
    this.ended.delete(sessionId)
    // A reconnect reuses its pane's id while the previous ssh2 Client may still emit
    // delayed error/close events. Those events must never close the replacement client.
    const isCurrent = () => this.sessions.get(sessionId) === session
    const closeCurrent = (reason: string) => {
      if (isCurrent()) this.close(sessionId, reason)
    }
    /** Algorithms agreed in the handshake, to explain a failure. */
    let negotiated: Negotiated | undefined
    /** ssh2 tells why a host key signature failed only in its debug output. */
    let sigError: string | undefined
    let handshakeCompleted = false
    /** ssh2's debug lines up to login, kept to hand over when the host key signature fails. */
    const handshakeLog: string[] = []
    /** Set once the session went on screen to ask for a login: from then on failures close it instead of rejecting. */
    let live = false
    const fail = (err: Error, reject: (e: Error) => void) => {
      if (!isCurrent()) return
      if (live) return this.close(sessionId, flow.state.cancelled ? 'вход отменён' : explain(err).message)
      this.sessions.delete(sessionId)
      // A failed reconnect leaves the pane as it was, ready for another try.
      if (reuseId) this.ended.set(sessionId, endedOf(session))
      client.end()
      const e = explain(err, negotiated, sigError)
      if (handshakeCompleted) Object.assign(e, { sshHandshakeCompleted: true })
      if (e instanceof SignatureError) e.log = handshakeLog
      reject(e)
    }

    const reader = new LineReader((text) => this.emit(sessionId, text))
    let banner = ''
    let goLive = () => {}
    const flow = loginFlow({ username: login.username, password, privateKey }, host.address, {
      ask: (prompt, echo) => ((session.reader = reader), reader.ask(prompt, echo)),
      print: (text) => this.emit(sessionId, text),
      prompting: () => {
        if (!live && banner) this.emit(sessionId, banner.replace(/\r?\n/g, '\r\n').replace(/(\r\n)?$/, '\r\n'))
        goLive()
      }
    })

    const config: ConnectConfig = {
      host: host.address,
      port: s.port,
      sock,
      // ssh2 throws "Invalid username" without one; the login flow asks for it in the terminal.
      username: login.username ?? '',
      authHandler: flow.authHandler,
      hostVerifier: (blob: Buffer, verify: (ok: boolean) => void) => {
        verifyHostKey(blob).then(verify, () => verify(false))
      },
      privateKey,
      algorithms: only ? { ...algorithmsFor(s.algoProfile), kex: [only.kex], serverHostKey: [only.hostKey] } as Algorithms : algorithmsFor(s.algoProfile),
      // 'handshake' fires only after the host key signature is checked, so take what was agreed from the debug lines.
      debug: (msg: string) => {
        if (!session.stream && handshakeLog.length < 400) handshakeLog.push(msg)
        if (msg.startsWith('Signature verification failed')) sigError = msg
        if (!msg.startsWith('Handshake: ')) return
        const m = /^Handshake: (\(remote\) )?Host key format: (.*)$/.exec(msg)
        if (m) negotiated = m[1] ? { ...negotiated, offered: m[2] } : { ...negotiated, serverHostKey: m[2] }
        const k = /^Handshake: (\(remote\) )?KEX (algorithm|method): (.*)$/.exec(msg)
        if (k) negotiated = k[1] ? { ...negotiated, remoteKex: k[3] } : { ...negotiated, kex: k[3] }
      },
      keepaliveInterval: 15000,
      // Includes the time the user spends reading the fingerprint dialog.
      readyTimeout: 90000
    }

    return new Promise((resolve, reject) => {
      goLive = () => {
        if (live) return
        live = true
        // ssh2's readyTimeout runs until login succeeds; the user typing must not count against it.
        clearTimeout((client as unknown as { _readyTimeout?: NodeJS.Timeout })._readyTimeout)
        resolve(sessionId)
      }
      client.on('banner', (msg) => (banner += msg))
      client.once('handshake', () => (handshakeCompleted = true))
      client.on('ready', async () => {
        if (flow.state.typed && remember && flow.state.username && flow.state.password !== undefined) {
          session.reader = reader
          const answer = await reader.ask('Запомнить логин и пароль для этого хоста? [Enter — да, n — нет]: ', true)
          if (!this.sessions.has(sessionId)) return
          if (isYes(answer)) {
            try {
              remember(flow.state.username, flow.state.password)
              this.emit(sessionId, '\x1b[32mСохранено.\x1b[0m\r\n')
            } catch (e) {
              this.emit(sessionId, `\x1b[33mНе удалось сохранить: ${(e as Error).message}\x1b[0m\r\n`)
            }
          }
        }
        session.reader = undefined
        client.shell({ term: 'xterm-256color', cols: session.cols, rows: session.rows }, (err, stream) => {
          // No shell channel (device limit, no rights): hang up, or the login keeps a VTY line busy.
          if (err) return fail(err, reject)
          session.stream = stream
          // A multi-byte character (Cyrillic in Huawei banners) can be split across chunks.
          const out = new StringDecoder('utf8')
          const err2 = new StringDecoder('utf8')
          stream.on('data', (d: Buffer) => this.emit(sessionId, out.write(d)))
          stream.stderr.on('data', (d: Buffer) => this.emit(sessionId, err2.write(d)))
          stream.on('close', () => closeCurrent('соединение закрыто сервером'))
          if (live) return
          live = true
          resolve(sessionId)
        })
      })
      client.on('error', (err) => {
        if (!isCurrent()) return
        if (!session.stream) fail(err, reject)
        else closeCurrent(err.message)
      })
      // The server hung up while the user was typing (its login grace time, too many tries).
      client.on('close', () => {
        if (!isCurrent()) return
        if (live) return void (!session.stream && closeCurrent('соединение закрыто сервером'))
        // Hung up after the handshake but before login, without an error (device busy, still booting): fail now,
        // not after readyTimeout. A tick later, so ssh2's own "Connection lost before handshake" (the queue retries
        // that one) comes first when the hang-up was earlier.
        setImmediate(() => isCurrent() && fail(new Error('Соединение закрыто сервером до входа.'), reject))
      })
      client.connect(config)
    })
  }

  private emit(sessionId: string, data: string): void {
    const s = this.sessions.get(sessionId)
    if (!s || !data) return
    s.scrollback.push(data)
    s.scrollbackSize += data.length
    s.total += data.length
    while (s.scrollbackSize > SCROLLBACK_BYTES && s.scrollback.length > 1) {
      s.scrollbackSize -= s.scrollback.shift()!.length
    }
    this.events.data(sessionId, data, s.total)
  }

  /** Everything the session printed so far (capped), for a freshly mounted terminal, and the offset it ends at. */
  scrollback(sessionId: string): { data: string; end: number } {
    const s = this.sessions.get(sessionId) ?? this.ended.get(sessionId)
    return s ? { data: s.scrollback.join(''), end: s.total } : { data: '', end: 0 }
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  write(sessionId: string, data: string): void {
    const s = this.sessions.get(sessionId)
    if (s?.reader) s.reader.feed(data)
    else s?.stream?.write(data)
  }

  /** One IPC call fans out to every session in the group. */
  broadcast(sessionIds: string[], data: string): void {
    for (const id of sessionIds) this.write(id, data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.cols = cols
    s.rows = rows
    s.stream?.setWindow(rows, cols, 0, 0)
  }

  /**
   * Hangs up and keeps the output for a reconnect. The user closing the pane calls it once more (or forget())
   * on an already closed session, and that drops what was kept.
   */
  close(sessionId: string, reason = 'закрыто'): void {
    const s = this.sessions.get(sessionId)
    if (!s) return void this.ended.delete(sessionId)
    this.sessions.delete(sessionId)
    this.ended.set(sessionId, endedOf(s))
    s.reader?.cancel()
    s.client.end()
    this.events.closed(sessionId, reason)
  }

  /** The pane is gone: nothing to reconnect into. */
  forget(sessionId: string): void {
    this.close(sessionId)
    this.ended.delete(sessionId)
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
    this.ended.clear()
  }
}

const endedOf = (s: Session): Ended => ({ scrollback: s.scrollback, scrollbackSize: s.scrollbackSize, total: s.total, cols: s.cols, rows: s.rows })

/** Turn ssh2's failures into something an engineer can act on. */
/** offered / remoteKex: what the server listed, comma-separated. */
export interface Negotiated {
  serverHostKey?: string
  offered?: string
  kex?: string
  remoteKex?: string
}

/** A key exchange method with a host key type. */
export interface Pair {
  kex: string
  hostKey: string
}

/** Failure of the host key signature check, with what was in use and what else the server offers. */
export class SignatureError extends Error {
  /** ssh2 debug output of the failed handshake (no secrets: it ends before login). */
  log?: string[]
  constructor(
    message: string,
    readonly used?: Pair,
    readonly serverKex: string[] = [],
    readonly serverHostKeys: string[] = []
  ) {
    super(message)
  }
}

export function explain(err: Error & { level?: string; code?: string }, negotiated?: Negotiated, sigError?: string): Error {
  if (/host denied/i.test(err.message)) return new Error('Подключение отменено: ключ хоста не подтверждён.')
  if (/signature verification failed/i.test(err.message)) {
    // "Signature verification failed: Error: <reason>\n    at ..." → "<reason>"; empty when the math simply did not match.
    const reason = sigError?.split('\n')[0].replace(/^.*?Signature verification failed:?\s*(Error:\s*)?/, '').trim()
    const offered = negotiated?.offered ? `\nКлючи устройства: ${negotiated.offered.split(',').join(', ')}.` : ''
    const used = [negotiated?.serverHostKey && `ключ ${negotiated.serverHostKey}`, negotiated?.kex && `обмен ${negotiated.kex}`].filter(Boolean).join(', ')
    return new SignatureError(
      `${err.message}${reason ? ` (${reason})` : ''}${offered}\n` +
        `Подпись хоста не сошлась${used ? ` (${used})` : ''}.`,
      negotiated?.kex && negotiated.serverHostKey ? { kex: negotiated.kex, hostKey: negotiated.serverHostKey } : undefined,
      negotiated?.remoteKex?.split(',') ?? [],
      negotiated?.offered?.split(',') ?? []
    )
  }
  if (/no matching|handshake failed/i.test(err.message)) {
    return new Error(
      `${err.message}\nСервер, вероятно, поддерживает только устаревшие алгоритмы. ` +
        `Поставьте хосту или папке профиль «Старые».`
    )
  }
  if (err.level === 'client-authentication') return new Error('Неверный логин или пароль.')
  if (err.code === 'ECONNREFUSED') return new Error('Порт закрыт: SSH на хосте не отвечает.')
  if (err.code === 'ETIMEDOUT' || /timed out/i.test(err.message)) return new Error('Хост не отвечает (таймаут).')
  if (err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') return new Error('Хост недоступен по сети.')
  return err
}
