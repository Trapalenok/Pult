import { connect, isIPv4, isIPv6, type Socket } from 'net'

export interface Socks5Proxy {
  address: string
  port: number
  username?: string
  password?: string
}

const REPLY: Record<number, string> = {
  1: 'общая ошибка прокси',
  2: 'правила прокси запрещают это подключение',
  3: 'сеть недоступна',
  4: 'хост недоступен',
  5: 'в подключении отказано (порт закрыт)',
  6: 'истёк TTL',
  7: 'команда не поддерживается',
  8: 'тип адреса не поддерживается'
}

/** Tells "the proxy refused this target" from "the proxy itself is unreachable / rejected us". */
export class Socks5Error extends Error {
  /** SOCKS5 reply code when the proxy answered the CONNECT; undefined for transport/auth failures. */
  readonly reply?: number

  constructor(message: string, reply?: number) {
    super(message)
    this.reply = reply
  }
}

/**
 * A TCP connection to address:port opened by a SOCKS5 proxy (RFC 1928, login/password per RFC 1929).
 * The returned socket is past the handshake: bytes written to it reach the target, so it can be
 * handed to ssh2 as `sock` or piped to a local listener. Names are resolved by the proxy.
 */
export function socks5Connect(p: Socks5Proxy, address: string, port: number, timeoutMs = 20000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: p.address, port: p.port })
    let buf = Buffer.alloc(0)
    let step: 'method' | 'auth' | 'connect' = 'method'
    let settled = false
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      sock.destroy()
      reject(err)
    }
    const where = `SOCKS5-прокси ${p.address}:${p.port}`
    sock.setTimeout(timeoutMs, () => fail(new Socks5Error(`${where} не ответил вовремя`)))
    sock.once('error', (e: NodeJS.ErrnoException) =>
      fail(new Socks5Error(e.code === 'ECONNREFUSED' ? `${where}: порт закрыт, прокси не запущен?` : `${where}: ${e.message}`))
    )
    sock.once('close', () => fail(new Socks5Error(`${where} закрыл соединение`)))

    const auth = !!p.username
    sock.once('connect', () => sock.write(Buffer.from(auth ? [5, 2, 0, 2] : [5, 1, 0])))

    const take = (n: number): Buffer | undefined => {
      if (buf.length < n) return undefined
      const out = buf.subarray(0, n)
      buf = buf.subarray(n)
      return out
    }

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      if (step === 'method') {
        const m = take(2)
        if (!m) return
        if (m[0] !== 5) return fail(new Socks5Error(`${where}: это не SOCKS5-прокси`))
        if (m[1] === 2) {
          if (!auth) return fail(new Socks5Error(`${where} требует логин и пароль`))
          const u = Buffer.from(p.username ?? '', 'utf8')
          const pw = Buffer.from(p.password ?? '', 'utf8')
          if (u.length > 255 || pw.length > 255) return fail(new Socks5Error(`${where}: логин или пароль длиннее 255 байт`))
          sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([pw.length]), pw]))
          step = 'auth'
        } else if (m[1] === 0) {
          sendConnect()
        } else return fail(new Socks5Error(auth ? `${where} не принял вход по логину и паролю` : `${where} требует логин и пароль`))
      }
      if (step === 'auth') {
        const a = take(2)
        if (!a) return
        if (a[1] !== 0) return fail(new Socks5Error(`${where}: неверный логин или пароль`))
        sendConnect()
      }
      if (step === 'connect') {
        if (buf.length < 5) return
        if (buf[1] !== 0) return fail(new Socks5Error(`${where} не смог открыть ${address}:${port}: ${REPLY[buf[1]] ?? `код ${buf[1]}`}`, buf[1]))
        // Bound address in the reply: IPv4, domain (length-prefixed) or IPv6, then 2 bytes of port.
        const len = buf[3] === 1 ? 4 : buf[3] === 4 ? 16 : buf[3] === 3 ? 1 + buf[4] : -1
        if (len < 0) return fail(new Socks5Error(`${where}: непонятный ответ`))
        if (!take(4 + len + 2)) return
        settled = true
        sock.removeListener('data', onData)
        sock.removeAllListeners('error')
        sock.removeAllListeners('close')
        sock.setTimeout(0)
        // Bytes the target sent right after the reply belong to the caller.
        if (buf.length) sock.unshift(buf)
        resolve(sock)
      }
    }

    const sendConnect = () => {
      step = 'connect'
      let addr: Buffer
      if (isIPv4(address)) addr = Buffer.from([1, ...address.split('.').map(Number)])
      else if (isIPv6(address)) addr = Buffer.concat([Buffer.from([4]), ipv6Bytes(address)])
      else {
        const name = Buffer.from(address, 'utf8')
        if (name.length > 255) return fail(new Socks5Error(`Имя хоста длиннее 255 байт: ${address}`))
        addr = Buffer.concat([Buffer.from([3, name.length]), name])
      }
      const pb = Buffer.alloc(2)
      pb.writeUInt16BE(port)
      sock.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, pb]))
    }

    sock.on('data', onData)
  })
}

function ipv6Bytes(a: string): Buffer {
  let s = a.replace(/%.*$/, '')
  // ::ffff:10.0.0.1 → ::ffff:a00:1
  const v4 = s.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (v4) {
    const [, pre, w, x, y, z] = v4
    s = `${pre}${((+w << 8) | +x).toString(16)}:${((+y << 8) | +z).toString(16)}`
  }
  const [head, tail] = s.split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const words = tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t]
  const out = Buffer.alloc(16)
  words.slice(0, 8).forEach((w, i) => out.writeUInt16BE(parseInt(w, 16) || 0, i * 2))
  return out
}
