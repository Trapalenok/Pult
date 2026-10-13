import { createServer, type Server, type Socket } from 'net'
import type { Duplex } from 'stream'
import type { Client } from 'ssh2'
import type { AlgoProfile } from '@shared/types'
import { algorithmsFor } from './algorithms'
import { explain, ssh2 } from './session-manager'
import { socks5Connect } from './socks5'

export interface JumpLogin {
  /** ssh: an OpenSSH server (мастер-кей); socks5: a SOCKS5 proxy, no SSH login on it. */
  kind: 'ssh' | 'socks5'
  address: string
  port: number
  username?: string
  password?: string
  algoProfile: AlgoProfile
}

/**
 * SSH kind: one SSH connection to the jump host, shared by every session that goes through it
 * (like OpenSSH ControlMaster): each switch session is a direct-tcpip channel inside it, so 20+
 * sessions cost one login on the jump host.
 * SOCKS5 kind: each session is its own TCP connection opened by the proxy (CONNECT).
 * Either way web and WinBox get local TCP tunnels on 127.0.0.1.
 */
export class JumpHost {
  private client?: Client
  private connecting?: Promise<Client>
  private key = ''
  /** "address:port" on the far side → local listener on 127.0.0.1. */
  private tunnels = new Map<string, { server: Server; port: number }>()

  private async conn(j: JumpLogin, verify: (blob: Buffer) => Promise<boolean>): Promise<Client> {
    this.use(j)
    if (this.client) return this.client
    this.connecting ??= this.open(j, verify)
      .then((c) => {
        this.client = c
        c.on('close', () => {
          if (this.client !== c) return
          this.client = undefined
          this.closeTunnels()
        })
        return c
      })
      .finally(() => (this.connecting = undefined))
    return this.connecting
  }

  /** Settings changed (other server, account or kind): drop the old connection and tunnels. */
  private use(j: JumpLogin): void {
    const key = `${j.kind}:${j.username}@${j.address}:${j.port}/${j.algoProfile}/${j.password ?? ''}`
    if (key !== this.key) this.reset()
    this.key = key
  }

  private async open(j: JumpLogin, verify: (blob: Buffer) => Promise<boolean>): Promise<Client> {
    const { Client } = await ssh2
    const c = new Client()
    return new Promise((resolve, reject) => {
      c.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => j.password ?? '')))
      c.on('ready', () => resolve(c))
      c.on('error', (err) => reject(new Error(`Jump-host ${j.address}: ${explain(err).message}`)))
      c.connect({
        host: j.address,
        port: j.port,
        username: j.username,
        password: j.password,
        tryKeyboard: true,
        algorithms: algorithmsFor(j.algoProfile),
        keepaliveInterval: 15000,
        readyTimeout: 90000,
        hostVerifier: (blob: Buffer, done: (ok: boolean) => void) => void verify(blob).then(done, () => done(false))
      })
    })
  }

  /** A byte stream to address:port opened by the jump host, to hand to ssh2 as `sock`. */
  async forward(j: JumpLogin, verify: (blob: Buffer) => Promise<boolean>, address: string, port: number): Promise<Duplex> {
    if (j.kind === 'socks5') {
      this.use(j)
      return socks5Connect(j, address, port)
    }
    const c = await this.conn(j, verify)
    return new Promise((resolve, reject) =>
      c.forwardOut('127.0.0.1', 0, address, port, (err, stream) =>
        err ? reject(new Error(`Jump-host ${j.address} не смог открыть ${address}:${port}: ${err.message}`)) : resolve(stream)
      )
    )
  }

  /** Local port on 127.0.0.1 that leads to address:port through the jump host (web UI, WinBox). */
  async tunnel(j: JumpLogin, verify: (blob: Buffer) => Promise<boolean>, address: string, port: number): Promise<number> {
    if (j.kind === 'socks5') this.use(j)
    else await this.conn(j, verify)
    const id = `${address}:${port}`
    const existing = this.tunnels.get(id)
    if (existing) return existing.port
    const server = createServer((sock: Socket) => {
      sock.on('error', () => {})
      this.forward(j, verify, address, port).then(
        (st) => {
          st.on('error', () => sock.destroy())
          sock.pipe(st).pipe(sock)
        },
        () => sock.destroy()
      )
    })
    const local = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    })
    this.tunnels.set(id, { server, port: local })
    return local
  }

  private closeTunnels(): void {
    for (const t of this.tunnels.values()) t.server.close()
    this.tunnels.clear()
  }

  reset(): void {
    this.closeTunnels()
    this.client?.end()
    this.client = undefined
  }
}
