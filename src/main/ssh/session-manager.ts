import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { StringDecoder } from 'string_decoder'
import type { Duplex } from 'stream'
import type { Client, ClientChannel, ConnectConfig } from 'ssh2'
import type { EffectiveSettings, Host } from '@shared/types'
import { algorithmsFor } from './algorithms'
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
}

export interface SessionEvents {
  /** end = session offset just after this chunk. */
  data(sessionId: string, data: string, end: number): void
  closed(sessionId: string, reason: string): void
}

export class SessionManager {
  private sessions = new Map<string, Session>()

  constructor(private events: SessionEvents) {}

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
    sock?: Duplex
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
    const sessionId = randomUUID()
    const client = new Client()
    const session: Session = { client, scrollback: [], scrollbackSize: 0, total: 0 }
    this.sessions.set(sessionId, session)
    /** Algorithms agreed in the handshake, to explain a failure. */
    let negotiated: { serverHostKey?: string } | undefined
    const fail = (err: Error, reject: (e: Error) => void) => {
      this.sessions.delete(sessionId)
      client.end()
      reject(explain(err, negotiated))
    }

    const config: ConnectConfig = {
      host: host.address,
      port: s.port,
      sock,
      username: login.username,
      password,
      hostVerifier: (blob: Buffer, verify: (ok: boolean) => void) => {
        verifyHostKey(blob).then(verify, () => verify(false))
      },
      privateKey,
      tryKeyboard: true, // Huawei / Cisco usually ask for the password via keyboard-interactive
      algorithms: algorithmsFor(s.algoProfile),
      keepaliveInterval: 15000,
      // Includes the time the user spends reading the fingerprint dialog.
      readyTimeout: 90000
    }

    return new Promise((resolve, reject) => {
      client.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
        // TODO stage 1: unknown prompts (OTP etc.) go to a dialog in the renderer.
        finish(prompts.map(() => password ?? ''))
      })
      client.on('handshake', (n) => (negotiated = n))
      client.on('ready', () => {
        client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
          // No shell channel (device limit, no rights): hang up, or the login keeps a VTY line busy.
          if (err) return fail(err, reject)
          session.stream = stream
          // A multi-byte character (Cyrillic in Huawei banners) can be split across chunks.
          const out = new StringDecoder('utf8')
          const err2 = new StringDecoder('utf8')
          stream.on('data', (d: Buffer) => this.emit(sessionId, out.write(d)))
          stream.stderr.on('data', (d: Buffer) => this.emit(sessionId, err2.write(d)))
          stream.on('close', () => this.close(sessionId, 'соединение закрыто сервером'))
          resolve(sessionId)
        })
      })
      client.on('error', (err) => {
        if (!session.stream) fail(err, reject)
        else this.close(sessionId, err.message)
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
    const s = this.sessions.get(sessionId)
    return s ? { data: s.scrollback.join(''), end: s.total } : { data: '', end: 0 }
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.stream?.write(data)
  }

  /** One IPC call fans out to every session in the group. */
  broadcast(sessionIds: string[], data: string): void {
    for (const id of sessionIds) this.write(id, data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.stream?.setWindow(rows, cols, 0, 0)
  }

  close(sessionId: string, reason = 'закрыто'): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    this.sessions.delete(sessionId)
    s.client.end()
    this.events.closed(sessionId, reason)
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }
}

/** Turn ssh2's failures into something an engineer can act on. */
export function explain(err: Error & { level?: string; code?: string }, negotiated?: { serverHostKey?: string }): Error {
  if (/host denied/i.test(err.message)) return new Error('Подключение отменено: ключ хоста не подтверждён.')
  if (/signature verification failed/i.test(err.message)) {
    return new Error(
      `${err.message}\nПодпись ключа хоста${negotiated?.serverHostKey ? ` (${negotiated.serverHostKey})` : ''} не сошлась. ` +
        `Если ключ на устройстве не менялся, это похоже на подмену соединения. Профиль алгоритмов здесь не поможет.`
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
