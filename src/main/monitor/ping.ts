import { spawn } from 'child_process'
import type { Duplex } from 'stream'

/**
 * One ICMP echo through the system ping (no admin rights, no raw sockets).
 * Resolves to the round-trip in ms, or null if there was no reply.
 * Windows prints localized text in the OEM code page; only "TTL=" and the digits are relied on.
 */
export function ping(address: string, timeoutMs = 1000): Promise<number | null> {
  const win = process.platform === 'win32'
  const args = win
    ? ['-n', '1', '-w', String(timeoutMs), address]
    : ['-c', '1', '-W', String(Math.max(1, Math.round(timeoutMs / 1000))), address]
  return new Promise((resolve) => {
    let out = ''
    const p = spawn('ping', args, { windowsHide: true })
    p.stdout.on('data', (d: Buffer) => (out += d.toString('latin1')))
    p.on('error', () => resolve(null))
    p.on('close', () => resolve(parseRtt(out)))
    setTimeout(() => p.kill(), timeoutMs + 2000)
  })
}

export function parseRtt(out: string): number | null {
  // "Destination host unreachable" replies come back without TTL: that is not alive.
  if (!/ttl=/i.test(out)) return null
  // Linux / English Windows: "time=0.045 ms", "time<1ms". Russian Windows: "время=12мс TTL=64",
  // where only the digits, the unit right after them and "TTL=" survive the code page.
  const m = out.match(/time([=<])\s*(\d+(?:\.\d+)?)/i) ?? out.match(/([=<])(\d+(?:[.,]\d+)?)[^\s\d=<]*\s+TTL=/i)
  if (!m) return 0
  const v = Number(m[2].replace(',', '.'))
  // "<1ms": under a millisecond.
  return m[1] === '<' ? v / 2 : v
}

/** Opens address:port from the jump host / proxy; rejects when it can't. */
export type TcpOpen = (address: string, port: number) => Promise<Duplex>

/**
 * "Ping" through a jump host or SOCKS5 proxy, where ICMP can't go: time to open a TCP connection to
 * address:port from there. A refused port still means the host answered, so it counts as alive.
 * Resolves to ms, or null when nothing answered in time (or the proxy itself is down).
 */
export function tcpPing(open: TcpOpen, address: string, port: number, timeoutMs = 3000): Promise<number | null> {
  const started = Date.now()
  return new Promise((resolve) => {
    let done = false
    const finish = (v: number | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    open(address, port).then(
      (st) => {
        st.destroy()
        finish(Date.now() - started)
      },
      (e: Error & { reply?: number }) => {
        // SOCKS5 reply 5 / OpenSSH "Connection refused": the host sent RST, so it is up.
        finish(e.reply === 5 || /refused|отказано/i.test(e.message) ? Date.now() - started : null)
      }
    )
  })
}
